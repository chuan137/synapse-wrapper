/**
 * tmuxTransport.ts 单测 —— 只覆盖纯函数(就绪判定 / 信任对话框识别)。
 * 注入与 tmux 交互需要真起会话,不在这里测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenLooksReady, screenIsTrustDialog, startTimeoutEvent } from './tmuxTransport.ts';

test('干净的 ❯ 提示行 → 就绪', () => {
  assert.equal(screenLooksReady('some output\n\n❯ \n'), true);
});

test('提示行带占位符 Try "…" → 就绪', () => {
  assert.equal(screenLooksReady('❯ Try "edit the config"\n'), true);
});

test('提示行带边框装饰 → 就绪', () => {
  assert.equal(screenLooksReady(' │ ❯                                    │\n'), true);
});

test('忙碌 spinner + 空 ❯ 行 → 可注入', () => {
  const screen = [
    '● Working on it',
    '',
    '❯ ',
    '',
    '✶ Schlepping… (22s · ↓ 603 tokens · esc to interrupt)',
  ].join('\n');
  assert.equal(screenLooksReady(screen), true);
});

test('输入框有残留文本 → 非就绪', () => {
  assert.equal(screenLooksReady('❯ show me app.js\n'), false);
});

test('没有任何提示行 → 非就绪', () => {
  assert.equal(screenLooksReady('Welcome back\nTips for getting started\n'), false);
});

test('信任对话框被识别', () => {
  assert.equal(
    screenIsTrustDialog('Do you trust this folder?\n❯ 1. Yes, I trust\n  2. No, exit'),
    true,
  );
});

test('普通就绪屏不误判为信任对话框', () => {
  assert.equal(screenIsTrustDialog('❯ \n'), false);
});

// start() 就绪探测超时但 pane 仍存活 —— 不应产生会被前端渲染成"发送失败"
// 的错误。daemon 重启后 #reclaimTmuxSessions 重建的 TmuxTransport 与用户
// 同时发的消息共享同一个 #waitReady 单飞结果时,这是唯一能阻断误判的分支
// (见 docs/notes/implementation-lessons.md「TUI 启动超时」条目)。
test('start() 就绪超时且 pane 存活 → lifecycle 错误,不是 send 错误', () => {
  const ev = startTimeoutEvent(true);
  assert.equal(ev.scope, 'lifecycle');
  assert.doesNotMatch(ev.message, /发送失败|注入失败/);
});

test('start() 就绪超时且 pane 已消失 → 仍是 lifecycle,不冒充某次发送失败', () => {
  const ev = startTimeoutEvent(false);
  assert.equal(ev.scope, 'lifecycle');
  assert.match(ev.message, /pane 已消失/);
});
