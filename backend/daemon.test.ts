/**
 * daemon.ts 单测 —— 只覆盖不需要真起进程的纯函数(旧状态目录搬迁)。
 * 每个用例用独立临时目录,不碰真实数据目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyStateDir, DEFAULT_PORT } from './daemon.ts';

function tmpBase(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-daemon-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('旧 <默认端口>/ 子目录 → token / sessions.json 搬到数据目录根', () => {
  const { dir, cleanup } = tmpBase();
  try {
    const legacy = join(dir, String(DEFAULT_PORT));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'token'), 'legacy-token');
    writeFileSync(join(legacy, 'sessions.json'), '[{"localId":"s1"}]');
    writeFileSync(join(legacy, 'hooks.settings.json'), '{"hooks":{}}');
    writeFileSync(join(legacy, 'daemon.pid'), '99999999'); // 几乎不可能存活的 PID
    writeFileSync(join(legacy, 'port'), String(DEFAULT_PORT));

    migrateLegacyStateDir(dir);

    assert.equal(readFileSync(join(dir, 'token'), 'utf8'), 'legacy-token');
    assert.equal(readFileSync(join(dir, 'sessions.json'), 'utf8'), '[{"localId":"s1"}]');
    assert.ok(existsSync(join(dir, 'hooks.settings.json')));
    // 死进程的 pid/port 残留被清掉
    assert.ok(!existsSync(join(legacy, 'daemon.pid')));
  } finally {
    cleanup();
  }
});

test('数据目录根已有 token → 不覆盖,旧的原样留在子目录', () => {
  const { dir, cleanup } = tmpBase();
  try {
    const legacy = join(dir, String(DEFAULT_PORT));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(dir, 'token'), 'current-token');
    writeFileSync(join(legacy, 'token'), 'legacy-token');

    migrateLegacyStateDir(dir);

    assert.equal(readFileSync(join(dir, 'token'), 'utf8'), 'current-token');
    assert.equal(readFileSync(join(legacy, 'token'), 'utf8'), 'legacy-token');
  } finally {
    cleanup();
  }
});

test('旧 daemon.pid 指向存活进程 → 整体跳过,不搬', () => {
  const { dir, cleanup } = tmpBase();
  try {
    const legacy = join(dir, String(DEFAULT_PORT));
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'token'), 'legacy-token');
    writeFileSync(join(legacy, 'daemon.pid'), String(process.pid)); // 本进程一定活着

    migrateLegacyStateDir(dir);

    assert.ok(!existsSync(join(dir, 'token')));
    assert.ok(existsSync(join(legacy, 'token')));
  } finally {
    cleanup();
  }
});

test('没有旧子目录 → 什么都不做', () => {
  const { dir, cleanup } = tmpBase();
  try {
    migrateLegacyStateDir(dir);
    assert.deepEqual(existsSync(join(dir, String(DEFAULT_PORT))), false);
  } finally {
    cleanup();
  }
});
