# Synapse Wrapper — 系统规格

用 Web 界面驱动 Claude Code,支持多工作区并行会话与网页端工具批准。

> 本文档中标注「实测」的结论均在 **Claude Code 2.1.226 / macOS** 上验证过。
> 早期版本的规格基于对 tmux 方案的推测,其中多处与实际行为不符,已按实测重写。

---

## 0. 命名与路径约定

### 0.1 CLI 命名:单一 `synapse` 命令 + 子命令

历史上入口叫 `wrapper`,`wrapper daemon <...>` 是它的子命令,主 agent 调度设计(`docs/design/main-agent-orchestration.md`)又拟了个独立的 `synapse-agent`。统一成**一个 `synapse` 命令**,其余都是子命令:

| 旧 | 新 |
|---|---|
| `wrapper [目录] [-- <claude 参数>]` | `synapse [目录] [-- <claude 参数>]`(默认动作:就地拉起 claude,不变) |
| `wrapper daemon <start\|status\|restart\|stop>` | `synapse daemon <start\|status\|restart\|stop>` |
| `synapse-agent <context\|spawn\|wait\|doc>` | `synapse agent <context\|spawn\|wait\|doc>` |

`bin/wrapper` → `bin/synapse`(无扩展名 JS 薄壳,§2.2 约束不变),`bin/wrapper.ts` → `bin/synapse.ts`,`package.json` 的 `bin` 键 `wrapper` → `synapse`。子命令分发在薄壳之后的实现里按 `argv[0]` 分:无参或路径 → 就地起 claude;`daemon` / `agent` → 各自的子模块。`agent` 子命令是 daemon HTTP 端点的瘦客户端(见 `docs/design/main-agent-orchestration.md`),不是单独的 binary。

**代码重命名尚未执行** —— 本节先定约定,`bin/`、`backend/`、`package.json` 与各处注释里的 `wrapper` 字样待统一改。改的时候一次性 sweep,`npm run typecheck` 兜底。

### 0.2 Artifacts 路径:`~/.synapse/artifacts/<cwd 转写>-<sessionId 前缀>/`

会话产出物(Artifacts 页签,§5;后端目前未采集,见 handoff)统一落:

```
~/.synapse/artifacts/<cwd 路径转写>-<sessionId 前 8 位>/
```

- `<cwd 路径转写>` 与 Claude Code 转写目录同一套规则:斜杠转连字符,前导斜杠保留成前导连字符(如 `/Users/me/proj` → `-Users-me-proj`)。**不要自行推算**能拿到的路径 —— 能从钩子/事件载荷取到就取(见 `docs/notes/claude-code-behavior.md`)。
- `<sessionId 前 8 位>`:裸 UUID 的前 8 个字符,同目录并存的多个会话据此分开,不必写全长。
- 与 `worktrees/`(§1.3)、`tasks.json`(§1.4)、`<port>/`(§4)平级,都在 `~/.synapse/` 下;artifacts 按会话分、不按端口分(产出物跟会话走,不跟 daemon 实例走)。

目录不自动清理(呼应 §1.3 worktree、接管模式下 tmux pane 归用户的处置原则)—— 里面是会话的产出。UI 提供显式删除入口。

---

## 1. 架构

```
        +----------------------------------------------------------+
        |                       浏览器 UI                           |
        |  任务视图:项目 / 任务 / 任务详情(默认)                  |
        |  会话视图:优先级流 + 单会话详情                           |
        |    详情页签:改动文件 / Artifacts / 对话 / 终端输出        |
        +---------------------------+------------------------------+
                    WebSocket       |      HTTP
                 (状态与事件推送)    | (提示词、批准决策、任务读写)
                                    v
        +----------------------------------------------------------+
        |                        Web 后端                           |
        |  SessionManager   — 多会话生命周期、运行时统计            |
        |  PermissionEngine — 钩子接收 + 决策挂起(fail-closed)     |
        |  SessionTransport — 传输抽象(tmux / stream-json)        |
        |  TaskStore        — 项目 / 任务 / agent 绑定 / 任务流事件 |
        |                     独立于 SessionManager,单向引用会话   |
        +--------+---------------------+-------------------------+--+
                 |                     |                         |
    HTTP 钩子响应 |                     | NDJSON over stdin/stdout | tmux paste-buffer
   (allow / deny) |                     |   (StreamJsonTransport)  | + tail 转写文件
                 v                     v                         v
        +----------------------------------------------------------+
        |  claude(--settings <hook 配置>)  × N                    |
        |    tmux 接管(长命):用户 pane 里的原生 TUI,进程独立于   |
        |      后端存活,wrapper/synapse CLI 起                     |
        |    stream-json(短命):后端 spawn 的子进程,后端退出即消失 |
        |      网页从任务里起的子 agent                             |
        +----------------------------------------------------------+
```

**两种传输并存,不是先后替代;本质区别是生命周期归谁。**

最初的实现(初始提交「tmux 包装 + 网页监管」)只有 tmux。后来加了 `StreamJsonTransport`(`claude -p --input-format stream-json`,双向 NDJSON),消除了缓冲区注入、ANSI 清洗、转写解析。

| | `TmuxTransport`(长命会话) | `StreamJsonTransport`(短命会话) |
|---|---|---|
| 进程归属 | 活在用户的 tmux pane 里,后端只是旁路观察者 | 后端 `spawn` 的子进程 |
| 后端重启 | claude 照跑,后端重启后重新探活接管(`notes/implementation-lessons.md`) | 随后端退出被带走(§7「崩溃恢复」) |
| 终端 | 可 attach,用户能直接在 pane 里接手 | 无 TTY,`AskUserQuestion` 等交互工具会挂起(§5.1) |
| 注入 / 观测 | paste-buffer 注入 + tail 转写文件 | stdin/stdout 双向 NDJSON |
| 用在 | `wrapper`/`synapse` CLI 就地拉起的会话(用户要能在自己的 pane 里干活) | 网页从任务里启动的后台子 agent |

两条路径共用一份转写解析逻辑(`backend/transcript.ts`,见 `notes/claude-code-behavior.md`)与同一套 hook 协议。

### 1.1 Claude 下的任务管理

在 Claude Code 体系内实现任务管理,形成 **项目 -> 任务 -> agents** 的层级(Phase 1,已实现 —— 历史方案见 `docs/phase1-task-management.md`)。

- 项目(Project):对应一个工作区或一组相关工作区,承载目标、上下文、会话列表与任务集合。
- 任务(Task):项目内可追踪的工作单元,记录目标、状态、优先级、负责人/参与 agent、关联会话、产物与验收结果。
- agents:执行任务的 Claude Code 会话。一个任务可以绑定一个主 agent,也可以挂多个辅助 agent;agent 的运行状态、权限请求、最终回复和中间执行过程都归入所属任务。

不引入跨 CLI 执行者,只把 Claude 会话纳入任务视图:用户先选项目,在项目下创建或选择任务,再把一个或多个 Claude 会话挂到任务上。UI 顶层是「项目 / 任务 / agents」三层导航,底层复用 SessionManager、PermissionEngine 与 SessionTransport。

任务管理状态应独立于 SessionManager。SessionManager 继续只负责会话生命周期、传输与运行时统计;Project/Task/AgentBinding 由新的任务存储维护,通过 localId/claudeId 引用现有会话,不要把项目、任务、验收等业务字段塞进 Session 对象。

### 1.2 备选方向:Claude 组织者 / Codex 执行者

一个可选的多 agent 方向是 **Claude Code 作为组织者、Codex 作为执行者** 的分层模型。该方向尚未决定是否由 Synapse 实现,暂作为架构备选记录。

Claude 会话负责理解目标、拆解任务、决定并行度、汇总结果与向用户解释取舍。Codex 会话作为被调度的执行 worker,负责在指定工作区内完成明确、边界清楚的实现、验证、审查或调查任务。

Synapse 后端提供 agent bus,而不是依赖某个 CLI 内部的 session 间通信协议:

- `AgentRegistry` 记录可调度的执行者:agentId、类型、workspace、thread/session ID、状态、角色与最近活动。
- `send_message` 把 Claude 的任务投递到目标 Codex thread/session,底层优先走 Codex app-server 的 thread/turn 协议。
- `wait_agent` 监听目标执行者的 turn 完成事件,把最终回复、执行过程摘要、文件变更与失败原因返回给组织者。
- 所有跨 agent 消息落后端事件日志,用于网页展示、权限审计与失败恢复。

若未来选择由 Synapse 实现,这层 bus 应作为 Synapse 自有能力:第一版只需要支持 Claude -> Codex 的单向调度和结果回收,不要把生产路径押在 Codex 内部 experimental collab/subagent 协议上。Codex app-server 暴露的 `collabAgentToolCall`、`spawnAgent`、`sendInput` 等事件可以展示和研究,但暂不作为稳定控制面。

### 1.3 任务 agent 的 worktree 隔离(设计,未实现)

> **状态**:`backend/worktree.ts` 与 policy 存储层**尚未落地**。Phase 1 收尾时评估「多子 agent 并行」不是近期需求,连同 §7 的未决项一起延后。当前从任务启动的子 agent 直接在传入 workspace 上跑(见 §5.2)。本节是待实现时的设计约束。

从任务启动子 agent 时,让 agent 在一个独立的 `git worktree` 上工作,而非直接进主工作区 —— 多个子 agent 并行改同一个仓库、或用户自己正在主库里操作时,不互相踩。这一节定死这个机制在「主库 dirty」下的行为。

**`git worktree add` 不要求主库 clean。** 它从某个 commit(默认 `HEAD`)拉一个新目录,主库的未提交改动留在原地、不跟过去。所以「建不建得出来」不是问题;真正的问题是**主库那些未提交改动 agent 看不到** —— 新 worktree 拿到的是干净的 `HEAD`。

按「主库 dirty 的改动与本次任务的关系」分三种策略,由预检步(见 §5.2)让用户选,后端不替他猜:

| 策略 | 适用 | 行为 |
|---|---|---|
| `require-clean` | 默认,最安全 | 主库 `git status --porcelain` 非空就报错,让用户先提交或 stash |
| `ignore` | dirty 改动与任务无关(改的是别的东西、构建产物) | `git worktree add <path> -b synapse/<taskId> HEAD`,agent 从干净 HEAD 开始,用户的改动继续留在主库 |
| `carry-stash` | dirty 改动是任务起点,agent 要接着改 | `worktree add` 后 `git -C <mainrepo> stash push -u`,再 `git -C <path> stash apply`(用 `apply` 不 `pop` —— 主库那份 stash 留着兜底);必须记下主库 stash ref 供任务结束时提示用户清理 |

`carry-stash` 的坑,实现时注意:`stash apply` 到新 worktree 可能因索引状态 / 子模块冲突;`-u` 带上 untracked 但 `.gitignore` 的文件不带。

**gitignore 的关键文件要单独搬。** worktree 是独立目录,`.env` / `.env.local` / `.claude/settings.local.json` / `node_modules` 都不会自动出现 —— 这与 dirty 无关,是 worktree 的固有性质。后端在 `worktree add` 后按一份可配置的 `linkFiles` 列表从主库 symlink 或 copy 过去;`node_modules` 太大,让 agent 自己 `npm install` 或整目录 symlink。

**worktree vs 本地 clone。** worktree 共享 `.git`,主库的 `git gc` / `git rebase` / 切分支会经 HEAD 引用、reflog 影响所有 worktree。agent 跑很久、或用户会在主库频繁操作时,`git clone --shared <repo> <path>`(甚至完整 `clone`)隔离性更好,代价是磁盘与 `npm install` 时间。子 agent 场景默认用 worktree(轻、快),clone 作为可选项留在这里。

**清理。** worktree 目录 `~/.synapse/worktrees/<project>-<taskId>`,任务结束后**不自动删**(和 tmux pane 同样的处置原则:里面可能有未提交/未合并的产物)——UI 给一个显式的「移除 worktree」入口,执行 `git worktree remove` + 分支删除 + `carry-stash` 时提示主库残留的 stash。

拟新增 `backend/worktree.ts`:

```ts
interface WorktreeSpec {
  repoRoot: string;
  branch: string;              // synapse/<taskId>
  base: string;                // 默认 'HEAD'
  dirtyStrategy: 'require-clean' | 'ignore' | 'carry-stash';
  linkFiles: string[];         // 从主库软链过去的 gitignore 文件
}

// 返回 worktree 路径与 cleanup 回调(carry-stash 时 cleanup 内含主库 stash ref)
async function createWorktree(spec: WorktreeSpec): Promise<{ path: string; cleanup: () => Promise<void> }>;
```

主 agent(tmux,用户 pane)不套 worktree —— 用户在自己的 pane 里,换目录不合适(呼应 §3.1 结论:`synapse` 的 tmux 会话不套 policy)。

### 1.4 任务数据的存储位置

`sessions.json` 按 `~/.synapse/<请求端口>/` 分区,因为会话跟着 daemon 实例走(见 §4「端口」段、store.ts 头注释)。任务数据不同:Project List 要跨 workspace 聚合,而不传 `--port` 的 `synapse` 都复用同一默认 daemon —— 任务视图同样应活在一个不随测试端口分裂的用户级命名空间里。

故 `tasks.json` 落 `~/.synapse/tasks.json`,**不带端口**。测试用环境变量 `SYNAPSE_TASKS_PATH` 覆盖以隔离生产数据。文件权限 `0600`,写入原子(临时文件 + chmod + rename)且串行化,JSON 解析失败不静默覆盖(重命名为 `tasks.json.corrupt-<ts>` 后新建空结构)。数据结构见 `docs/phase1-task-management.md`。

### 1.5 任务主 agent 与子 agent 的调度

设计移出本文件 —— 见 `docs/design/main-agent-orchestration.md`(主 agent 四项职责、`synapse agent` 子命令、`synapse-tasks` 共享文档库、文档端点、9 步落地顺序)。Phase 1 之后的方向,尚未实现。

一句话:调度用 `synapse agent {context,spawn,wait,doc}` 子命令(daemon HTTP 的瘦客户端),不引入 MCP;主 agent 沉淀的 handoff / progress / changelog 落一个独立 git repo。

---

## 2. 关键实测结论

这一节是本规格的事实基础,实现时不得与之冲突。**只保留三条构成整体设计前提的硬约束**;完整的实测记录分两处:

- `docs/notes/claude-code-behavior.md` — Claude Code / stream-json / hook 的固有行为(多轮对话、hook 同步控制、路径与标识符、tmux 承载方式、ai-title、转写文件结构、`stop_reason` 逐轮边界…)
- `docs/notes/implementation-lessons.md` — Synapse 某次实现错了 → 实测 → 修正的踩坑记录(会话 ID 认领、timeline 双路径对齐、持久化关停语义、退出检测、终端旁路观测…),锚在具体函数上

两条快速提醒(细节在上述 notes):转写路径**不要自行推算**,用钩子载荷的 `transcript_path`;会话 ID **由 CLI 生成经 `--session-id` 传入**,不按 mtime 事后认领 —— 踩过一次,批准请求路由到了错误的会话。

### 2.1 PreToolUse hook 无条件触发,早于内置权限判断

`matcher` 只按工具名匹配,匹配即触发 HTTP 请求 —— 与 `permissions.allow/deny/ask` 规则、权限模式(`default`/`acceptEdits`/`auto`/`bypassPermissions`)无关,发生在内置权限引擎判断之前。不存在「内置引擎判定需要询问时才转发」这种钩子事件,`settings.json` 里配得再全的 allow 规则也拦不住已匹配 matcher 的请求。

因此 `matcher: "*"` 会让**所有**工具调用(包括只读操作)绕开 Claude Code 自身的权限模式,一律先挂起等网页决策。这在早期是有意选择(见 §6 全量监管前提),但代价是繁琐 —— 常规操作也要网页确认一遍,且与 Auto/Edit Mode 的直觉不符(切了模式,网页请求仍照发)。

现按 `backend/daemon.ts` 的 `ENABLE_FULL_APPROVAL` 开关收窄:默认 `matcher` 只匹配 `AskUserQuestion`,其余工具（Bash/Write/Edit 等）交还给 Claude Code 内置权限系统处理，不再经过网页。需要恢复全量监管时把开关改回 `true` 即可，钩子入口与决策协议不变。（开关与 hook 配置一起放在 `daemon.ts` —— hook 配置文件由 daemon 写,见 §3.1。）

### 2.2 ⚠ 钩子超时是 fail-open

| 项目 | 实测值 |
|---|---|
| 默认超时 | 约 600 秒 |
| `timeout` 字段 | 可配置(实测 `timeout: 10` 生效) |
| **超时后行为** | **工具照常执行,`permission_denials` 为空** |

**这是本系统最重要的安全约束。** 若放任钩子请求自然过期,未经批准的命令会被执行。

因此后端**必须**自行管理截止时间,绝不依赖钩子超时:

- settings 中配置外层上限 `HOOK_TIMEOUT_S`(当前 300 秒)
- 后端内部截止 `DECISION_TIMEOUT_MS` 必须**更短**(当前 280 秒),留出响应回传余量
- 到点主动返回 `deny`,把 fail-open 翻转为 fail-closed

### 2.3 原生类型剥离替代 tsx

Node 22.6+ 直接执行 `.ts`(擦除类型标注,不做类型检查)。实测 Node 24 下整个后端可由 `node backend/server.ts` 启动,代码中无 `enum` / `namespace` / 装饰器 / 参数属性等需要代码生成的语法。

两个约束:剥离**只认 `.ts` 扩展名**,故 `bin/synapse`(见 §0.1)是无扩展名的 JS 薄壳,实现在 `bin/synapse.ts`;版本闸门也必须写在薄壳里,低版本 Node 会在 import `.ts` 时先抛语法错误。运行时警告用 `--disable-warning=ExperimentalWarning` 压掉。类型安全仍由 `npm run typecheck` 保证。


## 3. 数据协议

### 3.1 hook 配置注入

**一份 daemon 级文件,所有会话共用,经 `--settings` 挂载 —— 不碰用户的仓库文件。**

早期实现把 hook 追加进每个工作区的 `.claude/settings.local.json`。那是工作区级、非会话级的文件,代价:

- 该目录里任何一个裸 `claude`(不经 wrapper)也会读到 hook,开始给后端发请求;
- 同目录并存两个 wrapper 会话共用一份文件;
- 会话退出后 hook 条目留在文件里,下一个无关的 `claude` 打到可能已死的后端 —— 按 §2.2 是 fail-open。
`#writeSettings` 里那套「写入前按 URL 剔除旧条目」的去重逻辑就是为了缓解最后一条,治标不治本。

**实测 + 官方文档确认:`claude --settings <path|json>` 是叠加而非覆盖。** 优先级从高到低:企业级 → `--settings`(CLI)→ `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`。`--settings` 里写的键覆盖同名文件键、省略的键保留文件值;`hooks` 按**事件名 + matcher** 求并集,各来源的 hook 全部生效,互不遮蔽。

因此 hook 配置改由 `daemon.ts` 的 `writeHookSettings()` 写一份 `~/.synapse/<请求端口>/hooks.settings.json`(`0600`),内容只有 `hooks`。所有会话(`TmuxTransport` 与 `StreamJsonTransport` 都是 `--settings <这个路径>`)共用它,并与各自工作区自己的 `.claude/settings*.json` 由 Claude Code 求并集 —— 不必把用户的 model / permissions 拷进来,也不写用户仓库里的任何文件。

daemon 每次监听成功后重写一遍(幂等)。**URL 里的端口必须是实际监听端口**(默认端口被占用时会递增,见 §4),写错等同 fail-open,故 `writeHookSettings(请求端口, 实际端口)` 两个端口分开传:前者定文件路径,后者进 URL。文件路径仅依赖请求端口,可在监听前推导出来传给 `SessionManager`;文件本身等实际端口确定后才写,而会话启动都在监听成功之后,读到的一定是最新版本。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:47100/api/claude-event",
            "timeout": 300
          }
        ]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "http", "url": "http://127.0.0.1:47100/api/claude-event", "timeout": 300 }] }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [{ "type": "http", "url": "http://127.0.0.1:47100/api/claude-event", "timeout": 300 }]
      }
    ]
  }
}
```

`PreToolUse` 的 `matcher` 由 `daemon.ts` 的 `ENABLE_FULL_APPROVAL` 开关控制,见 §2.1(开关随 hook 配置一起搬到了 `daemon.ts`)。`Stop`/`SessionEnd` 不参与权限判断,`handleHookRequest` 里非 `PreToolUse` 事件一律立即放行 —— `SessionEnd` 额外触发退出回调(退出检测双通道见 `notes/implementation-lessons.md`),`Stop` 目前只是占位。

**副作用:hook 配置不再出现在工作区的 `.claude/settings.local.json` 里。** 那个文件通常是用户 gitignore 掉、用来查「Synapse 对我的仓库做了什么」的地方;现在要查得看 `~/.synapse/<端口>/hooks.settings.json`。实测(独立测试端口):stream-json 会话拿到的 `settingsPath` 正确指向该文件,`claude` 加载无报错;`ENABLE_FULL_APPROVAL=true` 下发一条需要 `Bash` 的提示词,后端 pending 表按 `tool_use_id` 挂起该调用、会话转 `waiting`、`deadlineAt` 就位 —— hook 全链路生效。

### 3.2 PreToolUse 钩子载荷(Claude Code → 后端)

实测字段:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "205d25cb-93b6-4c27-bd02-580ae7078aa7",
  "transcript_path": "/Users/me/.claude/projects/-private-tmp/205d25cb-….jsonl",
  "cwd": "/private/tmp",
  "prompt_id": "92a78ad7-a32e-4b89-8965-dd4ea568355c",
  "permission_mode": "default",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01DpSjUui6igQuEDPpBgrbxf",
  "tool_input": { "command": "rm -rf node_modules && npm install" }
}
```

**`tool_use_id` 是批准配对的必需键。** 同一会话可能有多个工具调用并发等待,仅按 `session_id` 索引会串。pending 表必须以 `tool_use_id` 为键。

### 3.3 决策响应(后端 → Claude Code)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "用户在网页拒绝"
  }
}
```

`hookEventName` **不可省略**。

---

## 4. 模块

### SessionManager

管理多个工作区会话。每个会话持有一个 `SessionTransport` 实例与独立的 settings 文件。按 `session_id` 建立索引,供权限引擎与 WebSocket 路由使用。

会话状态:`starting` / `ready` / `busy` / `waiting`(有待批准项)/ `exited`。

### PermissionEngine

接收 `/api/claude-event`,挂起 HTTP 响应直到网页决策或内部截止触发。

- pending 表以 `tool_use_id` 为键
- 内部定时器到点主动 deny(见 §2.2)
- 客户端断开时清理,避免连接泄漏
- 会话结束时 drain 所有挂起项

与传输方式无关 —— 钩子配置在 settings 中,tmux 阶段可直接复用。这是选择 HTTP 钩子(而非 `--permission-prompt-tool`)换来的性质。

### 守护进程(`backend/daemon.ts`)

状态存 `~/.synapse/<port>/`(`daemon.pid` / `port` / `token` / `hooks.settings.json` / `sessions.json` / `daemon.log`,均 `0600`),由后端监听成功后自己写入 —— 端口递增发生在服务端,detached 启动的父进程读不到 stdout,无从得知最终端口。`hooks.settings.json` 是所有会话共用的 hook 配置,见 §3.1;`daemon.pid`/`port` 是「进程是否存活」的判定依据,`clearState()` 只清这两个,其余保留。

健康检查必须 **PID 存活 + HTTP 探活且 token 相符** 双过:PID 可能已被系统回收并分配给无关进程,单看 PID 会误认;端口可能被别的程序占着,单看 HTTP 会把陌生服务当成自己人。任一不过即清理陈旧文件重启。

启动用 `detached: true` + `stdio: 'ignore'` + `unref()`,三者缺一都会让 CLI 退出时带走后端。

**端口。** 默认端口 `47100` —— `3000` 是 React/Next.js/Rails 等大量工具的默认端口,极易撞。`wrapper --port <n>`(或 `PORT` 环境变量)可覆盖,用于测试环境与日常使用的生产实例隔离。

状态目录按**请求端口**(调用方想要的目标端口,不是最终实际监听到的端口)分区。这是 Project List 落地后才有的需求:不同 workspace 下开 `wrapper` 不传 `--port` 时,都落在同一默认值上,天然复用同一个生产 daemon(`ensureDaemon()` 的健康检查通过就直接复用)—— Project List 能跨 workspace 聚合会话,前提正是这些会话本就活在同一个后端实例里。测试环境传入不同端口,则状态目录、daemon 实例、`sessions.json` 三者都完全隔离,不会读到/污染生产状态。

显式指定端口时**不允许递增重试**,占用即报错退出;只有默认端口才走原有的递增容错(`MAX_PORT_TRIES`)。这不是随意选择 —— 状态目录用「请求端口」命名的前提是它必须等于「实际监听端口」,否则下次启动按请求端口去读状态目录,读到的 `port` 字段会跟真实监听地址对不上,健康检查看着像活的,实际连不上。默认端口允许偏移是因为此时没人会显式记住"我要的是哪个端口",复用逻辑本就是"矬子里拔将军"——先看有没有活的,没有就在默认值附近另起一个。

**`synapse daemon <start|status|restart|stop>` 子命令。** 改完后端代码想让它生效,原先只能手动 `kill` 旧进程再随便跑一次 `synapse` 触发 `ensureDaemon()` 的自愈——容易漏步骤(比如忘了确认旧进程真退出就拉新的,或者 kill -9 跳过收尾)。四个子命令都基于既有的 `readState`/`checkHealth`/`ensureDaemon`,不是另起一套逻辑:

- `start` — `ensureDaemon()` + 打印网页链接,随即退出。不创建会话、不接管 pane、不要求在 tmux 内 —— 只看任务面板时用。已在跑就复用(健康检查通过即直接返回)
- `status` — 读状态文件 + 健康检查,报告运行中/陈旧/未运行
- `stop` — 发 `SIGTERM`(而非 `SIGKILL`)给 daemon 进程,轮询 PID 消失确认退出。`SIGTERM` 触发 `server.ts` 的 `shutdown()`,走 `stopAll()` 收尾(会话状态落盘、drain 挂起的批准请求),direct kill -9 会跳过这些
- `restart` = `stop` 后接 `ensureDaemon()`

**重启 daemon 不影响正在跑的 claude 会话。** daemon 只是 tmux pane 的旁路观察者(接管模式下 `stop()` 无论如何都不销毁 pane,见 `notes/claude-code-behavior.md`),`wrapper daemon restart` 只终止/拉起后端进程本身,不碰任何 pane 或其中的 claude 进程。网页 WebSocket 连接会短暂断开(daemon 重启期间),刷新页面后重新连上;这段空窗期内若 claude 恰好发起需要批准的工具调用,钩子请求会打空 —— 按 §2.2 是 fail-open,工具照常执行,不算安全风险(重启是本机操作者主动发起的)。

**token 跨 restart 复用,不必换链接。** `AUTH_TOKEN` 原先每次进程启动都 `randomUUID()`(§6 的安全设计:token 不因绑定本机而形同虚设),但这让 `wrapper daemon restart` ——一个纯粹为了加载新代码、不代表用户想切身份的操作——也附带地址失效的副作用,浏览器书签、终端历史里存的链接全部作废。改为 `daemon.ts` 的 `readOrCreateToken()`:同请求端口的状态目录下若已有 `token` 文件就复用,没有才新生成;`clearState()` 相应地只删 `daemon.pid`/`port`,不再删 `token`(那两个字段才是「进程是否存活」的判定依据,token 只是凭据值,没有这层语义)。`shutdown()` 里的 `clearState(PORT)` 因此不会带走 token,新进程启动时能读到旧值。

只有两种情况 token 仍会变:全新状态目录(首次启动,没有残留文件)、或磁盘 token 文件被手动删过。`wrapper daemon restart` 的输出因此从「token 已刷新」改为中性的「网页链接」,仍然打印出来兜底,而不是承诺"一定不变"。

实测(独立测试端口,不碰生产实例):`status` 对陈旧状态文件(PID 已死)正确报告「陈旧」而非「未运行」;`restart` 对陈旧状态走 `not-running` 分支直接拉新,对健康实例先打印「已停止旧进程」再拉新,新旧 PID 确认不同,token 前后一致;`stop` 幂等,重复调用不报错。

### SessionTransport(抽象)

```
start()      启动底层会话
send(text)   投递用户消息
interrupt()  中断当前轮次
stop()       关闭并释放
onEvent(fn)  订阅事件流
```

- `TmuxTransport` — **长命会话**:claude 活在用户的 tmux pane 里,进程独立于后端存活(后端重启后重新探活接管,见 `notes/implementation-lessons.md`)。load-buffer/paste-buffer 注入,tail 转写文件。`synapse` CLI 就地起的会话用它(用户 pane 接管模式),或自建 tmux 会话。
- `StreamJsonTransport` — **短命会话**:后端 `spawn` 的子进程,后端退出即消失。常驻期间 NDJSON 双向收发。网页从任务启动的后台子 agent 用它。无 TTY,`AskUserQuestion` 等交互工具会挂起(§5.1)。

区别详见 §1 架构下的对照表。权限引擎**不在**此接口内。

**`CreateOptions.appendSystemPrompt`** — `POST /api/sessions` 可带一段文本,后端拼成
`claude --append-system-prompt <text>` 传给新会话(stream-json 与 tmux 自建会话都走
`extraArgs`)。这是「把工作区约定 / 子 agent 模板固化进 system prompt」的最小能力,
只在进程启动时读一次 —— **无法作用于已在跑的会话**(运行时改 system prompt 没有通道,
唯一干净的注入点是启动前;详见 §7)。paneId 接管模式不生效:那条路径的 claude 由
`synapse` CLI 自己启动。worktree 隔离与 policy 存储层未实现,见 §1.3。

---

## 5. UI

左上角切换两个模式,偏好存 localStorage:

- **任务**(默认)— 项目 / 任务 / 任务详情三栏。左栏(复用 aside)列项目,带任务数、运行中 agent 数、待批准数;中栏列任务,带状态点、agent 数、待批准数;右栏是任务详情:目标 / 验收、agent 卡片(transport / state / context / cost / pending,主 agent 绿底)、任务流事件(newest-first)。项目按 name `localeCompare`、任务按 `createdAt` 固定排序,不随状态跳动(理由见 `notes/implementation-lessons.md`「左栏排序固定」)。交互:创建 / 编辑任务、绑定已有会话为主/子 agent、解绑(不关会话)、点 agent 卡片「打开会话」跳到会话模式的该会话详情。任务流首次拉取(`GET /api/tasks/:id`)与 WS 增量(`task_event` 消息)push 进同一个 `events` 数组、同一套渲染(「服务端归约与前端增量必须对齐」的老问题,见 `notes/implementation-lessons.md`)。
  - **未绑定会话区。** `synapse` 起的 tmux 会话进了 `SessionManager` 但不会自动成为任务 —— 若只渲染有 binding 的 agent,这些会话在任务视图里完全不可见。故中栏任务列表上方单列一区:属于当前项目 `workspaceRoots`、`state !== 'exited'`、且无 active binding 的会话,由 `GET /api/projects/:id/tasks` 的 `unboundSessions` 字段给出(服务端按 binding 算,前端无从本地推导 —— 新会话出现或 tmux 会话 `exited` 时前端重取该接口)。每行一个「转为任务」按钮,调 `POST /api/tasks/from-session`:以会话 `title || name` 建任务、立即把该会话挂为 main agent,一步到位。点会话行本身跳到会话模式查看。
- **会话** — 下面描述的原有两层结构,能力不变。

**顶层 — 优先级流。** 左栏按 workspace 分组(Project List),组内按「需要你 / 进行中 / 静默」排序;主区是跨会话的事件流,同样按「谁最需要你」排序。待批准项排最前并按等待时长排序,可就地批准无需进入会话。每项附风险说明(如「递归删除」「会直接改动线上基础设施」),而非仅展示命令原文。

Project 分组默认展开,用户手动收起的记入 localStorage(键存收起集合而非展开集合,故新 workspace 不需要额外记录就默认可见)。这是纯 UI 布局状态,刷新页面保留,与下面的会话持久化是两回事。

**详情 — 单会话。** 四个分段页签:

| 页签 | 内容 |
|---|---|
| 改动文件 | 文件列表带增删统计,点开看 diff |
| Artifacts | 会话产出物网格,文件落 `~/.synapse/artifacts/...`(路径规范见 §0.2)。**后端采集未实现** —— 页签暂空,见 §7 |
| 对话 | 按轮次分组,过程折叠,详见下 |
| 终端输出 | 命令输出按次分卡,带退出码与耗时 |

待批准项在改动文件/终端输出页签置顶;对话页签里它是当前对话的一部分,故置于消息流末尾而非页面顶端。

**对话页签的降噪。** 一轮对话(一条用户消息到下一条之间)常含多次工具调用与中间态 assistant 文本,原样平铺会让"两次结论之间"充满噪音。故按轮分组:
- 轮次仍在进行中 —— 只显示最新一步,旧步骤不追加显示(而非持续滚动列表)。
- 轮次已结束(收到 `turn_end`)—— 除最后一条 assistant 文本(结论)外,其余步骤折叠成一行「N 步」,默认收起,点击展开完整明细。
- 展开状态按轮次索引存在 `detail.expandedTurns`,随会话切换重置。

视觉风格:macOS 系统应用 —— 浅色、发丝分隔线、系统蓝作唯一强调色、状态用淡彩底、整体弱对比。

**列表行统一。** 两个视图都是「侧栏 + 主区」同一个 shell(会话视图主区单栏、任务视图主区两栏,取舍不同,不强行统一)。但列表行只有一套视觉:选中态一律 `blue-soft` 底 + 蓝字 + `0 1px 2px rgba(0,113,227,.16), 0 0 0 1px rgba(0,113,227,.08)` 阴影(`.nav-item.on` / `.proj-row.on` / `.task-row.on` 共用一条规则,见 `app.css`);「未绑定会话」行是 `.task-row.unbound`,与任务行共用网格,只少一点内边距、右侧放按钮而非计数。新增列表时复用这些 class,不要再造第四套。

### 5.1 AskUserQuestion 的回传机制

`PreToolUse` 钩子协议只支持 `permissionDecision: allow/deny`(+ `permissionDecisionReason`),**没有「允许执行并附带结构化结果」这个选项**。这意味着网页无法把用户在问题卡片上的选择当作 `AskUserQuestion` 的工具返回值直接注入。

`allow` 会放行工具调用本身去真正执行 —— 但 stream-json 管道没有交互 TTY,`AskUserQuestion` 会挂起等不到任何输入,表现为卡住(即 `pendingToolSince` / 疑似卡住提示要覆盖的场景之一)。

故网页问题卡片走 **deny + reason** 路径:用户选择后,后端对该工具调用发 `deny`,把选中项拼成文本塞进 `permissionDecisionReason`。Claude 会把这段 reason 当作工具失败原因读到,继而在对话里据此继续 —— 这是唯一能让网页选择真正生效的通道。卡片按钮因此不叫「批准/拒绝」,而是「提交回答/跳过」,语义上更贴近这条路径的实际效果。

**deny 路径带来的两处副作用,均已修正:**

- **不算失败。** Claude Code 把这次 `deny` 等同工具失败,`tool_result` 的 `is_error` 为 `true`。但这是协议限制下的正常回传,不是真的出错 —— 归约逻辑(`reduceEvent` 与前端 `onSessionEvent` 的 `tool_result` 分支)对 `AskUserQuestion` 强制把 `isError` 记为 `false`,「N 步」折叠摘要与单步图标因此不会把提交回答/跳过标成失败。
- **会话状态要收回。** `onApprovalRequested` 触发时会话被标 `waiting`(§4 PermissionEngine),但早期实现只在挂起时置位,没有对应的复位 —— `#settle` 落定决策后无人把 `s.state` 改回去,只能靠前端 `pendingFor()` 派生值动态覆盖显示,凡是直接读 `s.state` 原始字面量的地方都会一直显示"等待批准"。现在 `ResolveListener` 额外带上 `sessionId`,`onApprovalResolved` 里若该会话已无其它待批准项,按 `pendingTurns` 决定收回到 `busy` 还是 `ready`。

### 5.2 从任务启动子 agent 的预检步

从任务启动子 agent 前插入一步确认 —— system prompt、cwd/worktree、`--add-dir`、model 全是启动参数,启动后不可变(见 §7 与 §4 `CreateOptions.appendSystemPrompt`),既然如此就在唯一能真正生效的时刻让用户确认。

**已实现。** `POST /api/tasks/:id/agents/start` 复用 `manager.create()` 起一个 stream-json 子 agent、写 `agent_started` 事件、按模板(项目 / 工作区 / 任务 / 目标 / 验收 / 子任务 / 收尾格式)拼 prompt 后 `send()`。`role:'main' + transport:'tmux'` 返回 400 —— 网页接管不了用户 pane。预检对话框展示工作区、`GET /api/git-status` 的 `git status --porcelain` 结果(**信息用途,不阻断**)、system prompt 最终文本预览、model。

**未实现。** worktree 隔离(`dirtyStrategy` 三策略)与 policy 存储层 —— 子 agent 目前直接在传入工作区上跑,见 §1.3 / §7。对话框里的 worktree 策略选择、`--add-dir` 列表、「设为该工作区默认」也随之留白。

运行中的会话不进入这个流程 —— 无法改 system prompt,唯一「动态」的手段是往对话里 `send()` 一条要求消息,效果弱且会污染时间线,不作为正式路径。

**手动验证过(测试端口,独立 `SYNAPSE_TASKS_PATH`,真实 claude 会话):**
`synapse daemon start` 起面板不附带会话;现有会话按 workspace 自动归入默认 project;创建 / 编辑任务即时落盘、刷新保留;绑定 tmux 会话为主 agent 后详情页绿底卡片显示 state / context / cost;从任务启动 stream-json 子 agent,子 agent timeline 出现完整模板 prompt 并回复,任务流按序出现 `agent_started` / `turn_completed`;同一会话绑第二个 task 返回 409,详情页顶部红色错误条显示原因;kill 承载 pane → 存活巡检把会话判 `exited`,任务流出现 `agent_exited`,binding `endedAt` 落上;点 agent 卡片「打开会话」切到会话视图并打开该会话四页签;切回会话视图旧 overview 功能不变;1400px / 480px 宽度均无横向溢出。`GET /api/sessions` 与非 daemon 子命令的 `synapse` 行为回归无变化。

tmux agent 卡片:会话 `exited` 且 `transport === 'tmux'` 时状态标「pane 已失效」而非「已退出」——claude 进程可能还活着,只是网页失去了观察通道。binding 被存活巡检自动 `endedAt` 后卡片转「已解绑」,历史留在任务流的 `agent_exited` 事件里。

---

## 6. 安全

**绑定本机 ≠ 身份认证。** 任意网页都可向 `127.0.0.1` 发起请求(DNS rebinding / CSRF),从而批准任意命令。仅监听本机是不够的。

- 浏览器侧接口校验 `Origin`
- WebSocket 升级校验一次性 token(每次启动重新生成,随启动链接给出)
- 钩子接口不校验 Origin(子进程请求不带该头),仅接受本机来源
- settings 文件权限 `0600`

**超时必须 fail-closed。** 见 §2.2 —— 这是本系统最容易被忽略的安全缺口。

**钩子 URL 必须用实际监听端口。** 端口被占用时后端会递增重试,若 settings 里写的仍是初始端口,钩子会打到无人监听的地址而失败 —— 而钩子失败等同于 fail-open,所有工具将无审批执行。故 `SessionManager` 的端口取函数而非定值,Origin 校验与 WebSocket 同理。

**风险提示的边界。** UI 会标注已知危险模式(`rm -rf`、`terraform apply` 等)。这是辅助判断,不是安全保证 —— 规则覆盖不到的危险命令不会被标注,不应让用户产生「没标红就安全」的错觉。

---

## 7. 未决事项

- **中断能力** — `interrupt()` 目前发 SIGINT,stream-json 下的正确中断方式尚未实测确认,可能会终止整个会话。
- **崩溃恢复** — 后端退出会带走所有子进程。`--resume <session_id>` 可恢复对话上下文,但不恢复进行中的轮次。恢复流程尚未设计。
- **stream-json 会话的进程存活** — tmux 会话在后端重启后可重新探活接管(`notes/implementation-lessons.md`),stream-json 子进程随后端退出而消失(见「崩溃恢复」),这层还没补。
- **任务 agent 的 worktree 隔离** — 设计见 §1.3,预检步见 §5.2;`backend/worktree.ts` 与 policy 存储层未实现,Phase 1 收尾时评估「多子 agent 并行」非近期需求而延后。
- **Artifacts 采集** — §0.2 定了落盘路径规范,§5 的 Artifacts 页签在位,但后端未采集会话产出物,页签暂空。
- **主 agent 调度** — 设计见 `docs/design/main-agent-orchestration.md`。`synapse agent wait` 的长轮询信号、子 agent 异常退出的退出码语义待实现时定。
- **CLI 重命名** — §0.1:`wrapper` → `synapse`,子命令合并。约定已定,代码 sweep 待做。

