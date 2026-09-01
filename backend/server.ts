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
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionManager, replayTranscriptTimeline, mergedTodos, type ManagerEvent, type SessionSummary } from './sessionManager.ts';
import { PermissionEngine, HOOK_TIMEOUT_S, type PendingApproval } from './permissions.ts';
import { TaskStore, tasksPath, type AgentBinding, type Project, type Task } from './taskStore.ts';
import {
  writeState, clearState, readOrCreateToken, writeHookSettings, hookSettingsPath,
  DEFAULT_PORT, MAX_PORT_TRIES,
} from './daemon.ts';

const HOST = '127.0.0.1';
/** 显式通过 PORT 环境变量指定过端口,还是用的默认值 —— 决定要不要允许递增重试。 */
const PORT_EXPLICIT = process.env.PORT != null;
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 保护浏览器侧接口的会话令牌。同端口有残留 token(daemon.ts clearState 不删它,
 * 只清 pid/port)就复用,让 `synapse daemon restart` 之后旧链接继续有效 ——
 * 用户的浏览器书签、终端历史里存的都是这个 URL,链接跟着重启变会很烦人。
 * 全新安装或首次启动(没有残留文件)才随机生成。
 */
const AUTH_TOKEN = readOrCreateToken(PORT);

/**
 * 实际监听端口 —— 默认端口占用时会递增(见 listenWithRetry)。
 * 显式指定端口时不允许递增(见 §「端口」),此时恒等于 PORT ——
 * 测试/生产各自传入不同端口时,才能保证「请求端口」与「实际监听端口」
 * 精确相等,持久化目录名(daemon.ts stateDir)才可预测。
 * Origin 校验与钩子 URL 都必须用它,用 PORT 会在端口递增后全线失配。
 */
let activePort = PORT;

// hook 配置文件路径可提前推导(仅依赖请求端口),文件本身在 listenWithRetry
// 里等实际监听端口确定后才写。会话启动都在监听成功之后,读到的一定是新版本。
const manager = new SessionManager(PORT, hookSettingsPath(PORT));
const permissions = new PermissionEngine();
// 任务存储落 ~/.synapse/tasks.json —— 不按端口分区(见 spec §1.4),
// 与 sessions.json 不同:Project List 要跨 workspace/daemon 聚合。
const tasks = new TaskStore(tasksPath());
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
      model: typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined,
      appendSystemPrompt:
        typeof req.body?.appendSystemPrompt === 'string' && req.body.appendSystemPrompt.trim()
          ? req.body.appendSystemPrompt
          : undefined,
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

/** 把会话对应的 tmux pane 切到前台;stream-json 会话没有终端窗口可切。 */
app.post('/api/sessions/:id/focus', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const s = manager.get(String(req.params.id));
  if (!s) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  if (!s.transport.focus) {
    res.status(400).json({ error: '该会话没有可切换的终端窗口' });
    return;
  }
  await s.transport.focus();
  res.json({ ok: true });
});

/** 停掉会话进程但保留记录(标 exited)—— 任务子 agent 停止用这个,历史不丢。 */
app.post('/api/sessions/:id/stop', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const s = manager.get(String(req.params.id));
  if (!s) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  if (s.claudeId) permissions.drain(s.claudeId);
  await manager.stop(String(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const s = manager.get(String(req.params.id));
  if (s?.claudeId) permissions.drain(s.claudeId);
  await manager.close(String(req.params.id));
  res.json({ ok: true });
});

// ── 任务视图接口 ────────────────────────────────────────────
// Task 层只经 localId / claudeId 单向引用会话,不往 Session 加字段(spec §1.1)。
// 聚合读到的 session 一律用现有 summary 形状,不新造(方案 §285)。

const RUNNING_STATES = new Set(['busy', 'waiting', 'starting']);

/** localId → 现有会话 summary(含 pendingCount),给任务详情复用。 */
function sessionView(localId: string): (SessionSummary & { pendingCount: number }) | null {
  const s = manager.list().find((x) => x.localId === localId);
  if (!s) return null;
  return { ...s, pendingCount: s.claudeId ? permissions.countFor(s.claudeId) : 0 };
}

/** 一个 binding 对应会话的待批准数;会话不在了记 0。 */
function pendingForBinding(b: AgentBinding): number {
  const s = manager.list().find((x) => x.localId === b.localId);
  return s?.claudeId ? permissions.countFor(s.claudeId) : 0;
}

/**
 * 属于该 project 的工作区、仍活着、且没有 active binding 的会话。
 * `synapse` 起的 tmux 会话进了 SessionManager 但不会自动成为任务 —— 任务视图
 * 靠这个列表让它们可见,用户按需「转为任务」(见 spec §1.1)。
 */
function unboundSessionsFor(project: Project): (SessionSummary & { pendingCount: number })[] {
  const roots = new Set(project.workspaceRoots);
  return manager
    .list()
    .filter(
      (s) =>
        roots.has(s.workspace) &&
        s.state !== 'exited' &&
        !tasks.bindingForSession(s.localId),
    )
    .map((s) => ({ ...s, pendingCount: s.claudeId ? permissions.countFor(s.claudeId) : 0 }));
}

/** GET /api/tasks/:id 的详情形状 —— 多处复用(POST/PATCH 也返回它,见 step 4)。 */
function taskDetail(taskId: string) {
  const task = tasks.getTask(taskId);
  if (!task) return null;
  const project = tasks.getProject(task.projectId) ?? null;
  const agents = tasks.listBindings(taskId).map((binding) => ({
    binding,
    session: sessionView(binding.localId),
    pending: (() => {
      const s = manager.list().find((x) => x.localId === binding.localId);
      return s?.claudeId ? permissions.listPending(s.claudeId) : [];
    })(),
  }));
  return { task, project, agents, events: tasks.listEvents(taskId) };
}

app.get('/api/projects', (req, res) => {
  if (!checkOrigin(req, res)) return;
  // 惰性补默认 project:现有会话的 workspace 尚未归属任何 project 就建一个。
  for (const s of manager.list()) {
    tasks.ensureProjectForWorkspace(s.workspace);
  }
  const projects = tasks.listProjects().map((p) => {
    const projTasks = tasks.listTasks(p.id);
    let runningAgents = 0;
    let pendingApprovals = 0;
    for (const t of projTasks) {
      for (const b of tasks.listBindings(t.id)) {
        if (b.endedAt !== null) continue;
        const s = manager.list().find((x) => x.localId === b.localId);
        if (s && RUNNING_STATES.has(s.state)) runningAgents++;
        pendingApprovals += pendingForBinding(b);
      }
    }
    return {
      id: p.id,
      name: p.name,
      workspaceRoots: p.workspaceRoots,
      goal: p.goal,
      taskCount: projTasks.length,
      runningAgents,
      pendingApprovals,
      updatedAt: p.updatedAt,
    };
  });
  res.json({ projects });
});

app.get('/api/projects/:id/tasks', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const project = tasks.getProject(String(req.params.id));
  if (!project) {
    res.status(404).json({ error: 'project 不存在' });
    return;
  }
  const list = tasks.listTasks(project.id).map((t) => {
    const bindings = tasks.listBindings(t.id).filter((b) => b.endedAt === null);
    const main = bindings.find((b) => b.role === 'main');
    const events = tasks.listEvents(t.id);
    return {
      ...t,
      agentCount: bindings.length,
      mainAgent: main ? sessionView(main.localId) : null,
      pendingApprovals: bindings.reduce((n, b) => n + pendingForBinding(b), 0),
      lastEvent: events.length ? events[events.length - 1] : null,
    };
  });
  res.json({ project, tasks: list, unboundSessions: unboundSessionsFor(project) });
});

app.get('/api/tasks/:id', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const detail = taskDetail(String(req.params.id));
  if (!detail) {
    res.status(404).json({ error: 'task 不存在' });
    return;
  }
  res.json(detail);
});

app.post('/api/tasks', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const projectId = String(req.body?.projectId ?? '');
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) {
    res.status(400).json({ error: 'title 必填' });
    return;
  }
  if (!tasks.getProject(projectId)) {
    res.status(404).json({ error: 'project 不存在' });
    return;
  }
  const task = tasks.createTask({
    projectId,
    title,
    goal: typeof req.body?.goal === 'string' ? req.body.goal : undefined,
    acceptance: typeof req.body?.acceptance === 'string' ? req.body.acceptance : undefined,
    priority: req.body?.priority === 'low' || req.body?.priority === 'high' ? req.body.priority : undefined,
  });
  tasks.appendEvent({ taskId: task.id, kind: 'task_created', message: `创建任务「${task.title}」` });
  res.json(taskDetail(task.id));
});

/**
 * 把一个未绑定的会话「转为任务」—— 建任务 + 立即把该会话作为 main agent 挂上去。
 * 供任务视图的「未绑定会话」区一键操作(见 spec §1.1)。建任务和绑定分两步各自
 * 落盘,但对用户是一个动作,合并成一个端点少一次往返、也少一个「建了任务却没绑上」
 * 的中间态。
 */
app.post('/api/tasks/from-session', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const localId = String(req.body?.localId ?? '');
  const s = manager.get(localId);
  if (!s) {
    res.status(400).json({ error: '会话不存在' });
    return;
  }
  const project = tasks.ensureProjectForWorkspace(s.workspace);
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : s.title || s.name;
  const task = tasks.createTask({ projectId: project.id, title });
  tasks.appendEvent({ taskId: task.id, kind: 'task_created', message: `由会话 ${s.name} 转为任务` });
  try {
    const binding = tasks.attachAgent({
      taskId: task.id,
      localId,
      claudeId: s.claudeId,
      role: 'main',
      transportKind: s.transportKind,
    });
    tasks.appendEvent({
      taskId: task.id,
      agentBindingId: binding.id,
      kind: 'agent_attached',
      message: `绑定会话 ${s.name} 为 main agent`,
    });
  } catch (err) {
    res.status(409).json({ error: String(err instanceof Error ? err.message : err) });
    return;
  }
  res.json(taskDetail(task.id));
});

const TASK_STATUSES = new Set(['todo', 'running', 'waiting', 'blocked', 'done', 'archived']);
const TASK_PRIORITIES = new Set(['low', 'normal', 'high']);

app.patch('/api/tasks/:id', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const before = tasks.getTask(String(req.params.id));
  if (!before) {
    res.status(404).json({ error: 'task 不存在' });
    return;
  }
  const patch: Parameters<typeof tasks.updateTask>[1] = {};
  const b = req.body ?? {};
  if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim();
  if (typeof b.goal === 'string') patch.goal = b.goal;
  if (typeof b.acceptance === 'string') patch.acceptance = b.acceptance;
  if (typeof b.status === 'string' && TASK_STATUSES.has(b.status)) patch.status = b.status;
  if (typeof b.priority === 'string' && TASK_PRIORITIES.has(b.priority)) patch.priority = b.priority;
  if (b.archivedAt === null || typeof b.archivedAt === 'number') patch.archivedAt = b.archivedAt;

  const statusChanged = patch.status !== undefined && patch.status !== before.status;
  const task = tasks.updateTask(before.id, patch);
  if (statusChanged) {
    tasks.appendEvent({
      taskId: task.id,
      kind: 'task_status_changed',
      message: `状态 ${before.status} → ${task.status}`,
    });
  } else {
    tasks.appendEvent({ taskId: task.id, kind: 'task_updated', message: '更新任务' });
  }
  res.json(taskDetail(task.id));
});

app.post('/api/tasks/:id/agents', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const task = tasks.getTask(String(req.params.id));
  if (!task) {
    res.status(404).json({ error: 'task 不存在' });
    return;
  }
  const localId = String(req.body?.localId ?? '');
  const role = req.body?.role === 'main' ? 'main' : 'sub';
  const s = manager.get(localId);
  if (!s) {
    res.status(400).json({ error: '会话不存在' });
    return;
  }
  try {
    // transportKind 由后端从会话读,不信客户端(spec §1.1 / 方案 §324)。
    const binding = tasks.attachAgent({
      taskId: task.id,
      localId,
      claudeId: s.claudeId,
      role,
      transportKind: s.transportKind,
    });
    tasks.appendEvent({
      taskId: task.id,
      agentBindingId: binding.id,
      kind: 'agent_attached',
      message: `绑定会话 ${s.name} 为 ${role} agent`,
    });
    res.json(taskDetail(task.id));
  } catch (err) {
    // TaskStore 在「会话已绑其它 active task」时抛错 —— 转 409(方案 §339)。
    res.status(409).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

/**
 * 从任务启动子 agent(Phase 1 · 7a:不带 worktree)。
 * body: { role, transport?, workspace, prompt?, model?, appendSystemPrompt? }
 *
 * 复用 manager.create() —— 与 POST /api/sessions 同一条创建路径。worktree 隔离
 * (spec §1.3)、预检 policy 存储留待 7b,本步只验证「起 stream-json 子 agent +
 * prompt 模板 + agent_started 事件 + 卡片状态」这条主链路。
 */
function subAgentPrompt(
  project: Project | undefined,
  task: Task,
  workspace: string,
  userPrompt: string,
): string {
  return [
    '你是该任务的子 agent。',
    '',
    `项目:${project?.name ?? '(未命名)'}`,
    `工作区:${workspace}`,
    `任务:${task.title}`,
    `目标:${task.goal || '(未填写)'}`,
    `验收:${task.acceptance || '(未填写)'}`,
    '',
    '请只完成以下子任务:',
    userPrompt,
    '',
    '完成后用简短中文总结:',
    '- 做了什么',
    '- 改了哪些文件',
    '- 如何验证',
    '- 剩余风险',
  ].join('\n');
}

/** 预检用:目标工作区的 git 状态(信息用途,7a 不据此阻断)。 */
app.get('/api/git-status', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const workspace = resolve(String(req.query.workspace ?? ''));
  if (!workspace || !existsSync(workspace)) {
    res.status(400).json({ error: '工作目录不存在' });
    return;
  }
  execFile('git', ['-C', workspace, 'status', '--porcelain'], { timeout: 5000 }, (err, stdout) => {
    if (err) {
      res.json({ isRepo: false, porcelain: '' });
      return;
    }
    res.json({ isRepo: true, porcelain: stdout });
  });
});

app.post('/api/tasks/:id/agents/start', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const task = tasks.getTask(String(req.params.id));
  if (!task) {
    res.status(404).json({ error: 'task 不存在' });
    return;
  }
  const b = req.body ?? {};
  const role = b.role === 'main' ? 'main' : 'sub';
  const transport = b.transport === 'tmux' ? 'tmux' : 'stream-json';
  const workspace = resolve(String(b.workspace ?? ''));

  if (role === 'main' && transport === 'tmux') {
    // 网页接管不了用户 pane —— 主 tmux agent 只能在终端用 synapse 起,再绑定进来。
    res.status(400).json({ error: '不能从网页启动 tmux 主 agent,请在终端用 synapse 起会话后绑定' });
    return;
  }
  if (!workspace || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
    res.status(400).json({ error: '工作目录不存在' });
    return;
  }

  // 留空则回退到任务目标 —— 不带子任务启动会让子 agent 起来后干等,没有触发轮次的输入。
  const userPrompt =
    (typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt.trim() : '') || task.goal.trim();
  if (!userPrompt) {
    res.status(400).json({ error: '需要子任务描述(或先给任务填写目标)' });
    return;
  }
  const project = tasks.getProject(task.projectId);
  const appendSystemPrompt =
    typeof b.appendSystemPrompt === 'string' && b.appendSystemPrompt.trim()
      ? b.appendSystemPrompt
      : undefined;

  try {
    const s = await manager.create(workspace, {
      transport,
      model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined,
      appendSystemPrompt,
    });
    const binding = tasks.attachAgent({
      taskId: task.id,
      localId: s.localId,
      claudeId: s.claudeId,
      role,
      transportKind: s.transportKind,
    });
    tasks.appendEvent({
      taskId: task.id,
      agentBindingId: binding.id,
      kind: 'agent_started',
      message: `启动 ${role} agent(${transport})于 ${workspace}`,
    });
    manager.send(s.localId, subAgentPrompt(project, task, workspace, userPrompt));
    res.json(taskDetail(task.id));
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

app.delete('/api/tasks/:id/agents/:bindingId', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const task = tasks.getTask(String(req.params.id));
  const binding = tasks.getBinding(String(req.params.bindingId));
  if (!task || !binding || binding.taskId !== task.id) {
    res.status(404).json({ error: 'binding 不存在' });
    return;
  }
  tasks.detachAgent(binding.id);
  // 只解绑,不关会话 —— 用户的 tmux pane / 后台 worker 继续跑(方案 §366)。
  tasks.appendEvent({
    taskId: task.id,
    agentBindingId: binding.id,
    kind: 'agent_detached',
    message: '解除 agent 绑定',
  });
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
        manager.interrupt(String(msg.localId));
        break;
    }
  });

  ws.on('close', () => clients.delete(ws));
});

// ── 任务事件派生 ────────────────────────────────────────────
// 现有会话/权限回调里顺带写 task event。fail-safe:查不到 active binding 就
// 静默跳过,绝不影响原 broadcast / 会话流程(方案 §412、全局约束 4)。

/**
 * 派生一条 task event 并 broadcast。localId 找不到 active binding 时什么都不做。
 * try/catch 兜底 —— TaskStore 写盘失败不能让会话事件转发链断掉。
 */
function emitTaskEvent(
  localId: string,
  kind: Parameters<typeof tasks.appendEvent>[0]['kind'],
  message: string,
  data?: unknown,
): void {
  try {
    const binding = tasks.bindingForSession(localId);
    if (!binding) return;
    const event = tasks.appendEvent({
      taskId: binding.taskId,
      agentBindingId: binding.id,
      kind,
      message,
      data,
    });
    broadcast({ type: 'task_event', taskId: binding.taskId, event });
  } catch (err) {
    console.error('[task-event] 派生失败:', err);
  }
}

/** 会话退出时结束其 active binding —— 详情页 agent 卡片据此不再显示为「在跑」。 */
function endBindingForExited(localId: string): void {
  try {
    const binding = tasks.bindingForSession(localId);
    if (binding) tasks.detachAgent(binding.id);
  } catch (err) {
    console.error('[task-event] 结束 binding 失败:', err);
  }
}

// ── 事件转发 ────────────────────────────────────────────────
manager.onEvent((e: ManagerEvent) => {
  // 会话退出后其挂起批准再也不会有人放行,留着会一直占着「需要你」分组
  if (e.type === 'session_updated' && e.session.state === 'exited' && e.session.claudeId) {
    permissions.drain(e.session.claudeId);
  }
  if (e.type === 'session_updated' && e.session.state === 'exited') {
    emitTaskEvent(e.session.localId, 'agent_exited', 'agent 会话已退出');
    endBindingForExited(e.session.localId);
  }
  if (e.type === 'session_event' && e.event.kind === 'turn_end') {
    emitTaskEvent(e.localId, 'turn_completed', e.event.interrupted ? '轮次已中断' : '轮次完成');
  }
  broadcast(e);
});

permissions.onApprovalRequested((a: PendingApproval) => {
  // 有待批准项时把会话标为 waiting,顶层列表据此排序与显示角标
  const s = manager.byClaudeId(a.sessionId);
  if (s) manager.setState(s.localId, 'waiting');
  if (s) emitTaskEvent(s.localId, 'approval_requested', `等待批准:${a.toolName}`, { toolUseId: a.toolUseId });
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
  if (s) emitTaskEvent(s.localId, 'approval_resolved', `批准${decision === 'allow' ? '通过' : '拒绝'}`, { toolUseId, decision });
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
    // 钩子 URL 必须用实际监听端口(port),不是请求端口(PORT)——
    // 默认端口被占用递增后二者不等,写错等同 fail-open(见 §2.3/§6)。
    writeHookSettings(PORT, port);

    console.log(`\n  Synapse`);
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
