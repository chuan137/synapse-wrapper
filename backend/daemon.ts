/**
 * 守护进程管理 —— 状态落盘、健康检查、后台拉起。
 *
 * 状态存 ~/.synapse/:daemon.pid / port / token,由后端监听成功后自己写入
 * (端口递增重试发生在服务端,detached 启动的父进程拿不到 stdout,
 *  无从得知最终端口)。
 *
 * 健康检查必须 PID 与 HTTP 双过:PID 可能被系统回收后分配给无关进程,
 * 单看 PID 会把陌生进程误认成后端;而端口可能被别的程序占着,
 * 单看 HTTP 又会把非本工具的服务当成自己人。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const STATE_DIR = join(homedir(), '.synapse');
const PID_FILE = join(STATE_DIR, 'daemon.pid');
const PORT_FILE = join(STATE_DIR, 'port');
const TOKEN_FILE = join(STATE_DIR, 'token');

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;
/** 端口递增重试上限。 */
export const MAX_PORT_TRIES = 20;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_ENTRY = join(ROOT, 'backend', 'server.ts');

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
}

/** 后端就绪后调用,把连接信息交给 CLI。 */
export function writeState(state: DaemonState): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PID_FILE, String(state.pid), { mode: 0o600 });
  writeFileSync(PORT_FILE, String(state.port), { mode: 0o600 });
  // token 等价于批准任意命令的凭据,权限不能放宽
  writeFileSync(TOKEN_FILE, state.token, { mode: 0o600 });
}

export function readState(): DaemonState | null {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    const port = Number(readFileSync(PORT_FILE, 'utf8').trim());
    const token = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!Number.isInteger(port) || port <= 0) return null;
    if (!token) return null;
    return { pid, port, token };
  } catch {
    return null;
  }
}

export function clearState(): void {
  for (const f of [PID_FILE, PORT_FILE, TOKEN_FILE]) {
    rmSync(f, { force: true });
  }
}

/** signal 0 只做存在性检查,不投递信号。EPERM(进程存在但不归当前用户)同样算不健康。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * HTTP 探活。校验 token 相符,确保应答者确实是本状态文件描述的那个后端,
 * 而非恰好占用同一端口的其他程序。
 */
async function httpAlive(state: DaemonState, timeoutMs = 2000): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${HOST}:${state.port}/api/token`, {
      signal: ac.signal,
      headers: { origin: `http://${HOST}:${state.port}` },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { token?: string };
    return body.token === state.token;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 两项都过才算健康;任一不过即视为陈旧,调用方应清理后重启。 */
export async function checkHealth(state: DaemonState): Promise<boolean> {
  if (!pidAlive(state.pid)) return false;
  return httpAlive(state);
}

/**
 * 确保后端在跑,返回可用的连接信息。
 * 已有实例健康则直接复用;否则清掉陈旧状态重新拉起。
 */
export async function ensureDaemon(waitMs = 20_000): Promise<DaemonState> {
  const existing = readState();
  if (existing && (await checkHealth(existing))) return existing;
  if (existing) clearState();

  spawnDaemon();
  return waitForDaemon(waitMs);
}

/**
 * 后台拉起后端。detached + stdio ignore + unref 三者缺一不可:
 * 少了任何一个,CLI 退出(或它 attach 的 tmux 结束)都会带走后端。
 */
function spawnDaemon(): void {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SERVER_ENTRY],
    {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SYNAPSE_DAEMON: '1' },
    },
  );
  child.unref();
}

/** 轮询状态文件直到后端写入并通过健康检查。 */
async function waitForDaemon(waitMs: number): Promise<DaemonState> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const state = readState();
    if (state && (await checkHealth(state))) return state;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `后端启动超时(${waitMs / 1000}s)。手动排查:node ${SERVER_ENTRY}`,
  );
}

export function urlFor(state: DaemonState): string {
  return `http://${HOST}:${state.port}/?token=${state.token}`;
}
