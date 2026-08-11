/**
 * 守护进程管理 —— 状态落盘、健康检查、后台拉起。
 *
 * 状态存 ~/.synapse/<port>/:daemon.pid / port / token,由后端监听成功后
 * 自己写入(端口递增重试发生在服务端,detached 启动的父进程拿不到 stdout,
 * 无从得知最终端口)。
 *
 * 按「请求端口」(调用方想要的目标端口,不是最终实际监听的端口)分目录 ——
 * 这是 Project List 落地后的新需求:不同 workspace 下开 wrapper 要能找到
 * 同一个生产 daemon,但测试环境指定另一个端口时不能读到/污染生产的状态文件。
 * 显式指定端口时不允许递增(见 server.ts),故「请求端口」与「实际监听端口」
 * 精确相等,目录名可预测。默认端口仍走原有递增容错,此时两者也相等 ——
 * 只有在默认端口已被其他服务占用时才会有出入,那种情况下写回的状态文件
 * 会把后续 wrapper 调用指向递增后的端口。本仓库自己的手动调试(`npm run
 * dev`)因此固定用了另一个显式端口(见 package.json),避免它抢占默认端口
 * 触发递增、悄悄覆盖生产 daemon 的状态文件。
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
import { randomUUID } from 'node:crypto';

const SYNAPSE_DIR = join(homedir(), '.synapse');

export const HOST = '127.0.0.1';
// 3000 是 React/Next.js/Rails 等大量工具的默认端口,极易撞;
// 47100 落在常见开发端口段(<9000)与 Docker/K8s/数据库默认端口段之外。
export const DEFAULT_PORT = 47100;
/** 端口递增重试上限,仅默认端口适用(见 server.ts)。 */
export const MAX_PORT_TRIES = 20;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_ENTRY = join(ROOT, 'backend', 'server.ts');

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
}

/** 导出供 store.ts 用 —— 会话持久化跟着 daemon 实例走,同一状态目录同一份数据。 */
export function stateDir(requestedPort: number): string {
  return join(SYNAPSE_DIR, String(requestedPort));
}

/** 后端就绪后调用,把连接信息交给 CLI。requestedPort 决定落盘目录,见文件头注释。 */
export function writeState(requestedPort: number, state: DaemonState): void {
  if (state.port !== requestedPort) {
    // 请求端口被占用触发递增(见 server.ts listenWithRetry)—— 写回状态文件
    // 会让后续所有 wrapper 调用改道到这个递增后的实例。这本该只在默认端口
    // 撞上无关外部服务时发生;若撞上的是本仓库自己的另一个实例(比如忘了
    // 关的手动开发进程),不吭声地写回会悄悄劫持生产 daemon 的连接信息,
    // 且难以察觉 —— 所以在这里明确报出来,而不是任其静默发生。
    console.error(
      `[daemon] 端口 ${requestedPort} 被占用,已改用 ${state.port} —— 状态文件仍会指向 ${state.port},` +
      `确认占用方不是本仓库遗留的旧实例(如 npm run dev)。`,
    );
  }
  const dir = stateDir(requestedPort);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'daemon.pid'), String(state.pid), { mode: 0o600 });
  writeFileSync(join(dir, 'port'), String(state.port), { mode: 0o600 });
  // token 等价于批准任意命令的凭据,权限不能放宽
  writeFileSync(join(dir, 'token'), state.token, { mode: 0o600 });
}

export function readState(requestedPort: number): DaemonState | null {
  const dir = stateDir(requestedPort);
  try {
    const pid = Number(readFileSync(join(dir, 'daemon.pid'), 'utf8').trim());
    const port = Number(readFileSync(join(dir, 'port'), 'utf8').trim());
    const token = readFileSync(join(dir, 'token'), 'utf8').trim();
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!Number.isInteger(port) || port <= 0) return null;
    if (!token) return null;
    return { pid, port, token };
  } catch {
    return null;
  }
}

/**
 * 不删 token —— 那是「这个端口的固定身份」,daemon.pid/port 才是「进程是否
 * 还活着」的判定依据。restart 场景下旧进程退出时会调这个函数清场,不留
 * token 的话下次启动只能重新生成,用户手里的链接(书签、浏览器历史)全部
 * 失效。见 readOrCreateToken() —— 新进程启动时优先复用这份残留。
 */
export function clearState(requestedPort: number): void {
  const dir = stateDir(requestedPort);
  for (const f of ['daemon.pid', 'port']) {
    rmSync(join(dir, f), { force: true });
  }
}

/** 供 server.ts 启动时调用:同端口有残留 token 就复用,没有才新生成。 */
export function readOrCreateToken(requestedPort: number): string {
  const dir = stateDir(requestedPort);
  const path = join(dir, 'token');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // 没有残留,走下面的新生成分支
  }
  const token = randomUUID();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
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
 *
 * port 是「请求端口」:不同 workspace 下不传 port 时都落在同一默认值,
 * 天然复用同一个生产 daemon(Project List 能跨 workspace 聚合会话正是靠这个);
 * 测试环境显式传入不同端口,则状态目录、daemon 实例都完全隔离,互不干扰。
 */
export async function ensureDaemon(port = DEFAULT_PORT, waitMs = 20_000): Promise<DaemonState> {
  const existing = readState(port);
  if (existing && (await checkHealth(existing))) return existing;
  if (existing) clearState(port);

  spawnDaemon(port);
  return waitForDaemon(port, waitMs);
}

/**
 * 后台拉起后端。detached + stdio ignore + unref 三者缺一不可:
 * 少了任何一个,CLI 退出(或它 attach 的 tmux 结束)都会带走后端。
 */
function spawnDaemon(port: number): void {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SERVER_ENTRY],
    {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SYNAPSE_DAEMON: '1', PORT: String(port) },
    },
  );
  child.unref();
}

/** 轮询状态文件直到后端写入并通过健康检查。 */
async function waitForDaemon(port: number, waitMs: number): Promise<DaemonState> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const state = readState(port);
    if (state && (await checkHealth(state))) return state;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `后端启动超时(${waitMs / 1000}s)。手动排查:PORT=${port} node ${SERVER_ENTRY}`,
  );
}

/**
 * 优雅终止:发 SIGTERM 走 server.ts 的 shutdown()(落盘会话状态、drain 挂起的
 * 批准请求),而非直接 kill -9 —— 那会跳过 stopAll() 的收尾,sessions.json
 * 里的运行时字段可能停在终止前一刻的脏值。
 *
 * 只停 daemon 本身,不碰它旁路观察的 tmux pane —— pane 里的 claude 进程
 * 独立于 daemon 存活(见 tmuxTransport.ts stop() 的接管模式说明),
 * 这正是「重启网页后端不影响正在进行的终端会话」的前提。
 */
export async function stopDaemon(port: number, waitMs = 10_000): Promise<'stopped' | 'not-running'> {
  const state = readState(port);
  if (!state || !pidAlive(state.pid)) {
    if (state) clearState(port);
    return 'not-running';
  }

  process.kill(state.pid, 'SIGTERM');

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) return 'stopped';
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`进程 ${state.pid} 在 ${waitMs / 1000}s 内未退出,可能卡在收尾逻辑里`);
}

export function urlFor(state: DaemonState): string {
  return `http://${HOST}:${state.port}/?token=${state.token}`;
}
