/**
 * TaskStore 单测 —— node:test,免新依赖(见 spec §2.7 的 Node 环境)。
 * 每个用例用独立临时 tasks.json,不碰 ~/.synapse。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from './taskStore.ts';

function tmpTasksPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'synapse-tasks-'));
  return { path: join(dir, 'tasks.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('路径不存在 → 构造出空结构,不抛错', () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    const store = new TaskStore(path);
    assert.deepEqual(store.listProjects(), []);
  } finally {
    cleanup();
  }
});

test('createTask → getTask 读回一致,重启后仍一致', async () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    const s1 = new TaskStore(path);
    const project = s1.ensureProjectForWorkspace('/tmp/repo-a');
    const task = s1.createTask({
      projectId: project.id,
      title: '实现任务管理',
      goal: '目标',
      acceptance: '验收',
      priority: 'high',
    });
    await s1.flush();

    const s2 = new TaskStore(path);
    const reloaded = s2.getTask(task.id);
    assert.deepEqual(reloaded, task);
    assert.equal(reloaded?.status, 'todo');
  } finally {
    cleanup();
  }
});

test('写出的 tasks.json 权限位是 0600', async () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    const store = new TaskStore(path);
    store.ensureProjectForWorkspace('/tmp/repo-a');
    await store.flush();
    assert.ok(existsSync(path));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test('attachAgent({role:"main"}) 两次 → 旧 binding 被结束', async () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    const store = new TaskStore(path);
    const project = store.ensureProjectForWorkspace('/tmp/repo-a');
    const task = store.createTask({ projectId: project.id, title: 't' });

    const b1 = store.attachAgent({
      taskId: task.id,
      localId: 'sess-1',
      role: 'main',
      transportKind: 'tmux',
    });
    // 换会话再挂 main —— 上一条应被 endedAt 关掉。
    const b2 = store.attachAgent({
      taskId: task.id,
      localId: 'sess-2',
      role: 'main',
      transportKind: 'tmux',
    });
    await store.flush();

    assert.notEqual(store.getBinding(b1.id)?.endedAt, null);
    assert.equal(store.getBinding(b2.id)?.endedAt, null);
  } finally {
    cleanup();
  }
});

test('同一 localId 第二次 attachAgent 到另一个 task → 抛错', () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    const store = new TaskStore(path);
    const project = store.ensureProjectForWorkspace('/tmp/repo-a');
    const t1 = store.createTask({ projectId: project.id, title: 't1' });
    const t2 = store.createTask({ projectId: project.id, title: 't2' });

    store.attachAgent({ taskId: t1.id, localId: 'sess-1', role: 'sub', transportKind: 'stream-json' });
    assert.throws(() =>
      store.attachAgent({ taskId: t2.id, localId: 'sess-1', role: 'sub', transportKind: 'stream-json' }),
    );
  } finally {
    cleanup();
  }
});

test('detachAgent 只设 endedAt', async () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    const store = new TaskStore(path);
    const project = store.ensureProjectForWorkspace('/tmp/repo-a');
    const task = store.createTask({ projectId: project.id, title: 't' });
    const b = store.attachAgent({
      taskId: task.id,
      localId: 'sess-1',
      role: 'sub',
      transportKind: 'stream-json',
    });
    store.detachAgent(b.id);
    await store.flush();
    assert.notEqual(store.getBinding(b.id)?.endedAt, null);
    // detach 后该会话可再次绑定。
    assert.doesNotThrow(() =>
      store.attachAgent({ taskId: task.id, localId: 'sess-1', role: 'sub', transportKind: 'stream-json' }),
    );
  } finally {
    cleanup();
  }
});

test('损坏 JSON → 不覆盖,原文件改名保留,新结构可用', async () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    writeFileSync(path, '{ 这不是合法 JSON ');
    const store = new TaskStore(path);
    assert.deepEqual(store.listProjects(), []);
    const dir = join(path, '..');
    const corrupt = readdirSync(dir).filter((f) => f.startsWith('tasks.json.corrupt-'));
    assert.equal(corrupt.length, 1);

    // 新结构可正常写。
    const project = store.ensureProjectForWorkspace('/tmp/repo-a');
    store.createTask({ projectId: project.id, title: 't' });
    await store.flush();
    assert.equal(store.listTasks(project.id).length, 1);
  } finally {
    cleanup();
  }
});

test('ensureProjectForWorkspace 幂等 —— 同路径不重复建', () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    const store = new TaskStore(path);
    const p1 = store.ensureProjectForWorkspace('/tmp/repo-a');
    const p2 = store.ensureProjectForWorkspace('/tmp/repo-a');
    assert.equal(p1.id, p2.id);
    assert.equal(store.listProjects().length, 1);
  } finally {
    cleanup();
  }
});

test('appendEvent / listEvents 按 taskId 隔离', async () => {
  const { path, cleanup } = tmpTasksPath();
  try {
    const store = new TaskStore(path);
    const project = store.ensureProjectForWorkspace('/tmp/repo-a');
    const t1 = store.createTask({ projectId: project.id, title: 't1' });
    const t2 = store.createTask({ projectId: project.id, title: 't2' });
    store.appendEvent({ taskId: t1.id, kind: 'task_created', message: 'created' });
    store.appendEvent({ taskId: t2.id, kind: 'task_created', message: 'created' });
    store.appendEvent({ taskId: t1.id, kind: 'task_updated', message: 'updated' });
    await store.flush();
    assert.equal(store.listEvents(t1.id).length, 2);
    assert.equal(store.listEvents(t2.id).length, 1);
  } finally {
    cleanup();
  }
});
