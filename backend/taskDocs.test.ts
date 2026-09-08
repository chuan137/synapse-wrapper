/**
 * taskDocs 单测 —— node:test。每个用例用独立临时目录做 SYNAPSE_TASKS_REPO,
 * 不碰 ~/gb/synapse-tasks。测试串行跑(node:test 默认),环境变量全局但
 * 每个 test 用 try/finally 及时复原,不会互相踩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from './taskStore.ts';
import { readDoc, writeDoc, appendChangelog, ensureTasksRepo } from './taskDocs.ts';

async function withTasksRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-tasks-repo-'));
  const prev = process.env.SYNAPSE_TASKS_REPO;
  process.env.SYNAPSE_TASKS_REPO = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.SYNAPSE_TASKS_REPO;
    else process.env.SYNAPSE_TASKS_REPO = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    projectId: 'proj-1',
    title: '任务标题',
    goal: '目标文本',
    status: 'running',
    priority: 'normal',
    acceptance: '验收文本',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    ...overrides,
  };
}

test('读不存在的文档 → 返回按任务字段生成的骨架,不落盘', async () => {
  await withTasksRepo(async (repoRoot) => {
    const content = readDoc(undefined, fakeTask(), 'handoff');
    assert.match(content, /目标文本/);
    assert.match(content, /验收文本/);
    assert.ok(!existsSync(join(repoRoot, 'projects')), '骨架不应该落盘');
  });
});

test('writeDoc 首次调用 → git init + CLAUDE.md + skill 初版 + commit', async () => {
  await withTasksRepo(async (repoRoot) => {
    await writeDoc(undefined, fakeTask(), 'handoff', '## 子任务\n\n1. 做点什么');

    assert.ok(existsSync(join(repoRoot, '.git')));
    assert.ok(existsSync(join(repoRoot, 'CLAUDE.md')));
    assert.ok(existsSync(join(repoRoot, '.claude/skills/synapse-handoff/SKILL.md')));

    const log = execFileSync('git', ['-C', repoRoot, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /init synapse-tasks/);
    assert.match(log, /task a1b2c3d4: handoff/);
  });
});

test('writeDoc 写入内容落在标记区外,标记区原样保留', async () => {
  await withTasksRepo(async (repoRoot) => {
    const task = fakeTask();
    await writeDoc(undefined, task, 'progress', '当前状态:进行中');

    const content = readDoc(undefined, task, 'progress');
    assert.match(content, /<!-- synapse:begin state -->/);
    assert.match(content, /<!-- synapse:end -->/);
    assert.match(content, /当前状态:进行中/);

    // 第二次写入替换标记区外内容,不追加。
    await writeDoc(undefined, task, 'progress', '当前状态:已完成');
    const updated = readDoc(undefined, task, 'progress');
    assert.match(updated, /当前状态:已完成/);
    assert.ok(!updated.includes('进行中'));
  });
});

test('appendChangelog 是追加,不覆盖已有内容', async () => {
  await withTasksRepo(async (repoRoot) => {
    const task = fakeTask();
    await appendChangelog(undefined, task, '子 agent A 完成了 X');
    await appendChangelog(undefined, task, '子 agent B 完成了 Y');

    const content = readDoc(undefined, task, 'changelog');
    assert.match(content, /子 agent A 完成了 X/);
    assert.match(content, /子 agent B 完成了 Y/);

    const log = execFileSync('git', ['-C', repoRoot, 'log', '--oneline'], { encoding: 'utf8' });
    assert.equal(log.trim().split('\n').filter((l) => l.includes('changelog')).length, 2);
  });
});

test('project 不同 → 落进不同的 projects/<slug>/ 子目录', async () => {
  await withTasksRepo(async (repoRoot) => {
    const task = fakeTask();
    await writeDoc(
      { id: 'p1', name: '我的 项目', workspaceRoots: [], goal: '', createdAt: 0, updatedAt: 0 },
      task,
      'handoff',
      'x',
    );
    assert.ok(existsSync(join(repoRoot, 'projects', '我的-项目', task.id, 'handoff.md')));
  });
});

test('ensureTasksRepo 幂等 —— 已存在的 repo 不重复 init', async () => {
  await withTasksRepo(async (repoRoot) => {
    const first = await ensureTasksRepo();
    const beforeLog = execFileSync('git', ['-C', repoRoot, 'log', '--oneline'], { encoding: 'utf8' });
    const second = await ensureTasksRepo();
    const afterLog = execFileSync('git', ['-C', repoRoot, 'log', '--oneline'], { encoding: 'utf8' });
    assert.equal(first, second);
    assert.equal(beforeLog, afterLog);
  });
});
