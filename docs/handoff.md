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

## 待做

### 1. UI 适配 tmux 会话

tmux 会话的「终端输出」页签可用 `TmuxTransport.capture()` 做镜像,目前未接。

会话标识已完成:显示名优先用 claude 的 ai-title(说明会话在做什么),标题生成前退回 pane ID。见 spec §2.8。

### 2. 注入残留

实测见到过输入框残留上一次未提交的文本(`❯ show me app.js`)。`#inject` 开头有 `C-u` 清理,但时机可能不够稳。会话忙碌时注入的行为需要再验。

### 3. 死会话在网页端的呈现

按决定,pane 消失后的会话**不自动清理**,留给网页集中管理。`TmuxTransport.alive()` 已可查询承载体是否还在,但尚未接进会话摘要 —— UI 需要据此标出「pane 已失效」并提供关闭入口。

## 关键约束(改代码前必读)

**钩子超时是 fail-open。** 默认约 600 秒,超时后工具照常执行。后端必须自管截止时间:settings 配 `HOOK_TIMEOUT_S=300`,内部 `DECISION_TIMEOUT_MS=280_000` 到点主动 deny。绝不能依赖钩子超时。

**钩子 URL 必须用实际监听端口。** 端口占用时后端递增重试,若 settings 里写死初始端口,钩子会打到无人监听处而失败 —— 等同于 fail-open,所有工具无审批执行。故 `SessionManager` 端口取函数而非定值。

**pending 表必须以 `tool_use_id` 为键。** 同一会话可能多个工具并发等待,仅按 `session_id` 索引会串。

**settings 必须合并写入。** `.claude/settings.local.json` 通常已被用户占用。按事件名追加,写入前剔除本工具旧条目(按 URL 含 `/api/claude-event` 识别),权限 `0600`。

**信任对话框无法用钩子处理** —— 信任发生在钩子加载之前。已用 `TmuxTransport.ensureTrusted()` 预置解决。这是代用户作安全决定,CLI 在首次信任某目录时明确告知(该方法返回 true 表示本次新写入)。

**接管模式下 pane 属于用户。** `stop()` 任何情况都不销毁它。

**会话 ID 必须由 CLI 指定,不能事后推断。** 按转写文件 mtime 认领在同目录并存时会张冠李戴,批准请求随之路由到错误的会话(网页批准 A、实际放行 B)。CLI 生成 UUID 并经 `--session-id` 传给 claude。踩过一次,见 spec §2.6。

**`bin/wrapper` 必须是纯 JS。** 类型剥离只认 `.ts` 扩展名;版本闸门也必须留在薄壳里,否则低版本 Node 在 import 时就先崩了,提示永远显示不出来。

## 未决事项

- **中断能力** — stream-json 下 `interrupt()` 发 SIGINT,可能杀掉整个会话,未验证
- **Artifacts 页签** — 后端未采集产出物
- **diff 内容** — 只列文件名与类型,不显示具体 diff
- **崩溃恢复** — 后端退出会带走 stream-json 子进程(tmux 不受影响),`--resume` 流程未设计

## 测试注意

- tmux 测试会话统一用 `synapse_` 前缀,**测完必须清理**;`kill-session` 不一定带走 claude 进程,需另行确认无孤儿(`pgrep -fl <工作区名>`)
- 改了后端代码后要先杀掉旧守护进程,否则 `ensureDaemon` 会复用跑着旧代码的实例(踩过:新加的返回字段一直取不到)
- 临时测试脚本放项目内(scratchpad 不受 `"type": "module"` 影响会被当 CJS),用完删除
- 不要用 `echo hello` 这类提示词测钩子 —— 模型会直接回答而不调工具
- 验证 UI 用 Chrome 无头截图:`--headless --screenshot=... --virtual-time-budget=4000`
