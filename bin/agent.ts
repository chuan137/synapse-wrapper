/**
 * `synapse agent <子命令>` —— daemon HTTP 端点的瘦客户端。
 *
 * 主 agent 调度子 agent 的本质是「发命令 + 等结果」,HTTP + 轮询就够,不引入
 * MCP(见 docs/design/main-agent-orchestration.md)。这组子命令不持有任何状态:
 * 从数据目录的 port / token 拿地址与凭据,任务 id 从 SYNAPSE_TASK_ID 环境变量取
 * —— 主 agent 启动时由 daemon 注入,不必手动传。
 *
 * `context` 是主 agent 的唯一真相源;`spawn` / `poll` / `await` 是调度链的三步
 * (起子 agent → 轮询它的事件 → 等它本轮结束)。`doc` 见后续步骤。
 *
 * CLI 侧不维持长连接:每次调用都是一次短 HTTP 请求立即返回。`await` 的轮询
 * 循环跑在这个 CLI 进程里,不在 daemon 侧(设计文档「交互协议」是硬约束)。
 */
import { readFileSync } from 'node:fs';
import { readState, checkHealth, HOST } from '../backend/daemon.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

/** 明确报错,不留栈回溯 —— 主 agent(或 attach 进去的用户)要一眼看懂哪一步缺了。 */
function die(msg: string): never {
  console.error(`${c.red('✗')} ${msg}`);
  process.exit(1);
}

interface Conn {
  base: string;
  token: string;
  taskId: string;
}

/**
 * 定位 daemon 与当前任务。三样都缺则明确报错:
 * - SYNAPSE_TASK_ID 未设 → 这个 CLI 不是在主 agent 会话里跑的
 * - daemon 没跑 / 不健康 → 先 `synapse daemon start`
 */
async function connect(): Promise<Conn> {
  const taskId = process.env.SYNAPSE_TASK_ID;
  if (!taskId) {
    die(
      'SYNAPSE_TASK_ID 未设 —— `synapse agent` 只能在主 agent 会话里运行' +
        c.dim('(daemon 起主 agent 时注入这个变量)'),
    );
  }

  const state = readState();
  if (!state) {
    die('daemon 未运行 —— 先 `synapse daemon start`');
  }
  if (!(await checkHealth(state))) {
    die(`daemon 状态陈旧(端口 ${state.port},PID 或 HTTP 探活未过)—— 试 \`synapse daemon restart\``);
  }

  return { base: `http://${HOST}:${state.port}`, token: state.token, taskId };
}

async function apiGet<T>(conn: Conn, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${conn.base}${path}`, {
      headers: { 'x-auth-token': conn.token, origin: conn.base },
    });
  } catch (err) {
    die(`连接 daemon 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) die(`任务 ${conn.taskId} 不存在(daemon 里查不到)`);
  if (!res.ok) die(`daemon 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function apiPost<T>(conn: Conn, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${conn.base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-token': conn.token,
        origin: conn.base,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(`连接 daemon 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) die(`daemon 返回 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

interface PollBatch {
  events: { seq: number; kind: string; message: string; createdAt: number; data: unknown }[];
  cursor: number;
}

/**
 * poll 的裸实现 —— 不 die,失败抛错。`cmdPoll` 一次性调用后 die-on-error;
 * `cmdAwait` 的循环靠捕获这个异常做退避重试(单次抖动不该等于失败)。
 */
async function pollOnce(conn: Conn, bindingId: string, since: number): Promise<PollBatch> {
  const res = await fetch(
    `${conn.base}/api/tasks/${conn.taskId}/agents/${bindingId}/events?since=${since}`,
    { headers: { 'x-auth-token': conn.token, origin: conn.base } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as PollBatch;
}

interface AgentContext {
  task: { id: string; title: string; goal: string; acceptance: string; status: string };
  project: { id: string; name: string } | null;
  workDir: string | null;
  mainAgent: { bindingId: string; state: string } | null;
  handoff: string | null;
  subAgents: {
    bindingId: string;
    workspace: string | null;
    state: 'running' | 'idle' | 'exited';
    lastTurnAt: number | null;
    lastTurnSummary: string | null;
    pendingApprovals: number;
  }[];
}

function fmtWhen(ms: number | null): string {
  if (!ms) return '';
  const age = Date.now() - ms;
  if (age < 60_000) return c.dim(`${Math.round(age / 1000)}s 前`);
  if (age < 3_600_000) return c.dim(`${Math.round(age / 60_000)}m 前`);
  return c.dim(new Date(ms).toISOString().slice(0, 16).replace('T', ' '));
}

function stateColor(s: string): string {
  if (s === 'running') return c.green(s);
  if (s === 'exited') return c.dim(s);
  return c.yellow(s);
}

async function cmdContext(conn: Conn): Promise<void> {
  const ctx = await apiGet<AgentContext>(conn, `/api/tasks/${conn.taskId}/agent-context`);

  console.log(c.bold(ctx.task.title) + c.dim(`  ·  ${ctx.task.status}`));
  console.log(`${c.dim('项目  ')} ${ctx.project?.name ?? '(未命名)'}`);
  console.log(`${c.dim('work dir')} ${ctx.workDir ?? c.yellow('(主 agent 未起,未定)')}`);
  console.log();
  console.log(c.dim('目标'));
  console.log(`  ${ctx.task.goal || c.dim('(未填写)')}`);
  console.log(c.dim('验收'));
  console.log(`  ${ctx.task.acceptance || c.dim('(未填写)')}`);

  if (ctx.handoff) {
    console.log();
    console.log(c.dim('handoff'));
    console.log(ctx.handoff);
  }

  console.log();
  if (ctx.subAgents.length === 0) {
    console.log(c.dim('子 agent  (无)'));
  } else {
    console.log(c.dim(`子 agent  (${ctx.subAgents.length})`));
    for (const s of ctx.subAgents) {
      const parts = [
        `  ${s.bindingId.slice(0, 8)}`,
        stateColor(s.state),
        s.workspace ? c.dim(s.workspace) : '',
        s.pendingApprovals > 0 ? c.yellow(`⏵ ${s.pendingApprovals} 待批准`) : '',
      ].filter(Boolean);
      console.log(parts.join('  '));
      if (s.lastTurnSummary) {
        console.log(`      ${fmtWhen(s.lastTurnAt)} ${s.lastTurnSummary}`);
      }
    }
  }
}

/**
 * 摘出 `--key value` 与 `--key=value` 形式的 flag,余下的当位置参数。
 * synapse agent 的子命令不需要更复杂的解析(没有 short flag、没有布尔 flag)。
 */
function parseFlags(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) die(`${a} 需要一个值`);
        flags[a.slice(2)] = v;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function cmdSpawn(conn: Conn, argv: string[]): Promise<void> {
  const { flags } = parseFlags(argv);
  const workspace = flags.workspace;
  if (!workspace) die('spawn 需要 --workspace <dir>');

  const body: Record<string, unknown> = { workspace };
  if (flags.handoff) {
    try {
      body.handoff = readFileSync(flags.handoff, 'utf8');
    } catch (err) {
      die(`读取 handoff 文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (flags.prompt) body.prompt = flags.prompt;
  if (flags.model) body.model = flags.model;
  if (flags.strategy) body.strategy = flags.strategy; // 第 6 步才实现,后端暂忽略

  const out = await apiPost<{ bindingId: string; workspace: string }>(
    conn,
    `/api/tasks/${conn.taskId}/agents/spawn`,
    body,
  );
  // NDJSON 一行 —— 和 poll 的输出风格一致,主 agent 拿 bindingId 去 poll / await。
  console.log(JSON.stringify(out));
}

function printBatch(batch: PollBatch): void {
  for (const e of batch.events) {
    console.log(
      JSON.stringify({ seq: e.seq, kind: e.kind, message: e.message, at: e.createdAt, data: e.data }),
    );
  }
  console.log(JSON.stringify({ cursor: batch.cursor }));
}

async function cmdPoll(conn: Conn, argv: string[]): Promise<void> {
  const { flags, positional } = parseFlags(argv);
  const bindingId = positional[0];
  if (!bindingId) die('poll 需要 <bindingId>');
  const since = flags.since ? Number(flags.since) : 0;
  if (!Number.isFinite(since) || since < 0) die(`--since 需要一个非负整数: ${flags.since}`);

  let batch: PollBatch;
  try {
    batch = await pollOnce(conn, bindingId, since);
  } catch (err) {
    die(String(err instanceof Error ? err.message : err));
  }
  printBatch(batch);
}

const AWAIT_EXIT = { completed: 0, exited: 10, timeout: 11, unreachable: 20 } as const;

async function cmdAwait(conn: Conn, argv: string[]): Promise<never> {
  const { flags, positional } = parseFlags(argv);
  const bindingId = positional[0];
  if (!bindingId) die('await 需要 <bindingId>');
  const timeoutS = flags.timeout ? Number(flags.timeout) : 600;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) die(`--timeout 需要一个正整数: ${flags.timeout}`);

  const deadline = Date.now() + timeoutS * 1000;
  let cursor = flags.since ? Number(flags.since) : 0;
  let consecutiveFailures = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (Date.now() < deadline) {
    let batch: PollBatch;
    try {
      batch = await pollOnce(conn, bindingId, cursor);
      consecutiveFailures = 0;
    } catch {
      // 单次失败静默退避重试 —— 退出码只反映 daemon 事件日志里的事实,
      // 不反映 CLI 自己的连接抖动。连续 5 次全失败才判 daemon 连不上。
      consecutiveFailures++;
      if (consecutiveFailures >= 5) {
        console.error(`${c.red('✗')} daemon 连不上(连续 ${consecutiveFailures} 次 poll 失败)`);
        process.exit(AWAIT_EXIT.unreachable);
      }
      await sleep(Math.min(2000 * 2 ** (consecutiveFailures - 1), 30_000));
      continue;
    }

    cursor = batch.cursor;
    for (const e of batch.events) {
      if (e.kind === 'turn_completed') {
        // 本轮结束就是 await 的正常退出点 —— 子 agent 是 stream-json,一轮结束后
        // 仍活着等下一条输入,不会自然退出。打真结论,退出码 0。
        console.log((e.data as { result?: string } | null)?.result ?? e.message);
        process.exit(AWAIT_EXIT.completed);
      }
      if (e.kind === 'agent_exited') {
        // 没等到任何 turn_completed 就退出 —— claude 崩溃 / 被 stop / 干完没产出。
        console.error(`${c.yellow('!')} 子 agent 异常退出,无产出`);
        process.exit(AWAIT_EXIT.exited);
      }
    }

    await sleep(2000);
  }

  console.error(`${c.yellow('!')} --timeout 到点,子 agent 仍在运行`);
  process.exit(AWAIT_EXIT.timeout);
}

export async function agentMain(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (!sub || sub === '-h' || sub === '--help') {
    console.log(`
用法: synapse agent <子命令>

  context   打印当前任务的 work dir / 目标 / 验收 / 每个子 agent 的状态行。
            主 agent 每次决策前先拉一次 —— 这是它的唯一真相源。

  spawn --workspace <dir> [--handoff <file>] [--prompt <text>] [--model <m>]
            起一个 stream-json 子 agent,--handoff 文件内容拼进它的首轮 prompt。
            立即返回新 binding id(NDJSON 一行),不等子 agent 干完。

  poll <bindingId> [--since <seq>]
            打印该子 agent 自 <seq>(不含)以来的事件,每条一行 NDJSON,
            末行 {"cursor": <最新 seq>} 供下次 --since。无新事件立即返回,不 hang。

  await <bindingId> [--timeout <秒,默认 600>]
            CLI 侧每 2s 轮询一次,直到本轮 turn_completed(退出码 0,打印结论)
            或 agent_exited(退出码 10)。--timeout 到点仍在跑退出码 11;
            daemon 连不上退出码 20。

  (doc 见后续实现)

  任务 id 从 SYNAPSE_TASK_ID 环境变量取,daemon 地址从数据目录的 port/token 取
  —— 都由 daemon 起主 agent 时注入,无需手动传。
`);
    return;
  }

  if (sub === 'context' || sub === 'spawn' || sub === 'poll' || sub === 'await') {
    const conn = await connect();
    const rest = argv.slice(1);
    if (sub === 'context') return cmdContext(conn);
    if (sub === 'spawn') return cmdSpawn(conn, rest);
    if (sub === 'poll') return cmdPoll(conn, rest);
    await cmdAwait(conn, rest);
    return;
  }

  die(`未知子命令: ${sub} —— 可用: context / spawn / poll / await`);
}
