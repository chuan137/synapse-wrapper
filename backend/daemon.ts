/**
 * 守护进程管理 —— 状态落盘、健康检查、后台拉起。
 *
 * 所有 daemon 文件直接落在数据目录下(daemon.pid / port / token /
 * hooks.settings.json / sessions.json / daemon.log),不再按端口分子目录。
 * 数据目录默认 ~/.synapse,SYNAPSE_DATA_DIR 覆盖 —— 测试要隔离生产状态
 * 时指定一个临时目录,而不是靠换端口。一个数据目录对应至多一个 daemon 实例:
 * 同目录下 sessions.json / token 只有一份,不同端口的两个 daemon 共用同一
 * 数据目录会互相踩,由调用方(测试用独立 SYNAPSE_DATA_DIR)避免。
 *
 * port 文件仍记「实际监听端口」而非请求端口:端口递增重试发生在服务端,
 * detached 启动的父进程拿不到 stdout,只能靠这个文件知道最终监听到哪。
 *
 * 健康检查必须 PID 与 HTTP 双过:PID 可能被系统回收后分配给无关进程,
 * 单看 PID 会把陌生进程误认成后端;而端口可能被别的程序占着,
 * 单看 HTTP 又会把非本工具的服务当成自己人。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync, statSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HOOK_TIMEOUT_S } from './permissions.ts';

/**
 * Synapse 数据目录 —— 所有 daemon 文件与 tasks.json 都直接落在这里。
 * SYNAPSE_DATA_DIR 覆盖默认的 ~/.synapse,测试靠它隔离,不靠换端口。
 */
export const SYNAPSE_DIR = process.env.SYNAPSE_DATA_DIR
  ? resolve(process.env.SYNAPSE_DATA_DIR)
  : join(homedir(), '.synapse');

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

/**
 * 一次性搬迁:旧版把状态放在 <数据目录>/<默认端口>/ 下,现在直接放数据目录根。
 * 只在根目录还没有对应文件、且旧子目录有时才搬,搬完删空的旧目录。
 * daemon.pid/port 不搬 —— 那是「进程存活」标记,旧进程若还在跑仍归它管,
 * 新进程走正常的健康检查 + 拉起流程即可。token / sessions.json 搬上来,
 * 用户手里的链接和历史会话不因升级而丢。
 *
 * 只在 daemon 启动路径(server.ts 启动、CLI 的 main() / ensureDaemon)调用,
 * 不在模块加载时跑 —— 否则纯粹 import 到 daemon.ts 的单测也会去动数据目录。
 *
 * 旧目录里的 daemon.pid 还指向活进程时整体跳过:那个进程仍在往
 * <旧目录>/sessions.json 写,这会儿搬只会搬到一份随即被它覆盖回去的旧拷贝。
 * 等它经 `synapse daemon restart` / stop 退出(旧进程用旧代码,写的还是旧路径),
 * 下次启动前这里再搬。
 */
export function migrateLegacyStateDir(baseDir: string = SYNAPSE_DIR): void {
  const legacy = join(baseDir, String(DEFAULT_PORT));
  try {
    if (!statSync(legacy).isDirectory()) return;
  } catch {
    return;
  }
  try {
    const pid = Number(readFileSync(join(legacy, 'daemon.pid'), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return;
  } catch {
    // 没有 daemon.pid 或读不出 —— 旧进程已退,可以搬
  }
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  for (const f of ['token', 'sessions.json', 'hooks.settings.json']) {
    const from = join(legacy, f);
    const to = join(baseDir, f);
    try {
      statSync(to);
      continue; // 根目录已有,不覆盖
    } catch {
      // 根目录没有,尝试从旧目录搬
    }
    try {
      renameSync(from, to);
    } catch {
      // 旧目录也没有这个文件 —— 跳过
    }
  }
  // 剩下的 daemon.pid/port 是已经确认死掉的旧进程的残留,daemon.log 留作排查。
  // 清掉 pid/port 让旧目录尽量空,能删就删,免得下次又走一遍这里。
  for (const f of ['daemon.pid', 'port']) rmSync(join(legacy, f), { force: true });
  try {
    if (readdirSync(legacy).length === 0) rmSync(legacy, { recursive: true, force: true });
  } catch {
    // 还有 daemon.log 之类,留着
  }
}

/**
 * PreToolUse hook 的拦截范围。`*` 会连读操作也拦下网页审批,且拦截发生在
 * Claude Code 内置权限判断之前(实测:hook 无条件触发)。默认收窄到
 * AskUserQuestion —— 主动提问上网页,其余工具交回内置权限系统。
 * 需要恢复全量监管时改回 '*'。
 */
const ENABLE_FULL_APPROVAL = false;
const APPROVAL_MATCHER = ENABLE_FULL_APPROVAL ? '*' : 'AskUserQuestion';

/**
 * daemon 级的 hook 配置文件路径。所有会话共用一份 —— 内容只是后端 URL 与
 * 固定 matcher。claude 的 --settings 是叠加而非覆盖(实测 + 官方文档):
 * 此文件只贡献 hooks,与各 workspace 自己的 .claude/settings*.json 按事件名
 * + matcher 求并集,故不必把用户的 model/permissions 拷进来,也不碰用户的仓库文件。
 */
export function hookSettingsPath(): string {
  return join(SYNAPSE_DIR, 'hooks.settings.json');
}

/**
 * 写入 daemon 级 hook 配置。必须在 server.ts 确定「实际监听端口」之后调用 ——
 * 钩子 URL 里的端口写错等同 fail-open(见 §2.3/§6),所有工具无审批执行。
 * daemon 每次启动都重写一遍(幂等),顺带处理默认端口偶尔因占用而偏移的情况。
 */
export function writeHookSettings(actualPort: number): string {
  const path = hookSettingsPath();
  const hookEntry = {
    type: 'http' as const,
    url: `http://${HOST}:${actualPort}/api/claude-event`,
    // 显式设短于默认 600s。真正的兜底在 permissions.ts:
    // 钩子自然超时 = 放行(实测),绝不能依赖它。
    timeout: HOOK_TIMEOUT_S,
  };
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: APPROVAL_MATCHER, hooks: [hookEntry] }],
      Stop: [{ hooks: [hookEntry] }],
      SessionEnd: [{ matcher: '*', hooks: [hookEntry] }],
    },
  };
  mkdirSync(SYNAPSE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return path;
}

/** 后端就绪后调用,把连接信息交给 CLI。port 是实际监听端口,见文件头注释。 */
export function writeState(state: DaemonState): void {
  mkdirSync(SYNAPSE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(SYNAPSE_DIR, 'daemon.pid'), String(state.pid), { mode: 0o600 });
  writeFileSync(join(SYNAPSE_DIR, 'port'), String(state.port), { mode: 0o600 });
  // token 等价于批准任意命令的凭据,权限不能放宽
  writeFileSync(join(SYNAPSE_DIR, 'token'), state.token, { mode: 0o600 });
}

export function readState(): DaemonState | null {
  const dir = SYNAPSE_DIR;
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
 * 不删 token —— 那是「这个数据目录的固定身份」,daemon.pid/port 才是「进程
 * 是否还活着」的判定依据。restart 场景下旧进程退出时会调这个函数清场,不留
 * token 的话下次启动只能重新生成,用户手里的链接(书签、浏览器历史)全部
 * 失效。见 readOrCreateToken() —— 新进程启动时优先复用这份残留。
 *
 * onlyIfOwnedBy 给定时(server.ts shutdown() 传 process.pid)只在
 * daemon.pid 里记的就是这个 PID 才真的删 —— 一个数据目录本该至多一个
 * daemon,但曾经因为 bug(见 implementation-lessons.md「ensureDaemon
 * 不能靠…反推」)在同一数据目录下堆出过多个实例;这些实例各自退出时如果
 * 无差别 rm,谁后退出谁就把仍然健康的另一个实例的状态文件清掉 —— 状态
 * 文件指向的进程明明还活着,`synapse daemon status/stop` 却认不出它,
 * 只能手动把 pid/port 文件写回去。ensureDaemon 的调用路径(readState 后
 * 决定要不要 clearState)不传这个参数,继续无条件清 —— 那些场景已经
 * 确认过陈旧或即将被同 PID 的新状态覆盖,不存在"清错别人"的风险。
 */
export function clearState(onlyIfOwnedBy?: number): void {
  if (onlyIfOwnedBy != null) {
    const current = readState();
    if (current && current.pid !== onlyIfOwnedBy) return;
  }
  for (const f of ['daemon.pid', 'port']) {
    rmSync(join(SYNAPSE_DIR, f), { force: true });
  }
}

/** 供 server.ts 启动时调用:数据目录里有残留 token 就复用,没有才新生成。 */
export function readOrCreateToken(): string {
  const dir = SYNAPSE_DIR;
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

const LOCK_PATH = () => join(SYNAPSE_DIR, 'daemon.lock');
const LOCK_POLL_MS = 100;
const LOCK_WAIT_MS = 10_000;

/**
 * 跨进程互斥锁,只为串行化 ensureDaemon 里「判断没有健康实例 → spawn」这段
 * 临界区 —— 两个 CLI 调用(比如网页与终端各自触发一次)前后脚都读到「没有
 * 健康实例」,不加锁会各自 spawnDaemon,默认端口撞上后各自递增到不同端口,
 * 双双写 daemon.pid/port,最终谁后写生效,但两个进程其实都在监听,又是一次
 * 同目录多实例共存(与本文件其余注释描述的历史 bug 同类,只是触发路径不同:
 * 那两个 bug 是单次 ensureDaemon 内部逻辑错误,这里是多次 ensureDaemon 并发)。
 *
 * 用 `wx` 独占创建实现 —— 创建成功即持锁,EEXIST 则已有人持锁。文件内容记
 * 持锁者 PID,仅用于「持锁进程是否已经不在了」的陈旧锁判断(比如上次拿到锁
 * 之后进程被杀,没走到 finally 就没了),不影响锁语义本身。
 */
async function acquireLock(): Promise<void> {
  const path = LOCK_PATH();
  mkdirSync(SYNAPSE_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // 锁被占着 —— 先看是不是陈旧锁(持锁进程已经不在了),是就抢占。
    try {
      const holder = Number(readFileSync(path, 'utf8').trim());
      if (!Number.isInteger(holder) || holder <= 0 || !pidAlive(holder)) {
        rmSync(path, { force: true });
        continue;
      }
    } catch {
      // 锁文件在读的当口被持锁者自己删了(正常释放)—— 下一轮直接重新尝试创建
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待 daemon 启动锁超时(${LOCK_WAIT_MS / 1000}s),持锁 PID 见 ${path}`);
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

/** 仅删自己持有的锁 —— 万一等待期间被误判陈旧并遭抢占,不该删掉抢占者的新锁。 */
function releaseLock(): void {
  const path = LOCK_PATH();
  try {
    const holder = Number(readFileSync(path, 'utf8').trim());
    if (holder === process.pid) rmSync(path, { force: true });
  } catch {
    // 锁文件已经不在了 —— 没有需要释放的
  }
}

/**
 * 确保后端在跑,返回可用的连接信息。
 * 已有实例健康则直接复用;否则清掉陈旧状态重新拉起。
 *
 * port 只是新进程要监听的端口:一个数据目录至多一个 daemon,已有实例
 * 健康就直接复用它记在 port 文件里的实际端口,传入的 port 只在需要新起
 * 一个进程时才用上。不同 workspace 下不传 port 都复用同一个生产 daemon
 * (Project List 能跨 workspace 聚合会话正是靠这个);测试要隔离用独立的
 * SYNAPSE_DATA_DIR,不靠换端口。
 *
 * explicit 标记这个 port 是不是调用方(用户)显式给的,决定新起的子进程
 * 撞见端口占用时能不能递增重试(见 spawnDaemon/server.ts PORT_EXPLICIT)——
 * 不能靠子进程自己看有没有 PORT 环境变量反推,那样每次都会显式设置,永远
 * 判成「显式」,已有实例撞见占用直接退出、无从递增,表现为一撞就报「启动
 * 超时」,还容易在反复重试里堆出多个占着不同端口、彼此不知道对方存在的
 * 残留 daemon。
 *
 * 判断与 spawn 之间加锁(acquireLock/releaseLock,见其注释)串行化并发调用;
 * 拿到锁后重新读一次状态 —— 等锁期间可能有别的调用者已经把 daemon 启起来了,
 * 这时直接复用,不再重复 spawn。
 */
export async function ensureDaemon(
  port = DEFAULT_PORT, waitMs = 20_000, explicit = false,
): Promise<DaemonState> {
  // 旧进程可能刚被 stop 掉(restart 场景),这时才轮到把旧目录的 sessions.json 搬上来。
  migrateLegacyStateDir();
  const existing = readState();
  if (existing && (await checkHealth(existing))) return existing;

  await acquireLock();
  try {
    const afterLock = readState();
    if (afterLock && (await checkHealth(afterLock))) return afterLock;
    if (afterLock) clearState();

    spawnDaemon(port, explicit);
    return await waitForDaemon(port, waitMs);
  } finally {
    releaseLock();
  }
}

const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * daemon.log 不随 clearState 清空(见其注释,restart 要留痕以便事后排查),
 * 长期挂着跑会无限增长 —— 超过阈值就滚一份 .old,旧的 .old 直接覆盖,
 * 不需要更复杂的多代保留。
 */
function rotateLogIfLarge(path: string): void {
  try {
    if (statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.old`);
  } catch {
    // 文件不存在(首次启动)—— 无需处理
  }
}

/**
 * 后台拉起后端。detached + unref 缺一不可:少了任何一个,CLI 退出
 * (或它 attach 的 tmux 结束)都会带走后端。stdio 曾经是 'ignore',
 * 但 daemon 模式下这样会让所有 console.error/log 静默消失 ——
 * 排查 TUI 启动超时这类问题时无从下手。改成落盘到数据目录下的
 * daemon.log(测试用独立 SYNAPSE_DATA_DIR 时也一并隔离)。
 *
 * explicit 为假(默认端口)时不把 PORT 塞进子进程环境 —— 子进程据此
 * 判定 PORT_EXPLICIT=false,撞见占用会递增重试;塞了 PORT 就等于替
 * 用户「显式指定」了端口,子进程一撞见占用就直接退出,ensureDaemon
 * 只会看到「启动超时」,查不出真实原因(见 ensureDaemon 注释)。
 */
function spawnDaemon(port: number, explicit: boolean): void {
  mkdirSync(SYNAPSE_DIR, { recursive: true, mode: 0o700 });
  const logPath = join(SYNAPSE_DIR, 'daemon.log');
  rotateLogIfLarge(logPath);
  // 启动横幅会把 token 明文拼进 URL 打印(见 server.ts)—— 日志文件
  // 因此等价于存了一份凭据副本,权限必须跟 token/sessions.json 一样收紧。
  const logFd = openSync(logPath, 'a', 0o600);

  const env: NodeJS.ProcessEnv = { ...process.env, SYNAPSE_DAEMON: '1' };
  if (explicit) env.PORT = String(port);
  else delete env.PORT; // 继承自父进程 shell 的 PORT 也不该悄悄冒充「用户显式指定」

  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', SERVER_ENTRY],
    {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env,
    },
  );
  child.unref();
}

/** 轮询状态文件直到后端写入并通过健康检查。 */
async function waitForDaemon(port: number, waitMs: number): Promise<DaemonState> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const state = readState();
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
export async function stopDaemon(waitMs = 10_000): Promise<'stopped' | 'not-running'> {
  const state = readState();
  if (!state || !pidAlive(state.pid)) {
    if (state) clearState();
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
