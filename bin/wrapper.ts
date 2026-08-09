/**
 * wrapper 的实现主体。
 *
 * 入口是同目录的 bin/wrapper(无扩展名的 JS 薄壳)—— Node 的类型剥离
 * 只对 .ts 扩展名生效,可执行文件本身不能直接写 TypeScript。
 *
 * 定位是「带前置准备的 claude」:claude 就在用户当前的 pane 里启动,
 * 拉起后端、注册会话只是不可见的准备工作。不新建也不切换 tmux 会话 ——
 * 后端靠 pane ID 旁路观察与注入,用户看到的就是一个普通的 claude。
 *
 * 因此必须在 tmux 内运行:pane 是后端寻址的唯一手段。裸终端下直接提示,
 * 不隐式创建会话(那会把用户弹进一个他没要求的环境)。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { ensureDaemon, urlFor, HOST } from '../backend/daemon.ts';
import { TmuxTransport } from '../backend/tmuxTransport.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

function die(msg: string): never {
  console.error(`${c.red('✗')} ${msg}`);
  process.exit(1);
}

/** 当前 pane 的 ID(如 %3)。tmux 会把它放进环境变量。 */
function currentPane(): string | null {
  return process.env.TMUX_PANE || null;
}

/**
 * 同目录已有会话时告知一声。仅提示,不阻拦 —— 两个终端开同一项目本就合法。
 * 查询失败不影响启动:这只是知情提示,不该成为开不了 claude 的理由。
 */
async function warnExisting(
  state: { port: number; token: string },
  dir: string,
): Promise<void> {
  try {
    const res = await fetch(`http://${HOST}:${state.port}/api/sessions`, {
      headers: { 'x-auth-token': state.token, origin: `http://${HOST}:${state.port}` },
    });
    if (!res.ok) return;

    const { sessions } = (await res.json()) as {
      sessions: { workspace: string; state: string; paneId: string | null }[];
    };
    const same = sessions.filter((s) => s.workspace === dir && s.state !== 'exited');
    if (same.length === 0) return;

    const where = same
      .map((s) => s.paneId)
      .filter(Boolean)
      .join(' ');
    console.log(
      `${c.yellow('!')} ${c.bold(dir)} 已有 ${same.length} 个活跃会话` +
        (where ? c.dim(`(pane ${where})`) : ''),
    );
  } catch {
    // 提示而已,查不到就算了
  }
}

export async function main(argv: string[]): Promise<void> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    console.log(`
用法: wrapper [目录]

  在当前 tmux pane 里启动 claude,同时接入网页端监管。
  目录默认为当前目录;后端未运行时自动以守护进程拉起。

  需在 tmux 会话中运行 —— 后端通过 pane 观察与注入。
`);
    return;
  }

  const given = resolve(argv[0] ?? process.cwd());
  if (!existsSync(given) || !statSync(given).isDirectory()) die(`目录不存在: ${given}`);

  // 解析符号链接后再上报(macOS 的 /tmp → /private/tmp)。
  // 同一目录经不同路径进入时,后端才认得出是同一个工作区。
  const dir = realpathSync(given);

  const pane = currentPane();
  if (!pane) {
    console.error(`${c.red('✗')} 需要在 tmux 会话中运行`);
    console.error(c.dim('\n  后端通过 tmux pane 观察与注入,这是它能在网页端同步的前提。'));
    console.error(c.dim('  先进入 tmux 再执行:\n'));
    console.error('    tmux new -s work');
    console.error(`    wrapper ${argv[0] ?? ''}`.trimEnd());
    console.error('');
    process.exit(1);
  }

  const state = await ensureDaemon().catch((err) => die(String(err?.message ?? err)));

  // 同目录并存是允许的(裸 claude 亦然,且钩子按 claudeId 路由不会串),
  // 但要让用户知道网页端将出现同名会话。
  await warnExisting(state, dir);

  // 预置信任是代用户作安全决定,首次必须明说
  if (await TmuxTransport.ensureTrusted(dir)) {
    console.log(`${c.yellow('!')} 已将 ${c.bold(dir)} 标记为受信任目录(免去启动时的信任确认)`);
  }

  // 会话 ID 由本方指定而非事后推断。同目录并存时,靠「转写目录里最新的文件」
  // 认领会在两个 claude 几乎同时启动时张冠李戴,批准请求就会归到错误的会话。
  const sessionId = randomUUID();

  // 必须在启动 claude 之前完成 —— 注册会写入 settings,claude 只在启动时读一次
  const res = await fetch(`http://${HOST}:${state.port}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-auth-token': state.token,
      origin: `http://${HOST}:${state.port}`,
    },
    body: JSON.stringify({ workspace: dir, transport: 'tmux', paneId: pane, sessionId }),
  }).catch((err) => die(`无法连接后端: ${err}`));

  if (!res.ok) die(`注册会话失败 (HTTP ${res.status}): ${await res.text()}`);
  const { settingsPath } = (await res.json()) as { settingsPath?: string };
  if (!settingsPath) die('后端未返回 settings 路径');

  console.log(`${c.blue('●')} ${c.bold(basename(dir))} · 网页端 ${c.dim(urlFor(state))}\n`);

  // 交棒:用 claude 替换本进程,用户拿到的就是原生 TUI,退出即退出
  execClaude(dir, settingsPath, sessionId);
}

/**
 * 以 claude 替换当前进程。
 *
 * 用 exec 语义而非子进程:pane 里不该留一个 wrapper 壳进程,
 * 否则 claude 退出后用户会莫名回到 wrapper 而不是 shell。
 * Node 没有 execve,用 spawn + stdio inherit 后透传退出码是最接近的等价物。
 */
function execClaude(cwd: string, settingsPath: string, sessionId: string): void {
  const child = spawn('claude', ['--settings', settingsPath, '--session-id', sessionId], {
    cwd,
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    die(`无法启动 claude: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
}
