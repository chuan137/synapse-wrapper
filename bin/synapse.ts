/**
 * synapse 的实现主体。
 *
 * 入口是同目录的 bin/synapse(无扩展名的 JS 薄壳)—— Node 的类型剥离
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
import {
  ensureDaemon, stopDaemon, readState, checkHealth, urlFor, migrateLegacyStateDir,
  HOST, DEFAULT_PORT,
} from '../backend/daemon.ts';
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

/**
 * 从 argv 中摘出 --port(及其值)与位置参数(目录)。
 * --port 只在需要新起 daemon 时决定监听端口 —— 已有健康实例总是直接复用
 * (一个数据目录至多一个 daemon,不按端口区分)。测试要隔离改用独立的
 * SYNAPSE_DATA_DIR,不靠换端口,见 daemon.ts 的 SYNAPSE_DIR。
 *
 * portExplicit 标记这个端口号是不是用户主动给的(--port 或 PORT 环境变量),
 * 还是没给、退到了默认值 —— ensureDaemon 据此决定新起的进程撞见端口占用时
 * 能不能递增重试(见 daemon.ts ensureDaemon 注释)。不能靠"port 是否等于
 * DEFAULT_PORT"反推:用户完全可能 --port 47100 显式撞上默认值。
 */
function parseArgv(argv: string[]): { dir: string | undefined; port: number; portExplicit: boolean } {
  const rest: string[] = [];
  let port = Number(process.env.PORT ?? DEFAULT_PORT);
  let portExplicit = process.env.PORT != null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') {
      const v = argv[++i];
      if (!v || Number.isNaN(Number(v))) die(`--port 需要一个数字: ${v ?? '(缺失)'}`);
      port = Number(v);
      portExplicit = true;
    } else if (a.startsWith('--port=')) {
      const v = a.slice('--port='.length);
      if (Number.isNaN(Number(v))) die(`--port 需要一个数字: ${v}`);
      port = Number(v);
      portExplicit = true;
    } else {
      rest.push(a);
    }
  }
  return { dir: rest[0], port, portExplicit };
}

/**
 * synapse 总是自带 --session-id(会话归属必须由调用方指定,见 §2.6),
 * 但 claude CLI 规定 --session-id 与 --continue/--resume 同时出现时
 * 必须再加 --fork-session,否则直接报错拒绝启动。
 *
 * 不能省略 --session-id 来避让这条限制:那样 claude 会继续写回旧会话的
 * 转写文件,而后端已经用新生成的 UUID 注册了这个会话 —— 转写路径对不上,
 * 批准请求无处路由。故自动补 --fork-session,让 resume 的历史被复制到
 * 新会话里延续,新内容仍落在 synapse 注册的那个 UUID 下。
 */
function withForkSession(claudeArgs: string[]): string[] {
  const wantsResume = claudeArgs.some((a) =>
    a === '-c' || a === '--continue' || a === '-r' || a === '--resume' || a.startsWith('--resume='));
  if (!wantsResume || claudeArgs.includes('--fork-session')) return claudeArgs;
  return [...claudeArgs, '--fork-session'];
}

export async function main(argv: string[]): Promise<void> {
  // 旧版按端口分子目录 —— 升级后首次跑任何子命令时搬一次(见 daemon.ts)。
  migrateLegacyStateDir();

  if (argv[0] === '-h' || argv[0] === '--help') {
    console.log(`
用法: synapse [目录] [--port <端口>] [-- <claude 参数...>]
      synapse daemon <start|status|restart|stop> [--port <端口>]
      synapse agent <context>   (主 agent 会话内用,见 synapse agent -h)

  在当前 tmux pane 里启动 claude,同时接入网页端监管。
  目录默认为当前目录;后端未运行时自动以守护进程拉起。

  --port 指定新起后端时监听的端口(默认 ${DEFAULT_PORT},也可用 PORT 环境变量);
  已有健康后端总是直接复用,不管它监听哪个端口。所有 daemon 文件落在
  SYNAPSE_DATA_DIR(默认 ~/.synapse),测试想跟日常实例隔离就指定一个临时目录。

  -- 之后的参数原样透传给 claude CLI(如 --model、--mcp-config 等),
  synapse 自身不解析;--settings 与 --session-id 已由 synapse 管理,重复传入会被
  claude 自己的参数解析覆盖或报错。传入 --continue/-c 或 --resume/-r 时
  synapse 会自动补上 --fork-session(claude 的强制要求),历史对话会被复制到
  新会话延续,而不是接着写回旧会话的转写文件。

  需在 tmux 会话中运行 —— 后端通过 pane 观察与注入。

  daemon start    只拉起后端并打印网页链接,不创建会话、不要求在 tmux 内
                  (只看任务面板时用 —— 会话之后从网页里创建或绑定)
  daemon status   查看后端是否在跑、PID/端口
  daemon restart  优雅重启(改完代码后用这个加载新版本,不影响已在跑的 claude 会话)
  daemon stop     只停止,不重新拉起
`);
    return;
  }

  if (argv[0] === 'daemon') {
    await daemonCmd(argv.slice(1));
    return;
  }

  if (argv[0] === 'agent') {
    const { agentMain } = await import('./agent.ts');
    await agentMain(argv.slice(1));
    return;
  }

  const sepIdx = argv.indexOf('--');
  const ownArgv = sepIdx === -1 ? argv : argv.slice(0, sepIdx);
  const claudeArgs = sepIdx === -1 ? [] : withForkSession(argv.slice(sepIdx + 1));

  const { dir: dirArg, port, portExplicit } = parseArgv(ownArgv);
  const given = resolve(dirArg ?? process.cwd());
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
    console.error(`    synapse ${argv[0] ?? ''}`.trimEnd());
    console.error('');
    process.exit(1);
  }

  const state = await ensureDaemon(port, undefined, portExplicit).catch((err) => die(String(err?.message ?? err)));

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
  execClaude(dir, settingsPath, sessionId, claudeArgs);
}

/**
 * daemon 子命令 —— 独立于「拉起 claude」的主流程,只管后端本身的生命周期。
 * restart 不影响已在跑的 tmux 会话:daemon 只是旁路观察者,pane 里的 claude
 * 进程独立于它存活(见 tmuxTransport.ts stop() 的接管模式说明)。改完后端
 * 代码后用它加载新版本,比手动 kill + 重新执行 synapse 更不容易漏步骤。
 */
async function daemonCmd(argv: string[]): Promise<void> {
  // parseArgv 把非 --port 的位置参数当「目录」摘出来,子命令名恰好落在同一个槽位。
  // status / stop / restart 只认数据目录里记录的实例,--port 仅在需要新起进程时
  // (start / restart)决定监听端口。
  const { dir: sub, port, portExplicit } = parseArgv(argv);

  // start —— 只拉起 daemon + 打印网页链接,不附带会话、不要求在 tmux 内。
  // 任务面板只需要 daemon + 网页 UI:会话之后从网页里创建/绑定/启动。
  if (sub === 'start') {
    const state = await ensureDaemon(port, undefined, portExplicit).catch((err) => die(String(err?.message ?? err)));
    console.log(`${c.blue('●')} 端口 ${state.port} 已就绪 (PID ${state.pid})`);
    console.log(`${c.dim('网页链接:')}\n${urlFor(state)}`);
    process.exit(0);
  }

  if (sub === 'status') {
    const state = readState();
    if (!state) { console.log(`${c.dim('○')} 未运行`); return; }
    const healthy = await checkHealth(state);
    const mark = healthy ? c.blue('●') : c.red('✗');
    const label = healthy ? '运行中' : '陈旧(PID 或 HTTP 探活未过)';
    console.log(`${mark} 端口 ${state.port}: ${label} (PID ${state.pid})`);
    if (healthy) console.log(c.dim(urlFor(state)));
    return;
  }

  if (sub === 'stop') {
    const result = await stopDaemon().catch((err) => die(String(err?.message ?? err)));
    console.log(result === 'stopped' ? `${c.blue('●')} 已停止` : `${c.dim('○')} 本就没在跑`);
    return;
  }

  if (sub === 'restart') {
    // 在停之前读一次:重启要落回同一个端口,而不是命令行没给 --port 时的默认值。
    // 取自 prev.port 时按 explicit 处理 —— 要求精确落回那个端口(可能是上次
    // 默认端口递增重试后落到的非默认值),不允许这次又漂移到别的端口。
    const prev = readState();
    const relaunchPort = prev?.port ?? port;
    const relaunchExplicit = prev ? true : portExplicit;
    const before = await stopDaemon().catch((err) => die(String(err?.message ?? err)));
    if (before === 'stopped') console.log(`${c.dim('…')} 已停止旧进程,正在拉起新的`);
    const state = await ensureDaemon(relaunchPort, undefined, relaunchExplicit).catch((err) => die(String(err?.message ?? err)));
    // token 通常跟前一次相同(daemon.ts readOrCreateToken 复用磁盘残留),
    // 但仍打印链接兜底 —— 全新数据目录、或磁盘 token 文件被手动清过时会拿到新值。
    console.log(`${c.blue('●')} 端口 ${state.port} 已就绪 (PID ${state.pid})`);
    console.log(`${c.dim('网页链接:')}\n${urlFor(state)}`);
    return;
  }

  die(`未知子命令: ${sub ?? '(缺失)'} —— 可用: start / status / restart / stop`);
}

/**
 * 以 claude 替换当前进程。
 *
 * 用 exec 语义而非子进程:pane 里不该留一个 synapse 壳进程,
 * 否则 claude 退出后用户会莫名回到 synapse 而不是 shell。
 * Node 没有 execve,用 spawn + stdio inherit 后透传退出码是最接近的等价物。
 */
function execClaude(cwd: string, settingsPath: string, sessionId: string, extraArgs: string[]): void {
  const child = spawn(
    'claude',
    ['--settings', settingsPath, '--session-id', sessionId, ...extraArgs],
    { cwd, stdio: 'inherit' },
  );

  child.on('error', (err) => {
    die(`无法启动 claude: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
}
