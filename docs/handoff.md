# 交接

## 现状

已完成并实测通过:

| 模块 | 文件 | 状态 |
|---|---|---|
| 传输抽象 | `backend/transport.ts` | ✅ |
| stream-json 传输 | `backend/streamJson.ts` | ✅ 多轮对话、上下文保留 |
| tmux 传输 | `backend/tmuxTransport.ts` | ✅ 自建会话 + 接管 pane 两种模式 |
| 权限引擎 | `backend/permissions.ts` | ✅ fail-closed 兜底 |
| 风险识别 | `backend/risk.ts` | ✅ 11 用例验证 |
| 多会话管理 | `backend/sessionManager.ts` | ✅ 双 ID 路由、可选传输 |
| 任务管理存储 | `backend/taskStore.ts` | ✅ 项目 / 任务 / agent 绑定 / 任务流事件,独立于 SessionManager |
| HTTP/WS 服务 | `backend/server.ts` | ✅ token + Origin 校验、端口递增 |
| 守护进程 | `backend/daemon.ts` | ✅ 双重健康检查、detached 拉起 |
| wrapper CLI | `bin/wrapper` + `bin/wrapper.ts` | ✅ 端到端打通 |
| 两层 UI | `public/` | ✅ 浅色 macOS 风格 |

规格见 `docs/spec.md`(已按实测校正)。注释规范见 `CLAUDE.md`。

运行:`npm run dev`,或在 tmux 里直接 `wrapper`。

## wrapper 的定位

**「带前置准备的 claude」** —— claude 就在用户当前 pane 里启动,拉起后端与注册会话只是不可见的准备工作。不新建会话、不切换、不制造额外层级。

```
$ wrapper
● synapse-e2e · 网页端 http://127.0.0.1:3000/?token=…
[claude 原生 TUI 就地打开]
```

流程:校验在 tmux 内(取 `TMUX_PANE`)→ 确保后端运行 → 提示同目录已有会话 → 预置信任(首次明确告知)→ 生成 sessionId → `POST /api/sessions` 带 `transport:'tmux'` + `paneId` + `sessionId` → 拿回 `settingsPath` → `spawn claude --settings <path> --session-id <uuid>` 接管本 pane。

**不在 tmux 内时直接提示,不隐式建会话** —— 那会把用户弹进他没要求的环境。

**同目录允许并存**,仅提示「已有 N 个活跃会话(pane %X)」不阻拦 —— 两个终端开同一项目本就合法,裸 claude 亦然。共用 settings 无冲突(钩子按 claudeId 路由)。

实测链路已验证:网页发提示词 → 注入用户 pane → claude 执行 → PreToolUse 钩子回传 → 网页批准 → 工具放行。并发双会话下归属正确(实测批准请求与 pane 实际执行内容一一对应)。

## 备选方向

### Claude 组织者 / Codex 执行者

一个可选方向是 Claude Code 作为组织者,负责拆解、调度与汇总;Codex 作为执行者,负责具体实现、验证、审查或调查任务。见 spec §1.2。尚未决定是否由 Synapse 实现。

若选择 Synapse 实现,第一步做自有 agent bus:注册 Codex worker、支持 Claude -> Codex 的 `send_message`、等待执行者 turn 完成并回收最终回复与执行过程摘要。不要把生产路径押在 Codex app-server 里的 experimental collab/subagent 控制面上。

## 待做

### 1. Claude 下的任务管理

首选方向是先实现 Claude Code 体系内的任务管理,层级为 **项目 -> 任务 -> agents**。见 spec §1.1。

推荐按以下顺序实现,避免一次性重写现有会话页:

1. **数据模型与存储**
   - 新增 `TaskStore`,独立于 `SessionManager`。
   - 本地持久化先落 `~/.synapse/tasks.json`,权限 `0600`。
   - `Project`:id、name、workspaceRoots、goal、createdAt、updatedAt。
   - `Task`:id、projectId、title、goal、status、priority、acceptance、createdAt、updatedAt、archivedAt。
   - `AgentBinding`:id、taskId、localId、role(`main`/`sub`)、transportKind(`tmux`/`stream-json`)、createdAt、endedAt。

2. **只读 API**
   - `GET /api/projects`:项目列表,带任务数量、运行中 agent 数、待批准数。
   - `GET /api/projects/:id/tasks`:任务列表,聚合所属 agent 状态。
   - `GET /api/tasks/:id`:任务详情,包含 agent bindings、关联会话摘要、任务流事件。
   - 先从现有 sessions 按 workspace 自动生成默认 project,不要要求用户先建项目。

3. **基础写 API**
   - `POST /api/tasks`:在项目下创建任务。
   - `POST /api/tasks/:id/agents`:把现有会话绑定为 main/sub agent。
   - `PATCH /api/tasks/:id`:改 title、goal、status、priority、acceptance。
   - `DELETE /api/tasks/:id/agents/:bindingId`:解除绑定,不关闭底层会话。

4. **UI 骨架**
   - 以 `public/task-mock.html` 为视觉参考,把现有首页重组为三栏:项目、任务、任务详情。
   - 第一版保留原会话详情页能力,只是在任务详情里嵌入/链接对应会话。
   - 任务详情展示主 agent、子 agent、状态、pending approval、context、cost、最近输出。

5. **从任务启动 agent**
   - 主 agent 默认用 `tmux` transport,对应用户可接管的 Claude TUI。
   - 子 agent 默认用 `stream-json` transport,作为后台执行 worker。
   - 新建子 agent 时复用 `POST /api/sessions`,再创建 `AgentBinding` 归入任务。

6. **任务流事件**
   - 新增 task event log:task_created、agent_attached、agent_started、approval_requested、turn_completed、agent_finished、task_status_changed。
   - 事件来自 TaskStore 写操作和 SessionManager/PermissionEngine 的现有事件聚合。
   - 不在第一版解析完整 diff/artifacts,先记录文件名、工具名、最终回复摘要。

7. **收敛与清理**
   - 给老的纯会话 overview 保留入口,直到任务视图稳定。
   - 补 tmux 死会话标记后,任务 agent 卡片同步显示 `pane 已失效`。
   - 再考虑任务归档、验收结果、批量启动子 agent。
   - ✅ 未绑定会话可见性:`wrapper` 起的 tmux 会话不再只能靠手动绑定进任务视图。
     中栏任务列表上方加了「未绑定会话」区(`GET /api/projects/:id/tasks` 的
     `unboundSessions` 字段),每行一个「转为任务」按钮 → `POST /api/tasks/from-session`
     建任务 + 挂为 main agent。见 spec §5「任务」条目。
     待做:目前没有删除任务的端点,误转的任务只能改 status 为 archived 隐藏。
   - ✅ 列表行样式收敛:`.nav-item.on` / `.proj-row.on` / `.task-row.on` 三处选中态
     原本略有出入,现共用一条规则;`.unbound-row` 并入 `.task-row.unbound`。
     布局(会话单栏 vs 任务两栏)不动 —— 两者取舍不同,见 spec §5。

### 1b. 任务主 agent 调度 + 共享文档库(Phase 1 之后)

设计与 9 步落地顺序:`docs/design/main-agent-orchestration.md`。命名统一见 spec §0.1。

要点:主 agent 是一等 Claude 会话,背四项职责(定 work dir、维护 handoff、拆解分派、沉淀
进度/changelog);调度用 `synapse agent {context,spawn,wait,doc}` 子命令(daemon HTTP 的
瘦客户端),**不用 MCP**;沉淀的文档落独立 git repo `synapse-tasks`,仿 `~/gb/kit3588-plan`。
`plan §411 / §534` 明确把这块划在 Phase 1 之外。

### 2. UI 适配 tmux 会话

tmux 会话的「终端输出」页签可用 `TmuxTransport.capture()` 做镜像,目前未接。

会话标识已完成:显示名优先用 claude 的 ai-title(说明会话在做什么),标题生成前退回 pane ID。见 `docs/notes/claude-code-behavior.md`「ai-title」。

### 3. 注入残留

实测见到过输入框残留上一次未提交的文本(`❯ show me app.js`)。`#inject` 开头有 `C-u` 清理,但时机可能不够稳。会话忙碌时注入的行为需要再验。

### 4. 死会话在网页端的呈现

按决定,pane 消失后的会话**不自动清理**,留给网页集中管理。`TmuxTransport.alive()` 已可查询承载体是否还在,但尚未接进会话摘要 —— UI 需要据此标出「pane 已失效」并提供关闭入口。

## 关键约束(改代码前必读)

**钩子超时是 fail-open。** 默认约 600 秒,超时后工具照常执行。后端必须自管截止时间:settings 配 `HOOK_TIMEOUT_S=300`,内部 `DECISION_TIMEOUT_MS=280_000` 到点主动 deny。绝不能依赖钩子超时。

**钩子 URL 必须用实际监听端口。** 端口占用时后端递增重试,若 hook 配置里写死初始端口,钩子会打到无人监听处而失败 —— 等同于 fail-open,所有工具无审批执行。故 `writeHookSettings(请求端口, 实际端口)` 两个端口分开传,URL 用实际端口。

**pending 表必须以 `tool_use_id` 为键。** 同一会话可能多个工具并发等待,仅按 `session_id` 索引会串。

**hook 配置写 daemon 级文件,不碰用户仓库。** `daemon.ts` 的 `writeHookSettings()` 写一份 `~/.synapse/<端口>/hooks.settings.json`(`0600`),内容只有 `hooks`;所有会话 `--settings` 指向它,由 Claude Code 与用户自己的 `.claude/settings*.json` 按事件名 + matcher 求并集(`--settings` 是叠加不是覆盖,实测 + 官方文档确认)。**不要**再往工作区的 `.claude/settings.local.json` 里写东西 —— 那样裸 `claude` 也会读到 hook、两个会话共用一份、退出后残留打死后端。见 spec §3.1。

**信任对话框无法用钩子处理** —— 信任发生在钩子加载之前。已用 `TmuxTransport.ensureTrusted()` 预置解决。这是代用户作安全决定,CLI 在首次信任某目录时明确告知(该方法返回 true 表示本次新写入)。

**接管模式下 pane 属于用户。** `stop()` 任何情况都不销毁它。

**会话 ID 必须由 CLI 指定,不能事后推断。** 按转写文件 mtime 认领在同目录并存时会张冠李戴,批准请求随之路由到错误的会话(网页批准 A、实际放行 B)。CLI 生成 UUID 并经 `--session-id` 传给 claude。踩过一次,见 `docs/notes/implementation-lessons.md`。

**`bin/wrapper`(重命名后 `bin/synapse`)必须是纯 JS。** 类型剥离只认 `.ts` 扩展名;版本闸门也必须留在薄壳里,否则低版本 Node 在 import 时就先崩了,提示永远显示不出来。

## 未决事项

- **中断能力** — stream-json 下 `interrupt()` 发 SIGINT,可能杀掉整个会话,未验证
- **Artifacts 页签** — 后端未采集产出物;落盘路径规范已定(spec §0.2:`~/.synapse/artifacts/<cwd 转写>-<sessionId 前 8 位>/`)
- **diff 内容** — 只列文件名与类型,不显示具体 diff
- **崩溃恢复** — 后端退出会带走 stream-json 子进程(tmux 不受影响),`--resume` 流程未设计

## 测试注意

- tmux 测试会话统一用 `synapse_` 前缀,**测完必须清理**;`kill-session` 不一定带走 claude 进程,需另行确认无孤儿(`pgrep -fl <工作区名>`)
- 改了后端代码后要先杀掉旧守护进程,否则 `ensureDaemon` 会复用跑着旧代码的实例(踩过:新加的返回字段一直取不到)
- 临时测试脚本放项目内(scratchpad 不受 `"type": "module"` 影响会被当 CJS),用完删除
- 不要用 `echo hello` 这类提示词测钩子 —— 模型会直接回答而不调工具
- 验证 UI 用 Chrome 无头截图:`--headless --screenshot=... --virtual-time-budget=4000`
