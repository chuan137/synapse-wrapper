# Synapse Wrapper — 系统规格

用 Web 界面驱动 Claude Code,支持多工作区并行会话与网页端工具批准。

> 本文档中标注「实测」的结论均在 **Claude Code 2.1.226 / macOS** 上验证过。
> 早期版本的规格基于对 tmux 方案的推测,其中多处与实际行为不符,已按实测重写。

---

## 1. 架构

```
                +----------------------------------------------+
                |                  浏览器 UI                    |
                |  顶层:优先级流(全部会话)                    |
                |  详情:改动文件 / Artifacts / 对话 / 终端输出  |
                +----------------------+-----------------------+
                       WebSocket       |      HTTP
                    (状态与事件推送)    | (提示词与批准决策)
                                       v
                +----------------------------------------------+
                |                  Web 后端                     |
                |  SessionManager   — 多会话生命周期            |
                |  PermissionEngine — 钩子接收 + 决策挂起        |
                |  SessionTransport — 传输抽象                  |
                +----------+-----------------------+-----------+
                           |                       |
              HTTP 钩子响应 |                       | NDJSON over stdin/stdout
             (allow / deny) |                       |
                           v                       v
                +----------------------------------------------+
                |  claude -p --input-format stream-json   × N   |
                |  每个工作区一个常驻子进程                      |
                +----------------------------------------------+
```

**为什么是 stream-json 而不是 tmux。** 早期方案用 tmux 承载交互式 TTY,配合 paste-buffer 注入提示词、tail 转写文件取输出。实测确认 stream-json 提供双向 JSON 协议,直接消除了缓冲区注入、ANSI 清洗、转写解析三块工作量。tmux 的独有价值(进程存活于后端重启、终端可 attach)被评估为 nice-to-have,列入阶段二。

---

## 2. 关键实测结论

这一节是本规格的事实基础,实现时不得与之冲突。

### 2.1 stream-json 支持多轮对话

`-p` 意为 programmatic(程序化)而非 one-shot(单轮)。单轮行为来自 `--input-format text`。

实测:单进程连续三轮,`session_id` 保持一致,第二轮正确答出第一轮要求记住的数字 —— **上下文跨轮保留**,不只是进程复用。

### 2.2 HTTP 钩子可同步控制权限

`type: "http"` 的钩子会向指定 URL 发 POST,并**等待响应体中的决策**。实测 allow 与 deny 均被遵守。

延迟响应有效:模拟人工思考延迟 6 秒后返回 deny,工具被成功拦下。这是网页批准流程可行的前提。

### 2.3a PreToolUse hook 无条件触发,早于内置权限判断

`matcher` 只按工具名匹配,匹配即触发 HTTP 请求 —— 与 `permissions.allow/deny/ask` 规则、权限模式(`default`/`acceptEdits`/`auto`/`bypassPermissions`)无关,发生在内置权限引擎判断之前。不存在「内置引擎判定需要询问时才转发」这种钩子事件,`settings.json` 里配得再全的 allow 规则也拦不住已匹配 matcher 的请求。

因此 `matcher: "*"` 会让**所有**工具调用(包括只读操作)绕开 Claude Code 自身的权限模式,一律先挂起等网页决策。这在早期是有意选择(见 §6 全量监管前提),但代价是繁琐 —— 常规操作也要网页确认一遍,且与 Auto/Edit Mode 的直觉不符(切了模式,网页请求仍照发)。

现按 `backend/sessionManager.ts` 的 `ENABLE_FULL_APPROVAL` 开关收窄:默认 `matcher` 只匹配 `AskUserQuestion`,其余工具（Bash/Write/Edit 等）交还给 Claude Code 内置权限系统处理，不再经过网页。需要恢复全量监管时把开关改回 `true` 即可，钩子入口与决策协议不变。

### 2.3 ⚠ 钩子超时是 fail-open

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

### 2.4 路径与标识符

| 项目 | 实际值 |
|---|---|
| 转写文件位置 | `~/.claude/projects/<cwd 路径转写>/<session_uuid>.jsonl` |
| `session_id` 格式 | 裸 UUID,如 `205d25cb-93b6-4c27-bd02-580ae7078aa7` |

转写路径中的 cwd 会被路径转写(斜杠转连字符,macOS 上 `/tmp` 会解析为 `/private/tmp`)。**不要自行推算此路径** —— 钩子载荷中的 `transcript_path` 字段直接给出准确值。

使用 stream-json 时无需读取转写文件,助手消息、工具调用与结果均从 stdout 获得。

### 2.5 tmux 有两种承载方式

| 模式 | 触发方 | 行为 |
|---|---|---|
| 自建会话 | `sessionName` | `new-session -d` 建独立会话,后端持有其生命周期 |
| 接管 pane | `paneId` | 不建也不销毁会话,只对给定 pane 注入与观察 |

`wrapper` CLI 走接管模式:claude 在用户当前 pane 里启动,CLI 只做前置准备(拉起后端、写 settings),不制造额外的会话层级。因此 **CLI 必须在 tmux 内运行** —— pane 是后端寻址的唯一手段;裸终端下直接提示而非隐式建会话。

tmux 的所有 `-t` 目标在两种模式下分别取 pane ID 与会话名,pane ID(如 `%3`)在 tmux 中处处可作 target。接管模式下 `stop()` 无论如何都不销毁 pane —— 那属于用户。

### 2.6 会话 ID 必须由调用方指定

`claude --session-id <uuid>` 可指定会话 ID,转写文件即 `<uuid>.jsonl`。

**同目录并存时不能靠推断。** 早期实现按「转写目录里 mtime 最新的文件」认领 session_id。同一目录并存两个会话时(两个 pane 各开一个 claude),两者共用转写目录且几乎同时创建文件,认领会张冠李戴 —— 实测出现过 A 会话认领了 B 的转写文件,导致批准请求路由到错误的会话:**网页上批准 A,实际放行的是 B**。

故 `wrapper` 生成 UUID,注册时告知后端、启动时传给 claude,归属从此确定而非依赖时序。`SessionManager` 另有防御:同一 claudeId 被二次认领时告警并拒绝改判,不静默覆盖。

按 mtime 认领的旧路径保留给自建会话模式(该模式下目录内只有一个会话,不会冲突)。

### 2.7 原生类型剥离替代 tsx

Node 22.6+ 直接执行 `.ts`(擦除类型标注,不做类型检查)。实测 Node 24 下整个后端可由 `node backend/server.ts` 启动,代码中无 `enum` / `namespace` / 装饰器 / 参数属性等需要代码生成的语法。

两个约束:剥离**只认 `.ts` 扩展名**,故 `bin/wrapper` 是无扩展名的 JS 薄壳,实现在 `bin/wrapper.ts`;版本闸门也必须写在薄壳里,低版本 Node 会在 import `.ts` 时先抛语法错误。运行时警告用 `--disable-warning=ExperimentalWarning` 压掉。类型安全仍由 `npm run typecheck` 保证。

### 2.8 会话标题来自转写里的 ai-title

claude 会给会话起一个语义化标题(即 `/resume` 列表里显示的那个),写进转写文件:

```json
{ "type": "ai-title", "aiTitle": "查找login.js中硬编码密码的风险", "sessionId": "…" }
```

实测:首轮对话后不久出现(样本中位于第 8 行 / 共 38 行),**同一标题会重复写入多次**且该行**没有 `uuid`**,躲不过按 uuid 的去重,需自行比对上次值。样本中标题在会话内未变化过。

UI 用它区分同目录并存的会话 —— pane ID 能区分但不解释,标题才说明「这个会话在做什么」。标题与 `name`(目录名)并存而非覆盖,后者仍用于分组。

### 2.9 转写文件结构

行类型不止 `user` / `assistant`,还包括 `queue-operation`、`attachment`、`ai-title`、`last-prompt`,以及子代理产生的 `isSidechain` 条目。解析时须用白名单,否则控制类记录会被当作对话渲染。

实测确认:`claude -p --input-format stream-json` 与 tmux 里的原生 TUI 写的是**同一套路径规则**(`~/.claude/projects/<cwd 转写>/<session_id>.jsonl`),并非 tmux 独有。两种传输方式因此可以共用一份解析逻辑(`backend/transcript.ts`),既用于 tmux 的实时 tail,也用于 §2.11 的历史重放。

### 2.10 服务端 timeline 与前端增量视图必须落同一套分组边界

`GET /api/sessions/:id` 首次拉取用的是 `SessionManager` 自己维护的 `s.timeline`,与 WebSocket 增量更新走的前端 `onSessionEvent` 是两份独立实现,字段结构必须保持一致 —— 改其中一份而漏另一份,不会报类型错误(两边都是各自文件里的字面量对象),只在运行时表现为数据缺失。

`turn_end` 一度只被前端 `onSessionEvent` 记录为 timeline 分组边界,`SessionManager.#absorb` 里同名分支只更新了计数器,没有写回 `s.timeline`。后果:每次刷新页面或重新打开会话,拉到的历史 timeline 里没有任何 `turn_end`,渲染时把整段历史当成"一个仍在进行中的轮次" —— 而进行中轮次只展示最新一步,已完成轮次的全部工具调用与中间文本因此从界面上消失,而非折叠。

### 2.11 会话元数据持久化,对话内容不重复存

`SessionManager` 原本纯内存态,后端一重启会话列表就清空。持久化只落会话元数据(`~/.synapse/sessions.json`,0600):workspace、name、title、claudeId、turns/costUsd 等统计、以及 `transcriptPath`。

**对话 timeline 不进这份快照。** Claude Code 自己已经把完整对话写在转写文件里(§2.9),重复落一份等于造出两个可能不同步的历史来源。`GET /api/sessions/:id` 对没有内存态 timeline 的 exited 会话,现读 `transcriptPath` 重放出 timeline/files/commands(`replayTranscriptTimeline`),与在线会话走的 `#absorb` 共用同一个归约函数 `reduceEvent` —— 避免 §2.10 那次事故的重演(两条路径分叉出不一致的字段结构)。

写盘走 500ms debounce(`#absorb` 里几乎每条转写行都会触发一次状态变化,逐条同步写盘是明显的 I/O 负担),用户在网页上主动删除会话时改为立即 `saveNow()`,否则紧接着的进程退出会让磁盘上的旧快照把这条"已删除"的记录复活。

**关停语义分两种,不能共用一个方法。** 早期实现让 `SIGINT/SIGTERM` 触发的 `closeAll()` 直接调用 `close()`,而 `close()` 的语义是"用户主动删除,记录也从磁盘摘除"—— 结果是每次 Ctrl-C 正常关闭后端,`sessions.json` 就被清空,持久化形同虚设。故拆成两个方法:`close(localId)` 保留给用户删除操作;`stopAll()` 供进程退出用,只停子进程、把状态标 `exited`,记录本身留着。

重启后加载出的历史会话,`Session.transport` 落一个 `NullTransport` 占位(`alive()` 恒 `false`),避免 `Session.transport` 这个必填字段在历史记录上无处安放。

### 2.12 任务清单工具实测有两套,不能只认 TodoWrite

同一 2.1.226 环境下,同一会话实测调用的是 `TaskCreate` / `TaskUpdate` / `TaskGet` 这套增量工具,而非文档里常见的 `TodoWrite`。两者语义不同,不能共用一套归约逻辑:

| | `TodoWrite` | `TaskCreate` / `TaskUpdate` |
|---|---|---|
| 更新方式 | 单次调用给全量清单,直接覆盖 | 增量:`TaskCreate` 建一项,`TaskUpdate` 按 `taskId` 改状态 |
| 任务 ID | 无(数组顺序即身份) | 有,但 `TaskCreate` 的 `tool_use.input` 里**没有**,要等 `tool_result` |
| ID 的实际来源 | 不适用 | `tool_result` 是人话确认文本 `"Task #4 created successfully: …"`,`taskId` 只能从这段文本正则解析(`/Task #(\S+) created/`),没有结构化字段 |

哪套工具会被实际调用,目前判断依据不明(未观察到与 model/环境变量的明确关联),故两套都要接。两个来源(`s.todos` 全量数组、`s.tasks` 按 taskId 维护的 Map)合并成一份只读视图给前端,`TodoItem` 加一个可选 `id` 字段承载 `taskId`。归约逻辑并入 §2.11 提到的 `reduceEvent`,使其与 `#absorb`/`replayTranscriptTimeline` 两条路径天然共享,不需要单独维护;前端首次拉取详情页后要用 `id` 重建本地的 taskId 索引,否则后续 WS 增量的 `TaskUpdate` 事件找不到条目可改(参照 §2.10 的教训,这也是一处"服务端归约"与"前端增量"必须对齐的分叉点)。

---

## 3. 数据协议

### 3.1 settings 注入

写入工作区的 `.claude/settings.local.json`。

**必须合并,不得覆盖。** 该文件通常已被用户占用(model、permissions、插件、statusLine 等)。合并规则:

- 顶层字段保留
- `hooks` 下按事件名**追加**,不替换 —— 用户可能已有 PreToolUse / Stop 钩子
- 写入前剔除本工具此前注入的条目(按 URL 含 `/api/claude-event` 识别),避免重启堆积
- 文件权限 `0600`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:3000/api/claude-event",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

`matcher` 由 `ENABLE_FULL_APPROVAL` 开关控制,见 §2.3a。

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
- 内部定时器到点主动 deny(见 §2.3)
- 客户端断开时清理,避免连接泄漏
- 会话结束时 drain 所有挂起项

与传输方式无关 —— 钩子配置在 settings 中,tmux 阶段可直接复用。这是选择 HTTP 钩子(而非 `--permission-prompt-tool`)换来的性质。

### 守护进程(`backend/daemon.ts`)

状态存 `~/.synapse/<port>/`(`daemon.pid` / `port` / `token`,均 `0600`),由后端监听成功后自己写入 —— 端口递增发生在服务端,detached 启动的父进程读不到 stdout,无从得知最终端口。

健康检查必须 **PID 存活 + HTTP 探活且 token 相符** 双过:PID 可能已被系统回收并分配给无关进程,单看 PID 会误认;端口可能被别的程序占着,单看 HTTP 会把陌生服务当成自己人。任一不过即清理陈旧文件重启。

启动用 `detached: true` + `stdio: 'ignore'` + `unref()`,三者缺一都会让 CLI 退出时带走后端。

**端口。** 默认端口 `47100` —— `3000` 是 React/Next.js/Rails 等大量工具的默认端口,极易撞。`wrapper --port <n>`(或 `PORT` 环境变量)可覆盖,用于测试环境与日常使用的生产实例隔离。

状态目录按**请求端口**(调用方想要的目标端口,不是最终实际监听到的端口)分区。这是 Project List 落地后才有的需求:不同 workspace 下开 `wrapper` 不传 `--port` 时,都落在同一默认值上,天然复用同一个生产 daemon(`ensureDaemon()` 的健康检查通过就直接复用)—— Project List 能跨 workspace 聚合会话,前提正是这些会话本就活在同一个后端实例里。测试环境传入不同端口,则状态目录、daemon 实例、`sessions.json` 三者都完全隔离,不会读到/污染生产状态。

显式指定端口时**不允许递增重试**,占用即报错退出;只有默认端口才走原有的递增容错(`MAX_PORT_TRIES`)。这不是随意选择 —— 状态目录用「请求端口」命名的前提是它必须等于「实际监听端口」,否则下次启动按请求端口去读状态目录,读到的 `port` 字段会跟真实监听地址对不上,健康检查看着像活的,实际连不上。默认端口允许偏移是因为此时没人会显式记住"我要的是哪个端口",复用逻辑本就是"矬子里拔将军"——先看有没有活的,没有就在默认值附近另起一个。

### SessionTransport(抽象)

```
start()      启动底层会话
send(text)   投递用户消息
interrupt()  中断当前轮次
stop()       关闭并释放
onEvent(fn)  订阅事件流
```

阶段一:`StreamJsonTransport` — 常驻子进程,NDJSON 收发。
阶段二:`TmuxTransport` — load-buffer/paste-buffer 注入,tail 转写文件。

权限引擎**不在**此接口内。

---

## 5. UI

两层结构。

**顶层 — 优先级流。** 左栏按 workspace 分组(Project List),组内按「需要你 / 进行中 / 静默」排序;主区是跨会话的事件流,同样按「谁最需要你」排序。待批准项排最前并按等待时长排序,可就地批准无需进入会话。每项附风险说明(如「递归删除」「会直接改动线上基础设施」),而非仅展示命令原文。

Project 分组默认展开,用户手动收起的记入 localStorage(键存收起集合而非展开集合,故新 workspace 不需要额外记录就默认可见)。这是纯 UI 布局状态,刷新页面保留,与下面的会话持久化是两回事。

**详情 — 单会话。** 四个分段页签:

| 页签 | 内容 |
|---|---|
| 改动文件 | 文件列表带增删统计,点开看 diff |
| Artifacts | 会话产出物网格 |
| 对话 | 按轮次分组,过程折叠,详见下 |
| 终端输出 | 命令输出按次分卡,带退出码与耗时 |

待批准项在改动文件/终端输出页签置顶;对话页签里它是当前对话的一部分,故置于消息流末尾而非页面顶端。

**对话页签的降噪。** 一轮对话(一条用户消息到下一条之间)常含多次工具调用与中间态 assistant 文本,原样平铺会让"两次结论之间"充满噪音。故按轮分组:
- 轮次仍在进行中 —— 只显示最新一步,旧步骤不追加显示(而非持续滚动列表)。
- 轮次已结束(收到 `turn_end`)—— 除最后一条 assistant 文本(结论)外,其余步骤折叠成一行「N 步」,默认收起,点击展开完整明细。
- 展开状态按轮次索引存在 `detail.expandedTurns`,随会话切换重置。

视觉风格:macOS 系统应用 —— 浅色、发丝分隔线、系统蓝作唯一强调色、状态用淡彩底、整体弱对比。

### 5.1 AskUserQuestion 的回传机制

`PreToolUse` 钩子协议只支持 `permissionDecision: allow/deny`(+ `permissionDecisionReason`),**没有「允许执行并附带结构化结果」这个选项**。这意味着网页无法把用户在问题卡片上的选择当作 `AskUserQuestion` 的工具返回值直接注入。

`allow` 会放行工具调用本身去真正执行 —— 但 stream-json 管道没有交互 TTY,`AskUserQuestion` 会挂起等不到任何输入,表现为卡住(即 `pendingToolSince` / 疑似卡住提示要覆盖的场景之一)。

故网页问题卡片走 **deny + reason** 路径:用户选择后,后端对该工具调用发 `deny`,把选中项拼成文本塞进 `permissionDecisionReason`。Claude 会把这段 reason 当作工具失败原因读到,继而在对话里据此继续 —— 这是唯一能让网页选择真正生效的通道。卡片按钮因此不叫「批准/拒绝」,而是「提交回答/跳过」,语义上更贴近这条路径的实际效果。

---

## 6. 安全

**绑定本机 ≠ 身份认证。** 任意网页都可向 `127.0.0.1` 发起请求(DNS rebinding / CSRF),从而批准任意命令。仅监听本机是不够的。

- 浏览器侧接口校验 `Origin`
- WebSocket 升级校验一次性 token(每次启动重新生成,随启动链接给出)
- 钩子接口不校验 Origin(子进程请求不带该头),仅接受本机来源
- settings 文件权限 `0600`

**超时必须 fail-closed。** 见 §2.3 —— 这是本系统最容易被忽略的安全缺口。

**钩子 URL 必须用实际监听端口。** 端口被占用时后端会递增重试,若 settings 里写的仍是初始端口,钩子会打到无人监听的地址而失败 —— 而钩子失败等同于 fail-open,所有工具将无审批执行。故 `SessionManager` 的端口取函数而非定值,Origin 校验与 WebSocket 同理。

**风险提示的边界。** UI 会标注已知危险模式(`rm -rf`、`terraform apply` 等)。这是辅助判断,不是安全保证 —— 规则覆盖不到的危险命令不会被标注,不应让用户产生「没标红就安全」的错觉。

---

## 7. 未决事项

- **中断能力** — `interrupt()` 目前发 SIGINT,stream-json 下的正确中断方式尚未实测确认,可能会终止整个会话。
- **崩溃恢复** — 后端退出会带走所有子进程。`--resume <session_id>` 可恢复对话上下文,但不恢复进行中的轮次。恢复流程尚未设计。
- **阶段二 tmux** — 提供进程存活与终端 attach 能力,接口已预留。
