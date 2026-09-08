/**
 * 子 agent 的 git worktree 隔离 —— 落地顺序第 6 步的薄版本(见
 * docs/design/main-agent-orchestration.md)。
 *
 * 完整的 `dirtyStrategy`(require-clean / ignore / carry-stash)、`linkFiles`、
 * clone 变体见 spec §1.3,尚未落地。这里只做止血:`synapse agent spawn --worktree`
 * 时从干净 `HEAD` 拉一个独立目录给子 agent,等价于 §1.3 的 `ignore` 策略 ——
 * 两个任务的主 agent 并行跑时,子 agent 的改动不再缠进同一工作树。
 *
 * 主库 dirty 不阻断也不搬运:worktree 从 `HEAD` 起,用户的未提交改动留在主库。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SYNAPSE_DIR } from './daemon.ts';

const exec = promisify(execFile);

const WORKTREES_DIR = join(SYNAPSE_DIR, 'worktrees');

/** worktree 目录名 —— slug 由调用方安全化后传入,binding 前缀区分同任务的多个子 agent。 */
function worktreeDirName(projectSlug: string, taskId: string, bindingId: string): string {
  return `${projectSlug}-${taskId}-${bindingId.slice(0, 8)}`;
}

/**
 * 找 workspace 所在的 git 仓库根。不是 repo 就抛错 —— `--worktree` 对非 git 目录
 * 没有意义,让调用方把这个错回给主 agent。
 */
export async function repoRootOf(workspace: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    throw new Error(`${workspace} 不在 git 仓库里 —— --worktree 需要一个 git 仓库`);
  }
}

/**
 * 从 `repoRoot` 的 `HEAD` 拉一个 detached worktree 到
 * `~/.synapse/worktrees/<slug>-<taskId>-<binding 前缀>`,返回其绝对路径。
 *
 * 用 detached HEAD 不建分支 —— 薄版本不管合并回主库(那是 §1.3「清理」入口的事),
 * 子 agent 在里面 commit 出来的东西靠 `git worktree` 引用可达,不需要一个具名分支。
 * 目录已存在(上次没清理干净)先 `remove --force` 再重建。
 */
export async function addWorktree(
  repoRoot: string,
  projectSlug: string,
  taskId: string,
  bindingId: string,
): Promise<string> {
  mkdirSync(WORKTREES_DIR, { recursive: true, mode: 0o700 });
  const path = join(WORKTREES_DIR, worktreeDirName(projectSlug, taskId, bindingId));
  if (existsSync(path)) {
    await exec('git', ['-C', repoRoot, 'worktree', 'remove', '--force', path], { timeout: 10_000 })
      .catch(() => {});
  }
  await exec('git', ['-C', repoRoot, 'worktree', 'add', '--detach', path, 'HEAD'], {
    timeout: 30_000,
  });
  return path;
}

/**
 * 移除一个 worktree(`DELETE /agents/:bindingId` 与任务归档时调)。
 * `--force` —— 里面可能有未提交改动,但这是显式的解绑/归档动作,用户已表态。
 * repoRoot 从 worktree 自己反查:binding 上只存了 worktree 路径。
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;
  let repoRoot: string;
  try {
    const { stdout } = await exec(
      'git',
      ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: 5000 },
    );
    // git-common-dir 指向主库的 .git;去掉末尾的 /.git 得主库根
    repoRoot = stdout.trim().replace(/\/\.git\/?$/, '');
  } catch {
    return;
  }
  await exec('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath], {
    timeout: 10_000,
  }).catch(() => {});
}
