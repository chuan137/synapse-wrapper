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
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionManager, replayTranscriptTimeline, mergedTodos, type ManagerEvent, type SessionSummary } from './sessionManager.ts';
import { PermissionEngine, HOOK_TIMEOUT_S, type PendingApproval } from './permissions.ts';
import { TaskStore, tasksPath, type AgentBinding, type Project, type Task } from './taskStore.ts';
import {
  writeState, clearState, readOrCreateToken, writeHookSettings, hookSettingsPath,
  writeMainAgentSettings, mainAgentSettingsPath,
  migrateLegacyStateDir, DEFAULT_PORT, MAX_PORT_TRIES, SYNAPSE_DIR,
} from './daemon.ts';
import { repoRootOf, addWorktree, removeWorktree } from './worktree.ts';

/** Project.name → worktree 目录名的安全 slug:空白转 -,去掉路径分隔与 . 前缀。 */
function projectSlug(name: string | undefined): string {
  const s = (name ?? 'project').replace(/[/\\]+/g, '-').replace(/\s+/g, '-').replace(/^\.+/, '');
  return s || 'project';
}

// 旧版按端口分子目录,现在扁平放数据目录根 —— 升级后首次启动搬一次(见 daemon.ts)。
migrateLegacyStateDir();

const HOST = '127.0.0.1';
/** 显式通过 PORT 环境变量指定过端口,还是用的默认值 —— 决定要不要允许递增重试。 */
const PORT_EXPLICIT = process.env.PORT != null;
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 保护浏览器侧接口的会话令牌。数据目录有残留 token(daemon.ts clearState 不删它,
 * 只清 pid/port)就复用,让 `synapse daemon restart` 之后旧链接继续有效 ——
 * 用户的浏览器书签、终端历史里存的都是这个 URL,链接跟着重启变会很烦人。
 * 全新安装或首次启动(没有残留文件)才随机生成。
 */
const AUTH_TOKEN = readOrCreateToken();

/**
 * 实际监听端口 —— 默认端口占用时会递增(见 listenWithRetry)。
 * 显式指定端口时不允许递增(见 §「端口」),此时恒等于 PORT。
 * Origin 校验与钩子 URL 都必须用它,用 PORT 会在端口递增后全线失配。
 */
let activePort = PORT;

// hook 配置文件路径固定在数据目录下,文件本身在 listenWithRetry 里等实际
// 监听端口确定后才写。会话启动都在监听成功之后,读到的一定是新版本。
const manager = new SessionManager(hookSettingsPath());
const permissions = new PermissionEngine();
// 任务存储落 <数据目录>/tasks.json —— 和 sessions.json 同目录(见 spec §1.4)。
const tasks = new TaskStore(tasksPath());
const stopLivenessWatch = manager.startLivenessWatch();

/**
 * daemon 重启后的主 agent 扫回对账。
 *
 * 网页自建的 tmux 主 agent 长命、扛 daemon restart —— SessionManager 的 tmux
 * 扫回(#reclaimOwnTmuxSessions)按会话名 synapse-main-* 把还活着的接回来。
 * 这里补对账那一面:扫回后仍是 exited 的 main binding(用户在重启窗口里
 * kill 过会话),把 binding endedAt 落上,详情页显示「已退出」而不是永远
 * 挂着一个连不上的主 agent。
 */
async function reconcileMainAgentsAfterRestart(): Promise<void> {
  await manager.reclaimDone;
  for (const b of tasks.activeBindings()) {
    if (b.role !== 'main' || b.transportKind !== 'tmux') continue;
    const s = manager.get(b.localId);
    if (s && s.state !== 'exited') continue;  // 扫回接住了,还活着
    tasks.detachAgent(b.id);
    tasks.appendEvent({
      taskId: b.taskId,
      agentBindingId: b.id,
      kind: 'agent_exited',
      message: 'daemon 重启后未找到主 agent 的 tmux 会话',
    });
  }
}
void reconcileMainAgentsAfterRestart();

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

/**
 * 主 agent 的唯一真相源 —— `synapse agent context` 的后端。
 *
 * 每次决策前主 agent 拉一次:目标 / work dir / 验收 是任务的静态定义;
 * 子 agent 状态行是动态的(每个非 main binding 的会话状态 + 最近一次
 * turn_completed 的摘要 + pending 批准数)。handoff 文档要等落地顺序第 7 步
 * (`backend/taskDocs.ts` + `synapse-tasks` repo),这一步先回 null。
 */
function agentContext(taskId: string) {
  const task = tasks.getTask(taskId);
  if (!task) return null;
  const project = tasks.getProject(task.projectId) ?? null;
  const bindings = tasks.listBindings(taskId);
  const main = bindings.find((b) => b.role === 'main' && b.endedAt === null);

  // work dir:handoff 文档定稿前,主 agent 会话的工作区就是权威值;它还没起来
  // 时退回 project 的首个 workspaceRoot。
  const mainSession = main ? sessionView(main.localId) : null;
  const workDir = mainSession?.workspace ?? project?.workspaceRoots[0] ?? null;

  const subAgents = bindings
    .filter((b) => b.role === 'sub')
    .map((b) => {
      const session = sessionView(b.localId);
      const events = tasks.eventsForBinding(b.id);
      const lastTurn = [...events].reverse().find((e) => e.kind === 'turn_completed') ?? null;
      const exited = events.some((e) => e.kind === 'agent_exited') || b.endedAt !== null;
      // 优先取 turn_end 载荷里的真结论(首行、截断);没有再回退到固定 message。
      const result = (lastTurn?.data as { result?: string } | null)?.result;
      const summary = result?.trim()
        ? result.trim().split('\n')[0]!.slice(0, 200)
        : (lastTurn?.message ?? null);
      return {
        bindingId: b.id,
        workspace: session?.workspace ?? null,
        // running / idle / exited —— 主 agent 据此判断能不能派下一个子任务。
        state: exited ? 'exited' : session && RUNNING_STATES.has(session.state) ? 'running' : 'idle',
        lastTurnAt: lastTurn?.createdAt ?? null,
        lastTurnSummary: summary,
        pendingApprovals: pendingForBinding(b),
      };
    });

  return {
    task: { id: task.id, title: task.title, goal: task.goal, acceptance: task.acceptance, status: task.status },
    project: project ? { id: project.id, name: project.name } : null,
    workDir,
    mainAgent: main ? { bindingId: main.id, state: mainSession?.state ?? 'unknown' } : null,
    handoff: null as string | null,
    subAgents,
  };
}

app.get('/api/tasks/:id/agent-context', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const ctx = agentContext(String(req.params.id));
  if (!ctx) {
    res.status(404).json({ error: 'task 不存在' });
    return;
  }
  res.json(ctx);
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

app.patch('/api/tasks/:id', async (req, res) => {
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

  // 归档任务:回收所有 --worktree 子 agent 的隔离目录(spec §1.3 落地顺序第 6 步
  // 「任务归档时 git worktree remove」)。
  if (statusChanged && task.status === 'archived') {
    for (const binding of tasks.listBindings(task.id)) {
      if (binding.worktreePath) {
        await removeWorktree(binding.worktreePath).catch((err) =>
          console.error('[worktree] 归档清理失败:', err),
        );
      }
    }
  }

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

/**
 * 起一个 stream-json 子 agent 并挂上任务:manager.create + attachAgent(role:'sub')
 * + agent_started 事件 + send(首轮 prompt)。`/agents/start` 的 sub 分支和
 * `/agents/spawn` 端点共用这一段。
 *
 * 调用方决定 firstPrompt(网页 UI 用 subAgentPrompt 模板;主 agent 的
 * `synapse agent spawn --handoff` 用 handoff 文件内容)。
 */
async function spawnSubAgent(
  task: Task,
  opts: {
    workspace: string;
    model?: string;
    appendSystemPrompt?: string;
    firstPrompt: string;
    transport?: 'tmux' | 'stream-json';
    /** `synapse agent spawn --worktree` —— 在独立 git worktree 上跑,不进主工作区。 */
    worktree?: boolean;
    project?: Project;
  },
): Promise<AgentBinding> {
  // worktree 目录名要 binding 前缀,而 binding 在 manager.create 之后才 attach ——
  // 和主 agent 路径一样预生成 id,注入 + worktree 命名 + attach 用同一个。
  const bindingId = randomUUID();

  let cwd = opts.workspace;
  let worktreePath: string | null = null;
  if (opts.worktree) {
    const repoRoot = await repoRootOf(opts.workspace);
    worktreePath = await addWorktree(repoRoot, projectSlug(opts.project?.name), task.id, bindingId);
    cwd = worktreePath;
  }

  let s: Awaited<ReturnType<typeof manager.create>>;
  try {
    s = await manager.create(cwd, {
      transport: opts.transport ?? 'stream-json',
      model: opts.model,
      appendSystemPrompt: opts.appendSystemPrompt,
    });
  } catch (err) {
    // 会话没起来就别留一个孤儿 worktree —— 回滚再把错抛给端点。
    if (worktreePath) await removeWorktree(worktreePath).catch(() => {});
    throw err;
  }
  const binding = tasks.attachAgent({
    taskId: task.id,
    id: bindingId,
    localId: s.localId,
    claudeId: s.claudeId,
    role: 'sub',
    transportKind: s.transportKind,
    worktreePath,
  });
  tasks.appendEvent({
    taskId: task.id,
    agentBindingId: binding.id,
    kind: 'agent_started',
    message: worktreePath
      ? `启动子 agent(${opts.transport ?? 'stream-json'})于 worktree ${worktreePath}`
      : `启动子 agent(${opts.transport ?? 'stream-json'})于 ${opts.workspace}`,
  });
  manager.send(s.localId, opts.firstPrompt);
  return binding;
}

/**
 * 子 agent 的首轮 prompt —— 有 handoff 时用它的文件内容替换 subAgentPrompt 的
 * 硬编码模板(主 agent 已经在 handoff 里写清了目标 / work dir / 验收 / 子任务),
 * 没有时回退到模板。
 */
function spawnFirstPrompt(
  project: Project | undefined,
  task: Task,
  workspace: string,
  handoff: string | undefined,
  userPrompt: string | undefined,
): string {
  if (handoff && handoff.trim()) {
    return [
      handoff.trim(),
      ...(userPrompt && userPrompt.trim() ? ['', '---', '', userPrompt.trim()] : []),
      '',
      '完成后用简短中文总结:做了什么 / 改了哪些文件 / 如何验证 / 剩余风险。',
    ].join('\n');
  }
  return subAgentPrompt(project, task, workspace, (userPrompt ?? '').trim() || task.goal.trim());
}

/**
 * 主 agent 的 system prompt 基线 —— 只讲「该怎么做」。
 *
 * 这段只是倾向。真正兜住「不能做什么」的是受限 permissions(daemon.ts
 * writeMainAgentSettings:Bash 白名单、无 Write/Edit/Task)—— 两者配合,
 * 不互相替代。`synapse agent doc` 流程留待落地顺序第 7 步。
 */
function mainAgentPrompt(project: Project | undefined, task: Task): string {
  return [
    '你是这个任务的主 agent —— 一个调度者,不是执行者。',
    '',
    `项目:${project?.name ?? '(未命名)'}`,
    `任务:${task.title}`,
    `目标:${task.goal || '(未填写)'}`,
    `验收:${task.acceptance || '(未填写)'}`,
    '',
    '你的职责:确定 work dir、把任务拆成子任务、分派给子 agent、跟踪进度。',
    '你自己不改代码 —— 所有文件改动交给你 spawn 的子 agent。',
    '你的工具被限制过:只有 `synapse agent` 调度命令和只读观测(git 只读、Read、rg);',
    '没有 Write / Edit,也不能用原生 Task 子代理(那些不进任务视图、不受 worktree',
    '隔离)。白名单外的 Bash 会卡住 —— 那是有意的,不要尝试绕过。',
    '',
    '调度用 `synapse agent` 子命令(daemon HTTP 的瘦客户端,任务 id 已通过',
    '环境变量注入,无需手动传):',
    '  synapse agent context',
    '      打印 work dir / 目标 / 验收 / 每个子 agent 的状态。每次决策前先拉一次,',
    '      这是你的唯一真相源。',
    '  synapse agent spawn --workspace <dir> [--handoff <file>] [--prompt <text>] --worktree',
    '      起一个子 agent,立即返回 binding id。**务必带 --worktree** —— 子 agent 在',
    '      独立 git worktree 上跑,并行子任务的改动才不会缠在一起、能按任务提交。',
    '  synapse agent await <bindingId> [--timeout <秒>]',
    '      阻塞到该子 agent 本轮结束(退出码 0)或异常退出(10),打印它的结论。',
    '  synapse agent poll <bindingId> [--since <seq>]',
    '      要并行等多个子 agent 时,用它自己轮询,不用 await。',
    '',
    '现在:先跑 `synapse agent context` 看清任务全貌,再规划子任务拆解。',
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
  const given = resolve(String(b.workspace ?? ''));
  const model =
    typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined;

  if (!given || !existsSync(given) || !statSync(given).isDirectory()) {
    res.status(400).json({ error: '工作目录不存在' });
    return;
  }
  // 解析符号链接后再用 —— claude 的信任检查(TmuxTransport.ensureTrusted 写的
  // ~/.claude.json)按真实路径匹配,tmux 主 agent 自建会话会撞信任对话框,
  // 默认选项是「No, exit」,claude 一退 tmux 会话就没了。CLI 路径也这么做
  // (bin/synapse.ts realpathSync)。
  const workspace = realpathSync(given);
  const project = tasks.getProject(task.projectId);

  if (role === 'main') {
    // 网页启动的主 agent 只走 tmux 自建会话(长命、扛 daemon restart)。stream-json
    // 主 agent(纯后台一次性)不从这个端点起 —— 用户在终端用 synapse 起再绑定。
    if (transport !== 'tmux') {
      res.status(400).json({ error: '网页启动的主 agent 只支持 tmux(自建会话)' });
      return;
    }
    // 一个任务至多一个活跃主 agent —— 名字 synapse-main-<taskId> 因此唯一,
    // 也是 daemon 重启后扫回的锚点(重启扫回见落地顺序第 4 步)。
    if (tasks.listBindings(task.id).some((x) => x.role === 'main' && x.endedAt === null)) {
      res.status(409).json({ error: '该任务已有活跃主 agent' });
      return;
    }

    const sessionName = `synapse-main-${task.id}`;
    // binding id 要在 spawn 前作为 SYNAPSE_AGENT_BINDING 注入 —— 先生成,
    // 再带着同一个 id attach(见 taskStore AttachAgentInput.id)。
    const bindingId = randomUUID();
    const sessionId = randomUUID();

    try {
      const s = await manager.create(workspace, {
        transport: 'tmux',
        tmuxName: sessionName,
        sessionId,
        model,
        appendSystemPrompt: mainAgentPrompt(project, task),
        // 受限 permissions(Bash 白名单、无 Write/Edit/Task)叠在共用 hook 配置
        // 之后 —— system prompt 只是倾向,这份才兜住「不能做什么」(spec §1.5)。
        settingsPaths: [mainAgentSettingsPath()],
        env: {
          SYNAPSE_TASK_ID: task.id,
          SYNAPSE_AGENT_BINDING: bindingId,
          SYNAPSE_DATA_DIR: SYNAPSE_DIR,
        },
      });
      const binding = tasks.attachAgent({
        taskId: task.id,
        id: bindingId,
        localId: s.localId,
        claudeId: s.claudeId,
        role: 'main',
        transportKind: s.transportKind,
      });
      tasks.appendEvent({
        taskId: task.id,
        agentBindingId: binding.id,
        kind: 'agent_started',
        message: `启动主 agent(tmux ${sessionName})于 ${workspace}`,
      });
      // 自建会话默认没人 attach —— 发一句首轮 prompt 让主 agent 立刻开始规划,
      // 否则会话起来后干等,用户 attach 进去看到的是个空会话。
      manager.send(s.localId, '开始:先 `synapse agent context` 看清任务,再规划子任务拆解并逐个 spawn 子 agent。');
      res.json(taskDetail(task.id));
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
    return;
  }

  // ── 子 agent(stream-json,现有路径)──
  // 留空则回退到任务目标 —— 不带子任务启动会让子 agent 起来后干等,没有触发轮次的输入。
  const userPrompt =
    (typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt.trim() : '') || task.goal.trim();
  if (!userPrompt) {
    res.status(400).json({ error: '需要子任务描述(或先给任务填写目标)' });
    return;
  }
  const appendSystemPrompt =
    typeof b.appendSystemPrompt === 'string' && b.appendSystemPrompt.trim()
      ? b.appendSystemPrompt
      : undefined;

  try {
    await spawnSubAgent(task, {
      workspace,
      model,
      appendSystemPrompt,
      transport,
      firstPrompt: subAgentPrompt(project, task, workspace, userPrompt),
    });
    res.json(taskDetail(task.id));
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

/**
 * 主 agent 起子 agent —— `synapse agent spawn` 的后端。
 * body: { workspace, handoff?, prompt?, model?, strategy? }
 *
 * 和 `/agents/start` 的 sub 分支同一条创建路径(spawnSubAgent),差异只在:
 *  - `handoff` 是 CLI 侧读出的文件内容,替换 subAgentPrompt 的模板拼进首轮 prompt
 *  - 返回 `{ bindingId, workspace }`,不是 taskDetail —— 主 agent 只要这个 id 去 poll
 *
 * `worktree: true`(`synapse agent spawn --worktree`)让子 agent 在独立 git
 * worktree 上跑(spec §1.3 的薄版本 = `ignore` 策略,见 backend/worktree.ts)。
 * 返回的 `workspace` 是 worktree 路径。完整 `dirtyStrategy` 仍留 §1.3 后续。
 */
app.post('/api/tasks/:id/agents/spawn', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const task = tasks.getTask(String(req.params.id));
  if (!task) {
    res.status(404).json({ error: 'task 不存在' });
    return;
  }
  const b = req.body ?? {};
  const given = resolve(String(b.workspace ?? ''));
  if (!given || !existsSync(given) || !statSync(given).isDirectory()) {
    res.status(400).json({ error: '工作目录不存在' });
    return;
  }
  const workspace = realpathSync(given);
  const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim() : undefined;
  const handoff = typeof b.handoff === 'string' ? b.handoff : undefined;
  const prompt = typeof b.prompt === 'string' ? b.prompt : undefined;
  const worktree = b.worktree === true;

  if (!handoff?.trim() && !prompt?.trim() && !task.goal.trim()) {
    res.status(400).json({ error: '需要 handoff 文件、prompt,或先给任务填写目标' });
    return;
  }

  const project = tasks.getProject(task.projectId);
  try {
    const binding = await spawnSubAgent(task, {
      workspace,
      model,
      worktree,
      project,
      firstPrompt: spawnFirstPrompt(project, task, workspace, handoff, prompt),
    });
    res.json({ bindingId: binding.id, workspace: binding.worktreePath ?? workspace });
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

/**
 * 某子 agent 自 `since`(不含)以来的任务流事件 —— `synapse agent poll` 的后端。
 * 无新事件立即返回空,不 hang(轮询循环在 CLI 侧,见设计文档「交互协议」)。
 */
app.get('/api/tasks/:id/agents/:bindingId/events', (req, res) => {
  if (!checkOrigin(req, res)) return;
  const task = tasks.getTask(String(req.params.id));
  if (!task) {
    res.status(404).json({ error: 'task 不存在' });
    return;
  }
  const binding = tasks.getBinding(String(req.params.bindingId));
  if (!binding || binding.taskId !== task.id) {
    res.status(404).json({ error: 'binding 不存在' });
    return;
  }
  if (binding.role !== 'sub') {
    res.status(400).json({ error: '只能 poll 子 agent 的事件' });
    return;
  }
  const sinceRaw = Number(req.query.since);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;
  const events = tasks.eventsForBinding(binding.id, since);
  // 这批为空则 cursor 停在传入的 since —— 下次 poll 从同一处继续。
  const cursor = events.length ? events[events.length - 1]!.seq : since;
  res.json({ events, cursor });
});

app.delete('/api/tasks/:id/agents/:bindingId', async (req, res) => {
  if (!checkOrigin(req, res)) return;
  const task = tasks.getTask(String(req.params.id));
  const binding = tasks.getBinding(String(req.params.bindingId));
  if (!task || !binding || binding.taskId !== task.id) {
    res.status(404).json({ error: 'binding 不存在' });
    return;
  }
  tasks.detachAgent(binding.id);

  // 网页自建的 tmux 主 agent(会话名 synapse-main-<taskId>):解绑 = kill-session。
  // 自建会话没有「pane 归用户」的顾虑(那条原则只管接管用户 pane 的普通会话)。
  // 普通 tmux 会话(synapse CLI 起的、接管 pane 的)解绑仍只断绑定不碰会话。
  const s = manager.get(binding.localId);
  const isOwnMainSession =
    binding.role === 'main' &&
    binding.transportKind === 'tmux' &&
    s?.tmuxName === `synapse-main-${task.id}` &&
    s?.paneId == null;
  if (isOwnMainSession) {
    await manager.stop(binding.localId, true).catch((err) =>
      console.error('[main-agent] kill-session 失败:', err),
    );
  }

  // 普通会话:只解绑,不关会话 —— 用户的 tmux pane / 后台 worker 继续跑(方案 §366)。
  tasks.appendEvent({
    taskId: task.id,
    agentBindingId: binding.id,
    kind: 'agent_detached',
    message: isOwnMainSession ? '解除主 agent 绑定并关闭其 tmux 会话' : '解除 agent 绑定',
  });
  // --worktree 起的子 agent:解绑时移除隔离 worktree(spec §1.3「清理」的薄版本
  // —— 完整设计是不自动删、给 UI 显式入口,这里先跟随解绑动作)。
  if (binding.worktreePath) {
    await removeWorktree(binding.worktreePath).catch((err) =>
      console.error('[worktree] 移除失败:', err),
    );
  }
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
    // message 仍是固定串;子 agent 本轮的实际结论(最终 assistant 文本)放进
    // data.result,让 `synapse agent poll` / `await` / `context` 能打印真结论
    // 而不是「轮次完成」。改动文件列表 turn_end 载荷里没有 —— 留到后续从
    // transcript 解析(设计文档「未决」)。
    emitTaskEvent(
      e.localId,
      'turn_completed',
      e.event.interrupted ? '轮次已中断' : '轮次完成',
      { result: e.event.result, costUsd: e.event.costUsd, interrupted: e.event.interrupted ?? false },
    );
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
 * 仅默认端口走递增:显式指定端口时,占用即报错退出,不静默换端口 ——
 * 用户显式记住的是哪个端口就该监听哪个,悄悄改道只会让人对着旧地址干等。
 * 无论哪种情况,最终监听端口都写进 <数据目录>/port,健康检查与 CLI 据此寻址。
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

    writeState({ pid: process.pid, port, token: AUTH_TOKEN });
    // 钩子 URL 必须用实际监听端口(port),不是请求端口(PORT)——
    // 默认端口被占用递增后二者不等,写错等同 fail-open(见 §2.3/§6)。
    writeHookSettings(port);
    // 主 agent 受限 settings 内容固定(不含端口),启动时写一遍即可 —— 幂等。
    writeMainAgentSettings();

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
  // 只清自己名下的状态 —— 同一数据目录曾经因为 bug 堆出过多个实例(见
  // daemon.ts clearState 注释),无差别清会把仍然健康的别的实例的
  // daemon.pid/port 也删掉,状态文件指向的进程明明还活着却查无此地址。
  clearState(process.pid);
  permissions.drain();
  // stopAll 而非 closeAll —— 会话记录要留着,下次启动时左栏仍能看到(持久化的意义)。
  await manager.stopAll();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
