# Phase 1:Claude 任务管理实施方案

## 目标

Phase 1 的目标是在现有 Claude Code wrapper 之上增加任务管理层,形成 **项目 -> 任务 -> agents** 的工作视图。

这一阶段只管理 Claude 会话,不接入 Codex,不实现跨 CLI agent bus。主任务 agent 默认来自 tmux transport,子任务 agent 默认来自 stream-json transport。

这一阶段的主 agent 是「用户在原生 TUI 里正常干活、顺带被纳入任务视图」的会话,后端不裁剪它的工具能力、不套 worktree(呼应 spec §3.1 / §1.3)。子 agent 的启动由用户在网页上手动触发,不是主 agent 通过工具调用自动 spawn。「主 agent 只编排不动手 + 通过工具触发子 agent」是本阶段之后的方向,见文末「后续演进」。

最终用户应该能做到:

- 按项目查看任务。
- 在项目下创建任务。
- 把已有 Claude 会话绑定到任务。
- 从任务下启动新的子 agent。
- 在任务详情里看到主 agent、子 agent、状态、待批准项、最近输出和任务流事件。

## 非目标

Phase 1 不做以下内容:

- 不引入 SQLite 或外部数据库。
- 不接 Codex app-server。
- 不实现 Claude -> Codex 的跨 agent 通信。
- 不重写 SessionManager 的生命周期逻辑。
- 不把 Project/Task 字段塞进 Session 对象。
- 不做完整 artifacts/diff 解析。
- 不删除旧的纯会话视图入口。

## 现有边界

当前系统核心边界如下:

- `SessionManager`:负责会话生命周期、状态、transport、统计、timeline。
- `PermissionEngine`:负责 Claude HTTP hook 的 pending approval 和 fail-closed。
- `SessionTransport`:屏蔽 stream-json / tmux 差异。
- `Store`:目前只存 sessions 元数据。

任务管理必须作为独立层接入,通过 `localId` / `claudeId` 引用会话。

## 存储策略

Phase 1 使用 JSON 文件:

```text
~/.synapse/tasks.json
```

理由:

- 当前是本机单用户。
- 数据量预计小。
- 写入频率低。
- 方便调试和 review。
- 与当前 `~/.synapse/sessions.json` 风格一致。
- 可以先验证产品模型,以后按接口迁移到 SQLite。

实现要求:

- 文件权限 `0600`。
- 父目录不存在时创建。
- 读不到文件时初始化空数据。
- JSON 解析失败时不要静默覆盖,应抛出明确错误或保留损坏文件后新建。
- 写入必须串行化。
- 写入走临时文件 + chmod + rename 的原子替换流程。

建议文件结构:

```json
{
  "version": 1,
  "projects": [],
  "tasks": [],
  "agentBindings": [],
  "events": []
}
```

## 数据模型

### Project

```ts
export interface Project {
  id: string;
  name: string;
  workspaceRoots: string[];
  goal: string;
  createdAt: number;
  updatedAt: number;
}
```

约束:

- `id` 使用 `crypto.randomUUID()`。
- `workspaceRoots` 存绝对路径。
- Phase 1 允许一个项目多个 workspace root,但 UI 第一版可以只显示第一个。
- 如果没有显式项目,后端应按现有 session workspace 自动生成或持久化默认项目。

### Task

```ts
export type TaskStatus = 'todo' | 'running' | 'waiting' | 'blocked' | 'done' | 'archived';
export type TaskPriority = 'low' | 'normal' | 'high';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  priority: TaskPriority;
  acceptance: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}
```

约束:

- `title` 必填。
- `goal` / `acceptance` 可为空字符串。
- `status` 初始为 `todo`。
- `priority` 初始为 `normal`。
- 归档用 `archivedAt` 和 `status: 'archived'`,不要物理删除。

### AgentBinding

```ts
export type AgentRole = 'main' | 'sub';
export type AgentTransportKind = 'tmux' | 'stream-json';

export interface AgentBinding {
  id: string;
  taskId: string;
  localId: string;
  claudeId: string | null;
  role: AgentRole;
  transportKind: AgentTransportKind;
  createdAt: number;
  endedAt: number | null;
}
```

约束:

- `localId` 指向 `Session.localId`。
- `claudeId` 启动初期可能为 null,后续可在 session 认领后补齐。
- 一个任务最多一个 active main binding。
- 一个会话 Phase 1 只绑定到一个 active task,避免 UI 和事件归属混乱。
- 解除绑定只设置 `endedAt`,不关闭底层会话。

### TaskEvent

```ts
export type TaskEventKind =
  | 'task_created'
  | 'task_updated'
  | 'task_status_changed'
  | 'agent_attached'
  | 'agent_detached'
  | 'agent_started'
  | 'approval_requested'
  | 'approval_resolved'
  | 'turn_completed'
  | 'agent_exited';

export interface TaskEvent {
  id: string;
  taskId: string;
  agentBindingId: string | null;
  kind: TaskEventKind;
  message: string;
  data: unknown;
  createdAt: number;
}
```

Phase 1 只要求事件能展示成任务流,不要求复杂查询。

## TaskStore 接口

新增文件建议:

```text
backend/taskStore.ts
```

建议接口:

```ts
export interface TaskStore {
  listProjects(): Project[];
  getProject(projectId: string): Project | undefined;
  ensureProjectForWorkspace(workspace: string): Project;

  listTasks(projectId: string, opts?: { includeArchived?: boolean }): Task[];
  getTask(taskId: string): Task | undefined;
  createTask(input: CreateTaskInput): Task;
  updateTask(taskId: string, patch: TaskPatch): Task;

  listBindings(taskId: string): AgentBinding[];
  getBinding(bindingId: string): AgentBinding | undefined;
  bindingForSession(localId: string): AgentBinding | undefined;
  attachAgent(input: AttachAgentInput): AgentBinding;
  detachAgent(bindingId: string): void;

  appendEvent(input: AppendTaskEventInput): TaskEvent;
  listEvents(taskId: string): TaskEvent[];
}
```

实现建议:

- 构造函数同步加载文件。
- 所有 mutation 调用内部 `#save()`。
- `#save()` 维护 promise chain,保证并发写串行。
- 公开方法可以先同步返回,内部保存失败要至少 `console.error` 并抛出。
- 时间戳统一用 `Date.now()`。

## API 设计

所有 API 复用现有 `x-auth-token` 和 Origin 校验模式。

### GET /api/projects

返回项目列表和聚合信息。

```json
{
  "projects": [
    {
      "id": "...",
      "name": "synapse-wrapper",
      "workspaceRoots": ["/path/to/repo"],
      "goal": "",
      "taskCount": 4,
      "runningAgents": 2,
      "pendingApprovals": 1,
      "updatedAt": 123
    }
  ]
}
```

聚合逻辑:

- `taskCount`:非 archived task 数。
- `runningAgents`:绑定 session 中 state 为 `busy` / `waiting` / `starting` 的数量。
- `pendingApprovals`:绑定 session 的 pending approval 数量。

### GET /api/projects/:id/tasks

返回项目下任务列表。

每个 task 附带:

- agentCount
- mainAgent summary
- pendingApprovals
- lastEvent

### GET /api/tasks/:id

返回任务详情。

```json
{
  "task": {},
  "project": {},
  "agents": [
    {
      "binding": {},
      "session": {},
      "pending": []
    }
  ],
  "events": []
}
```

`session` 使用现有 session summary 形状,不要新造一套字段。

### POST /api/tasks

请求:

```json
{
  "projectId": "...",
  "title": "实现任务管理 UI",
  "goal": "...",
  "acceptance": "...",
  "priority": "normal"
}
```

行为:

- 创建 Task。
- 写 `task_created` event。
- 返回 `GET /api/tasks/:id` 的详情形状。

### PATCH /api/tasks/:id

允许更新:

- title
- goal
- status
- priority
- acceptance
- archivedAt

行为:

- 更新 `updatedAt`。
- 状态变化写 `task_status_changed`。
- 其他变化写 `task_updated`。

### POST /api/tasks/:id/agents

绑定已有会话。

```json
{
  "localId": "...",
  "role": "main"
}
```

行为:

- 校验 session 存在。
- 如果 `role === 'main'`,结束该 task 下旧 main binding。
- 如果该 session 已绑定其他 active task,返回 409。
- 写 `agent_attached` event。

### POST /api/tasks/:id/agents/start

从任务下启动新 agent。

```json
{
  "role": "sub",
  "transport": "stream-json",
  "workspace": "/path/to/repo",
  "prompt": "请实现..."
}
```

Phase 1 约束:

- `role: 'main'` 默认要求 `transport: 'tmux'`,但网页无法直接接管用户 pane;第一版可以禁用从网页启动 tmux main agent,只允许绑定已有 tmux 会话。
- `role: 'sub'` 默认 `transport: 'stream-json'`。
- 复用现有 `POST /api/sessions` 创建 session。
- 创建成功后写 AgentBinding。
- 如果有 `prompt`,创建后调用 `manager.send(localId, prompt)`。
- 写 `agent_started` event。

启动前的预检步、system prompt 注入(`--append-system-prompt`,已在 `POST /api/sessions` 开出口子)、以及 worktree 隔离(主库 dirty 时的三种策略)见 `docs/spec.md` §1.3 / §4 / §5.2。子 agent 默认在独立 worktree 上工作;`backend/worktree.ts` 与 policy 存储层在本阶段落地,策略选择通过预检步交给用户,不由后端猜。

### DELETE /api/tasks/:id/agents/:bindingId

行为:

- 设置 binding.endedAt。
- 写 `agent_detached` event。
- 不关闭 session。

## `wrapper serve` 入口

现有 `synapse`(spec §0.1 / notes / handoff)是「带前置准备的 claude」:必须在 tmux 内跑,就地接管当前 pane 启动一个 claude 会话,拉起 daemon 只是副作用。任务面板只需要 daemon + 网页 UI,不需要这个附带的会话 —— 从网页里创建任务、绑定已有会话、启动子 agent 时,没有「当前 workspace」这个概念。

因此 Phase 1 加一个轻量子命令:

```bash
wrapper serve
```

行为:

- 走现有 `ensureDaemon()`,确保 daemon 在跑(不在则 detached 拉起)。
- 打印网页链接(复用现有链接打印逻辑)。
- **不**创建 claude 会话,**不**要求在 tmux 内,随即退出。

与现有入口的分工:

| 入口 | 语义 | 环境要求 |
|---|---|---|
| `wrapper` | 我要在这个 workspace 干活,顺便纳入任务系统 | 必须在 tmux 内 |
| `wrapper serve` | 我只要任务面板,会话之后从网页里起 | 无 |

实现上是 `bin/wrapper.ts` 里跳过「校验 tmux → 生成 sessionId → POST /api/sessions → spawn claude」那一段,只保留 `ensureDaemon()` 与链接输出。`daemon <status|restart|stop>` 子命令不变。

`wrapper serve` 排在实施顺序的只读 API 之前 —— 验证任务视图 UI 时就需要一个不附带会话的启动方式。

## 事件聚合

Phase 1 不需要重构 WebSocket 协议,但后端应在以下位置追加 task event:

- 绑定 agent 时:`agent_attached`
- 从任务启动 agent 时:`agent_started`
- PermissionEngine 收到 pending 时:如果 claudeId/localId 能找到 active binding,写 `approval_requested`
- approval resolve 时:写 `approval_resolved`
- SessionManager 收到 `turn_end` 时:写 `turn_completed`
- session exited 时:写 `agent_exited`

如果事件归属查不到 task,直接跳过,不要影响原会话流程。

## UI 实现

视觉参考:

```text
public/task-mock.html
public/task-mock.css
```

第一版 UI 目标:

- 三栏布局:项目列表、任务列表、任务详情。
- 保留旧会话 overview 入口,避免任务视图未完成时阻塞现有使用。
- 项目列表显示 task 数、运行中 agent 数、待批准数。
- 任务列表显示 title、goal 摘要、状态、agent 数、待批准数。
- 任务详情显示:
  - 任务目标和验收标准。
  - main agent 卡片。
  - sub agents 卡片。
  - 每个 agent 的 transport、state、context、cost、pending approval。
  - 任务流事件。

交互第一版只需要:

- 创建任务。
- 编辑任务基本字段。
- 把当前已有 session 绑定到任务。
- 从任务启动 stream-json 子 agent。
- 点击 agent 打开现有会话详情。

不要在第一版做复杂拖拽、批量操作或图形化 DAG。

## 主 agent / 子 agent 规则

Phase 1 推荐规则:

- 主 agent:tmux transport,用户可在原生 Claude TUI 中接管。
- 子 agent:stream-json transport,后台执行明确子任务。
- 一个 task 最多一个 active main agent。
- 一个 task 可以有多个 active sub agents。
- 子 agent 的 prompt 应包含任务目标、验收标准和边界,不要只发一句标题。

从任务启动子 agent 时,建议 prompt 模板:

```text
你是该任务的子 agent。

项目:{project.name}
工作区:{workspace}
任务:{task.title}
目标:{task.goal}
验收:{task.acceptance}

请只完成以下子任务:
{userPrompt}

完成后用简短中文总结:
- 做了什么
- 改了哪些文件
- 如何验证
- 剩余风险
```

## 测试计划

至少覆盖:

- TaskStore 空文件初始化。
- TaskStore 写入后重读数据一致。
- 文件权限为 `0600`。
- attach main agent 时旧 main binding 被结束。
- 同一 session 不能绑定到两个 active task。
- detach 不关闭 session。
- `GET /api/projects` 能按现有 sessions 生成默认项目。
- `POST /api/tasks` 创建任务并写 event。
- `POST /api/tasks/:id/agents` 绑定会话并写 event。
- `POST /api/tasks/:id/agents/start` 能创建 stream-json session 并绑定到 task。

命令:

```bash
npm run typecheck
```

如果项目还没有测试框架,Phase 1 可以先写轻量 Node 脚本或直接补最小测试 harness,但不要跳过手动验证。

手动验证:

1. 启动后端。
2. 打开任务视图。
3. 确认现有 sessions 自动归到默认 project。
4. 创建任务。
5. 绑定一个已有 tmux 会话为 main agent。
6. 启动一个 stream-json 子 agent。
7. 发送 prompt,确认 agent 卡片状态和任务流更新。
8. 触发一次需要批准的操作,确认任务详情能看到 pending approval。

## 实施顺序

建议按 commit/PR 粒度拆:

1. `TaskStore` + 类型 + JSON 持久化。
2. `wrapper serve` 入口(不附带会话的 daemon 启动)。
3. 只读 API + 默认 project 聚合。
4. 写 API + agent binding。
5. 任务事件聚合。
6. UI 三栏骨架。
7. 从任务启动 stream-json 子 agent。
8. polish:空状态、错误提示、旧 overview 入口、手动验证记录。

## 注意事项

- 不要改 `docs/handoff.md` 来承载本方案;该文件只保留交接摘要。
- 不要让任务状态影响现有 `/api/sessions` 行为。
- 不要因为 task 删除或解绑而关闭用户 tmux pane。
- 不要把 `~/.synapse/tasks.json` 放进项目目录。
- 不要依赖 workspace basename 作为稳定 project id。
- 不要在 UI 里把 sub agent 表示成独立项目;它属于 task。
- 不要把 Codex 相关字段放进 Phase 1 数据模型,最多保留 future-compatible 的 `transportKind` 字符串。

## 后续演进:主 agent 受限编排 + 通过工具触发子 agent

Phase 1 之后的一个方向是让主 agent 变成「只编排、不动手」的角色:在主 session 里裁剪它能调的工具(比如只允许 Read、禁止 Write / 禁止 `Task` 子代理、read 到一定次数就打断),让它把实际的实现工作拆成子任务,通过工具调用触发 stream-json 子 agent 去执行;子 agent 拥有完整工具能力,在独立 worktree 上干活。

这个方向依赖 Phase 1 的产物,不需要重写:

- `TaskStore` / `AgentBinding` —— 「主 agent 触发子 agent」本质就是写一条 sub binding + 起一个 stream-json 会话,与 `POST /api/tasks/:id/agents/start` 同源。
- 任务事件流 —— 编排过程要可观察。
- `backend/worktree.ts` + policy 存储层(spec §1.3 / §5.2)—— 多个子 agent 并行才有意义。

但它与 Phase 1 现状有几处冲突,需要专门设计:

- **hook 开关**:现在默认 `matcher` 只匹配 `AskUserQuestion`,其余工具交还 Claude Code 内置权限系统(spec §2.1)。裁剪主 agent 工具能力要重新打开 `ENABLE_FULL_APPROVAL` 或引入按工具名的自动决策层,且必须 fail-closed —— hook 超时是 fail-open(spec §2.2),「按调用次数打断」这类计数策略一旦后端判断慢了就形同虚设。
- **主 agent 的 transport**:Phase 1 的主 agent 是 tmux 接管模式(用户自己的 pane),spec §3.1 明确「wrapper 的 tmux 会话不套 policy」。要真正控制主 agent 看到的工具,可能得把主 agent 从 tmux 改成 stream-json,这会牺牲「用户在原生 TUI 里接管」的能力。
- **触发通道**:主 agent 如何触发子 agent —— 自定义 MCP 工具?还是拦截 `Task` 工具调用改写成「创建子 agent binding」?未定。
- **中断能力**:spec §7 —— stream-json 下 `interrupt()` 可能杀掉整个会话,「read 多次就 stop 他」需要可靠的逐轮中断,先实测掉。

这些决策留到 Phase 1 落地、产品模型验证之后再定。
