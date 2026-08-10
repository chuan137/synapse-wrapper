/**
 * 两层界面:
 *   view = 'overview'  顶层优先级流,跨会话
 *   view = <localId>   单会话详情,四个页签
 *
 * 状态全部由服务端事件驱动,本地只缓存渲染所需的数据。
 */

const token = new URLSearchParams(location.search).get('token');
const $ = (id) => document.getElementById(id);

// 手动收起的 project(key = workspace 绝对路径)。记录「收起」而非「展开」,
// 使新 workspace 默认展开 —— 新建会话应该立刻在左栏可见,不用用户再点一次。
// 刷新页面后左栏布局要保持原样,故存 localStorage;会话数据本身仍是服务端权威、不缓存。
const COLLAPSED_KEY = 'synapse.collapsedProjects';
function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')); }
  catch { return new Set(); }
}
function saveCollapsed(set) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
}

const state = {
  view: 'overview',
  tab: 'chat',
  sessions: new Map(),   // localId -> summary
  pending: new Map(),    // toolUseId -> approval
  detail: null,          // 当前打开会话的详情
  connected: false,
  collapsedProjects: loadCollapsed(),
  draftQueue: new Map(), // localId -> string[],会话忙碌时攒的待发 prompt(纯前端,不持久化)
  pinBottom: false,      // 下次 renderDetail 是否无条件贴底(切会话/切页签/刚发消息)
};

// ── 工具函数 ────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 极简 Markdown 渲染,只覆盖 Claude 输出里常见的语法(粗体/斜体/行内代码/
 * 代码块/链接/标题/列表),不追求 CommonMark 完整规范。用户自己发的消息
 * 不经过这里 —— 原样转义显示,不该被解释成 markdown。
 *
 * 先整体 HTML 转义再逐步替换成标签,任何用户可控内容都不会被当成 HTML
 * 注入执行。代码块/行内代码先抽成占位符,避免块内内容被后续的粗体/链接
 * 等行内规则误伤(比如代码里的 * 或 [ ] 被当语法解析)。
 */
function renderMarkdown(src) {
  const blocks = [];
  let text = esc(src).replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.push(`<pre class="md-code"><code>${code.replace(/\n$/, '')}</code></pre>`) - 1;
    return `@@B${i}@@`;
  });

  const inlineCode = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = inlineCode.push(`<code>${code}</code>`) - 1;
    return `@@I${i}@@`;
  });

  text = text.replace(/^(#{1,4})\s+(.+)$/gm, (_, h, t) => `@@H${h.length}@@${t}@@/H@@`);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // 表头行下一行必须是 |---|---| 分隔行才算表格,避免把正文里偶然出现的
  // "a | b" 误判成表格。分隔行本身不进输出。
  const splitRow = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  text = text.replace(
    /(?:^|\n)(\|.+\|)\n(\|[ :|-]+\|)\n((?:\|.+\|\n?)*)/g,
    (m, head, sep, body) => {
      if (!/^\|?[ :|-]+\|?$/.test(sep)) return m;
      const th = splitRow(head).map((c) => `<th>${c}</th>`).join('');
      const rows = body.trim().split('\n').filter(Boolean)
        .map((r) => `<tr>${splitRow(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
      const i = blocks.push(`<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`) - 1;
      return `\n@@B${i}@@\n`;
    },
  );

  text = text.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (m, block) =>
    `\n@@UL@@${block.trim().split('\n').map((l) => `<li>${l.replace(/^[-*]\s+/, '')}</li>`).join('')}@@/UL@@`);
  text = text.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m, block) =>
    `\n@@OL@@${block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('')}@@/OL@@`);

  text = text.replace(/@@H(\d)@@([\s\S]*?)@@\/H@@/g, (_, n, t) => `<h${Number(n) + 2}>${t}</h${Number(n) + 2}>`);
  text = text.replace(/@@UL@@/g, '<ul>').replace(/@@\/UL@@/g, '</ul>');
  text = text.replace(/@@OL@@/g, '<ol>').replace(/@@\/OL@@/g, '</ol>');

  // 代码块占位符此时还不是真正的块级标签,换行折 <br> 前先临时套一层
  // div,避免占位符前后的换行被误转成 <br>(块级标签自带换行,不需要)。
  text = text.replace(/@@B(\d+)@@/g, '<div data-b>@@B$1@@</div>');
  text = text.replace(/\n(?!<\/?(h\d|ul|ol|li|div))/g, '<br>');
  text = text.replace(/<br>(<\/?(ul|ol|h\d|div)>)/g, '$1').replace(/(<\/?(ul|ol|h\d|div)>)<br>/g, '$1');
  text = text.replace(/<div data-b>(@@B\d+@@)<\/div>/g, '$1');

  text = text.replace(/@@I(\d+)@@/g, (_, i) => inlineCode[i]);
  text = text.replace(/@@B(\d+)@@/g, (_, i) => blocks[i]);
  return text;
}

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

// AskUserQuestion 之外的工具不再经网页批准(spec §2.3a),Claude Code
// 内置权限系统若需要询问,会在没有 TTY 的 stream-json 管道里干等 ——
// 网页看不到这类阻塞。超过此时长仍无结果回填,视为疑似卡住。
const STALL_THRESHOLD_MS = 20_000;
const isStalled = (s) => s.pendingToolSince != null && Date.now() - s.pendingToolSince > STALL_THRESHOLD_MS;
const stallNotice = (s) => `<div class="c-why stall" style="border-radius:8px;margin-bottom:8px">
  <span>⚠️ 工具调用已发出但${waited(s.pendingToolSince)}未返回结果,可能卡在本地终端的权限确认。</span>
  <button class="stall-interrupt" data-interrupt="${s.localId}" title="向该会话发送 Escape,尝试打断当前卡住的操作">中断</button>
</div>`;

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
        if (m.session.state === 'ready') flushDraftQueue(m.session.localId);
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
          // 自己刚发的消息,不管发送前滚到哪都跳回底部去看它。
          if (state.view === m.localId) state.pinBottom = true;
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
      // TodoWrite 是整份清单替换,不是增量。
      if (ev.name === 'TodoWrite' && Array.isArray(ev.input?.todos)) {
        d.todos = ev.input.todos;
      }
      // Task* 系列(部分环境用它替代 TodoWrite):TaskCreate 的 tool_use 阶段
      // 还没有 taskId(要等 tool_result 解出),先记生成信息;TaskUpdate 有
      // taskId,直接改已建档任务的状态 —— 与后端 sessionManager.ts 同一套归约。
      if (ev.name === 'TaskCreate') {
        d.pendingTaskCreates.set(ev.toolUseId, {
          subject: ev.input?.subject ?? '', activeForm: ev.input?.activeForm ?? '',
        });
      } else if (ev.name === 'TaskUpdate') {
        const existing = d.tasks.get(ev.input?.taskId);
        if (existing) {
          if (['pending', 'in_progress', 'completed'].includes(ev.input?.status)) existing.status = ev.input.status;
          if (typeof ev.input?.subject === 'string') existing.content = ev.input.subject;
          if (typeof ev.input?.activeForm === 'string') existing.activeForm = ev.input.activeForm;
        }
      }
      if (d.pendingToolSince == null) d.pendingToolSince = Date.now();
      break;
    }
    case 'tool_result': {
      const t = d.timeline.find((x) => x.kind === 'tool' && x.toolUseId === ev.toolUseId);
      // AskUserQuestion 只能靠 deny+reason 回传(spec §5.1),Claude Code 因此
      // 把它标成 is_error —— 是协议限制,不是真的失败,与后端 sessionManager.ts 同处理。
      if (t) { t.done = true; t.isError = t.name === 'AskUserQuestion' ? false : ev.isError; }
      if (t?.name === 'Bash') {
        d.commands.push({
          toolUseId: ev.toolUseId, command: t.summary,
          output: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
          isError: ev.isError, at: Date.now(),
        });
      }
      // TaskCreate 的 taskId 只在结果文本里给出("Task #4 created ..."),
      // tool_use 阶段拿不到,等结果回填建档。
      if (t?.name === 'TaskCreate' && !ev.isError) {
        const pending = d.pendingTaskCreates.get(ev.toolUseId);
        const match = typeof ev.content === 'string' ? ev.content.match(/Task #(\S+) created/) : null;
        if (pending && match) {
          d.tasks.set(match[1], { id: match[1], content: pending.subject, activeForm: pending.activeForm, status: 'pending' });
        }
        d.pendingTaskCreates.delete(ev.toolUseId);
      }
      // 并发工具调用下,清掉的可能不是最早那个,需要重新取最小值
      const openAts = d.timeline.filter((x) => x.kind === 'tool' && !x.done).map((x) => x.at);
      d.pendingToolSince = openAts.length ? Math.min(...openAts) : null;
      break;
    }
    case 'turn_end':
      d.turns++;
      if (ev.costUsd) d.costUsd += ev.costUsd;
      // 分组边界:标记本轮结束,渲染时据此把过程步骤折叠、只留结论。
      d.timeline.push({ kind: 'turn_end', at: Date.now() });
      break;
    case 'error':
      // 后端已经把泄漏的 pendingTurns 收回、state 改回 ready(见
      // sessionManager.ts #absorb 的 case 'error' 注释),这里只负责
      // 让用户看到"刚才那次发送其实没成功",不必再去 tmux 才发现。
      d.timeline.push({ kind: 'error', text: ev.message, at: Date.now() });
      break;
  }
  // renderTodoPanel 只读 d.todos,Task* 分支只改了 d.tasks Map,
  // 每次事件后都要重新合并 —— 与后端 sessionManager.ts 的 mergedTodos 同逻辑。
  // TodoWrite 场景 d.todos 由该分支直接赋值,优先级更高,这里只在没有
  // TodoWrite 数据时才用 tasks Map 兜底(不能靠 d.todos.length 判断 ——
  // tasks 场景下上一次同步已经把它填成非空,length 再也不会掉回 0)。
  if (ev.name !== 'TodoWrite' && d.tasks.size) d.todos = [...d.tasks.values()];
  renderBody();
  renderTabs();
}

/**
 * 按 user 消息切分 turn,组内除最后一条 assistant 文本外全部算「过程」
 * (工具调用 + 中间文本)。已结束的 turn 把过程折叠成一行,默认收起,
 * 减少两次结论之间的噪音;进行中的 turn 没有「结论」的概念,过程原样
 * 滚动展示(不折叠),跳动的三个点跟步数徽标并排挂在"Claude"旁边,
 * 表示还在继续、后面还有内容要来。
 */
function renderTurns(d) {
  if (!d.expandedTurns) d.expandedTurns = new Set();
  // 记录"已经以已结束态渲染过"的轮次索引 —— 每次事件都会整块重绘
  // innerHTML,若无差别给所有已结束气泡加入场动画,历史气泡会跟着任何
  // 新事件反复重播,只在进行中→已结束的第一次渲染时补一次性 class。
  if (!d.settledTurns) d.settledTurns = new Set();
  const groups = [];
  let cur = null;
  for (const t of d.timeline) {
    if (t.kind === 'user') { cur = { user: t, steps: [], ended: false, error: null }; groups.push(cur); continue; }
    if (!cur) { cur = { user: null, steps: [], ended: false, error: null }; groups.push(cur); }
    if (t.kind === 'turn_end') { cur.ended = true; continue; }
    // 不进 steps/toolLine —— 那条渲染管线是为工具调用步骤设计的,错误
    // 提示单独用一块红色条挂在这一轮末尾。
    if (t.kind === 'error') { cur.error = t.text; continue; }
    cur.steps.push(t);
  }

  return groups.map((g, i) => {
    let out = g.user ? `<div class="turn me"><div class="who">你</div><div class="said">${esc(g.user.text)}</div></div>` : '';
    if (g.error) out += `<div class="c-why">⚠️ 发送失败:${esc(g.error)}</div>`;

    if (!g.steps.length) return out;

    if (!g.ended) {
      // 进行中:全部步骤原样滚动显示,不折叠(折叠是「已结束」轮次专属
      // 的降噪手段,进行中还不知道最终会有几步,折叠了也没有稳定的
      // 「结论」可露出)。
      const who = `Claude<span class="proc-sum live">${LIVE_DOTS}<span class="proc-steps">${g.steps.length} 步</span></span>`;
      out += `<div class="turn"><div class="who">${who}</div><div class="said">${g.steps.map(toolLine).join('')}</div></div>`;
      return out;
    }

    // 已结束:最后一条 assistant 文本是结论,常显;其余步骤折叠。
    const lastAssistantIdx = [...g.steps].reverse().findIndex((s) => s.kind === 'assistant');
    const concludeIdx = lastAssistantIdx === -1 ? -1 : g.steps.length - 1 - lastAssistantIdx;
    const conclude = concludeIdx === -1 ? null : g.steps[concludeIdx];
    const process = g.steps.filter((_, idx) => idx !== concludeIdx);

    // 步骤摘要挂在"Claude"标签旁边而非气泡内部 —— 折叠/展开是对这一轮
    // 过程的元信息,跟发言人一起出现比塞进正文顶部更符合"这是谁、做了
    // 多少步"的阅读顺序。展开后的过程详情仍放在气泡内、结论文字上方
    // (过程先于结论发生,顺序不能反)。
    let who = 'Claude';
    let procHtml = '';
    if (process.length) {
      const failed = process.some((s) => s.kind === 'tool' && s.isError);
      const open = d.expandedTurns.has(i);
      who += `<span class="proc-sum" data-turn="${i}">
        <span class="proc-steps">${process.length} 步</span>
        ${failed ? '<span class="err-mark">含出错</span>' : ''}
      </span>`;
      procHtml = `<div class="proc ${open ? 'open' : ''}">
        <div class="proc-body-wrap"><div class="proc-body">${process.map(toolLine).join('')}</div></div>
      </div>`;
    }
    if (procHtml || conclude) {
      const text = conclude ? renderMarkdown(conclude.text) : '<span class="no-conclude">(无文字回复)</span>';
      // 首次以已结束态渲染:补一次性入场动画,缓解「滚动列表→折叠结论」
      // 的突变感;之后每次重绘(如别的轮次触发的事件)不再重播。
      const justSettled = !d.settledTurns.has(i);
      d.settledTurns.add(i);
      out += `<div class="turn ${justSettled ? 'settle-in' : ''}"><div class="who">${who}</div><div class="said">${procHtml}${text}</div></div>`;
    }
    return out;
  }).join('');
}

// 轮次/工具调用"进行中"的统一动效标记 —— 三个依次跳动的圆点,
// 比静态的"running"文字更直观地传达"还没结束,后面还有内容"。
const LIVE_DOTS = '<span class="live-dots"><span></span><span></span><span></span></span>';

function toolLine(t) {
  // 过程中的 assistant 文本(非本轮结论)—— 弱于工具调用行,
  // 也区分于 .turn .said 承载的结论,避免抢视觉、分不清主次。
  if (t.kind === 'assistant') return `<div class="mid-text">${renderMarkdown(t.text)}</div>`;
  const mark = !t.done ? LIVE_DOTS
    : t.isError ? '<span class="err-mark">✕</span>' : '<span class="ok-mark">✓</span>';
  return `<div class="tool-line"><span class="nm">${esc(t.name)}</span><span class="ar">${esc(t.summary)}</span>${mark}</div>`;
}

/** 迷你进度指示,列表侧栏与顶层卡片共用。 */
function todoChip(progress) {
  if (!progress || !progress.total) return '';
  const pct = Math.round((progress.done / progress.total) * 100);
  return `<span class="todo-chip" title="任务清单 ${progress.done}/${progress.total}">
    <span class="todo-chip-bar"><span style="width:${pct}%"></span></span>
    ${progress.done}/${progress.total}
  </span>`;
}

/** 已知模型 id 的短名 —— header 空间有限,不认识的原样显示。 */
const MODEL_SHORT_NAME = {
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

/** header 用:模型名 + 上下文占用迷你进度条,两个数据源都缺时不占位。 */
function contextChip(s) {
  const modelLabel = s.model ? (MODEL_SHORT_NAME[s.model] ?? s.model) : '';
  if (!s.contextTokens || !s.contextWindow) {
    return modelLabel ? `<span class="ctx-chip">${esc(modelLabel)}</span>` : '';
  }
  const pct = Math.min(100, Math.round((s.contextTokens / s.contextWindow) * 100));
  const fmt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  return `<span class="ctx-chip" title="上下文占用 ${fmt(s.contextTokens)}/${fmt(s.contextWindow)}">
    ${esc(modelLabel)}
    <span class="todo-chip-bar ctx-bar"><span style="width:${pct}%"></span></span>
    ${pct}%
  </span>`;
}

/**
 * 常驻任务清单面板 —— 不放进 renderTurns 的折叠逻辑里:
 * 进行中的轮次只展示最新一步(见 renderTurns 顶部注释),TodoWrite 之后
 * 一旦有别的工具调用,清单就会从"最新一步"里滚出去,必须独立于该规则常驻。
 */
function renderTodoPanel(d) {
  if (!d.todos?.length) return '';
  const STATUS_MARK = { completed: '✓', in_progress: '●', pending: '○' };
  const rows = d.todos.map((t) => `<div class="todo-item ${t.status}">
    <span class="todo-mark">${STATUS_MARK[t.status] ?? '○'}</span>
    <span class="todo-text">${esc(t.status === 'in_progress' ? t.activeForm : t.content)}</span>
  </div>`).join('');
  const done = d.todos.filter((t) => t.status === 'completed').length;
  return `<div class="card todo-panel">
    <div class="c-top"><span class="c-repo">任务清单</span><span class="c-time">${done}/${d.todos.length} 完成</span></div>
    ${rows}
  </div>`;
}

function summarize(name, input) {
  if (name === 'Bash' && input?.command) return input.command;
  if (name === 'AskUserQuestion') {
    const qs = Array.isArray(input?.questions) ? input.questions : [];
    const first = qs[0]?.question;
    if (first) return qs.length > 1 ? `${first}(共 ${qs.length} 个问题)` : first;
  }
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    if (!todos.length) return '更新任务清单';
    const done = todos.filter((t) => t.status === 'completed').length;
    return `更新任务清单(已完成 ${done}/${todos.length})`;
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

/** 会话的显示态:有待批准项时优先显示 waiting,覆盖 s.state 原始值。 */
function displayState(s) {
  return pendingFor(s.localId).length ? 'waiting' : s.state;
}

/** 同目录下是否还有其他会话 —— 决定要不要挂短标识区分。 */
function hasDup(s) {
  for (const o of state.sessions.values()) {
    if (o.localId !== s.localId && o.name === s.name) return true;
  }
  return false;
}

/**
 * 会话显示名(HTML)。
 *
 * 同一目录可并存多个会话,此时目录名必然相同,需要额外信息区分。
 * 优先用 claude 自己起的标题(说明这个会话在做什么);标题要首轮对话后
 * 才有,在此之前退回 pane —— 它能区分但不解释,只是过渡。
 *
 * `withName` 控制是否带上 s.name:侧栏按 workspace 分组后 proj-h 已经
 * 报过一次目录名,组内每条再重复就是同一个词连续出现两遍,故传 false 省略。
 */
function displayName(s, withName = true) {
  if (!s) return '未知会话';
  const name = esc(s.name);
  const tag = esc(s.paneId ?? s.localId.slice(0, 4));

  if (!withName) {
    // 分组内 proj-h 已报过一次目录名,这里只需要能区分/说明该会话的部分;
    // 标题最优先,没标题时退回短标识而非留空 —— 组内每行都要有可点的内容。
    if (s.title) return `<span class="s-tag ttl">${esc(s.title)}</span>`;
    return `<span class="s-tag">${tag}</span>`;
  }

  if (s.title) return `${name}<span class="s-tag ttl">${esc(s.title)}</span>`;
  if (!hasDup(s)) return name;
  return `${name}<span class="s-tag">${tag}</span>`;
}

/**
 * header 专用:标题只放目录名 + 同名区分标识,不掺 AI title ——
 * title 是自然语言、可能很长,与目录名挤在同一个 <h1> 里会互相截断,
 * 改放第二行(见 renderTopbar),这里只负责"这是哪个会话"。
 *
 * tmux 传输时,pane ID 标签本身就是"切到 tmux 窗口"的入口 —— 标签和 ⇱
 * 合并成一个按钮,而非并排的标识+操作两个元素。非 tmux 传输没有窗口可切,
 * 标签退回纯展示的 span。
 */
function headerName(s) {
  const name = `<span class="h1-name">${esc(s.name)}</span>`;
  if (!hasDup(s) && s.transport !== 'tmux') return name;

  const tag = esc(s.paneId ?? s.localId.slice(0, 4));
  if (!hasDup(s)) {
    // 无重名可省标签文字,但 tmux 会话仍需要落点 —— 用图标单独占位。
    return `${name}<button class="icon-btn" id="focusTmux" title="切到 tmux 窗口">⇱</button>`;
  }
  if (s.transport === 'tmux') {
    return `${name}<button class="s-tag" id="focusTmux" title="切到 tmux 窗口">${tag} ⇱</button>`;
  }
  return `${name}<span class="s-tag">${tag}</span>`;
}

/** 会话的排序权重:需要你 > 进行中 > 静默,用于组内排序与判断组是否需要提醒。 */
function sessionRank(s) {
  if (pendingFor(s.localId).length) return 0;
  if (s.state === 'busy' || s.state === 'starting') return 1;
  return 2;
}

function renderNav() {
  const item = (s) => {
    const n = pendingFor(s.localId).length;
    const st = n ? 'waiting' : s.state;
    return `<div class="nav-item ${state.view === s.localId ? 'on' : ''}" data-id="${s.localId}">
      <span class="pip ${st}"></span>
      <span class="nav-name">${displayName(s, false)}</span>
      ${todoChip(s.todoProgress)}
      ${n ? `<span class="nav-badge">${n}</span>` : ''}
    </div>`;
  };

  // 按 workspace 分组(而非目录名 name)—— 绝对路径全局唯一,不会把同名的
  // 不同目录混进一组。组内保留原「需要你/进行中/静默」的排序权重。
  // exited 的会话不在左栏出现 —— 进程已经不在了,不算 active;仍能在
  // 「全部会话」总览页的「静默」分组里找到,不是彻底消失。
  const byWorkspace = new Map();
  for (const s of state.sessions.values()) {
    if (s.state === 'exited') continue;
    if (!byWorkspace.has(s.workspace)) byWorkspace.set(s.workspace, []);
    byWorkspace.get(s.workspace).push(s);
  }
  const projects = [...byWorkspace.entries()].map(([workspace, sessions]) => {
    sessions.sort((a, b) => sessionRank(a) - sessionRank(b) || b.lastActivity - a.lastActivity);
    return { workspace, name: sessions[0].name, sessions, rank: Math.min(...sessions.map(sessionRank)) };
  });
  projects.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  let html = `<div class="nav-item ${state.view === 'overview' ? 'on' : ''}" data-id="overview">
    <span class="nav-name" style="font-weight:500">全部会话</span>
  </div>`;

  for (const p of projects) {
    const open = !state.collapsedProjects.has(p.workspace);
    const attn = p.rank === 0;
    const waitCount = p.sessions.reduce((n, s) => n + pendingFor(s.localId).length, 0);
    html += `<div class="proj-h ${open ? 'open' : ''} ${attn ? 'attn' : ''}" data-ws="${esc(p.workspace)}">
      <span class="proj-caret">▸</span>
      <span class="proj-name">${esc(p.name)}</span>
      <span class="proj-count">${waitCount ? `${waitCount} 待批准` : p.sessions.length}</span>
    </div>
    <div class="proj-body">${p.sessions.map(item).join('')}</div>`;
  }

  $('nav').innerHTML = html;
  for (const el of $('nav').querySelectorAll('.nav-item')) {
    el.onclick = () => navigate(el.dataset.id);
  }
  for (const el of $('nav').querySelectorAll('.proj-h')) {
    el.onclick = () => {
      const ws = el.dataset.ws;
      if (state.collapsedProjects.has(ws)) state.collapsedProjects.delete(ws);
      else state.collapsedProjects.add(ws);
      saveCollapsed(state.collapsedProjects);
      renderNav();
    };
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
  const st = displayState(s);
  $('topbar').innerHTML = `
    <div class="topbar-main">
      <h1>${headerName(s)}</h1>
      <div class="topbar-stats">
        ${s.costUsd ? `<span class="cost">$${s.costUsd.toFixed(4)}</span>` : ''}
        <span class="chip ${st}">${STATE_LABEL[st]}${s.turns ? ` · 第 ${s.turns} 轮` : ''}</span>
      </div>
    </div>
    <div class="topbar-sub">
      ${s.title
        ? `<span class="path ttl">${esc(s.title)}</span>`
        : `<span class="path">${esc(s.workspace)}</span>`}
      ${contextChip(s)}
    </div>`;
  updateComposer(st);

  // 只影响本机 tmux 最近活跃的 client(见 backend/tmuxTransport.ts #focus),
  // 网页本身无法强制切换终端应用的窗口焦点。
  const focusBtn = $('focusTmux');
  if (focusBtn) focusBtn.onclick = () => api(`/api/sessions/${s.localId}/focus`, { method: 'POST' }).catch(() => {});
}

/**
 * 会话不是 ready 时(忙碌/待批准/启动中/已退出)发送按钮不再禁用 ——
 * 改为把 prompt 存进本地 draftQueue,等 turn_end 收到 ready 后自动弹出
 * 队首真正发送。这样用户不用盯着状态等按钮变亮,打完就能提交。
 */
function updateComposer(st) {
  $('send').textContent = st === 'ready' ? '发送' : '加入队列';
  $('send').title = st === 'ready' ? '' : '会话尚未就绪,已加入队列,轮到时自动发送';
  // 中断信号有时对卡住的 CLI 不生效,state 迟迟回不到 ready 时用户
  // 需要一条能立刻把消息送出去的路径,不必再干等 turn_end。
  $('sendForce').style.display = st === 'ready' ? 'none' : '';
  if (state.tab === 'chat') renderBody();
}

/**
 * 待发草稿接在对话流末尾、跟已发消息同一条时间线渲染(而非浮在输入框
 * 上方的独立面板)—— 用户攒的下一句本来就是对话的一部分,应该跟历史
 * 消息挨在一起看,视觉上用 amber 而非蓝色区分"还没真的发出去"。
 */
function renderDraftQueueInline(localId) {
  const q = state.draftQueue.get(localId);
  if (!q?.length) return '';
  return q.map((text, i) => `<div class="turn me draft" data-i="${i}">
    <div class="who">你 · 待发送 #${i + 1}<button class="draft-del" data-i="${i}" title="从队列移除">✕</button></div>
    <div class="said">${esc(text)}</div>
  </div>`).join('');
}

function wireDraftQueue(root) {
  for (const btn of root.querySelectorAll('.draft-del')) {
    btn.onclick = () => {
      const q = state.draftQueue.get(state.view);
      if (!q) return;
      q.splice(Number(btn.dataset.i), 1);
      if (q.length) state.draftQueue.set(state.view, q); else state.draftQueue.delete(state.view);
      renderBody();
    };
  }
}

/**
 * 会话回到 ready 时把队列里攒的所有 prompt 合并成一条发送,而不是逐条
 * 排队消耗多个轮次 —— 用户攒的是"这一轮该做的几件事",不是想让 CLI
 * 分好几轮串行处理。
 */
function flushDraftQueue(localId) {
  const q = state.draftQueue.get(localId);
  if (!q?.length) return;
  state.draftQueue.delete(localId);
  const text = q.join('\n\n');
  ws.send(JSON.stringify({ type: 'prompt', localId, text }));
  if (state.view === localId && state.tab === 'chat') renderBody();
}

// ── 渲染:页签 ──────────────────────────────────────────────
function renderTabs() {
  if (state.view === 'overview') { $('tabs').style.display = 'none'; return; }
  const d = state.detail;
  $('tabs').style.display = 'flex';
  const defs = [
    ['chat', '对话', 0],
    ['files', '改动文件', d?.files.length ?? 0],
    ['term', '终端输出', d?.commands.length ?? 0],
  ];
  $('tabs').innerHTML = defs.map(([k, label, n]) =>
    `<button class="tab ${state.tab === k ? 'on' : ''}" data-t="${k}">${label}${n ? `<span class="n">${n}</span>` : ''}</button>`
  ).join('');
  for (const t of $('tabs').querySelectorAll('.tab')) {
    t.onclick = () => { state.tab = t.dataset.t; state.pinBottom = true; renderTabs(); renderBody(); };
  }
}

// ── 渲染:批准卡片 ───────────────────────────────────────────
function approvalCard(a, showSession) {
  const s = [...state.sessions.values()].find((x) => x.claudeId === a.sessionId);
  const why = a.risk
    ? `<div class="c-why ${a.risk.level === 'medium' ? 'medium' : ''}">${esc(a.risk.text)}</div>` : '';
  const isQuestion = a.toolName === 'AskUserQuestion';
  const body = isQuestion ? renderQuestions(a.toolInput) : `<div class="c-cmd">${renderCmd(a.summary, a.risk)}</div>`;
  // AskUserQuestion 没有「批准/拒绝」这个执行层面的选择,钩子协议也不支持带着
  // 结构化答案放行工具调用 —— 提交答案的唯一路径是 deny + reason(见 server.ts)。
  const actions = isQuestion
    ? `<button class="btn pri" data-act="answer" disabled>提交回答</button>
       <button class="btn" data-act="skip">跳过</button>`
    : `<button class="btn pri" data-act="allow">批准</button>
       <button class="btn dan" data-act="deny">拒绝</button>`;
  return `<div class="card act" data-tuid="${a.toolUseId}">
    <div class="c-top">
      ${showSession ? `<span class="c-repo">${displayName(s)}</span>` : '<span class="c-repo">等待批准</span>'}
      <span class="c-tool">${esc(a.toolName)}</span>
      <span class="c-time">${waited(a.requestedAt)}</span>
    </div>
    ${body}
    ${why}
    <div class="c-act">
      ${actions}
      ${showSession && s ? `<button class="btn" data-open="${s.localId}">打开会话</button>` : ''}
      <span class="cd" data-deadline="${a.deadlineAt}">${countdown(a.deadlineAt)}</span>
    </div>
  </div>`;
}

function renderQuestions(toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  if (!questions.length) return `<div class="c-cmd">${esc(JSON.stringify(toolInput ?? {}))}</div>`;

  return questions.map((q, qi) => {
    const options = Array.isArray(q.options) ? q.options : [];
    return `<div class="qblock" data-qi="${qi}" data-multi="${q.multiSelect ? '1' : ''}">
      <div class="qhead">
        ${q.header ? `<span class="qtag">${esc(q.header)}</span>` : ''}
        ${q.multiSelect ? '<span class="qtag multi">多选</span>' : ''}
      </div>
      <div class="qtext">${esc(q.question ?? '')}</div>
      <div class="qopts">
        ${options.map((o, oi) => `<div class="qopt" data-oi="${oi}" data-label="${esc(o.label ?? '')}">
          <span class="qmark">${q.multiSelect ? '☐' : '○'}</span>
          <span class="qopt-body"><span class="qlabel">${esc(o.label ?? '')}</span>${o.description ? `<span class="qdesc">${esc(o.description)}</span>` : ''}</span>
        </div>`).join('')}
        <div class="qopt qopt-other" data-oi="other">
          <span class="qmark">${q.multiSelect ? '☐' : '○'}</span>
          <span class="qopt-body">
            <span class="qlabel">其他</span>
            <input class="qother-input" type="text" placeholder="输入你自己的答案" />
          </span>
        </div>
      </div>
    </div>`;
  }).join('');
}

/**
 * 选中态存在 DOM(data-selected)上,提交时直接读取,不额外维护 state。
 *
 * "其他"是自由输入行,选中态跟着输入框内容走而非点击态 —— 有文字才算
 * 选中,清空即取消,不需要用户额外点一下"取消选择"。
 */
function wireQuestionPicker(card) {
  const submit = card.querySelector('[data-act="answer"]');
  const anySelected = () => card.querySelector('.qopt[data-selected]') != null;

  for (const block of card.querySelectorAll('.qblock')) {
    const multi = block.dataset.multi === '1';
    const selectOpt = (opt, on) => {
      if (on) opt.dataset.selected = '1'; else delete opt.dataset.selected;
      opt.querySelector('.qmark').textContent = multi ? (on ? '☑' : '☐') : (on ? '●' : '○');
    };

    for (const opt of block.querySelectorAll('.qopt')) {
      const isOther = opt.classList.contains('qopt-other');
      const input = isOther ? opt.querySelector('.qother-input') : null;

      opt.onclick = () => {
        if (isOther) { input.focus(); return; } // 选中态由输入框内容驱动,见下方 input 监听
        if (!multi) {
          for (const sib of block.querySelectorAll('.qopt')) selectOpt(sib, false);
          const otherInput = block.querySelector('.qother-input');
          if (otherInput) otherInput.value = '';
        }
        selectOpt(opt, multi ? opt.dataset.selected == null : true);
        if (submit) submit.disabled = !anySelected();
      };

      if (input) {
        input.onclick = (e) => e.stopPropagation();
        input.oninput = () => {
          const has = input.value.trim().length > 0;
          if (has && !multi) {
            for (const sib of block.querySelectorAll('.qopt')) {
              if (sib !== opt) selectOpt(sib, false);
            }
          }
          selectOpt(opt, has);
          if (submit) submit.disabled = !anySelected();
        };
      }
    }
  }
}

/** 把各 qblock 里选中的项拼成模型能读的回答文本,"其他"取输入框文字而非 label。 */
function collectAnswer(card) {
  const parts = [];
  for (const block of card.querySelectorAll('.qblock')) {
    const question = block.querySelector('.qtext')?.textContent ?? '';
    const labels = [...block.querySelectorAll('.qopt[data-selected]')].map((o) =>
      o.classList.contains('qopt-other') ? o.querySelector('.qother-input').value.trim() : o.dataset.label);
    if (labels.length) parts.push(`${question}: ${labels.join(', ')}`);
  }
  return parts.join('\n');
}

function wireApprovals(root) {
  for (const card of root.querySelectorAll('[data-tuid]')) {
    const tuid = card.dataset.tuid;
    wireQuestionPicker(card);

    for (const b of card.querySelectorAll('[data-act]')) {
      b.onclick = () => {
        const act = b.dataset.act;
        const decision = act === 'allow' ? 'allow' : 'deny';
        const answer = act === 'answer' ? collectAnswer(card) : undefined;
        for (const x of card.querySelectorAll('button')) x.disabled = true;
        ws.send(JSON.stringify({ type: 'decision', toolUseId: tuid, decision, answer }));
      };
    }
    const open = card.querySelector('[data-open]');
    if (open) open.onclick = () => navigate(open.dataset.open);
  }
}

function wireStallNotice(root) {
  for (const btn of root.querySelectorAll('[data-interrupt]')) {
    btn.onclick = () => {
      btn.disabled = true;
      ws.send(JSON.stringify({ type: 'interrupt', localId: btn.dataset.interrupt }));
    };
  }
}

// ── 渲染:主体 ──────────────────────────────────────────────
function renderOverview() {
  const pend = [...state.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt);
  // 组内按最新活动时间倒序 —— 同一优先级分组里,用户最可能想看的是刚动过的会话。
  const all = [...state.sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  const busy = all.filter((s) => !pendingFor(s.localId).length && (s.state === 'busy' || s.state === 'starting'));
  const quiet = all.filter((s) => !pendingFor(s.localId).length && s.state !== 'busy' && s.state !== 'starting');

  let html = '';

  if (pend.length) {
    html += `<div class="sect">需要决策 — 按等待时长排序</div>`;
    html += pend.map((a) => approvalCard(a, true)).join('');
  }

  if (busy.length) {
    html += `<div class="sect">进行中</div>`;
    html += busy.map((s) => `${isStalled(s) ? stallNotice(s) : ''}<div class="card">
      <div class="c-top">
        <span class="c-repo">${displayName(s)}</span>
        <span class="c-tool">${STATE_LABEL[s.state]}${s.turns ? ` · 第 ${s.turns} 轮` : ''}</span>
        <span class="c-time">${ago(s.lastActivity)}</span>
      </div>
      <div class="c-cmd">${esc(s.lastAction)}</div>
      <div class="c-act">
        <span style="font-size:12px;color:var(--ink-3)">${s.fileCount ? `${s.fileCount} 个文件已改动` : ''}</span>
        ${todoChip(s.todoProgress)}
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
  wireStallNotice($('body'));
  for (const b of $('body').querySelectorAll('[data-open]')) {
    b.onclick = () => navigate(b.dataset.open);
  }
}

function renderDetail() {
  const d = state.detail;
  if (!d) { $('body').innerHTML = `<div class="empty">加载中…</div>`; return; }

  const pend = pendingFor(d.localId).sort((a, b) => a.requestedAt - b.requestedAt);
  // AskUserQuestion 这类待批准项是当前对话的一部分,留在对话流末尾更符合语境;
  // 其余页签没有"对话流"概念,沿用置顶,卡住提示同理。
  const pendCards = pend.map((a) => approvalCard(a, false)).join('');
  const stall = isStalled(d) ? stallNotice(d) : '';
  // 常驻所有页签顶部,不随对话页签的折叠规则隐藏 —— 见 renderTodoPanel 注释。
  let html = renderTodoPanel(d) + (state.tab === 'chat' ? '' : stall + pendCards);

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
    const draftHtml = renderDraftQueueInline(d.localId);
    if (d.timeline.length) {
      html += renderTurns(d);
    } else if (!pend.length && !draftHtml) {
      html += `<div class="empty">还没有对话。在下方输入框开始。</div>`;
    }
    html += stall + pendCards + draftHtml;
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

  // 首次切进这个会话(或切换页签)时旧 DOM 的滚动位置跟这次要不要贴底
  // 无关,强制贴底一次;之后的增量重绘才用"渲染前是否已在底部"这个
  // 启发式,让用户主动往上翻看历史时不被拉回底部。
  const forceBottom = state.pinBottom;
  state.pinBottom = false;
  const wasBottom = forceBottom || $('body').scrollHeight - $('body').scrollTop - $('body').clientHeight < 100;
  $('body').innerHTML = html;
  wireApprovals($('body'));
  wireStallNotice($('body'));
  if (state.tab === 'chat') { wireProcs($('body'), d); wireDraftQueue($('body')); }
  if (state.tab === 'chat' && wasBottom) $('body').scrollTop = $('body').scrollHeight;
}

function wireProcs(root, d) {
  // .proc-sum.live(进行中轮次)没有 data-turn、也没有对应的 .proc 可展开,
  // 排除在外,否则点击会把 NaN 塞进 expandedTurns。
  for (const el of root.querySelectorAll('.proc-sum:not(.live)')) {
    el.onclick = () => {
      const i = Number(el.dataset.turn);
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
  state.pinBottom = true;
  if (id === 'overview') {
    state.detail = null;
    $('foot').style.display = 'none';
  } else {
    $('foot').style.display = 'block';
    try {
      state.detail = await api(`/api/sessions/${id}`);
      if (state.detail) {
        state.detail.expandedTurns = new Set();
        state.detail.settledTurns = new Set();
        // 后端已把 TodoWrite/Task* 两个来源合并进 todos 数组;Task* 来源的
        // 条目带 id(见 sessionManager.ts TodoItem 注释),据此重建索引,
        // 否则后续 WS 增量的 TaskUpdate 事件找不到条目可改。
        state.detail.tasks = new Map(
          state.detail.todos.filter((t) => t.id).map((t) => [t.id, t]),
        );
        state.detail.pendingTaskCreates = new Map();
      }
    } catch {
      state.detail = null;
    }
  }
  renderAll();
}

// ── 新建会话 ────────────────────────────────────────────────
$('add').onclick = () => {
  // 用过的 workspace 去重,按最近活跃排前 —— 常规操作不用每次手打全路径。
  const seen = new Map();
  for (const s of state.sessions.values()) {
    const prev = seen.get(s.workspace);
    if (!prev || s.lastActivity > prev) seen.set(s.workspace, s.lastActivity);
  }
  const known = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([ws]) => ws);

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">
    <h3>新建会话</h3>
    <p>选择或填写工作目录的绝对路径。该目录下的 .claude/settings.local.json 会被合并写入钩子配置。</p>
    ${known.length ? `<select id="wsSel">
      ${known.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('')}
      <option value="__other__">其他路径…</option>
    </select>` : ''}
    <input id="wsp" placeholder="/Users/you/projects/my-repo" spellcheck="false"
      style="${known.length ? 'display:none' : ''}">
    <label for="wModel">模型</label>
    <select id="wModel">
      <option value="">默认(跟随 CLI / settings.json)</option>
      <option value="claude-opus-5">Opus 5</option>
      <option value="claude-sonnet-5">Sonnet 5</option>
      <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
    </select>
    <div class="err" id="mErr" style="display:none"></div>
    <div class="modal-act">
      <button class="btn" id="mCancel">取消</button>
      <button class="btn pri" id="mOk">创建</button>
    </div>
  </div>`;
  document.body.append(bg);
  const sel = bg.querySelector('#wsSel');
  const inp = bg.querySelector('#wsp');
  (sel ?? inp).focus();

  if (sel) {
    sel.onchange = () => {
      const other = sel.value === '__other__';
      inp.style.display = other ? '' : 'none';
      if (other) inp.focus(); else inp.value = '';
    };
  }

  const close = () => bg.remove();
  bg.querySelector('#mCancel').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };

  const submit = async () => {
    const workspace = (sel && sel.value !== '__other__' ? sel.value : inp.value).trim();
    if (!workspace) return;
    const model = bg.querySelector('#wModel').value;
    const err = bg.querySelector('#mErr');
    const ok = bg.querySelector('#mOk');
    ok.disabled = true;
    try {
      const { localId } = await api('/api/sessions', {
        method: 'POST', body: JSON.stringify({ workspace, model: model || undefined }),
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
  const onEnter = (e) => { if (e.key === 'Enter' && !e.isComposing) submit(); };
  inp.onkeydown = onEnter;
  if (sel) sel.onkeydown = onEnter;
};

// ── 发送 ────────────────────────────────────────────────────
function send() {
  const text = $('input').value.trim();
  if (!text || state.view === 'overview' || !state.connected) return;
  const s = state.sessions.get(state.view);
  const ready = s && !pendingFor(s.localId).length && s.state === 'ready';
  if (ready) {
    ws.send(JSON.stringify({ type: 'prompt', localId: state.view, text }));
  } else {
    // 会话忙碌/待批准/启动中时先攒进本地队列,turn_end 回到 ready 后
    // flushDraftQueue 自动弹出队首发送 —— 不用用户盯着状态手动重试。
    const q = state.draftQueue.get(state.view) ?? [];
    q.push(text);
    state.draftQueue.set(state.view, q);
    state.pinBottom = true;
    if (state.tab === 'chat') renderBody();
  }
  $('input').value = '';
}
$('send').onclick = send;

/**
 * 中断当前轮次并把输入框内容(连同已攒的草稿队列)立即发出去 ——
 * interrupt 通常会让后端把 state 收回 ready(见 sessionManager.ts
 * #interrupt),但网页不必等那趟往返再让用户重新点一次发送。
 */
$('sendForce').onclick = () => {
  const text = $('input').value.trim();
  if (state.view === 'overview' || !state.connected) return;
  const localId = state.view;
  const q = state.draftQueue.get(localId) ?? [];
  if (text) q.push(text);
  if (!q.length) return;
  state.draftQueue.delete(localId);
  ws.send(JSON.stringify({ type: 'interrupt', localId }));
  ws.send(JSON.stringify({ type: 'prompt', localId, text: q.join('\n\n') }));
  $('input').value = '';
  state.pinBottom = true;
  if (state.tab === 'chat') renderBody();
};

$('input').onkeydown = (e) => {
  // isComposing 排除中文输入法候选词确认的回车 —— 否则拼音上屏会被
  // 误判成发送,把还没选完的内容连着输入法自己的回车一起提交出去。
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
};

/**
 * 拖文件进输入框时接管,不让浏览器默认导航打开文件 —— 但浏览器不会把
 * 本地绝对路径交给网页(File 对象只有文件名,没有目录),所以插入的是
 * 「待补全占位符 + 文件名」,占位符预选中方便用户直接输入替换成真实路径。
 */
const PATH_PLACEHOLDER = '<补全路径>';
// 拖拽落在输入框以外的空白处时,不挡住会让浏览器整页跳去打开文件 ——
// textarea 自己的 drop 监听只处理落在它内部的情况,这里兜底页面其余区域。
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { if (e.target !== $('input')) e.preventDefault(); });
$('input').addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
$('input').addEventListener('drop', (e) => {
  e.preventDefault();
  const names = [...(e.dataTransfer.files ?? [])].map((f) => f.name);
  if (!names.length) return;
  const el = $('input');
  const inserted = names.map((n) => `${PATH_PLACEHOLDER}/${n}`).join('\n');
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + inserted + el.value.slice(end);
  el.focus();
  // 只选中第一个占位符 —— 多文件时其余占位符留给用户依次 Tab/点击手动改。
  const firstStart = start;
  const firstEnd = start + PATH_PLACEHOLDER.length;
  el.setSelectionRange(firstStart, firstEnd);
});

// ── 倒计时:每秒刷新,不重绘整页 ─────────────────────────────
setInterval(() => {
  for (const el of document.querySelectorAll('[data-deadline]')) {
    el.textContent = countdown(Number(el.dataset.deadline));
  }
}, 1000);

// 卡住提示的触发条件(超过 STALL_THRESHOLD_MS)只靠时间推移达成,没有事件
// 会触发它 —— 需要独立轮询,不能像倒计时那样只改文本,得整块增删 DOM。
setInterval(() => {
  if (state.view === 'overview' && [...state.sessions.values()].some(isStalled)) renderOverview();
  else if (state.detail && isStalled(state.detail)) renderBody();
}, 5000);

// ── 启动 ────────────────────────────────────────────────────
if (!token) {
  document.body.innerHTML = `<div class="empty" style="margin:auto">缺少访问令牌 —— 请使用终端打印的完整链接打开。</div>`;
} else {
  connect();
  renderAll();
}
