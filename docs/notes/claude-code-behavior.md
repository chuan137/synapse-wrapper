# Claude Code 实测行为

这些是 Claude Code / stream-json 管道 / hook 机制的**固有行为**,与 Synapse 的实现方式无关 —— 换个项目也成立。稳定的、构成 Synapse 设计前提的结论提炼进 `../spec.md`;这里是完整的实测记录。

> 均在 **Claude Code 2.1.226 / macOS** 上验证。

---

## stream-json 支持多轮对话

`-p` 意为 programmatic(程序化)而非 one-shot(单轮)。单轮行为来自 `--input-format text`。

实测:单进程连续三轮,`session_id` 保持一致,第二轮正确答出第一轮要求记住的数字 —— **上下文跨轮保留**,不只是进程复用。

## HTTP 钩子可同步控制权限

`type: "http"` 的钩子会向指定 URL 发 POST,并**等待响应体中的决策**。实测 allow 与 deny 均被遵守。

延迟响应有效:模拟人工思考延迟 6 秒后返回 deny,工具被成功拦下。这是网页批准流程可行的前提。

决策响应格式见 `../spec.md` §3.3。超时行为(fail-open)是安全底线,见 `../spec.md` §2.2 —— 那条留在主 spec。

## 路径与标识符

| 项目 | 实际值 |
|---|---|
| 转写文件位置 | `~/.claude/projects/<cwd 路径转写>/<session_uuid>.jsonl` |
| `session_id` 格式 | 裸 UUID,如 `205d25cb-93b6-4c27-bd02-580ae7078aa7` |

转写路径中的 cwd 会被路径转写(斜杠转连字符,macOS 上 `/tmp` 会解析为 `/private/tmp`)。**不要自行推算此路径** —— 钩子载荷中的 `transcript_path` 字段直接给出准确值。

使用 stream-json 时无需读取转写文件,助手消息、工具调用与结果均从 stdout 获得。

## 会话 ID 可由调用方指定

`claude --session-id <uuid>` 可指定会话 ID,转写文件即 `<uuid>.jsonl`。

早期实现按「转写目录里 mtime 最新的文件」认领 session_id,在同目录并存时会张冠李戴 —— 这个坑与修复见 `implementation-lessons.md`「会话 ID 必须由调用方指定」。

## tmux 有两种承载方式

| 模式 | 触发方 | 行为 |
|---|---|---|
| 自建会话 | `sessionName` | `new-session -d` 建独立会话,后端持有其生命周期 |
| 接管 pane | `paneId` | 不建也不销毁会话,只对给定 pane 注入与观察 |

`synapse` CLI 走接管模式:claude 在用户当前 pane 里启动,CLI 只做前置准备(拉起后端、写 settings),不制造额外的会话层级。因此 **CLI 必须在 tmux 内运行** —— pane 是后端寻址的唯一手段;裸终端下直接提示而非隐式建会话。

`synapse daemon start` 是例外:只拉起 daemon 并打印网页链接,不创建会话、不接管 pane,不要求在 tmux 内。用于「只看任务面板,会话之后从网页里创建/绑定」的场景。`daemon <start|status|restart|stop>` 四个子命令都只管后端本身的生命周期。

tmux 的所有 `-t` 目标在两种模式下分别取 pane ID 与会话名,pane ID(如 `%3`)在 tmux 中处处可作 target。接管模式下 `stop()` 无论如何都不销毁 pane —— 那属于用户。

## 会话标题来自转写里的 ai-title

claude 会给会话起一个语义化标题(即 `/resume` 列表里显示的那个),写进转写文件:

```json
{ "type": "ai-title", "aiTitle": "查找login.js中硬编码密码的风险", "sessionId": "…" }
```

实测:首轮对话后不久出现(样本中位于第 8 行 / 共 38 行),**同一标题会重复写入多次**且该行**没有 `uuid`**,躲不过按 uuid 的去重,需自行比对上次值。

**标题几乎不会随话题变化更新。** 大范围扫描本地转写文件(435 个有多次 `ai-title` 写入的会话)发现:约 98%(426/435)的标题内容自始至终未变,即使反复写入多次;仅有的 9 个真正换过标题的样本,每一个的第二次标题都伴随新出现的 `agent-name` 行 —— 即标题变化只发生在会话被 `Task` 工具(子代理)接管的场景,不是主话题内部自然漂移出新标题。`s.title = ev.title`(见 `sessionManager.ts` `#absorb` 的 `case 'title'`)本身能正确处理"标题变了"的情况,只是触发条件在实践中极少满足 —— 这是上游行为,不是本项目的解析缺陷,遇到"标题一直不变"不必怀疑传递链路。

UI 用它区分同目录并存的会话 —— pane ID 能区分但不解释,标题才说明「这个会话在做什么」。标题与 `name`(目录名)并存而非覆盖,后者仍用于分组。

## 转写文件结构

行类型不止 `user` / `assistant`,还包括 `queue-operation`、`attachment`、`ai-title`、`last-prompt`,以及子代理产生的 `isSidechain` 条目。解析时须用白名单,否则控制类记录会被当作对话渲染。

实测确认:`claude -p --input-format stream-json` 与 tmux 里的原生 TUI 写的是**同一套路径规则**(`~/.claude/projects/<cwd 转写>/<session_id>.jsonl`),并非 tmux 独有。两种传输方式因此可以共用一份解析逻辑(`backend/transcript.ts`),既用于 tmux 的实时 tail,也用于历史重放。

**逐轮结束信号:`assistant` 消息的 `stop_reason` 字段。** 值为 `tool_use` 表示后面还要继续调工具、同一轮未结束;其他值(如 `end_turn`)才是这一轮真正说完。每轮必有恰好一条这样的收尾消息,是可靠的逐轮边界。`last-prompt` **不是**逐轮信号(早期实现踩过,见 `implementation-lessons.md`)。

**中断在转写文件里的痕迹。** 用户在终端按 Escape 中断,CLI 写一条 `type: "user"` 消息,`content` 是纯文本块:`[Request interrupted by user]`(工具调用中途则是 `[Request interrupted by user for tool use]`)。正常的下一轮用户输入,`type: "user"` 行的 `content` 是**纯字符串**不是数组。合成消息(会话摘要 `isCompactSummary`、跨会话通知、queue 提醒)带 `isMeta: true`;CLI 内置 `!command` 转写成 `<bash-input>...` / `<bash-stdout>...`。这些区分怎么用见 `implementation-lessons.md`。

**换行符落盘。** `claude` 收到粘贴的多行内容后,把消息内部换行符落盘成 `\r`(不是 `\n`)。回显比对时要归一化,见 `implementation-lessons.md`「换行符导致重复消息」。
