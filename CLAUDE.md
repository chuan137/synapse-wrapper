Synapse Wrapper 是用于驱动 Claude Code 多工作区会话的生产级 Web 应用,提供浏览器端状态查看、对话、产物展示与权限控制流程。
权威系统规格见 `./docs/spec.md`。
---

## 注释规范

源码注释只说明代码本身无法表达的约束,优先解释「为什么」,不要复述「是什么」。

如果一段代码看起来可以随意改动、实则不能,可以用一句简短注释说明原因。

调试过程、试错记录、版本行为差异**不写进源码**,分三处存:

- `docs/spec.md` —— 稳定的、构成设计前提的硬约束和事实
- `docs/notes/claude-code-behavior.md` —— Claude Code / stream-json / hook 的固有行为(与本项目实现解耦)
- `docs/notes/implementation-lessons.md` —— 本项目某次实现错了 → 实测 → 修正的踩坑记录,锚在具体函数上

设计决策(还没定稿或还没实现的)放 `docs/design/<主题>.md`,带 `status` frontmatter。时间线编号只在 `docs/phase1-implementation-plan.md` 一处。

```ts
// 好 —— 说明了一个不可见的约束
// 信任对话框的选项前也带 ❯,必须在就绪判断之前识别,否则提示词会被粘进对话框而丢失。

// 差 —— 复述代码
// 清理临时文件

// 差 —— 调试过程
// 这里之前用的是 /^❯/m,实测踩过坑后改成现在这样
```
