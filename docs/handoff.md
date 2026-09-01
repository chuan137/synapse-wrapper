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

## Phase 1 已完成(2026-09-01)

**Claude 下的任务管理**,层级 **项目 -> 任务 -> agents**(spec §1.1)。已实现并手动验证:

- `TaskStore`(`backend/taskStore.ts`),独立于 `SessionManager`,落 `~/.synapse/tasks.json`。`Project` / `Task` / `AgentBinding` / `TaskEvent`。
- 只读 API:`GET /api/projects`、`GET /api/projects/:id/tasks`(带 `unboundSessions`)、`GET /api/tasks/:id`。现有 sessions 按 workspace 自动归入默认 project。
- 写 API:`POST /api/tasks`、`POST /api/tasks/:id/agents`(绑定)、`POST /api/tasks/from-session`(转为任务)、`PATCH /api/tasks/:id`、`DELETE /api/tasks/:id/agents/:bindingId`(解绑不关会话)、`POST /api/tasks/:id/agents/start`(启动 stream-json 子 agent + 预检对话框,见 spec §5.2)。
- UI 三栏:项目 / 任务 / 任务详情。「未绑定会话」区 + 「转为任务」。列表行选中态收敛(`.nav-item.on` / `.proj-row.on` / `.task-row.on` 共用一条规则)。旧会话 overview 入口保留。
- 任务流事件:`GET /api/tasks/:id` 首拉与 WS `task_event` 增量同一套渲染。
- tmux 死会话卡片标「pane 已失效」;binding 被存活巡检 `endedAt` 后转「已解绑」。

**未纳入 Phase 1**(收尾评估非近期需求,延后 —— spec §7):

- worktree 隔离:`backend/worktree.ts` + `dirtyStrategy` 三策略 + policy 存储(spec §1.3 / §5.2)。子 agent 目前直接在传入 workspace 上跑。
- Artifacts 后端采集(spec §0.2 定了路径,页签暂空)。
- 删除任务的端点 —— 误转的任务只能改 status 为 archived 隐藏。

## 待做

### 主 agent 调度 + 共享文档库(下一步)

设计与 9 步落地顺序:`docs/design/main-agent-orchestration.md`。命名统一见 spec §0.1。

要点:主 agent 是一等 Claude 会话,背四项职责(定 work dir、维护 handoff、拆解分派、沉淀
进度/changelog);调度用 `synapse agent {context,spawn,wait,doc}` 子命令(daemon HTTP 的
瘦客户端),**不用 MCP**;沉淀的文档落独立 git repo `synapse-tasks`,仿 `~/gb/kit3588-plan`。
`plan §411 / §534` 明确把这块划在 Phase 1 之外。

### UI 适配 tmux 会话

tmux 会话的「终端输出」页签可用 `TmuxTransport.capture()` 做镜像,目前未接。

会话标识已完成:显示名优先用 claude 的 ai-title(说明会话在做什么),标题生成前退回 pane ID。见 `docs/notes/claude-code-behavior.md`「ai-title」。

### 注入残留

实测见到过输入框残留上一次未提交的文本(`❯ show me app.js`)。`#inject` 开头有 `C-u` 清理,但时机可能不够稳。会话忙碌时注入的行为需要再验。

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
