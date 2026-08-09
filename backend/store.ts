/**
 * 会话元数据持久化 —— 让左栏「Project 分组 + 历史会话」在后端重启后不丢。
 *
 * 只存元数据(workspace/name/title/claudeId/transportKind/统计数字等),
 * 不存 timeline —— 那份数据 Claude Code 自己已经写在转写文件里
 * (~/.claude/projects/<cwd 转写>/<session_uuid>.jsonl,详见 docs/spec.md),
 * 重复落盘只会造出两份可能不同步的历史。重启后无法恢复正在跑的子进程,
 * 加载出的会话一律标 exited;真正的对话内容按需从 transcriptPath 现读。
 *
 * 写盘走 debounce:#absorb 里几乎每条 transcript 行都会触发一次状态变化,
 * 逐条同步写盘在长对话里是明显的 I/O 负担。
 *
 * 落盘路径按端口分目录(见 daemon.ts 的 stateDir)——会话数据跟着 daemon 实例走,
 * 不同端口是不同的 daemon 实例,不该共享同一份 sessions.json。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './daemon.ts';
import type { PersistedSession } from './sessionManager.ts';

const DEBOUNCE_MS = 500;

export function loadSessions(port: number): PersistedSession[] {
  const storePath = join(stateDir(port), 'sessions.json');
  if (!existsSync(storePath)) return [];
  try {
    const data = JSON.parse(readFileSync(storePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    console.warn(`[store] ${storePath} 解析失败,当作没有历史记录`);
    return [];
  }
}

export class SessionStore {
  #timer: NodeJS.Timeout | null = null;
  #getAll: () => PersistedSession[];
  #storePath: string;

  constructor(port: number, getAll: () => PersistedSession[]) {
    this.#storePath = join(stateDir(port), 'sessions.json');
    this.#getAll = getAll;
  }

  /** 合并进同一个 debounce 窗口,而非每次调用都开定时器。 */
  scheduleSave(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.saveNow();
    }, DEBOUNCE_MS);
    this.#timer.unref?.();
  }

  /** 关停前调用,确保最后一批变更不因 debounce 窗口未到而丢失。 */
  saveNow(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const dir = join(this.#storePath, '..');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 先写临时文件再改名 —— 避免写到一半时进程被杀导致 JSON 半截、下次加载整体失败。
    const tmp = `${this.#storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#getAll(), null, 2), { mode: 0o600 });
    renameSync(tmp, this.#storePath);
  }
}
