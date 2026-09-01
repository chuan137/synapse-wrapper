# 实现踩坑与归因

每条是 Synapse 某次实现**错了 → 实测发现 → 修正**的记录。锚在具体的文件和函数上,随代码走 —— 所以不放主 `../spec.md`(那是稳定事实),也不塞进源码注释(CLAUDE.md:注释只写代码本身无法表达的约束,不写调试过程和版本行为差异)。

改到相关代码时先读这里对应的条目,别把已经填过的坑重挖一遍。

> 均在 **Claude Code 2.1.226 / macOS** 上验证。

---

## 会话 ID 必须由调用方指定,不能事后推断

锚点:`bin/synapse.ts`(生成 UUID)、`sessionManager.ts` 的 claimedId 防御。

早期实现按「转写目录里 mtime 最新的文件」认领 session_id。同一目录并存两个会话时(两个 pane 各开一个 claude),两者共用转写目录且几乎同时创建文件,认领会张冠李戴 —— 实测出现过 A 会话认领了 B 的转写文件,导致批准请求路由到错误的会话:**网页上批准 A,实际放行的是 B**。

现在 CLI 生成 UUID,注册时告知后端、启动时经 `--session-id` 传给 claude,归属从此确定而非依赖时序。`SessionManager` 另有防御:同一 claudeId 被二次认领时告警并拒绝改判,不静默覆盖。

按 mtime 认领的旧路径保留给自建会话模式(该模式下目录内只有一个会话,不会冲突)。

## `last-prompt` 不能当逐轮 `turn_end` 信号

锚点:`transcript.ts` 的 `turn_end` 判定。

早期实现认为转写没有显式的 result 行,拿 `last-prompt`(CLI 回到顶层输入态时写入)当"本轮结束"的近似。实测某会话 93 次用户输入只对应 15 次 `last-prompt` —— 它标记的是空闲态,不是每轮回复的收尾。多数轮次因此永远等不到配对的 `turn_end`,界面对话气泡与 header 状态卡死在"进行中"。

改用 `assistant` 消息自带的 `stop_reason`(见 `claude-code-behavior.md`)。

## 服务端 timeline 与前端增量视图必须落同一套分组边界

锚点:`sessionManager.ts` `#absorb` / `reduceEvent`,`public/app.js` `onSessionEvent`。**反复踩的一类坑,后面几条都是它的变体。**

`GET /api/sessions/:id` 首次拉取用的是 `SessionManager` 维护的 `s.timeline`,与 WebSocket 增量更新走的前端 `onSessionEvent` 是两份独立实现,字段结构必须一致 —— 改一份漏另一份不会报类型错误(两边都是各自文件里的字面量对象),只在运行时表现为数据缺失。

`turn_end` 一度只被前端 `onSessionEvent` 记录为 timeline 分组边界,`#absorb` 里同名分支只更新了计数器,没写回 `s.timeline`。后果:每次刷新页面或重新打开会话,拉到的历史 timeline 里没有任何 `turn_end`,渲染时把整段历史当成"一个仍在进行中的轮次" —— 进行中轮次只展示最新一步,已完成轮次的全部工具调用与中间文本因此从界面上消失,而非折叠。

## 会话元数据持久化,对话内容不重复存

锚点:`store.ts`,`sessionManager.ts` 的 `#loadPersisted` / `replayTranscriptTimeline` / `close` vs `stopAll`。

`SessionManager` 原本纯内存态,后端一重启会话列表就清空。持久化只落会话元数据(`~/.synapse/sessions.json`,0600):workspace、name、title、claudeId、turns/costUsd 等统计、`transcriptPath`。

**对话 timeline 不进这份快照。** Claude Code 自己已经把完整对话写在转写文件里,重复落一份等于造出两个可能不同步的历史来源。`GET /api/sessions/:id` 对没有内存态 timeline 的 exited 会话,读 `transcriptPath` 重放出 timeline/files/commands(`replayTranscriptTimeline`),与在线会话走的 `#absorb` 共用同一个归约函数 `reduceEvent` —— 避免上一条那次事故的重演(两条路径分叉出不一致的字段结构)。

写盘走 500ms debounce(`#absorb` 里几乎每条转写行都会触发状态变化,逐条同步写盘是明显的 I/O 负担);用户在网页上主动删除会话时改为立即 `saveNow()`,否则紧接着的进程退出会让磁盘上的旧快照把这条"已删除"的记录复活。

**关停语义分两种,不能共用一个方法。** 早期实现让 `SIGINT/SIGTERM` 触发的 `closeAll()` 直接调 `close()`,而 `close()` 的语义是"用户主动删除,记录也从磁盘摘除" —— 结果每次 Ctrl-C 正常关闭后端,`sessions.json` 就被清空,持久化形同虚设。故拆成两个方法:`close(localId)` 给用户删除操作;`stopAll()` 供进程退出用,只停子进程、把状态标 `exited`,记录本身留着。

重启后加载出的历史会话,`Session.transport` 落一个 `NullTransport` 占位(`alive()` 恒 `false`),避免 `Session.transport` 这个必填字段在历史记录上无处安放。

## 任务清单工具实测有两套,不能只认 TodoWrite

锚点:`reduceEvent` 的 todo/task 归约,`s.todos` / `s.tasks`,前端 taskId 索引重建。

同一 2.1.226 环境下,同一会话实测调用的是 `TaskCreate` / `TaskUpdate` / `TaskGet` 这套增量工具,而非文档里常见的 `TodoWrite`。两者语义不同:

| | `TodoWrite` | `TaskCreate` / `TaskUpdate` |
|---|---|---|
| 更新方式 | 单次调用给全量清单,直接覆盖 | 增量:`TaskCreate` 建一项,`TaskUpdate` 按 `taskId` 改状态 |
| 任务 ID | 无(数组顺序即身份) | 有,但 `TaskCreate` 的 `tool_use.input` 里**没有**,要等 `tool_result` |
| ID 的实际来源 | 不适用 | `tool_result` 是人话确认文本 `"Task #4 created successfully: …"`,`taskId` 只能从这段文本正则解析(`/Task #(\S+) created/`),没有结构化字段 |

哪套工具会被实际调用,判断依据不明(未观察到与 model/环境变量的明确关联),故两套都要接。两个来源(`s.todos` 全量数组、`s.tasks` 按 taskId 维护的 Map)合并成一份只读视图给前端,`TodoItem` 加一个可选 `id` 字段承载 `taskId`。归约逻辑并入 `reduceEvent`,与 `#absorb`/`replayTranscriptTimeline` 两条路径天然共享;前端首次拉取详情页后要用 `id` 重建本地的 taskId 索引,否则后续 WS 增量的 `TaskUpdate` 事件找不到条目可改(又一处"服务端归约"与"前端增量"必须对齐的分叉点)。

## 会话退出检测靠 SessionEnd 钩子 + 存活巡检双通道

锚点:`permissions.ts` 的 SessionEnd 识别,`sessionManager.ts` `startLivenessWatch` / `#markExited`。

stream-json 管道没有显式的"本轮/本会话结束"事件可读 —— 转写文件末行只是进程停下时恰好在做的事,不是结束标记。退出检测因此不能指望从 stdout/转写内容里推断,改挂 `SessionEnd` 钩子:进程退出时 Claude Code 会向钩子 URL 发一次带 `reason` 的 POST,后端在 `permissions.ts` 里识别该事件、直接回调,不进入权限 pending 表。

钩子是快路径,但覆盖不了 `kill -9`、直接关掉承载的 tmux pane 等场景 —— 那些情况下 Claude Code 自己也来不及发钩子。故 `SessionManager` 另起一个 4 秒间隔的存活巡检兜底,双通道都指向同一个 `#markExited`。

`Stop` 事件也一并挂了钩子(见 `../spec.md` §3.1),但目前只是占位放行,尚无消费逻辑。

## 终端里直接按 Escape 中断,转写文件有痕迹但需专门识别

锚点:`tmuxTransport.ts` 的 `parseTranscriptLineMulti` user 分支。

`interrupt(localId)` 处理的是网页发起的中断。tmux 接管模式下用户完全可以绕过网页、直接在承载的 pane 里按 Escape —— 这个动作不经过后端任何入口,只能靠转写文件事后感知。

CLI 把中断写成一条 `type: "user"` 消息,`content` 是纯文本块(`[Request interrupted by user]`,详见 `claude-code-behavior.md`)。`parseTranscriptLineMulti` 原先的 `user` 分支只认数组里的 `tool_result` 块,这类纯文本块会被静默丢弃 —— 之后也不会再有 assistant 消息带来 `stop_reason` 触发的 `turn_end`,会话因此永久卡在 `busy`。

现改为识别这段固定前缀,直接产出 `{ kind: 'turn_end', interrupted: true }` 收尾;`sessionManager.ts` 据此把 `lastAction` 设为「已中断,等待输入」,与网页发起中断的文案统一。`interrupted` 标记只影响 `#absorb`(在线路径)的 `lastAction`,不进 `reduceEvent`/`ReplayTarget` 的 timeline —— 折叠渲染只需要轮次边界,中断与正常结束在这一层是同一件事。

`StreamJsonTransport` 无终端可供直接按键,不受此路径影响 —— 这条修复只对 `TmuxTransport` 的实时 tail 与历史重放生效。

## 终端里直接发下一轮 prompt,同样只能靠转写文件补分组边界

锚点:同上 `parseTranscriptLineMulti`,`#pendingEchoes` FIFO,前端 `renderTurns`。

与上一条同一类问题的另一面:用户在 tmux pane 里不经网页、直接敲下一轮对话。`send()`(网页发送)会主动 `s.timeline.push({ kind: 'user', ... })`,但终端直接输入完全绕开这条代码路径。

正常用户输入的 `type: "user"` 行,`content` 是**纯字符串**不是数组 —— `parseTranscriptLineMulti` 原先只在 `Array.isArray(c)` 分支产出事件,字符串分支直接 `return []`,连开新分组的信号都没有。后果:`renderTurns` 靠 `kind: 'user'` 的 timeline 条目切分轮次,没有这个边界,新一轮的 assistant 文本与工具调用全部并入上一轮 —— 这轮"结论"读起来混进了上一轮的过程里。

字符串 `content` 并非都是真人敲的新一轮:也承载会话摘要、跨会话通知、queue 提醒等合成消息(`isMeta: true`),以及 `!command` 转写(`<bash-...>`)。故只在 `!d.isMeta && !c.startsWith('<bash-')` 时才产出 `{ kind: 'user', text: c }`。

**自我回显的去重。** `TmuxTransport.send()` 本质是把文本粘贴进 pane 再回车,与用户手敲键盘在 tmux 层面完全等价 —— 转写文件里的行没有任何字段能区分"网页注入"还是"用户自己敲"。不去重的话,网页发的每条消息会被识别两次(一次 `send()` 主动 push,一次 tail 读到回显)。`TmuxTransport` 因此维护一个 `#pendingEchoes` FIFO,`send()` 注入前记一笔,`#handleLine` 解析出 `user` 事件时先查队列、命中则消费掉不下发。

`SessionEvent` 新增的 `user` kind 只服务这一条转写观测路径,`#absorb` 的运行时态 switch 没有对应 case(不需要),但 `reduceEvent` 与前端 `onSessionEvent` 都要接住它写入各自的 timeline。

## 后端重启后,tmux 接管会话默认全部判 exited —— 需要重新探活,且 paneId 本身可能缺失

锚点:`sessionManager.ts` `#reclaimTmuxSessions` / `#loadPersisted`,`tmuxTransport.ts` `findClaimedPanes` / `paneExists`。

`#loadPersisted` 早期实现无条件把所有历史记录标 `exited` 并挂 `NullTransport`,不检查对应的 tmux pane 是否其实还活着。`synapse daemon restart` 让这个盲区第一次被实际触发:重启纯粹是为了加载新代码,并不代表这些会话真的死了,但网页刷新后全部显示"已退出",体验上等同于"重启一次弄丢所有进行中的会话"。

**修复分两层。** 运行时状态:`#reclaimTmuxSessions()` 在构造函数末尾异步跑,对 `transportKind === 'tmux'` 且有 `paneId` 的历史记录逐个 `paneExists()` 探测,还在就重建 `TmuxTransport`(带上已知 `sessionId`)接回去,状态交给 `start()` 的正常流程。构造函数不能是 `async`,故先同步把历史记录标 `exited` 让 `SessionManager` 立刻可用,真实状态在随后几秒内异步纠正;存活巡检对 `state === 'exited'` 的会话直接跳过,不会跟异步重建产生竞态。

**数据缺口:`paneId` 是后加的字段。** `PersistedSession` 起初没有 `paneId`(落盘设计成型时只关心元数据统计,没考虑过要重新接管 pane)。补上字段后,新记录会正确落盘,但**旧数据补不回来** —— 磁盘上已有的记录里这个字段就是不存在,`#reclaimTmuxSessions` 因为没有 `paneId` 可用而跳过这些会话,继续显示 `exited`。

手动改 `sessions.json` 补这个字段是条死路:只要还有一个跑着旧内存状态(没有 `paneId`)的进程,它下一次 `stopAll()` 或任何 `scheduleSave()` 就会用自己内存里缺字段的快照同步覆盖磁盘,把补丁冲掉 —— 实测连续两次手动补丁都被冲掉(每次补完还得再重启一次让新数据被读到,而这次重启本身又会经过一次旧进程的 `stopAll`)。

**因此补全逻辑必须在代码里自己完成。** `findClaimedPanes()` 反查当前操作系统状态:`ps -eo pid,ppid,command` 全量扫描,用 `--session-id <uuid>` 定位每个 claude 进程,再沿 `ppid` 链向上爬直到匹配某个 tmux pane 的 `pane_pid`(claude 不是 pane 的直接子进程 —— CLI 会先起一层 node 壳、`execClaude` 再 spawn claude),建立 `sessionId -> paneId` 的映射。`#reclaimTmuxSessions()` 对 `paneId` 缺失但有 `claudeId` 的候选记录先用这份映射补一次,查到就顺手写回 `s.paneId` 并 `scheduleSave()` 落盘 —— 只反查这一次,之后的重启直接读已补全的磁盘数据。

## 左栏排序固定,不随会话状态跳动

锚点:`public/app.js` 的 project/session 排序,`createdAt` 字段贯穿 `Session`/`SessionSummary`/`PersistedSession`。

早期实现里 project 与 session 的排序都掺了 `sessionRank`(需要你/进行中/静默):project 按 `min(rank)` 排,组内 session 按 `rank` 再按 `lastActivity` 倒序。代价是顺序随时间不断改变 —— 一个会话变 busy、来一条批准请求、或单纯有了新动态,所在的 project 与 session 位置就跳,常用会话"眼疾手快"才找得到。

改为固定排序:project 纯字母序(`localeCompare`),session 按 `createdAt`(旧到新),两者都不再受 `rank` 影响位置。`rank` 仍保留,只用于 `attn` class 与 `pip` 颜色这类纯视觉提示,不参与排序比较函数。

`createdAt` 是新增字段。旧数据没有,`#loadPersisted` 用 `p.createdAt ?? p.lastActivity` 兜底 —— 不精确(旧会话的"创建时间"实际是它最后一次活动的时间),但保证有排序依据而不是 `undefined` 参与比较导致顺序不确定。

## 网页发消息与终端回显对不上换行符,导致重复消息

锚点:`tmuxTransport.ts` `#pendingEchoes` 比对,`normalizeNewlines()`。

`TmuxTransport.send()` 用 `#pendingEchoes` FIFO 消化自己的回显,精确字符串匹配比对注入文本与转写文件里读回的文本。多行消息(网页 textarea 用 Shift+Enter 换行)会命中一个换行符不一致的坑:

`claude` 收到粘贴内容后,把消息内部换行符落盘成 `\r`(如 `"...状态\r从 Manila API..."`),而网页 `<textarea>` 的 `value` 里 Shift+Enter 产生的是标准 `\n`。`send()` 传入 `#pendingEchoes` 的是原始 `\n` 版本,`#handleLine` 解析出的 `ev.text` 是 `\r` 版本,`indexOf` 精确匹配永远不命中 —— 回显消不掉,`emit(ev)` 照常发出,叠加前端自己已经通过 `user_message` 展示的那条,网页上同一条多行消息显示两遍。单行消息不受影响。

修复:比对前对两侧都过一遍 `normalizeNewlines()`(`\r\n?` 统一换成 `\n`)。`#inject()` 实际写入 tmux 的仍是原始 `text` —— 归一化只用于回显比对这一步。
