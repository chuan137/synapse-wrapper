# Phase 1 实施计划 —— spec-driven

本文件是 `docs/phase1-task-management.md`(方案)与 `docs/spec.md`(权威规格)之上的**执行层**:
把方案拆成可独立提交、可独立验证的步骤,每一步都绑定它所依据的 spec 章节和验收条件。

- 方案里「做什么 / 为什么」不在这里重复,只在需要时引用章节号。
- 每步给出:依据(spec §)、改动文件、契约(类型 / API 形状)、验收(自动 + 手动)、不做什么。
- 顺序沿用方案 §「实施顺序」,但把 `wrapper serve` 提前到只读 API 之前(方案 §399 已说明)。

规格冲突处理:实现中若发现 spec 与代码/实测不符,**先改 spec 再改代码**(遵循 handoff「关键约束」与 CLAUDE.md:实测结论归 spec)。本文件不承载实测记录。

---

## 全局约束(每步都适用)

来自 handoff「关键约束」与 spec,违反即返工:

1. **不碰 `SessionManager` 生命周期**。Task 层通过 `localId` / `claudeId` 单向引用 Session,不往 `Session` / `SessionSummary` / `PersistedSession` 加业务字段(spec §1.1)。
2. **`~/.synapse/tasks.json` 不进项目目录**,不按端口分区 —— 它是跨 daemon 实例的用户级数据(与 `sessions.json` 按端口分区不同,理由见下「存储位置决策」)。
3. **写盘原子**:临时文件 → chmod `0600` → rename;写入串行化(promise chain)。
4. **事件聚合 fail-safe**:task event 查不到归属就跳过,绝不影响 `/api/sessions` 或会话流程(方案 §412)。
5. **不改 hook 协议、不改 WebSocket 协议**。task event 走现有 broadcast 通道新增消息类型。
6. **typecheck 必须过**:`npm run typecheck`。改后端代码先杀旧 daemon(handoff「测试注意」)。

### 存储位置决策(需在 step 1 敲定并写回 spec)

`sessions.json` 按 `~/.synapse/<port>/` 分区,因为「会话数据跟着 daemon 实例走」(store.ts 头注释)。
Task 数据不同:方案 §529 明确「不要把 tasks.json 放进项目目录」,§46 写的是 `~/.synapse/tasks.json`(**不带端口**)。
理由:Project List 要跨 workspace 聚合(spec §4「端口」段:不传 `--port` 的 wrapper 都复用同一默认 daemon),
Task 视图同理应在一个用户级命名空间里,不随测试端口分裂。

**决策**:`tasks.json` 落 `~/.synapse/tasks.json`,与端口无关。测试时用环境变量 `SYNAPSE_TASKS_PATH` 覆盖以隔离。
这条要作为一句话补进 spec §1.1 或新开 §1.4。

---

## Step 1 —— TaskStore + 类型 + JSON 持久化

**依据**:方案 §「存储策略」§「数据模型」§「TaskStore 接口」§「测试计划」1-6;spec §1.1(独立于 SessionManager)。

### 改动文件

| 文件 | 动作 |
|---|---|
| `backend/taskStore.ts` | 新增 —— 类型 + `TaskStore` 类 |
| `backend/taskStore.test.ts` 或 `scripts/test-taskstore.ts` | 新增 —— 见「测试框架决策」 |

### 契约

类型逐字采用方案 §「数据模型」的 `Project` / `Task` / `AgentBinding` / `TaskEvent` 及 `TaskStatus` / `TaskPriority` / `AgentRole` / `AgentTransportKind` / `TaskEventKind`。

输入类型(方案接口里引用但未展开的):

```ts
export interface CreateTaskInput {
  projectId: string;
  title: string;
  goal?: string;
  acceptance?: string;
  priority?: TaskPriority;
}
export interface TaskPatch {
  title?: string;
  goal?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  acceptance?: string;
  archivedAt?: number | null;
}
export interface AttachAgentInput {
  taskId: string;
  localId: string;
  claudeId?: string | null;
  role: AgentRole;
  transportKind: AgentTransportKind;
}
export interface AppendTaskEventInput {
  taskId: string;
  agentBindingId?: string | null;
  kind: TaskEventKind;
  message: string;
  data?: unknown;
}
```

`TaskStore` 接口逐字采用方案 §「TaskStore 接口」。实现要点(方案 §「实现建议」):

- 构造函数同步 `loadTasksFile()`;文件缺失 → 空结构 `{ version: 1, projects: [], tasks: [], agentBindings: [], events: [] }`。
- JSON 解析失败 → **不静默覆盖**:把损坏文件重命名为 `tasks.json.corrupt-<ts>` 后新建空结构,并 `console.error`(方案 §64)。
- 所有 mutation 走内部 `#save()`,`#save()` 维护 promise chain 串行化,写临时文件 + `chmod 0600` + rename(方案 §66)。
- `ensureProjectForWorkspace(workspace)`:按绝对路径精确匹配已有 project 的 `workspaceRoots`,命中即返回;否则新建 project(`name` 用 `basename(workspace)`,`id` 用 `crypto.randomUUID()`)。**不要**用 basename 做 id(方案 §530)。
- `attachAgent`:若 `role === 'main'`,先把该 task 下现存 active main binding(`endedAt === null`)置 `endedAt = Date.now()`;若 `input.localId` 已有其它 active binding(任意 task),**抛错**(路由层转 409,方案 §339)。
- `detachAgent`:只设 `endedAt`,不动 session(方案 §154)。
- 时间戳统一 `Date.now()`。

### 测试框架决策

项目当前无测试框架(方案 §498 允许先写轻量 Node 脚本)。
**决策**:用 Node 内置 `node:test` + `node:assert`,免新依赖(Node 24 环境,spec §2.7)。
加 `package.json` script:`"test": "node --test --disable-warning=ExperimentalWarning backend/*.test.ts"`。

### 验收

自动(方案 §「测试计划」1-6):

- [ ] 空文件(路径不存在)→ 构造出空结构,不抛错。
- [ ] `createTask` → `getTask` 读回字段一致;重启(新建 store 实例读同一文件)后仍一致。
- [ ] 写出的 `tasks.json` 权限位是 `0600`(`statSync().mode & 0o777 === 0o600`)。
- [ ] `attachAgent({role:'main'})` 两次 → 第一个 binding 的 `endedAt` 非 null,第二个为 null。
- [ ] 同一 `localId` 第二次 `attachAgent` 到另一个 task → 抛错。
- [ ] `detachAgent` 后,对应 session 不受影响(store 层不持有 session,断言 binding.endedAt 被设置即可)。
- [ ] 损坏 JSON → 不覆盖,原文件被改名保留,新结构可用。
- [ ] `npm run typecheck` 过。

### 不做

- 不接路由(step 3+)。
- 不写 event 聚合逻辑(step 5)。
- 不做 SQLite、不做迁移层(方案 §「非目标」)。

---

## Step 2 —— `wrapper serve` 入口

**依据**:方案 §「`wrapper serve` 入口」;spec §2.5(wrapper 必须在 tmux 内)、§4 守护进程。

### 改动文件

| 文件 | 动作 |
|---|---|
| `bin/wrapper.ts` | 加 `serve` 子命令分支 |

### 契约

`wrapper serve`:

- 走现有 `ensureDaemon(port)`(daemon.ts §210),确保 daemon 在跑。
- 打印网页链接:复用现有链接输出(`urlFor(state)`,daemon.ts §302)。
- **不**校验 `TMUX_PANE`,**不**生成 sessionId,**不** `POST /api/sessions`,**不** spawn claude。
- 随即 `process.exit(0)`。
- 尊重现有 `--port` / `PORT`(spec §4)。

现有 `daemon <status|restart|stop>` 子命令不变。实现是把 wrapper.ts 主流程里
「校验 tmux → sessionId → POST → spawn」那段跳过,只留 `ensureDaemon` + 链接输出。

### 验收

手动:

- [ ] 在非 tmux 终端跑 `wrapper serve` → 不报「必须在 tmux 内」,打印链接后退出。
- [ ] daemon 未运行时 → 拉起 daemon,链接可访问。
- [ ] daemon 已运行时 → 复用,不新起进程(PID 不变)。
- [ ] 跑完后无 claude 子进程产生(`pgrep -fl claude` 对比前后)。
- [ ] `wrapper`(无 serve)行为不变:tmux 内正常接管 pane。

### 不做

- 不加 UI 路由;这步只是让「不带会话地起 daemon」成为可能,供后续步骤验证任务视图。

---

## Step 3 —— 只读 API + 默认 project 聚合

**依据**:方案 §「API 设计」的 GET 三个端点;spec §1.1、§6(Origin + token 校验)。

### 改动文件

| 文件 | 动作 |
|---|---|
| `backend/server.ts` | 注册 3 个 GET 路由;实例化 `TaskStore` |
| `backend/taskStore.ts` | 若聚合需要新增只读辅助方法则补 |

### 契约

实例化:`server.ts` 里 `const tasks = new TaskStore(tasksPath())`,`tasksPath()` 读 `SYNAPSE_TASKS_PATH ?? ~/.synapse/tasks.json`。

所有路由复用 `checkOrigin(req, res)`(server.ts §70)。

**`GET /api/projects`** — 方案 §228 的形状。聚合逻辑(方案 §249):

- 默认 project:遍历 `manager.list()` 的 session workspace,对每个未被现有 project 覆盖的 workspace 调 `tasks.ensureProjectForWorkspace(workspace)`。这一步在请求处理时惰性执行(方案 §100)。
- `taskCount`:该 project 下 `status !== 'archived'` 的 task 数。
- `runningAgents`:该 project 所有 task 的 active binding 里,对应 session `manager.get(localId)?.state` ∈ `{busy, waiting, starting}` 的数量。（spec §「会话状态」枚举无 `starting` 之外的 `starting`;方案 §252 写的是 `busy/waiting/starting`,以方案为准。）
- `pendingApprovals`:该 project 所有 task 的 active binding 对应 session 的 `permissions.countFor(claudeId)` 之和。

**`GET /api/projects/:id/tasks`** — 方案 §255。每个 task 附:`agentCount`(active binding 数)、`mainAgent`(main binding 对应 session 的现有 summary 形状,方案 §285)、`pendingApprovals`、`lastEvent`(该 task 最后一条 event)。

**`GET /api/tasks/:id`** — 方案 §266 的形状:`{ task, project, agents: [{ binding, session, pending }], events }`。
`session` **直接用 `manager.list()` 里那条 summary 的形状**,不新造字段(方案 §285)。
`pending` 用 `permissions.listPending(claudeId)`。

404:project / task 不存在。

### 验收

自动(方案 §「测试计划」7):

- [ ] 起 daemon,开一个 stream-json 会话,`GET /api/projects` → 返回一个按该 workspace 生成的默认 project,`taskCount: 0`。
- [ ] 无 Origin 头 + 正确 token → 通过;错 token → 401;跨 Origin → 403。

手动:

- [ ] `wrapper serve` 起面板,现有 sessions 自动归入默认 project(方案 §504 步骤 3)。
- [ ] `GET /api/tasks/:id` 的 `session` 字段结构与 `GET /api/sessions` 中一致(逐字段比对)。

### 不做

- 不做写操作(step 4)。
- 不做 event 生成 —— 此时 `events` 恒为空数组,`lastEvent` 为 null。

---

## Step 4 —— 写 API + agent binding

**依据**:方案 §「API 设计」的 POST/PATCH/DELETE(除 `/agents/start`);spec §1.1。

### 改动文件

| 文件 | 动作 |
|---|---|
| `backend/server.ts` | 注册 `POST /api/tasks`、`PATCH /api/tasks/:id`、`POST /api/tasks/:id/agents`、`DELETE /api/tasks/:id/agents/:bindingId` |

### 契约

**`POST /api/tasks`**(方案 §287):body `{ projectId, title, goal?, acceptance?, priority? }`。
`title` 必填,缺失 → 400。创建 Task + 写 `task_created` event。返回 `GET /api/tasks/:id` 的详情形状。

**`PATCH /api/tasks/:id`**(方案 §307):允许 `title/goal/status/priority/acceptance/archivedAt`。
更新 `updatedAt`。status 变化写 `task_status_changed`,其它变化写 `task_updated`。返回详情形状。

**`POST /api/tasks/:id/agents`**(方案 §324):body `{ localId, role }`。

- 校验 `manager.get(localId)` 存在 → 否则 400。
- `role === 'main'` 时结束旧 main binding(TaskStore.attachAgent 内部已做)。
- session 已绑定其它 active task → 409(TaskStore 抛错,路由 catch 转 409)。
- `transportKind` 从 `manager.get(localId).transport` 读,不由客户端传。
- `claudeId` 从 session 读(可能为 null,后续认领后补 —— step 5 或后续)。
- 写 `agent_attached` event。返回详情形状。

**`DELETE /api/tasks/:id/agents/:bindingId`**(方案 §366):设 `binding.endedAt`,写 `agent_detached` event,**不关 session**。返回 `{ ok: true }`。

所有路由 `checkOrigin`。event 写入此步已接(step 5 只是补「从 SessionManager/PermissionEngine 派生」的那部分)。

### 验收

自动(方案 §「测试计划」8-9):

- [ ] `POST /api/tasks` → task 落盘,`GET /api/tasks/:id` 的 `events` 含一条 `task_created`。
- [ ] `POST /api/tasks/:id/agents` 绑定已有会话 → `agents` 数组出现该 binding,`events` 含 `agent_attached`。
- [ ] 同一 session 绑第二个 task → 409。
- [ ] `PATCH` 改 status → `events` 含 `task_status_changed`;改 title → `task_updated`。
- [ ] `DELETE .../agents/:bindingId` → binding.endedAt 非 null,`manager.get(localId)` 仍存在且 state 不变。
- [ ] `npm run typecheck` 过。

### 不做

- 不做 `/agents/start`(step 7)。
- 不做物理删除 task(方案 §128:归档用 `archivedAt` + `status:'archived'`)。

---

## Step 5 —— 任务事件聚合

**依据**:方案 §「事件聚合」;spec §2.13(SessionEnd)、§2.9(turn_end / stop_reason)、§4 PermissionEngine。

### 改动文件

| 文件 | 动作 |
|---|---|
| `backend/server.ts` | 在现有 `manager.onEvent` / `permissions.on*` 回调里追加 task event 派生 + broadcast |

### 契约

在 server.ts 已有的事件回调中,查 `tasks.bindingForSession(localId)`(或按 claudeId → localId → binding),查到 active binding 才写 event,否则**静默跳过**(方案 §412):

| 触发点 | 现有回调 | 新增 event |
|---|---|---|
| `permissions.onApprovalRequested` | server.ts §275 | `approval_requested`(能定位 binding 时) |
| `permissions.onApprovalResolved` | server.ts §286 | `approval_resolved` |
| SessionManager 收到 `turn_end` | `manager.onEvent` 的 `session_event` 分支 | `turn_completed` |
| session `state === 'exited'` | server.ts §269 | `agent_exited`,并把 binding `endedAt` 补上 |

`agent_attached` / `agent_started` 已在 step 4 / step 7 的路由里写,不在这里重复。

broadcast:新增 `{ type: 'task_event', taskId, event }` 消息,前端 step 6 消费。
**不改** WebSocket 协议结构,只加消息类型(全局约束 5)。

fail-safe 验证:binding 查不到时,原 `broadcast(e)` / `manager.setState` 等原有逻辑路径完全不变。

### 验收

自动:

- [ ] 绑定一个会话为 main,发一条会触发工具的 prompt,turn 结束后 `GET /api/tasks/:id` 的 `events` 出现 `turn_completed`。
- [ ] 未绑定任何 task 的会话触发 turn_end → `tasks.json` 的 events 数组不增长,`/api/sessions` 正常。

手动(方案 §509 步骤 7-8):

- [ ] 触发一次需批准操作(用 `AskUserQuestion` 或临时开 `ENABLE_FULL_APPROVAL`)→ 任务详情能看到 pending approval,任务流出现 `approval_requested`。
- [ ] 会话退出 → 任务流出现 `agent_exited`,binding.endedAt 落上。

### 不做

- 不解析 diff / artifacts 内容,只记文件名 / 工具名 / 回复摘要(handoff §90)。
- 不重构 WebSocket 协议(方案 §403)。

---

## Step 6 —— UI 三栏骨架

**依据**:方案 §「UI 实现」;视觉参考 `public/task-mock.html` / `public/task-mock.css`;spec §5(视觉风格:macOS 系统应用)。

### 改动文件

| 文件 | 动作 |
|---|---|
| `public/index.html` | 加任务视图容器 / 视图切换入口 |
| `public/app.js` | 加 projects/tasks/task-detail 渲染 + 数据拉取 + WS `task_event` 消费 |
| `public/app.css` | 并入 task-mock.css 的样式(去重,统一到现有 token) |
| `public/task-mock.html` / `task-mock.css` | 保留或删除 —— 见「mock 文件处置」 |

### 契约

- 三栏:项目列表 / 任务列表 / 任务详情(方案 §426)。
- **保留旧会话 overview 入口**(方案 §427、handoff §93):顶部或侧栏加视图切换,默认落哪个视图待定(建议默认任务视图,一个链接回 overview)。
- 项目列表项:name、task 数、运行中 agent 数、待批准数(方案 §427)。
- 任务列表项:title、goal 摘要、status、agent 数、待批准数(方案 §428)。
- 任务详情(方案 §429):目标 + 验收;main agent 卡片;sub agents 卡片;每个 agent 的 transport / state / context / cost / pending;任务流事件列表。
- 交互第一版(方案 §436):创建任务、编辑任务基本字段、绑定当前已有 session、点 agent 打开现有会话详情(复用 `renderDetail`)。「从任务启动子 agent」留 step 7。
- WS:收到 `task_event` 且当前正看该 task → 增量追加到任务流;否则刷新列表角标。参照 spec §2.10 教训 —— 首次拉取(HTTP)与增量(WS)必须落同一套渲染结构。
- 排序:项目按 name `localeCompare`,任务按 `createdAt`(呼应 spec §2.17 固定排序,不随状态跳动)。

### mock 文件处置

`public/task-mock.*` 是 git 未跟踪的视觉稿。**决策**:样式并入 `app.css` 后,把 mock 文件删除(不 commit),避免留下第二套漂移的样式源(呼应 spec §2.10 对「两份独立实现」的警惕)。

### 验收

手动(方案 §504 步骤 1-4;handoff §142 用 Chrome 无头截图):

- [ ] `wrapper serve` → 打开面板默认可见三栏,现有 sessions 归入默认 project。
- [ ] 创建任务 → 列表即时出现,刷新后仍在。
- [ ] 编辑 title / goal / status → 持久化,任务流出现对应 event。
- [ ] 把一个已有 tmux 会话绑为 main agent → 详情页 main 卡片显示其 state / context / cost。
- [ ] 点 agent 卡片 → 打开该会话的现有详情页(四页签)。
- [ ] 旧 overview 入口仍可达且功能不变。
- [ ] 移动端宽度无横向滚动、无文本溢出(spec §5 / 方案 §「测试计划」验证子 agent 那条的精神)。

### 不做

- 不做拖拽、批量操作、图形化 DAG(方案 §444)。
- 不把 sub agent 表示成独立项目(方案 §531)。

---

## Step 7 —— 从任务启动 stream-json 子 agent

**依据**:方案 §「POST /api/tasks/:id/agents/start」§「主 agent / 子 agent 规则」;spec §5.2(预检步)、§1.3(worktree)、§4 `CreateOptions.appendSystemPrompt`、§7(中断能力未决)。

### 改动文件

| 文件 | 动作 |
|---|---|
| `backend/server.ts` | 注册 `POST /api/tasks/:id/agents/start` |
| `public/app.js` | 「启动子 agent」表单 + 预检对话框 |
| `backend/worktree.ts` | **本步范围待定** —— 见「worktree 范围决策」 |

### 契约

**`POST /api/tasks/:id/agents/start`**(方案 §342):body `{ role, transport?, workspace, prompt?, model?, appendSystemPrompt? }`。

- `role: 'main'` + `transport: 'tmux'`:**第一版禁止从网页启动**(方案 §357)—— 网页接管不了用户 pane。返回 400,提示改用绑定已有 tmux 会话。
- `role: 'sub'`:默认 `transport: 'stream-json'`。
- 复用 `POST /api/sessions` 的创建路径(`manager.create(workspace, opts)`),`opts` 带 `appendSystemPrompt`(spec §4 —— 启动时读一次,运行中不可改)。
- 创建成功 → `tasks.attachAgent({ role:'sub', transportKind:'stream-json', ... })`。
- 有 `prompt` → `manager.send(localId, prompt)`(方案 §362)。prompt 建议套方案 §458 的模板(项目 / workspace / task / goal / acceptance / 子任务 / 收尾格式)。
- 写 `agent_started` event。
- 返回 `GET /api/tasks/:id` 详情形状。

**预检对话框**(spec §5.2):启动前一步,前端展示:目标 workspace、`git status --porcelain` 结果、worktree 策略选择、要注入的 system prompt 最终文本(可预览)、model。改动只作用本次,除非勾「设为该工作区默认」。

### worktree 范围决策(需在本步开工前定，可能拆子步)

spec §1.3 / §5.2 / §7 把 `backend/worktree.ts` 与 policy 存储层标为「待 Phase 1 子 agent 场景验证后落地」。
方案 §364 说「`backend/worktree.ts` 与 policy 存储层在本阶段落地」。**二者措辞有张力**。

**决策(建议)**:step 7 拆两个子步:

- **7a**:不带 worktree —— 子 agent 直接在传入 workspace 上跑,预检对话框只展示 `git status`(信息用途,不阻断),验证「从任务起 stream-json 子 agent + prompt 模板 + agent_started 事件 + 卡片状态」这条主链路。这对应方案 §509 步骤 6-7 的手动验证。
- **7b**:落 `backend/worktree.ts`(`createWorktree(spec)` 按 spec §1.3 的三策略)+ 最小 policy 存储(每 workspace 一份默认策略 + linkFiles,可先塞进 `tasks.json` 或单独文件)。`dirtyStrategy` 由预检对话框传入,后端不猜(spec §1.3)。

7b 是否纳入 Phase 1 收尾,取决于 7a 验证后是否确认「多子 agent 并行」是近期需求。若否,7b 连同 spec §7 的未决项一起延后 —— 本计划不强行拉进来。

### 验收

自动(方案 §「测试计划」最后一条):

- [ ] `POST /api/tasks/:id/agents/start { role:'sub', workspace }` → 创建 stream-json session 且 `GET /api/tasks/:id` 的 agents 含该 binding,`transportKind: 'stream-json'`。
- [ ] `role:'main', transport:'tmux'` → 400。
- [ ] 带 `prompt` → 子 agent 收到消息(session timeline 出现 user 条目)。
- [ ] `events` 含 `agent_started`。

手动(方案 §509 步骤 6-7):

- [ ] 从任务详情「启动子 agent」→ 预检对话框显示 workspace / git status / system prompt 预览。
- [ ] 确认后子 agent 卡片出现,state 从 starting → ready/busy,任务流更新。
- [ ] (7b)主库 dirty + 选 `require-clean` → 报错;选 `ignore` → worktree 从干净 HEAD 建出;`.env` 等 linkFiles 已搬过去。

### 不做

- 不做主 agent 受限编排 / 通过工具触发子 agent(方案 §534「后续演进」)。
- 不实测 stream-json 逐轮中断(spec §7 未决 —— 不在 Phase 1 解决)。
- 不做 clone 隔离(spec §1.3 —— 留作可选项)。

---

## Step 8 —— polish

**依据**:方案 §「实施顺序」8;handoff「待做」7。

### 范围

- 空状态:无项目 / 无任务 / 无 agent / 无事件的占位文案。
- 错误提示:409(session 已绑其它 task)、400(缺 title / tmux main)、404 的前端呈现。
- 旧 overview 入口的位置与措辞收敛(方案 §427)。
- tmux 死会话:agent 卡片显示「pane 已失效」(handoff §94 / §108,依赖 `TmuxTransport.alive()`)。
- 手动验证记录写入 spec(实测结论归 spec，CLAUDE.md)—— 方案 §498「不要跳过手动验证」。

### 验收

- [ ] 方案 §「测试计划」的「手动验证」8 步全部走通并记录。
- [ ] `npm run typecheck` 过。
- [ ] 旧 `/api/sessions` 行为、`wrapper`(非 serve)行为回归无变化(方案 §527)。

---

## 依赖与并行

```
Step 1 (TaskStore) ──┬── Step 3 (只读 API) ── Step 4 (写 API) ── Step 5 (事件聚合) ──┐
                     │                                                              ├── Step 6 (UI) ── Step 7 (启动子 agent) ── Step 8 (polish)
Step 2 (wrapper serve) ────────────────────────────────────────────────────────────┘
```

- Step 2 可与 Step 1 并行(独立文件)。
- Step 6 需要 Step 3-5 的 API,但可在 Step 5 未完时用 Step 3-4 的数据先搭骨架。
- Step 7b 的取舍在 Step 7a 验证后再定。

## 每步收尾清单

1. `npm run typecheck` 过。
2. 该步「验收」全部勾掉(自动 + 手动)。
3. 若触碰实测行为 → 先更新 `docs/spec.md`。
4. 单独 commit,message 说清「实现了方案哪一步」。
5. 杀掉测试用的 daemon / tmux 会话(handoff「测试注意」)。
