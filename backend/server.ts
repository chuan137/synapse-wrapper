/**
 * Web 后端 —— 串起 SessionManager、权限引擎与浏览器。
 *
 * 安全取向(本机开发用):
 *  - 只监听 127.0.0.1。但绑定本机 ≠ 身份认证:任意网页都能向 localhost
 *    发请求(DNS rebinding / CSRF),故浏览器侧接口校验 Origin,WS 校验 token。
 *  - 钩子接口不校验 Origin(子进程请求不带该头),仅接受本机来源。
 */
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionManager, replayTranscriptTimeline, mergedTodos, type ManagerEvent } from './sessionManager.ts';
import { PermissionEngine, HOOK_TIMEOUT_S, type PendingApproval } from './permissions.ts';
import { writeState, clearState, DEFAULT_PORT, MAX_PORT_TRIES } from './daemon.ts';

const HOST = '127.0.0.1';
/** 显式通过 PORT 环境变量指定过端口,还是用的默认值 —— 决定要不要允许递增重试。 */
const PORT_EXPLICIT = process.env.PORT != null;
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 保护浏览器侧接口的会话令牌,每次启动重新生成。 */
const AUTH_TOKEN = randomUUID();

/**
 * 实际监听端口 —— 默认端口占用时会递增(见 listenWithRetry)。
 * 显式指定端口时不允许递增(见 §「端口」),此时恒等于 PORT ——
 * 测试/生产各自传入不同端口时,才能保证「请求端口」与「实际监听端口」
 * 精确相等,持久化目录名(daemon.ts stateDir)才可预测。
 * Origin 校验与钩子 URL 都必须用它,用 PORT 会在端口递增后全线失配。
 */
let activePort = PORT;

const manager = new SessionManager(HOST, () => activePort, PORT);
const permissions = new PermissionEngine();
const stopLivenessWatch = manager.startLivenessWatch();

const app = express();
app.use(express.json({ limit: '10mb' }));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

function broadcast(payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// ── 钩子入口 ────────────────────────────────────────────────
// 请求在此挂起,直到网页决策或 fail-closed 兜底触发。
app.post('/api/claude-event', permissions.handleHookRequest);

// ── 浏览器侧接口 ─────────────────────────────────────────────
function checkOrigin(req: express.Request, res: express.Response): boolean {
  const origin = req.get('origin');
  if (origin && !origin.startsWith(`http://${HOST}:${activePort}`)) {
    res.status(403).json({ error: 'origin 不被允许' });
    return false;
  }
  if (req.get('x-auth-token') !== AUTH_TOKEN) {
    res.status(401).json({ error: 'token 无效' });
    return false;
  }
  return true;
}

app.get('/api/token', (req, res) => {
  const origin = req.get('origin');
  if (origin && !origin.startsWith(`http://${HOST}:${activePort}`)) {
    res.status(403).json({ error: 'origin 不被允许' });
    return;
  }
  res.json({ token: AUTH_TOKEN });
});

/** 会话列表 + 每个会话的待批准数。 */
app.get('/api/sessions', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const sessions = manager.list().map((s) => ({
    ...s,
    pendingCount: s.claudeId ? permissions.countFor(s.claudeId) : 0,
  }));
  res.json({ sessions, pending: permissions.listPending() });
});

/** 新建会话。 */
app.post('/api/sessions', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const workspace = resolve(String(req.body?.workspace ?? ''));

  if (!workspace || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
    res.status(400).json({ error: '工作目录不存在' });
    return;
  }

  const transport = req.body?.transport === 'tmux' ? 'tmux' : 'stream-json';

  try {
    const s = await manager.create(workspace, {
      name: req.body?.name,
      transport,
      tmuxName: typeof req.body?.tmuxName === 'string' ? req.body.tmuxName : undefined,
      paneId: typeof req.body?.paneId === 'string' ? req.body.paneId : undefined,
      sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined,
    });
    res.json({ localId: s.localId, tmuxName: s.tmuxName, settingsPath: s.settingsPath });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** 单会话详情:改动文件、命令记录、时间线。 */
app.get('/api/sessions/:id', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const s = manager.get(String(req.params.id));
  if (!s) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  let pendingToolSince = null;
  for (const t of s.openTools.values()) {
    if (pendingToolSince === null || t.at < pendingToolSince) pendingToolSince = t.at;
  }

  // 重启后加载的历史记录没有内存态 timeline —— 对话内容本就只写在转写文件里
  // (sessions.json 只存元数据,见 backend/store.ts),按需现读。todos 同理:
  // exited 会话的 s.todos/s.tasks 是初始化的空值,要靠重放才能补全(见 §2.12)。
  let files = [...s.files.values()];
  let commands = s.commands;
  let timeline = s.timeline;
  let todos = mergedTodos(s);
  if (s.fromDisk && timeline.length === 0 && s.transcriptPath) {
    const history = await replayTranscriptTimeline(s.transcriptPath);
    files = history.files;
    commands = history.commands;
    timeline = history.timeline;
    todos = history.todos;
  }

  res.json({
    localId: s.localId,
    claudeId: s.claudeId,
    name: s.name,
    title: s.title,
    workspace: s.workspace,
    state: s.state,
    transport: s.transportKind,
    tmuxName: s.tmuxName,
    paneId: s.paneId,
    turns: s.turns,
    costUsd: s.costUsd,
    files,
    commands,
    timeline,
    todos,
    pending: s.claudeId ? permissions.listPending(s.claudeId) : [],
    pendingToolSince,
  });
});

app.delete('/api/sessions/:id', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const s = manager.get(String(req.params.id));
  if (s?.claudeId) permissions.drain(s.claudeId);
  await manager.close(String(req.params.id));
  res.json({ ok: true });
});

app.use(express.static(resolve(ROOT, 'public')));

// ── WebSocket ───────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${activePort}`);
  if (url.searchParams.get('token') !== AUTH_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);

  // 补齐状态:新连上的客户端要看到全部会话与仍在等待的批准项
  ws.send(JSON.stringify({
    type: 'hello',
    sessions: manager.list().map((s) => ({
      ...s,
      pendingCount: s.claudeId ? permissions.countFor(s.claudeId) : 0,
    })),
    pending: permissions.listPending(),
  }));

  ws.on('message', (raw) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'prompt':
        if (typeof msg.localId === 'string' && typeof msg.text === 'string' && msg.text.trim()) {
          manager.send(msg.localId, msg.text);
          broadcast({ type: 'user_message', localId: msg.localId, text: msg.text });
        }
        break;

      case 'decision':
        if (typeof msg.toolUseId === 'string' && (msg.decision === 'allow' || msg.decision === 'deny')) {
          // AskUserQuestion 没有「允许执行」的意义 —— 钩子协议不支持带着答案放行
          // 工具调用,只能 deny 并把用户选择塞进 reason,由模型读取后继续对话。
          const reason = typeof msg.answer === 'string' && msg.answer.trim() ? msg.answer.trim() : undefined;
          permissions.decide(msg.toolUseId, msg.decision, reason);
        }
        break;

      case 'interrupt':
        manager.get(String(msg.localId))?.transport.interrupt();
        break;
    }
  });

  ws.on('close', () => clients.delete(ws));
});

// ── 事件转发 ────────────────────────────────────────────────
manager.onEvent((e: ManagerEvent) => {
  // 会话退出后其挂起批准再也不会有人放行,留着会一直占着「需要你」分组
  if (e.type === 'session_updated' && e.session.state === 'exited' && e.session.claudeId) {
    permissions.drain(e.session.claudeId);
  }
  broadcast(e);
});

permissions.onApprovalRequested((a: PendingApproval) => {
  // 有待批准项时把会话标为 waiting,顶层列表据此排序与显示角标
  const s = manager.byClaudeId(a.sessionId);
  if (s) manager.setState(s.localId, 'waiting');
  broadcast({ type: 'approval_request', approval: a, localId: s?.localId ?? null });
});

permissions.onSessionEnd((claudeId, reason) => {
  manager.endByClaudeId(claudeId, reason);
});

permissions.onApprovalResolved((toolUseId, decision, reason, sessionId) => {
  // 决策落定后若该会话已无其它待批准项,状态从 waiting 收回 —— 否则
  // s.state 永远卡在 setState(waiting) 那次赋值,前端全靠 pendingFor()
  // 派生覆盖掩盖,凡是直接读 s.state 原始值的地方都会显示假的"等待批准"。
  const s = manager.byClaudeId(sessionId);
  if (s && s.state === 'waiting' && permissions.countFor(sessionId) === 0) {
    manager.setState(s.localId, s.pendingTurns > 0 ? 'busy' : 'ready');
  }
  broadcast({ type: 'approval_resolved', toolUseId, decision, reason });
});

// ── 启动 ────────────────────────────────────────────────────
/**
 * 端口递增重试必须在这里做,不能交给 CLI:守护进程是 detached 起的,
 * 父进程读不到 stdout,只能靠本进程把最终端口写进状态文件。
 *
 * 仅默认端口走递增:显式指定端口(测试环境常用来避免撞生产)时,
 * 「请求端口」必须精确等于「实际监听端口」,否则持久化目录(按请求端口
 * 分目录,见 daemon.ts)会对不上实际服务监听的地址,daemon.ts 的健康检查
 * 也会因为读到的 port 字段与真实监听端口不一致而失真。故占用即报错退出,
 * 不静默换port。
 */
function listenWithRetry(port: number, triesLeft: number): void {
  const onError = (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE' || triesLeft <= 0) {
      const hint = PORT_EXPLICIT
        ? `端口 ${PORT} 已被占用 —— 显式指定端口时不会自动改用其他端口,换一个再试。`
        : `监听 ${port} 失败:`;
      console.error(hint, err.code === 'EADDRINUSE' ? '' : err.message);
      process.exit(1);
    }
    server.removeListener('error', onError);
    listenWithRetry(port + 1, triesLeft - 1);
  };

  server.once('error', onError);
  server.listen(port, HOST, async () => {
    server.removeListener('error', onError);
    activePort = port;

    writeState(PORT, { pid: process.pid, port, token: AUTH_TOKEN });

    console.log(`\n  Synapse Wrapper`);
    console.log(`  钩子超时: ${HOOK_TIMEOUT_S}s(后端 fail-closed 兜底更短)`);
    console.log(`\n  打开: http://${HOST}:${port}/?token=${AUTH_TOKEN}\n`);

    // 命令行给了工作区就自动开一个会话,否则从网页新建
    const initial = process.env.WORKSPACE;
    if (initial) {
      const ws = resolve(initial);
      if (existsSync(ws)) {
        await manager.create(ws);
        console.log(`  已启动会话: ${ws}\n`);
      }
    }
  });
}

listenWithRetry(PORT, PORT_EXPLICIT ? 0 : MAX_PORT_TRIES);

async function shutdown(): Promise<void> {
  console.log('\n正在关闭...');
  stopLivenessWatch();
  clearState(PORT);
  permissions.drain();
  // stopAll 而非 closeAll —— 会话记录要留着,下次启动时左栏仍能看到(持久化的意义)。
  await manager.stopAll();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
