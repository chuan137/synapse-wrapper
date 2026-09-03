---
status: draft
builds-on: phase1-implementation-plan.md（Phase 1 完成后的下一步；plan §411 / §534 明确把「主 agent 受限编排」划在 Phase 1 之外）
spec-refs: [§0.1, §1.1, §1.3, §1.4, §2.1, §2.2, §3.1, §4, §5.2, §7]
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

给 `synapse` 加一组 `agent` 子命令(命名见 spec §0.1),复用 `bin/synapse` 这个无扩展名 JS 薄壳、实现在 `bin/synapse.ts` 的 `agent` 分支(spec §2.2 —— 类型剥离只认 `.ts`)。这组子命令是 daemon HTTP 端点的瘦客户端,从数据目录(默认 `~/.synapse/`,`SYNAPSE_DATA_DIR` 覆盖)的 `port` / `token` 文件拿地址与凭据,不自己持有任何状态。

主 agent 启动时 `manager.create()` 注入三个环境变量:`SYNAPSE_TASK_ID`(本任务 id)、`SYNAPSE_AGENT_BINDING`(主 agent 自己的 binding id)、`SYNAPSE_DATA_DIR`(定位 `port`/`token`,继承自 daemon 进程环境)。`synapse agent` 的每个子命令据此定位任务与 daemon,主 agent 不必手动传 id。

### 交互协议:一次调用 = 一个 HTTP 请求,不在 CLI 侧维持长连接

早期设想里 `synapse agent wait` 直接 hang 在一个长轮询 HTTP 上,阻塞到子 agent 本轮结束。这条路径有三个问题:(1)HTTP 长连接跨 daemon 重启必断,`wait` 的退出码无法区分「子 agent 真的异常」和「只是 daemon 重启了」;(2)主 agent 的 Bash 工具在 `wait` 期间完全占住,主 agent 自己也没法响应用户;(3)stream-json 子 agent 是短命进程(spec §1 对照表),daemon 一挂子 agent 就没了,`wait` 却还在傻等。

改成 **每个 `synapse agent` 调用都是一次短 HTTP 请求、立刻返回**,状态由 daemon 侧的 `TaskStore` 事件日志持有,CLI 侧不 hang:

| 子命令 | 方法 · 端点 | 请求即返回,返回什么 |
|---|---|---|
| `synapse agent context` | `GET /api/tasks/:id/agent-context` | work dir、目标、验收、当前 `handoff.md`、**每个子 agent 的最新状态行**(binding id / workspace / `running\|idle\|exited` / 最近一次 `turn_completed` 的摘要 / pending 批准数)。主 agent 每次决策前先拉一次,这是它的唯一真相源 |
| `synapse agent spawn --workspace <dir> --handoff <file> [--strategy …]` | `POST /api/tasks/:id/agents/spawn` | 起一个 stream-json 子 agent,`--handoff` 文件内容拼进首轮 prompt,`send()` 后**立即返回新 binding id**(不等子 agent 干完)。worktree 隔离(spec §1.3)在这一步落地 |
| `synapse agent poll <bindingId> [--since <seq>]` | `GET /api/tasks/:id/agents/:bindingId/events?since=<seq>` | 该子 agent 自 `<seq>` 以来的事件(`turn_completed` / `agent_exited` / `approval_requested`),每条带单调递增 `seq`。**无新事件立即返回空**,不 hang。stdout 是 NDJSON,最后一行打印 `{"cursor": <最新 seq>}` 供下次 `--since` |
| `synapse agent await <bindingId> [--timeout 600]` | 循环调 `poll`,daemon 侧不 hang | CLI 侧的便利包装:每 2s 调一次 `poll`,直到出现该子 agent 的 `turn_completed`(本轮结束)或 `agent_exited`,或 `--timeout` 到点。**轮询逻辑在 CLI 里,不在 daemon**,所以 daemon 重启只是让某几次 `poll` 失败重试,不影响最终判定。退出码见下 |
| `synapse agent doc <kind> [< file]` | `GET` / `PUT` / `POST` 文档端点(见下) | `kind ∈ {handoff, progress, changelog}`,stdin 有内容则写、无则读。`changelog` 走 `POST`(append-only) |

**为什么保留 `await` 这个便利包装** —— 主 agent 的心智模型就是「spawn 一个,等它回来,读结果,再 spawn 下一个」。让它自己写 `while true; do synapse agent poll …; sleep 2; done` 是噪音。`await` 把轮询收进一个命令,但轮询发生在**主 agent 这条 tmux 会话的子进程里**,不占 daemon 连接;主 agent 的会话仍然是 busy(它在等一个 Bash 命令返回),这点无法回避 —— 但主 agent 本来就是串行调度者,一次只推进一个子任务。要并行等多个,主 agent 改用 `poll --since` 自己轮而不用 `await`。

### `await` 的退出码语义

| 退出码 | 含义 | 主 agent 应做 |
|---|---|---|
| `0` | 子 agent 本轮 `turn_completed`,正常结束 | 读 `context` 里该 binding 的摘要,决定下一步 |
| `10` | 子 agent `agent_exited`(进程退出:干完自然退出 / claude 崩溃 / 被 stop) | 读 `context` 看最后一条 `turn_completed` 有没有;没有就是异常,主 agent 记进 changelog 并决定重试还是换策略 |
| `11` | `--timeout` 到点,子 agent 还在跑 | 不代表失败。主 agent 可以再 `await` 一次,或先去干别的、稍后 `poll` |
| `20` | daemon 连不上(多次 `poll` 全失败) | daemon 可能在重启。主 agent 等一会重试 `context`;`context` 能通了说明 daemon 回来了,子 agent 状态从事件日志恢复 |

关键:退出码只反映 **daemon 事件日志里的事实**,不反映 CLI 自己的连接状态。`await` 内部某次 `poll` 失败会静默重试(指数退避,上限 5 次),只有连续全失败才是 `20`。

### daemon 重启中断调度链 —— 分传输讨论

- **主 agent 是 tmux(推荐)**:主 agent 长命,`synapse daemon restart` 不碰它。重启窗口内它正在跑的 `await` 会经历几次 `poll` 失败 → 退避重试 → daemon 回来 → 从 `TaskStore` 事件日志续上。**前提**:子 agent 的 `turn_completed` / `agent_exited` 事件在 daemon 挂掉前已落盘。stream-json 子 agent 随 daemon 一起没了的情况 —— 主 agent 的 `await` 会拿到 `agent_exited`(daemon 重启时 `SessionManager` 探活发现子进程没了,补一条),退出码 `10`,主 agent 据 `context` 判断该子任务做完没、要不要重新 `spawn`。
- **主 agent 是 stream-json**:daemon 一挂,主 agent 和它所有子 agent 一起没。整条链断,无人 `await`。这条路径只用于「纯后台、一次性、能容忍从头再来」的编排。完整恢复依赖 spec §7「崩溃恢复」,那个还没设计。

**主 agent 用 `tmux` 还是 `stream-json` —— 这不只是「要不要终端」,是调度链能不能扛后端重启。** tmux 会话是长命的(claude 活在 tmux 里,独立于 daemon 存活,重启后重新接管,spec §1 对照表);stream-json 会话是短命的,daemon 一退出就带走 claude,进行中的整条调度链(主 agent + 它 spawn 的所有子 agent)一起断。

- **tmux 主 agent**(推荐,也是网页启动的默认):**由网页直接起,走 `TmuxTransport` 的自建会话模式**(不是接管用户 pane —— 见下「网页启动 tmux 主 agent」)。用户能 `tmux attach` 看它怎么调度,`synapse daemon restart` 加载新代码也不打断它。子 agent 仍是 stream-json(短命),但主 agent 在,断了的子 agent 可由主 agent 重新 spawn。
- **stream-json 主 agent**:纯后台、一次性、能容忍从头再来的编排任务用。daemon 一退出丢整条链,`synapse agent await` 也随之中断 —— 呼应 spec §7「崩溃恢复」尚未设计。

两种都能调 `synapse agent` —— 子命令只依赖环境变量和 daemon HTTP,与 transport 无关。

### 网页启动 tmux 主 agent —— 自建会话,不接管 pane

spec §5.2 原来写「`role:'main' + transport:'tmux'` 从网页起返回 400」,那条针对的是**接管模式**(`synapse` CLI 拿 `TMUX_PANE` 接管用户当前所在的 pane —— 网页确实动不了那个 pane)。网页要起的是**另一回事**:`TmuxTransport` 自建一个 tmux 会话(handoff:「自建会话 + 接管 pane 两种模式」),claude 跑在里面,没有「用户的 pane」这个概念。这条路放开。

```
POST /api/tasks/:id/agents/spawn   { role:'main', transport:'tmux', workspace, model? }
  → manager.create(workspace, { transport:'tmux', tmuxMode:'own-session',
                                settingsPaths:[hooks, main-agent],   // 受限 settings,见「约束主 agent 的行为」
                                appendSystemPrompt:<调度者职责>, model,
                                env:{ SYNAPSE_TASK_ID, SYNAPSE_AGENT_BINDING, SYNAPSE_DATA_DIR } })
  → TmuxTransport: tmux new-session -d -s synapse-main-<taskId>
       → 会话内 spawn: claude --settings <hooks> --settings <main-agent>
                              --session-id <uuid> --append-system-prompt <…> [--model <…>]
  → tasks.attachAgent({ role:'main', transportKind:'tmux' }) + agent_started 事件
  → 返回 taskDetail
```

**会话名固定为 `synapse-main-<taskId>`。** 一个任务至多一个主 agent(已有活跃 main binding 时端点 409),名字因此唯一,也是 daemon 重启后扫回的锚点(见下)。

**详情页绿卡给一个「attach」动作** —— 复制 `tmux attach -t synapse-main-<taskId>` 到用户手边。网页仍不能替用户切终端窗口焦点(和 `TmuxTransport.focus()` 一样的边界),但把命令递到位。

**解绑 = kill-session。** 自建会话没有「pane 归用户」的顾虑(那条原则只管接管模式)。任务做完或用户在详情页「解绑」主 agent 时,`DELETE /api/tasks/:id/agents/:bindingId` 对 `role:'main' && transportKind:'tmux' && 自建` 的 binding 额外跑 `tmux kill-session -t synapse-main-<taskId>`。普通 tmux 会话(`synapse` CLI 起的、接管 pane 的)解绑仍只断绑定不碰会话 —— 两者靠「是不是 `synapse-main-` 前缀的自建会话」区分。

**daemon 重启后自动扫回。** daemon 启动路径(挨着 `migrateLegacyStateDir()`)加一步:`tmux list-sessions` 找 `synapse-main-*`,对每个还活着的会话,按会话名里的 taskId 查 `TaskStore` 的 main binding,`SessionManager` 用转写文件 + 探活重新认领(和现有 tmux 重连同一套,见 `notes/implementation-lessons.md`)。会话没了(用户手动 kill 过)则把 binding `endedAt`,详情页显示「已退出」。重启窗口内漏记的子 agent turn 见「未决」。

## 约束主 agent 的行为

主 agent 是一个**完整的 Claude 会话**,手里默认有全套工具(Bash / Write / Edit / Read / Task…)。要让它只当调度者、不越界自己改代码,靠 `--append-system-prompt` 讲职责是**不够的** —— 那只是「倾向」,没有强制力,它随时可能「顺手改一下」。真正的约束落在 **Claude Code settings 层的 `permissions`**。

### 能力边界:Bash 白名单,无 Write/Edit,无 Task

daemon 为主 agent 单独写一份 settings(`<数据目录>/main-agent.settings.json`,`0600`,内容只有 `permissions`),叠在共用的 `hooks.settings.json` 之后(`--settings` 可传多个,叠加,spec §3.1):

```json
{
  "permissions": {
    "allow": [
      "Bash(synapse agent:*)",
      "Bash(git log:*)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git show:*)",
      "Bash(ls:*)", "Bash(cat:*)", "Bash(rg:*)", "Bash(find:*)",
      "Read(**)"
    ],
    "deny": ["Write(**)", "Edit(**)", "NotebookEdit(**)", "Task", "WebFetch", "WebSearch"]
  }
}
```

- **`allow` 是能力全集**:调度(`synapse agent`)+ 只读观测(git 只读子命令、`Read`、`rg`)。主 agent 想推进任务,唯一的出口是 `synapse agent spawn`。
- **Bash 是白名单,不是黑名单。** 黑名单挡不住 `python -c "open(...,'w')"` 这类绕过 `Write` 的写法。`deny` 里列的 `Write` / `Edit` 等是「即使将来有人往 `allow` 里加了通配也要挡住」的第二道;主防线是「不在 `allow` 里的 Bash 一律不自动放行」。
- **白名单外的 Bash 会卡住,这是有意的 fail-safe。** 主 agent 会话按 spec §2.1 默认(PreToolUse matcher 只匹配 `AskUserQuestion`),未 `allow` 的 Bash 交回 Claude Code 内置权限;`default` 模式下内置弹终端确认。网页自建的 tmux 主 agent 会话默认没人 attach,确认弹窗没人点 —— 命令挂住。卡住比放行安全,且主 agent 本就不该跑白名单外的命令。
- **`Task` 必须 deny。** 否则主 agent 用 Claude Code 原生子代理绕开整个 `synapse agent spawn`:那些子代理不进任务视图、不受 worktree 隔离(§1.3)、不进事件日志。
- **这份 settings 只发主 agent。** 子 agent、`synapse` CLI 起的普通 tmux 会话都不受影响(靠 `spawn` 端点 `role:'main'` 分支才叠 `main-agent.settings.json`)。

### handoff / progress / changelog 只能经 `synapse agent doc` 写

主 agent 没有 `Write` / `Edit`,连自己写 `handoff.md` 初版也不行 —— 全部走 `synapse agent doc <kind>`(后端 `backend/taskDocs.ts` 代写进 `synapse-tasks` repo + `git commit`,见下「文档端点」)。这把「主 agent 沉淀文档」这个职责收进一个受控通道:内容经后端校验(`:kind` 白名单、路径不穿越)、渲染标记区由后端刷新、commit 消息统一。主 agent 不直接碰 `synapse-tasks` 的文件系统,也不碰 git。

### attach 进主 agent 会话的用户也受限

网页自建的 tmux 主 agent 长命、扛重启,用户可以 `tmux attach -t synapse-main-<taskId>` 进去手动敲命令。上面的 `permissions` 对**用户的手动输入同样生效** —— Claude Code 不区分「主 agent 自己发的命令」和「用户手敲的」。这是接受的取舍:主 agent 会话就是个**只读调度典台**,用户想在这个仓库里手动干活,应另开一个普通 `synapse` 会话(那个不带受限 settings)。

### system prompt 仍然写,但只作基线

`--append-system-prompt`(spec §4 `CreateOptions.appendSystemPrompt`)由后端在起主 agent 时拼:说明它是调度者、四项职责、`synapse agent` 五个子命令的用法、「先 `doc handoff` 再 `spawn`」的顺序要求。这段只在启动时读一次(spec §7「唯一干净的注入点是启动前」),讲清楚**该怎么做**;`permissions` 兜住**不能做什么**。两者配合,不互相替代。

## 任务共享文档库

主 agent 沉淀的进度 / change log 落一个**独立 git repo**(工作名 `synapse-tasks`),仿 `~/gb/kit3588-plan` 的 team memory bank:按维度分目录、不同颗粒度、`git commit` 留痕、可跨项目 review。

**它是 memory bank,但和 `kit3588-plan` 不是同一物种 —— 它是 task memory bank。**

| | `kit3588-plan`(team memory bank) | `synapse-tasks`(task memory bank) |
|---|---|---|
| 写入者 | 多个**人**,各自更新 `team/<name>.md` | 一个**主 agent**,经 `synapse agent doc`;人不直接写 |
| 读者 | 队友之间对账、避免冲突 | 子 agent(handoff 拼进 prompt)+ 用户看进度 |
| 组织维度 | 按人 / topic / 决策 | 按 project / task |
| harness | `grain`(git log → 标记区) | `backend/taskDocs.ts` 的 `renderState`(TaskStore 事件 → 标记区) |
| 生命周期 | 长期演进的团队状态 | 一个任务从拆解到收尾的调度记录 |

共同骨架(memory bank 的定义特征):独立 git repo、按维度分目录、`git commit` 留痕、标记区内机器渲染 / 标记区外自由叙述、格式规范在 repo 自己手里(一个放 `CLAUDE.md`,一个放 skill)。

**不取代什么:**

- **不取代用户项目的 `docs/`** —— `synapse-tasks` 存的是**过程记录**(某次用主 agent 干这个任务时怎么拆的、子 agent 交了什么),不是**设计事实**(那还在各自仓库的 spec / notes / design 里)。
- **不取代 `~/.synapse/tasks.json`** —— 那是结构化状态(TaskStore),机器读写;`synapse-tasks` 是人类可读的叙述,git 可 review。`renderState` 是从前者渲染进后者的桥。
- **不取代 Claude Code 的 auto-memory**(`~/.claude/projects/.../memory/`)—— 那是写代码的 Claude 跨会话的记忆;`synapse-tasks` 是主 agent(调度者)的工作产物。

**为什么独立放 `~/gb/synapse-tasks`,不埋进 `~/.synapse/`:**

- **不复用 `kit3588-plan`** —— 受众和颗粒度都不同,把 Synapse 的运行产物混进去会污染它。
- **不落 `~/.synapse/`** —— 那里全是 daemon 运行时状态(`0600`、不进 git、换 `SYNAPSE_DATA_DIR` 隔离测试)。把一个 git repo 埋进去,心智上它会变成「daemon 内部文件」,没人会想着 push;`cd ~/.synapse && git status` 和 `cd ~/.synapse/tasks && git status` 一个报错一个是 repo,徒增困惑。放 `~/gb/` 下和 kit3588-plan、lynxi 并列,天然是「可 push、可分享、有历史」的东西 —— 这正是 memory bank 的价值所在。

```
synapse-tasks/
  CLAUDE.md                              ← 这个 repo 是什么、目录结构、何时 commit(仿 kit3588-plan/CLAUDE.md)
  .claude/skills/synapse-handoff/SKILL.md ← 交接文件的推荐结构(见下「skill 初版」)
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

### 交接文件写什么 —— 分四层,harness 只钉死机制

「handoff 该长什么样」这个问题不进 Synapse 代码。参照 `~/gb/kit3588-plan`:那个 memory bank 的格式规范写在 **repo 根的 `CLAUDE.md`** 里(每个字段标「人写 / grain 渲染 / 人写+grain 标注」),`grain` 只碰标记区,标记区外是自由叙述**但有推荐结构**。Synapse 照搬这个分层:

| 层 | 谁拥有 | 可否覆盖 | 内容 |
|---|---|---|---|
| 路径 + `synapse agent doc` 通道 + `git commit` | Synapse harness(代码) | 否 | `projects/<slug>/<taskId>/{handoff,progress,changelog}.md`、读写端点、commit 时机 |
| 标记区**内** | Synapse harness(`renderState`) | 否 | 机器派生的量(子 agent 数、turn 数、改动文件数、耗时、pending 数) |
| 标记区**外的推荐结构** | `synapse-handoff` skill | 是(项目 CLAUDE.md 改写) | section 划分、每次更新写什么、字段归属表 |
| 标记区外的**实际叙述** | 主 agent + workspace CLAUDE.md | —— | 具体内容,项目自定 |

- **选项 3(harness 钉死结构化字段)否掉** —— 钉死的 schema 永远不够用(项目 A 要风险登记、B 要依赖图),且把整个文件变成标记区,跟 memory bank「标记区外自由」的初衷冲突。
- **选项 1(只给文件系统)否掉** —— 主 agent 冷启动没抓手,同一用户的不同任务交接文件长得都不一样。
- skill 是 **baseline**,项目自己的 `CLAUDE.md` 是 **override**,优先级与「用户的话 > 项目系统 > 默认」一致。

**skill 住在 `synapse-tasks` repo 里**,不进 Synapse 代码 —— 它是那个 repo 自己的资产,可独立演进(发现某种结构更好用就改 skill):

```
synapse-tasks/
  .claude/skills/synapse-handoff/SKILL.md
```

主 agent 的 work dir 是**用户的项目仓库**,不是 `synapse-tasks`。daemon 起主 agent 时给 `--add-dir <synapse-tasks 路径>`,Claude Code 把那个目录的 `.claude/skills/` 也纳入;`--append-system-prompt` 里一句「写 / 更新交接文档前先加载 `synapse-handoff` skill」。

### `synapse-handoff` skill 初版

> 建 `synapse-tasks` repo 时把下面内容落成 `.claude/skills/synapse-handoff/SKILL.md`。这里是草案,skill 上线后以 repo 里那份为准。

```markdown
---
name: synapse-handoff
description: >-
  写或更新 Synapse 任务的 handoff.md / progress.md / changelog.md 时加载。
  给出三个文件的推荐结构和字段归属。项目自己的 CLAUDE.md 可以改写这里的建议。
---

# Synapse 交接文档的写法

你是任务的主 agent。这三个文件是你的调度记录,也是子 agent 的输入和用户的进度窗口。
只经 `synapse agent doc <kind>` 读写 —— 不直接编辑文件,不碰 git。

`<!-- synapse:begin state --> … <!-- synapse:end -->` 之间由后端渲染,**不要手写**,
你写的内容一律在标记区外。

## handoff.md —— 子任务分派的依据

子 agent `spawn` 时,它这一段会拼进子 agent 的首轮 prompt。写给子 agent 看,不是写给用户。

- **目标** —— 一段话。这个任务做完是什么样。从 Task.goal 起草,按你的理解补全。
- **work dir** —— 子 agent 该在哪个目录工作。多个子任务涉及不同目录就在子任务里分别标。
- **验收** —— 可检验的条目。子 agent 拿这个判断自己做完没。
- **子任务** —— 编号列表。每条:一句话描述 + work dir(若与上面不同)+ 依赖哪条先完成。
  一条子任务对应一次 `synapse agent spawn`。
- **约束 / 上下文** —— 子 agent 不看代码就不知道的前提(接口不能改、某文件是生成的…)。

项目的 CLAUDE.md 若要求额外 section(风险登记、依赖图…),照它的。

## progress.md —— 每次子 agent 返回后更新

标记区内是后端渲染的量。你在标记区外写:

- **当前状态** —— 一句话。整个任务推进到哪。
- **最近一轮** —— 上一个返回的子 agent 做了什么、结论是什么、你据此决定下一步做什么。
- **阻塞** —— 卡在什么上。没有就写「无」。
- **下一步** —— 你接下来要 spawn 什么,或在等什么。

## changelog.md —— append-only,一条一个子 agent 产出

`synapse agent doc changelog` 是追加。每条:

- 哪个子 agent(binding 前缀)、做了什么、改了哪些文件、怎么验证的、剩余风险。
- 子 agent 异常退出没产出也记一条,写明「未完成」和你的处置(重试 / 换策略 / 搁置)。

不写流水账 —— 一条对应一次有意义的交付,不是每个 turn 一条。
```

### 文档端点

`backend/taskDocs.ts` 暴露给 daemon,`synapse agent doc` 与 UI 都经这里读写 `synapse-tasks` repo。

| 端点 | 行为 |
|---|---|
| `GET /api/tasks/:id/docs/:kind` | 读 `projects/<slug>/<taskId>/<kind>.md`,不存在返回按任务字段生成的骨架(目标 / work dir / 验收从 `Task` 带) |
| `PUT /api/tasks/:id/docs/:kind` | 写 `handoff` / `progress`(整体替换标记区外内容);写完 `git add` + `commit` |
| `POST /api/tasks/:id/docs/changelog` | 追加一条 changelog(append-only),body 是一段 markdown;`commit` |
| (内部)`renderState(taskId)` | 从 `TaskStore` 事件日志渲染 `<!-- synapse:begin state -->` 区,`PUT`/`POST` 与子 agent 返回时各调一次 |

`:kind` 白名单 `handoff | progress | changelog`,其它值 400。`<project-slug>` 由 `Project.name` 走 `localeCompare` 安全化(空格转 `-`、去掉路径分隔符),与 `taskId`(UUID)一起定位目录,避免主 agent 传入的路径穿越。

repo 不存在时 `backend/taskDocs.ts` 首次写入前 `git init` + 放一份 `CLAUDE.md`(内容仿 `~/gb/kit3588-plan/CLAUDE.md`:说明这个 repo 是主 agent 的共享记忆库、目录结构、何时 commit)+ 放 `.claude/skills/synapse-handoff/SKILL.md`(上面「skill 初版」的内容)。之后这两份由 `synapse-tasks` repo 自己维护,Synapse 代码不再覆盖。

## 未决

- ~~**子 agent 事件的 `seq`**~~ —— ✅ 落地顺序第 2 步已做。`TaskStore` 加 store 级自增 `seq`,落 `tasks.json` 的 `eventSeq`;旧文件从已有事件的最大 `seq` 恢复。`TaskEvent.seq` 严格递增、重启不回退,`eventsForBinding(bindingId, sinceSeq)` 按 `seq > since` 过滤,是第 5 步 `poll --since` 的后端。
- **`turn_completed` 摘要的来源**:`context` 要打印每个子 agent「最近一次 turn 的结论」。现在 `emitTaskEvent(…, 'turn_completed', '轮次完成')` 的 message 是固定串,`context` 的 `lastTurnSummary` 就先取这个固定串。要把 `turn_end` 事件的 `result`(最终 assistant 文本,见 `backend/transport.ts`)带进 `TaskEvent.data`,`context` 改从那里取。改动文件列表同理 —— 从子 agent 的 transcript 解析(`backend/transcript.ts`)或 `turn_end` 载荷带出。
- **重启窗口内漏记的 `turn_completed`**:tmux 主 agent 扛得住重启,但 daemon 挂掉的那几秒里子 agent 若正好结束一轮,`turn_end` 事件到不了 daemon。子 agent 是 stream-json、随 daemon 一起没,重启后 `SessionManager` 探活补 `agent_exited`,但「最后那轮干了什么」丢了 —— 主 agent 只能靠 `context` 里的 handoff/changelog 和 worktree 里的实际改动对账。完整恢复依赖 spec §7。

## 落地顺序

每步可独立验证,不重写现有会话页:

1. ~~**`wrapper` → `synapse` 重命名 sweep**(spec §0.1)~~ —— ✅ 已完成。`bin/wrapper*` → `bin/synapse*`、`package.json` 的 `bin` 键、`backend/` 与 `public/` 注释、living docs(spec / handoff / notes)里的 `wrapper` 字样已一次性改,`npm run typecheck` 通过。子命令分发挂在 `bin/synapse` → `bin/synapse.ts` 的 `main()` 上。
2. ~~**`TaskEvent.seq` + `synapse agent context` 骨架**~~ —— ✅ 已完成。`TaskStore` 加 `eventSeq`(落 `tasks.json`)+ `TaskEvent.seq`(严格递增、重启不回退)+ `eventsForBinding(bindingId, sinceSeq)`。`bin/synapse.ts` 的 `argv[0]` 分发加 `agent` 分支 → `bin/agent.ts`(daemon HTTP 瘦客户端,`readState()` 拿 `port`/`token`,`SYNAPSE_TASK_ID` 拿任务 id),`context` 走 `GET /api/tasks/:id/agent-context`(后端 `agentContext()`):打印 work dir(主 agent 会话工作区,未起时退回 project 首个 root)/ 目标 / 验收 / 每个 `role:'sub'` binding 的状态行(binding 前缀 + `running｜idle｜exited` + workspace + 最近 `turn_completed` 摘要 + pending 数)。`SYNAPSE_TASK_ID` 未设 / daemon 没跑 → 明确报错。`spawn`/`poll`/`await`/`doc` 未实现。
3. ~~**主 agent 启动路径(网页自建 tmux 会话)**~~ —— ✅ 已完成。`POST /api/tasks/:id/agents/start` 的 `role:'main'` 分支放开 `transport:'tmux'`(替换掉原 400;端点名沿用 `/start`,`spawn` 重命名留到第 5 步）。`TmuxTransport` 的自建会话模式(`sessionName` 给定、无 `paneId`)本就存在,补:`TmuxOptions.env`(`tmux new-session -e KEY=VAL` 注入,tmux 3.2+)+ 自建会话也带 `--session-id`(不再按 mtime 猜)。`CreateOptions.env?: Record<string,string>` 注入 `SYNAPSE_TASK_ID` / `SYNAPSE_AGENT_BINDING`(`AttachAgentInput.id` 预生成)/ `SYNAPSE_DATA_DIR`。会话名 `synapse-main-<taskId>`,已有活跃 main binding → 409。`appendSystemPrompt` 拼**基线**调度者职责 + `synapse agent context` 用法(完整职责文档 + `doc handoff` 流程 + 受限说明留到第 4/7 步)。spawn 后 `send()` 一句首轮 prompt 让主 agent 立即开始(自建会话默认没人 attach)。**信任对话框坑**:web 端 `resolve()` 不解符号链接,claude 按真实路径查信任,自建会话撞信任框默认「No, exit」→ claude 退 → 会话消失;端点改用 `realpathSync`(对齐 CLI),`#waitReady` 的兜底也从「Enter」改成「Down + Enter」。UI:详情页「启动主 agent」按钮 + 绿卡「attach」动作(复制 `tmux attach -t synapse-main-<taskId>`)。**受限 settings 未做**(第 4 步)—— 当前主 agent 有全套工具。
4. **主 agent 受限 settings**(见「约束主 agent 的行为」)—— `daemon.ts` 新增 `writeMainAgentSettings()`,写 `<数据目录>/main-agent.settings.json`(`0600`,只有 `permissions`:Bash 白名单 + `deny` Write/Edit/Task)。`CreateOptions` 的 `settingsPath` 改成 `settingsPaths?: string[]`,透传成多个 `--settings`;`role:'main'` 时把这份路径叠在共用 `hooks.settings.json` 之后。共用那份仍只放 `hooks`,不加 `Bash(synapse agent:*)` 的 allow —— 那条只在主 agent 的受限 settings 里(普通会话不需要)。
   - **解绑 kill-session**:`DELETE /api/tasks/:id/agents/:bindingId` 对自建主 agent binding(名字 `synapse-main-` 前缀)额外 `tmux kill-session`;接管 pane 的普通会话解绑仍只断绑定。
   - **重启扫回**:`daemon.ts` 启动路径加一步 `tmux list-sessions` → `synapse-main-*` → 按名里的 taskId 查 main binding → `SessionManager` 走现有 tmux 重连认领;会话已没则 binding `endedAt`。
5. **`spawn` + `poll` + `await`** —— `spawn` 调现有 sub 分支,`--handoff <file>` 内容进子 agent 首轮 prompt(替换 `subAgentPrompt()` 的硬编码模板),`send()` 后立即返回 binding id。`poll <bindingId> --since <seq>` 走 `GET …/events?since=`,NDJSON 输出 + 末行 cursor,**不 hang**。`await` 是 CLI 侧循环调 `poll`(退避重试,退出码 `0/10/11/20`,见上)。`turn_end` 的 `result` 与改动文件带进 `TaskEvent.data`。`AgentBinding` 加 `parentBindingId`,任务流加 `subagent_dispatched` / `subagent_returned`。
6. **worktree 隔离** —— `spawn` 走 spec §1.3 的 `dirtyStrategy`,落地 `backend/worktree.ts`。`--strategy require-clean|ignore|carry-stash`。
7. **`backend/taskDocs.ts` + `synapse-tasks` repo** —— 上面四个文档端点 + `synapse agent doc`。repo 首次写入前 `git init` + 放 `CLAUDE.md` + 放 `.claude/skills/synapse-handoff/SKILL.md`(「skill 初版」的内容)。`PUT`/`POST` 后 `git add` + `commit`(不 push)。第 3 步起主 agent 时给 `--add-dir <synapse-tasks 路径>`,`appendSystemPrompt` 加「写交接文档前加载 `synapse-handoff` skill」。
8. **渲染标记区** —— `renderState(taskId)` 从 `TaskStore` 事件日志渲染 `<!-- synapse:begin state -->` 区,`PUT`/`POST` 与每次子 agent 返回时刷新。
9. **UI** —— 任务详情页加三个文档 tab(handoff / progress / changelog)+ 子 agent 树(按 `parentBindingId` 缩进)。

**参考实现**:`~/gb/kit3588-plan`(team memory bank 的目录结构与 CLAUDE.md 写法)、`~/gb/lynxi/grain/`(git log → markdown 标记区渲染工具,对应第 8 步)。
