/**
 * 两层界面:
 *   view = 'overview'  顶层优先级流,跨会话
 *   view = <localId>   单会话详情,四个页签
 *
 * 状态全部由服务端事件驱动,本地只缓存渲染所需的数据。
 */

const token = new URLSearchParams(location.search).get('token');
const $ = (id) => document.getElementById(id);

const state = {
  view: 'overview',
  tab: 'files',
  sessions: new Map(),   // localId -> summary
  pending: new Map(),    // toolUseId -> approval
  detail: null,          // 当前打开会话的详情
  connected: false,
};

// ── 工具函数 ────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

function waited(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `已等 ${s} 秒`;
  return `已等 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function countdown(deadline) {
  const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  if (s <= 0) return '已超时';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} 后自动拒绝`;
}

const STATE_LABEL = {
  starting: '启动中', ready: '就绪', busy: '运行中',
  waiting: '等待批准', exited: '已退出',
};

/** 把风险规则命中的片段标红。 */
function renderCmd(summary, risk) {
  const safe = esc(summary);
  if (!risk?.highlight) return safe;
  const h = esc(risk.highlight);
  return safe.replace(h, `<span class="risk-hl">${h}</span>`);
}

function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

// ── API ─────────────────────────────────────────────────────
const api = (path, opts = {}) =>
  fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token, ...(opts.headers || {}) },
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });

// ── WebSocket ───────────────────────────────────────────────
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}/?token=${token}`);

  ws.onopen = () => { state.connected = true; renderConn(); };
  ws.onclose = () => {
    state.connected = false; renderConn();
    setTimeout(connect, 2000);
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);

    switch (m.type) {
      case 'hello':
        state.sessions.clear();
        for (const s of m.sessions) state.sessions.set(s.localId, s);
        state.pending.clear();
        for (const a of m.pending) state.pending.set(a.toolUseId, a);
        renderAll();
        break;

      case 'session_added':
      case 'session_updated':
        state.sessions.set(m.session.localId, {
          ...state.sessions.get(m.session.localId),
          ...m.session,
        });
        renderNav();
        if (state.view === 'overview') renderOverview();
        else if (state.view === m.session.localId) renderTopbar();
        break;

      case 'session_event':
        onSessionEvent(m.localId, m.event);
        break;

      case 'approval_request':
        state.pending.set(m.approval.toolUseId, m.approval);
        renderAll();
        break;

      case 'approval_resolved':
        state.pending.delete(m.toolUseId);
        renderAll();
        break;

      case 'user_message':
        if (state.detail?.localId === m.localId) {
          state.detail.timeline.push({ kind: 'user', text: m.text, at: Date.now() });
          if (state.tab === 'chat') renderBody();
        }
        break;
    }
  };
}

/** 增量维护当前打开会话的详情,避免每个事件都重新拉取。 */
function onSessionEvent(localId, ev) {
  const d = state.detail;
  if (!d || d.localId !== localId) return;

  switch (ev.kind) {
    case 'assistant_text':
      d.timeline.push({ kind: 'assistant', text: ev.text, at: Date.now() });
      break;
    case 'tool_use': {
      d.timeline.push({
        kind: 'tool', toolUseId: ev.toolUseId, name: ev.name,
        summary: summarize(ev.name, ev.input), done: false, isError: false, at: Date.now(),
      });
      const kind = { Edit: 'edit', Write: 'new', NotebookEdit: 'edit' }[ev.name];
      const path = ev.input?.file_path;
      if (kind && path && !d.files.some((f) => f.path === path)) {
        d.files.push({ path, kind, at: Date.now() });
      }
      break;
    }
    case 'tool_result': {
      const t = d.timeline.find((x) => x.kind === 'tool' && x.toolUseId === ev.toolUseId);
      if (t) { t.done = true; t.isError = ev.isError; }
      if (t?.name === 'Bash') {
        d.commands.push({
          toolUseId: ev.toolUseId, command: t.summary,
          output: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
          isError: ev.isError, at: Date.now(),
        });
      }
      break;
    }
    case 'turn_end':
      d.turns++;
      if (ev.costUsd) d.costUsd += ev.costUsd;
      // 分组边界:标记本轮结束,渲染时据此把过程步骤折叠、只留结论。
      d.timeline.push({ kind: 'turn_end', at: Date.now() });
      break;
  }
  renderBody();
  renderTabs();
}

/**
 * 按 user 消息切分 turn,组内除最后一条 assistant 文本外全部算「过程」
 * (工具调用 + 中间文本)。已结束的 turn 把过程折叠成一行,默认收起,
 * 减少两次结论之间的噪音;进行中的 turn 没有「最后一条」的概念,
 * 只显示过程中最新一步,原地更新而非持续追加。
 */
function renderTurns(d) {
  if (!d.expandedTurns) d.expandedTurns = new Set();
  const groups = [];
  let cur = null;
  for (const t of d.timeline) {
    if (t.kind === 'user') { cur = { user: t, steps: [], ended: false }; groups.push(cur); continue; }
    if (!cur) { cur = { user: null, steps: [], ended: false }; groups.push(cur); }
    if (t.kind === 'turn_end') { cur.ended = true; continue; }
    cur.steps.push(t);
  }

  return groups.map((g, i) => {
    let out = g.user ? `<div class="turn me"><div class="who">你</div><div class="said">${esc(g.user.text)}</div></div>` : '';

    if (!g.steps.length) return out;

    if (!g.ended) {
      // 进行中:只展示最新一步,旧步骤不追加显示。
      const last = g.steps[g.steps.length - 1];
      out += last.kind === 'assistant'
        ? `<div class="turn"><div class="who">Claude</div><div class="said">${esc(last.text)}</div></div>`
        : toolLine(last);
      return out;
    }

    // 已结束:最后一条 assistant 文本是结论,常显;其余步骤折叠。
    const lastAssistantIdx = [...g.steps].reverse().findIndex((s) => s.kind === 'assistant');
    const concludeIdx = lastAssistantIdx === -1 ? -1 : g.steps.length - 1 - lastAssistantIdx;
    const conclude = concludeIdx === -1 ? null : g.steps[concludeIdx];
    const process = g.steps.filter((_, idx) => idx !== concludeIdx);

    if (process.length) {
      const failed = process.some((s) => s.kind === 'tool' && s.isError);
      const open = d.expandedTurns.has(i);
      out += `<div class="proc ${open ? 'open' : ''}" data-turn="${i}">
        <div class="proc-sum">
          <span class="proc-caret">▸</span>
          <span>${process.length} 步${failed ? ' · 含出错' : ''}</span>
        </div>
        <div class="proc-body">${process.map(toolLine).join('')}</div>
      </div>`;
    }
    if (conclude) out += `<div class="turn"><div class="who">Claude</div><div class="said">${esc(conclude.text)}</div></div>`;
    return out;
  }).join('');
}

function toolLine(t) {
  if (t.kind === 'assistant') return `<div class="turn"><div class="who">Claude</div><div class="said">${esc(t.text)}</div></div>`;
  const mark = !t.done ? '<span class="run-mark">running</span>'
    : t.isError ? '<span class="err-mark">✕</span>' : '<span class="ok-mark">✓</span>';
  return `<div class="tool-line"><span class="nm">${esc(t.name)}</span><span class="ar">${esc(t.summary)}</span>${mark}</div>`;
}

function summarize(name, input) {
  if (name === 'Bash' && input?.command) return input.command;
  if (name === 'AskUserQuestion') {
    const qs = Array.isArray(input?.questions) ? input.questions : [];
    const first = qs[0]?.question;
    if (first) return qs.length > 1 ? `${first}(共 ${qs.length} 个问题)` : first;
  }
  if (input?.file_path) return input.file_path;
  if (input?.pattern) return input.pattern;
  if (input?.url) return input.url;
  return JSON.stringify(input ?? {});
}

// ── 渲染:侧栏 ──────────────────────────────────────────────
function renderConn() {
  $('conn').className = `conn ${state.connected ? 'up' : 'down'}`;
}

function pendingFor(localId) {
  const s = state.sessions.get(localId);
  if (!s?.claudeId) return [];
  return [...state.pending.values()].filter((a) => a.sessionId === s.claudeId);
}

/**
 * 会话显示名(HTML)。
 *
 * 同一目录可并存多个会话,此时目录名必然相同,需要额外信息区分。
 * 优先用 claude 自己起的标题(说明这个会话在做什么);标题要首轮对话后
 * 才有,在此之前退回 pane —— 它能区分但不解释,只是过渡。
 */
function displayName(s) {
  if (!s) return '未知会话';
  const name = esc(s.name);

  let dup = false;
  for (const o of state.sessions.values()) {
    if (o.localId !== s.localId && o.name === s.name) { dup = true; break; }
  }

  if (s.title) return `${name}<span class="s-tag ttl">${esc(s.title)}</span>`;
  if (!dup) return name;
  return `${name}<span class="s-tag">${esc(s.paneId ?? s.localId.slice(0, 4))}</span>`;
}

function renderNav() {
  const groups = { waiting: [], active: [], quiet: [] };
  for (const s of state.sessions.values()) {
    if (pendingFor(s.localId).length) groups.waiting.push(s);
    else if (s.state === 'busy' || s.state === 'starting') groups.active.push(s);
    else groups.quiet.push(s);
  }

  const item = (s) => {
    const n = pendingFor(s.localId).length;
    const st = n ? 'waiting' : s.state;
    return `<div class="nav-item ${state.view === s.localId ? 'on' : ''}" data-id="${s.localId}">
      <span class="pip ${st}"></span>
      <span class="nav-name">${displayName(s)}</span>
      ${n ? `<span class="nav-badge">${n}</span>` : ''}
    </div>`;
  };

  let html = `<div class="nav-item ${state.view === 'overview' ? 'on' : ''}" data-id="overview">
    <span class="nav-name" style="font-weight:500">全部会话</span>
  </div>`;
  if (groups.waiting.length) html += `<div class="nav-h">需要你</div>` + groups.waiting.map(item).join('');
  if (groups.active.length) html += `<div class="nav-h">进行中</div>` + groups.active.map(item).join('');
  if (groups.quiet.length) html += `<div class="nav-h">静默</div>` + groups.quiet.map(item).join('');

  $('nav').innerHTML = html;
  for (const el of $('nav').querySelectorAll('.nav-item')) {
    el.onclick = () => navigate(el.dataset.id);
  }
}

// ── 渲染:顶栏 ──────────────────────────────────────────────
function renderTopbar() {
  if (state.view === 'overview') {
    const all = [...state.sessions.values()];
    const wait = all.filter((s) => pendingFor(s.localId).length).length;
    const run = all.filter((s) => s.state === 'busy').length;
    $('topbar').innerHTML = `<h1>全部会话</h1>
      <div class="summary">
        <span class="s-wait">待决策 <b>${wait}</b></span>
        <span class="s-run">进行中 <b>${run}</b></span>
        <span>会话 <b>${all.length}</b></span>
      </div>`;
    return;
  }

  const s = state.sessions.get(state.view);
  if (!s) return;
  const n = pendingFor(s.localId).length;
  const st = n ? 'waiting' : s.state;
  $('topbar').innerHTML = `<h1>${displayName(s)}</h1>
    <span class="chip ${st}">${STATE_LABEL[st]}${s.turns ? ` · 第 ${s.turns} 轮` : ''}</span>
    <span class="path">${esc(s.workspace)}</span>
    <span class="spacer"></span>
    <span class="cost">${s.costUsd ? '$' + s.costUsd.toFixed(4) : ''}</span>`;
}

// ── 渲染:页签 ──────────────────────────────────────────────
function renderTabs() {
  if (state.view === 'overview') { $('tabs').style.display = 'none'; return; }
  const d = state.detail;
  $('tabs').style.display = 'flex';
  const defs = [
    ['files', '改动文件', d?.files.length ?? 0],
    ['chat', '对话', 0],
    ['term', '终端输出', d?.commands.length ?? 0],
  ];
  $('tabs').innerHTML = defs.map(([k, label, n]) =>
    `<button class="tab ${state.tab === k ? 'on' : ''}" data-t="${k}">${label}${n ? `<span class="n">${n}</span>` : ''}</button>`
  ).join('');
  for (const t of $('tabs').querySelectorAll('.tab')) {
    t.onclick = () => { state.tab = t.dataset.t; renderTabs(); renderBody(); };
  }
}

// ── 渲染:批准卡片 ───────────────────────────────────────────
function approvalCard(a, showSession) {
  const s = [...state.sessions.values()].find((x) => x.claudeId === a.sessionId);
  const why = a.risk
    ? `<div class="c-why ${a.risk.level === 'medium' ? 'medium' : ''}">${esc(a.risk.text)}</div>` : '';
  const body = a.toolName === 'AskUserQuestion' ? renderQuestions(a.toolInput) : `<div class="c-cmd">${renderCmd(a.summary, a.risk)}</div>`;
  return `<div class="card act" data-tuid="${a.toolUseId}">
    <div class="c-top">
      ${showSession ? `<span class="c-repo">${displayName(s)}</span>` : '<span class="c-repo">等待批准</span>'}
      <span class="c-tool">${esc(a.toolName)}</span>
      <span class="c-time">${waited(a.requestedAt)}</span>
    </div>
    ${body}
    ${why}
    <div class="c-act">
      <button class="btn pri" data-act="allow">批准</button>
      <button class="btn dan" data-act="deny">拒绝</button>
      ${showSession && s ? `<button class="btn" data-open="${s.localId}">打开会话</button>` : ''}
      <span class="cd" data-deadline="${a.deadlineAt}">${countdown(a.deadlineAt)}</span>
    </div>
  </div>`;
}

/**
 * AskUserQuestion 的选项是只读展示,不是实际作答——批准只放行工具调用本身,
 * 真正的回答仍需在 Claude Code 所在终端里选择(PreToolUse 钩子拿不到工具结果)。
 */
function renderQuestions(toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  if (!questions.length) return `<div class="c-cmd">${esc(JSON.stringify(toolInput ?? {}))}</div>`;

  return questions.map((q) => {
    const options = Array.isArray(q.options) ? q.options : [];
    return `<div class="qblock">
      <div class="qhead">
        ${q.header ? `<span class="qtag">${esc(q.header)}</span>` : ''}
        ${q.multiSelect ? '<span class="qtag multi">多选</span>' : ''}
      </div>
      <div class="qtext">${esc(q.question ?? '')}</div>
      <div class="qopts">
        ${options.map((o) => `<div class="qopt">
          <span class="qmark">${q.multiSelect ? '☐' : '○'}</span>
          <span class="qopt-body"><span class="qlabel">${esc(o.label ?? '')}</span>${o.description ? `<span class="qdesc">${esc(o.description)}</span>` : ''}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function wireApprovals(root) {
  for (const card of root.querySelectorAll('[data-tuid]')) {
    const tuid = card.dataset.tuid;
    for (const b of card.querySelectorAll('[data-act]')) {
      b.onclick = () => {
        for (const x of card.querySelectorAll('button')) x.disabled = true;
        ws.send(JSON.stringify({ type: 'decision', toolUseId: tuid, decision: b.dataset.act }));
      };
    }
    const open = card.querySelector('[data-open]');
    if (open) open.onclick = () => navigate(open.dataset.open);
  }
}

// ── 渲染:主体 ──────────────────────────────────────────────
function renderOverview() {
  const pend = [...state.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt);
  const all = [...state.sessions.values()];
  const busy = all.filter((s) => !pendingFor(s.localId).length && (s.state === 'busy' || s.state === 'starting'));
  const quiet = all.filter((s) => !pendingFor(s.localId).length && s.state !== 'busy' && s.state !== 'starting');

  let html = '';

  if (pend.length) {
    html += `<div class="sect">需要决策 — 按等待时长排序</div>`;
    html += pend.map((a) => approvalCard(a, true)).join('');
  }

  if (busy.length) {
    html += `<div class="sect">进行中</div>`;
    html += busy.map((s) => `<div class="card">
      <div class="c-top">
        <span class="c-repo">${displayName(s)}</span>
        <span class="c-tool">${STATE_LABEL[s.state]}${s.turns ? ` · 第 ${s.turns} 轮` : ''}</span>
        <span class="c-time">${ago(s.lastActivity)}</span>
      </div>
      <div class="c-cmd">${esc(s.lastAction)}</div>
      <div class="c-act">
        <span style="font-size:12px;color:var(--ink-3)">${s.fileCount ? `${s.fileCount} 个文件已改动` : ''}</span>
        <button class="btn" style="margin-left:auto" data-open="${s.localId}">打开会话</button>
      </div>
    </div>`).join('');
  }

  if (quiet.length) {
    html += `<div class="sect">静默</div>`;
    html += quiet.map((s) => `<div class="card">
      <div class="c-top">
        <span class="c-repo">${displayName(s)}</span>
        <span class="c-tool">${STATE_LABEL[s.state]}${s.costUsd ? ` · $${s.costUsd.toFixed(4)}` : ''}</span>
        <span class="c-time">${ago(s.lastActivity)}</span>
      </div>
      <div class="c-act">
        <span style="font-size:12px;color:var(--ink-3)">${s.fileCount ? `${s.fileCount} 个文件已改动` : esc(s.lastAction)}</span>
        <button class="btn" style="margin-left:auto" data-open="${s.localId}">打开会话</button>
      </div>
    </div>`).join('');
  }

  if (!all.length) {
    html = `<div class="empty">还没有会话。点左下角「新建会话」选一个工作目录开始。</div>`;
  }

  $('body').innerHTML = html;
  wireApprovals($('body'));
  for (const b of $('body').querySelectorAll('[data-open]')) {
    b.onclick = () => navigate(b.dataset.open);
  }
}

function renderDetail() {
  const d = state.detail;
  if (!d) { $('body').innerHTML = `<div class="empty">加载中…</div>`; return; }

  const pend = pendingFor(d.localId).sort((a, b) => a.requestedAt - b.requestedAt);
  // AskUserQuestion 这类待批准项是当前对话的一部分,留在对话流末尾更符合语境;
  // 其余页签没有"对话流"概念,沿用置顶。
  const pendCards = pend.map((a) => approvalCard(a, false)).join('');
  let html = state.tab === 'chat' ? '' : pendCards;

  if (state.tab === 'files') {
    if (d.files.length) {
      const label = { edit: '修改', new: '新增', delete: '删除' };
      html += `<div class="card">
        <div class="c-top"><span class="c-repo">本次会话改动</span><span class="c-time">${d.files.length} 个文件</span></div>
        ${d.files.map((f) => {
          const [dir, base] = splitPath(f.path);
          return `<div class="file-row">
            <span class="tagm ${f.kind}">${label[f.kind]}</span>
            <span class="fname"><span class="fdir">${esc(dir)}</span>${esc(base)}</span>
          </div>`;
        }).join('')}
      </div>`;
    } else if (!pend.length) {
      html += `<div class="empty">本次会话还没有文件改动。</div>`;
    }
  }

  if (state.tab === 'chat') {
    if (d.timeline.length) {
      html += renderTurns(d);
    } else if (!pend.length) {
      html += `<div class="empty">还没有对话。在下方输入框开始。</div>`;
    }
    html += pendCards;
  }

  if (state.tab === 'term') {
    if (d.commands.length) {
      html += d.commands.map((c) => `<div class="card">
        <div class="c-top">
          <span class="c-repo" style="font-family:var(--mono);font-size:12.5px">${esc(c.command)}</span>
          <span class="c-time">${c.isError ? '出错' : '成功'} · ${ago(c.at)}</span>
        </div>
        <div class="term-out">${esc(c.output) || '(无输出)'}</div>
      </div>`).join('');
    } else if (!pend.length) {
      html += `<div class="empty">本次会话还没有命令执行记录。</div>`;
    }
  }

  const wasBottom = $('body').scrollHeight - $('body').scrollTop - $('body').clientHeight < 100;
  $('body').innerHTML = html;
  wireApprovals($('body'));
  if (state.tab === 'chat') wireProcs($('body'), d);
  if (state.tab === 'chat' && wasBottom) $('body').scrollTop = $('body').scrollHeight;
}

function wireProcs(root, d) {
  for (const el of root.querySelectorAll('.proc-sum')) {
    el.onclick = () => {
      const i = Number(el.parentElement.dataset.turn);
      if (d.expandedTurns.has(i)) d.expandedTurns.delete(i); else d.expandedTurns.add(i);
      renderDetail();
    };
  }
}

function renderBody() {
  if (state.view === 'overview') renderOverview();
  else renderDetail();
}

function renderAll() {
  renderNav(); renderTopbar(); renderTabs(); renderBody();
}

// ── 导航 ────────────────────────────────────────────────────
async function navigate(id) {
  state.view = id;
  if (id === 'overview') {
    state.detail = null;
    $('foot').style.display = 'none';
  } else {
    $('foot').style.display = 'block';
    try {
      state.detail = await api(`/api/sessions/${id}`);
      if (state.detail) state.detail.expandedTurns = new Set();
    } catch {
      state.detail = null;
    }
  }
  renderAll();
}

// ── 新建会话 ────────────────────────────────────────────────
$('add').onclick = () => {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <h3>新建会话</h3>
    <p>填写工作目录的绝对路径。该目录下的 .claude/settings.local.json 会被合并写入钩子配置。</p>
    <input id="wsp" placeholder="/Users/you/projects/my-repo" spellcheck="false">
    <div class="err" id="mErr" style="display:none"></div>
    <div class="modal-act">
      <button class="btn" id="mCancel">取消</button>
      <button class="btn pri" id="mOk">创建</button>
    </div>
  </div>`;
  document.body.append(bg);
  const inp = bg.querySelector('#wsp');
  inp.focus();

  const close = () => bg.remove();
  bg.querySelector('#mCancel').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };

  const submit = async () => {
    const workspace = inp.value.trim();
    if (!workspace) return;
    const err = bg.querySelector('#mErr');
    const ok = bg.querySelector('#mOk');
    ok.disabled = true;
    try {
      const { localId } = await api('/api/sessions', {
        method: 'POST', body: JSON.stringify({ workspace }),
      });
      close();
      navigate(localId);
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
      ok.disabled = false;
    }
  };
  bg.querySelector('#mOk').onclick = submit;
  inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
};

// ── 发送 ────────────────────────────────────────────────────
function send() {
  const text = $('input').value.trim();
  if (!text || state.view === 'overview' || !state.connected) return;
  ws.send(JSON.stringify({ type: 'prompt', localId: state.view, text }));
  $('input').value = '';
}
$('send').onclick = send;
$('input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
};

// ── 倒计时:每秒刷新,不重绘整页 ─────────────────────────────
setInterval(() => {
  for (const el of document.querySelectorAll('[data-deadline]')) {
    el.textContent = countdown(Number(el.dataset.deadline));
  }
}, 1000);

// ── 启动 ────────────────────────────────────────────────────
if (!token) {
  document.body.innerHTML = `<div class="empty" style="margin:auto">缺少访问令牌 —— 请使用终端打印的完整链接打开。</div>`;
} else {
  connect();
  renderAll();
}
