/**
 * tmuxTransport.ts 单测 —— 只覆盖纯函数(就绪判定 / 信任对话框识别)。
 * 注入与 tmux 交互需要真起会话,不在这里测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenLooksReady, screenIsTrustDialog } from './tmuxTransport.ts';

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
