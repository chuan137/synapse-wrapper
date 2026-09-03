/**
 * `synapse agent <子命令>` —— daemon HTTP 端点的瘦客户端。
 *
 * 主 agent 调度子 agent 的本质是「发命令 + 等结果」,HTTP + 轮询就够,不引入
 * MCP(见 docs/design/main-agent-orchestration.md)。这组子命令不持有任何状态:
 * 从数据目录的 port / token 拿地址与凭据,任务 id 从 SYNAPSE_TASK_ID 环境变量取
 * —— 主 agent 启动时由 daemon 注入,不必手动传。
 *
 * 落地顺序第 2 步只实现 `context`(主 agent 的唯一真相源,也最容易验证)。
 * spawn / poll / await / doc 见后续步骤。
 */
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

export async function agentMain(argv: string[]): Promise<void> {
  const sub = argv[0];

  if (!sub || sub === '-h' || sub === '--help') {
    console.log(`
用法: synapse agent <子命令>

  context   打印当前任务的 work dir / 目标 / 验收 / 每个子 agent 的状态行。
            主 agent 每次决策前先拉一次 —— 这是它的唯一真相源。

  (spawn / poll / await / doc 见后续实现)

  任务 id 从 SYNAPSE_TASK_ID 环境变量取,daemon 地址从数据目录的 port/token 取
  —— 都由 daemon 起主 agent 时注入,无需手动传。
`);
    return;
  }

  if (sub === 'context') {
    const conn = await connect();
    await cmdContext(conn);
    return;
  }

  die(`未知子命令: ${sub} —— 目前只有 context`);
}
