---
status: draft
builds-on: phase1-implementation-plan.md（Phase 1 完成后的下一步；plan §411 / §534 明确把「主 agent 受限编排」划在 Phase 1 之外）
spec-refs: [§0.1, §1.1, §1.3, §1.4, §2.2, §3.1, §4, §7]
notes-refs: [notes/claude-code-behavior.md, notes/implementation-lessons.md]
---

# 任务主 agent 与子 agent 的调度

Phase 1 的 Step 7a(见 `../phase1-implementation-plan.md`)让子 agent 由**用户在网页手动点「启动子 agent」**触发。这份设计是 Phase 1 之后的下一步:把「调度」这个动作交给任务里的一个**主 agent**。

主 agent 是一个正常的 Claude 会话,额外背四项职责:

1. 确定 work dir
2. 写并维护 handoff 文档
3. 把任务拆成子任务,分派给子 agent
4. 把进度与 change log 沉淀成结构化文档(见下「共享文档库」)

## 调度用 CLI,不用 MCP

本项目的架构已经是「CLI(`synapse`)+ HTTP daemon」两层,主 agent 调度子 agent 的本质是「发命令 + 等结果」,HTTP 请求 + 长轮询就够 —— 不需要 MCP 的双向流、常驻进程和第三种协议表面。

给 `synapse` 加一组 `agent` 子命令(命名见 spec §0.1),复用 `bin/synapse` 这个无扩展名 JS 薄壳、实现在 `bin/synapse.ts` 的 `agent` 分支(spec §2.2 —— 类型剥离只认 `.ts`)。这组子命令是 daemon HTTP 端点的瘦客户端,从 `~/.synapse/<请求端口>/`(`port` / `token`)拿地址与凭据,不自己持有任何状态。

主 agent 启动时 `manager.create()` 注入两个环境变量:`SYNAPSE_TASK_ID`(本任务 id)、`SYNAPSE_AGENT_BINDING`(主 agent 自己的 binding id)。`synapse agent` 的每个子命令据此定位任务,主 agent 不必手动传 id。

| 子命令 | 对应端点 | 行为 |
|---|---|---|
| `synapse agent context` | `GET /api/tasks/:id` | 打印 work dir、目标、验收、当前 `handoff.md`、已有子 agent 列表及状态 |
| `synapse agent spawn --workspace <dir> --handoff <file>` | `POST /api/tasks/:id/agents/start` | 起一个 stream-json 子 agent,`--handoff` 文件内容作为交接文本拼进子 agent 首轮 prompt;worktree 隔离(spec §1.3 `dirtyStrategy`)在这一步落地。打印新 binding id |
| `synapse agent wait <bindingId>` | 长轮询 `GET /api/tasks/:id` | 阻塞到该子 agent 本轮 `turn_end` 或 `exited`,stdout 打印最终回复摘要 + 改动文件 + 失败原因,退出码区分「完成 / 异常退出」 |
| `synapse agent doc <kind> [< file]` | 文档端点(见下) | `kind ∈ {handoff, progress, changelog}`,stdin 写入 / 无 stdin 时读出。`changelog` 是 append-only |

**主 agent 调 `synapse agent` 的 Bash 调用不能每次弹网页批准。** daemon 写 `hooks.settings.json` 时(spec §3.1)同时在同一份 settings 里加 `permissions.allow: ["Bash(synapse agent:*)"]` —— `--settings` 是叠加(spec §3.1),这条 allow 与用户仓库自己的规则求并集,只放行这一个前缀。

**主 agent 用 `tmux` 还是 `stream-json` —— 这不只是「要不要终端」,是调度链能不能扛后端重启。** tmux 会话是长命的(claude 活在 pane 里,独立于后端存活,重启后重新接管,spec §1 对照表);stream-json 会话是短命的,后端一退出就带走 claude,进行中的整条调度链(主 agent + 它 spawn 的所有子 agent)一起断。

- **tmux 主 agent**(推荐用于长任务):在终端用 `synapse` 起、再绑为 main。用户能 attach 看它怎么调度,`synapse daemon restart` 加载新代码也不打断它。子 agent 仍是 stream-json(短命),但主 agent 在,断了的子 agent 可由主 agent 重新 spawn。
- **stream-json 主 agent**:纯后台、一次性的编排任务用。后端重启会丢整条链,`synapse agent wait` 也随之中断 —— 呼应 spec §7「崩溃恢复」尚未设计。

两种都能调 `synapse agent` —— 子命令只依赖环境变量和 daemon HTTP,与 transport 无关。

**主 agent 的职责写进 `--append-system-prompt`(spec §4 `CreateOptions.appendSystemPrompt`)。** 由后端在起主 agent 时拼:说明它是调度者、四项职责、`synapse agent` 四个子命令的用法、以及「先产出 handoff 再 spawn」的顺序要求。这段只在启动时读一次,符合「唯一干净的注入点是启动前」(spec §7)。

## 任务共享文档库

主 agent 沉淀的进度 / change log 落一个**独立 git repo**(工作名 `synapse-tasks`),仿 `~/gb/kit3588-plan` 的 team memory bank:按维度分目录、不同颗粒度、`git commit` 留痕、可跨项目 review。

- **不复用 `kit3588-plan`** —— 那是团队规划库,受众和颗粒度都不同,把 Synapse 的运行产物混进去会污染它。
- **也不落 `~/.synapse/`** —— 那里的东西不进 git、不天然可分享,而「team shared document」的价值正在可分享和有历史。

```
synapse-tasks/
  CLAUDE.md                       ← 主 agent 的读写职责说明(仿 kit3588-plan/CLAUDE.md)
  projects/<project-slug>/
    <taskId>/
      handoff.md    ← 目标 / work dir / 验收 / 子任务拆解。人给初版(或留空),主 agent 维护
      progress.md   ← 进度快照。主 agent 每次子 agent 返回后更新
      changelog.md  ← 变更记录,append-only,一条对应一个子 agent 的产出
```

repo 路径可配(环境变量 `SYNAPSE_TASKS_REPO`,默认 `~/gb/synapse-tasks`),测试用独立路径隔离。后端 `backend/taskDocs.ts` 管这个 repo 的读写与 `git add/commit`(push 与否可配,默认不 push —— 本机单用户先不引入远端)。commit 消息仿 kit3588-plan:`task <id>: handoff` / `task <id>: subagent <binding> returned`。主 agent 只通过 `synapse agent doc` 间接写,不直接碰 git。

### 颗粒度对齐:机器派生的量与主 agent 的判断分开

`progress.md` / `changelog.md` 里各留一个渲染标记区:

```
<!-- synapse:begin state -->
（后端从 tasks.json 事件日志渲染:子 agent 数、turn 数、改动文件数、耗时、pending 数）
<!-- synapse:end -->
```

标记区**内**由 `backend/taskDocs.ts` 从 `TaskStore` 的事件日志渲染,主 agent 不手写;标记区**外**是主 agent 写的人类叙述(下一步、阻塞、取舍理由)。这对应 `kit3588-plan` 里 `grain` 工具的角色(git log → 渲染进 markdown 标记区),也呼应 `~/gb/kit3588-plan/docs/agent-init-discussion.md` 的判断:判定层不做抽象推理,只把可测量的量摆出来,推理留给人 / 主 agent。

### 文档端点

`backend/taskDocs.ts` 暴露给 daemon,`synapse agent doc` 与 UI 都经这里读写 `synapse-tasks` repo。

| 端点 | 行为 |
|---|---|
| `GET /api/tasks/:id/docs/:kind` | 读 `projects/<slug>/<taskId>/<kind>.md`,不存在返回按任务字段生成的骨架(目标 / work dir / 验收从 `Task` 带) |
| `PUT /api/tasks/:id/docs/:kind` | 写 `handoff` / `progress`(整体替换标记区外内容);写完 `git add` + `commit` |
| `POST /api/tasks/:id/docs/changelog` | 追加一条 changelog(append-only),body 是一段 markdown;`commit` |
| (内部)`renderState(taskId)` | 从 `TaskStore` 事件日志渲染 `<!-- synapse:begin state -->` 区,`PUT`/`POST` 与子 agent 返回时各调一次 |

`:kind` 白名单 `handoff | progress | changelog`,其它值 400。`<project-slug>` 由 `Project.name` 走 `localeCompare` 安全化(空格转 `-`、去掉路径分隔符),与 `taskId`(UUID)一起定位目录,避免主 agent 传入的路径穿越。

repo 不存在时 `backend/taskDocs.ts` 首次写入前 `git init` + 放一份 `CLAUDE.md`(内容仿 `~/gb/kit3588-plan/CLAUDE.md`:说明这个 repo 是主 agent 的共享记忆库、目录结构、何时 commit)。

## 未决

- `synapse agent wait` 的长轮询要复用哪个已有的 turn 边界信号(`stop_reason`,见 `notes/claude-code-behavior.md`)。
- 子 agent 异常退出时 `wait` 的退出码语义。
- **后端重启中断调度链**:stream-json 主 agent 及其子 agent 全是短命进程(spec §1 对照表),`synapse daemon restart` 或后端崩溃会丢整条链、`wait` 悬空。tmux 主 agent 能扛重启(它自己长命),但重启窗口内子 agent 的 `turn_completed` 事件可能漏记 —— 主 agent 重连后靠 `synapse agent context` 重新对账。完整恢复流程依赖 spec §7「崩溃恢复」,那个还没设计。

## 落地顺序

每步可独立验证,不重写现有会话页:

1. ~~**`wrapper` → `synapse` 重命名 sweep**(spec §0.1)~~ —— ✅ 已完成。`bin/wrapper*` → `bin/synapse*`、`package.json` 的 `bin` 键、`backend/` 与 `public/` 注释、living docs(spec / handoff / notes)里的 `wrapper` 字样已一次性改,`npm run typecheck` 通过。子命令分发挂在 `bin/synapse` → `bin/synapse.ts` 的 `main()` 上。
2. **`synapse agent context` 骨架** —— `bin/synapse.ts` 的子命令分发加 `agent` 分支,先只做 `context`:读 `~/.synapse/<port>/`(port/token)+ `SYNAPSE_TASK_ID` 环境变量 → `GET /api/tasks/:id` → 打印 work dir / 目标 / 验收 / 子 agent 列表。
3. **主 agent 启动路径** —— `POST /api/tasks/:id/agents/start` 的 `role:'main'` 分支:`manager.create()` 注入 `SYNAPSE_TASK_ID` / `SYNAPSE_AGENT_BINDING`(`CreateOptions` 加 `env?: Record<string,string>`,透传进 transport 的 spawn),`appendSystemPrompt` 拼调度者职责 + `synapse agent` 用法 + 「先 handoff 再 spawn」。tmux 主 agent 仍走终端 `synapse` 起后绑定(spec §5.2 的 400 不变),env 由 CLI 注入。
4. **Bash allow 规则** —— `daemon.ts` 的 `writeHookSettings()` 写的那份 settings 加 `permissions.allow: ["Bash(synapse agent:*)"]`(`--settings` 叠加,spec §3.1)。
5. **`synapse agent spawn` + `wait`** —— `spawn` 调现有 sub 分支,`--handoff <file>` 内容进子 agent 首轮 prompt(替换 `subAgentPrompt()` 的硬编码模板)。`wait <bindingId>` 长轮询 `GET /api/tasks/:id`,盯 `turn_completed` / `agent_exited`。`AgentBinding` 加 `parentBindingId`,任务流加 `subagent_dispatched` / `subagent_returned`。
6. **worktree 隔离** —— `spawn` 走 spec §1.3 的 `dirtyStrategy`,落地 `backend/worktree.ts`。`--strategy require-clean|ignore|carry-stash`。
7. **`backend/taskDocs.ts` + `synapse-tasks` repo** —— 上面四个文档端点 + `synapse agent doc`。repo 首次写入前 `git init` + 放 `CLAUDE.md`。`PUT`/`POST` 后 `git add` + `commit`(不 push)。
8. **渲染标记区** —— `renderState(taskId)` 从 `TaskStore` 事件日志渲染 `<!-- synapse:begin state -->` 区,`PUT`/`POST` 与每次子 agent 返回时刷新。
9. **UI** —— 任务详情页加三个文档 tab(handoff / progress / changelog)+ 子 agent 树(按 `parentBindingId` 缩进)。

**参考实现**:`~/gb/kit3588-plan`(team memory bank 的目录结构与 CLAUDE.md 写法)、`~/gb/lynxi/grain/`(git log → markdown 标记区渲染工具,对应第 8 步)。
