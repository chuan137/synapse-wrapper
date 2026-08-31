/**
 * SessionManager —— 管理多个工作区会话。
 *
 * 每个会话:一个 SessionTransport 实例 + 累积的活动记录。hook 配置不再逐会话
 * 写入工作区,改由 daemon.ts 写一份 daemon 级文件,各会话经 --settings 共用。
 * 按 Claude Code 分配的 session_id 建索引,供权限引擎与 WebSocket 路由使用。
 *
 * 注意会话 ID 有两个:
 *  - localId  由本服务生成,启动瞬间即可用,UI 用它寻址
 *  - claudeId 由 Claude Code 分配(UUID),启动后才知道,钩子载荷用它
 * 钩子到达时只有 claudeId,故需维护 claudeId -> localId 的映射。
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { StreamJsonTransport } from './streamJson.ts';
import { TmuxTransport, findClaimedPanes } from './tmuxTransport.ts';
import { summarizeInput } from './risk.ts';
import { transcriptPathFor, replayTranscript } from './transcript.ts';
import { loadSessions, SessionStore } from './store.ts';
import type { SessionEvent, SessionTransport } from './transport.ts';

// hook 配置(matcher / 拦截范围 / 后端 URL)现由 daemon.ts 统一写一份
// daemon 级文件,所有会话经 --settings 共用 —— 见 daemon.ts writeHookSettings。

export type SessionState = 'starting' | 'ready' | 'busy' | 'waiting' | 'exited';

/** 网页新建走 stream-json;wrapper CLI 走 tmux —— 后者可 attach 且存活于后端重启。 */
export type TransportKind = 'stream-json' | 'tmux';

export interface CreateOptions {
  name?: string;
  transport?: TransportKind;
  /** 仅 tmux:复用同名会话,使同一目录重复 wrapper 不会开出第二个。 */
  tmuxName?: string;
  /** 仅 tmux:接管用户已有的 pane,而非新建会话。 */
  paneId?: string;
  /** 仅 tmux:调用方以 `claude --session-id` 指定的会话 ID。 */
  sessionId?: string;
  /** 仅 stream-json:透传 `--model`,省略则用 CLI/settings 的默认值。 */
  model?: string;
}

/** 会话内累积的一次文件改动。 */
export interface FileChange {
  path: string;
  kind: 'edit' | 'new' | 'delete';
  at: number;
}

/** 会话内累积的一次命令执行。 */
export interface CommandRun {
  toolUseId: string;
  command: string;
  output: string;
  isError: boolean;
  at: number;
}

/**
 * 任务清单的单项。字段名对齐 TodoWrite 的 tool_input 结构;
 * Task* 系列(见 §2.11)的字段名不同,读取时会映射到这套统一形状。
 */
export interface TodoItem {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
  /**
   * 仅 Task* 系列(s.tasks Map 的 key)才有 —— TodoWrite 语义是全量替换,
   * 没有稳定 ID。前端首拉详情页后靠这个字段重建 taskId 索引,
   * 否则后续 WS 增量的 TaskUpdate 事件找不到对应条目可改。
   */
  id?: string;
}

/** 对话与工具调用的时间线条目。 */
export type TimelineItem =
  | { kind: 'user'; text: string; at: number }
  | { kind: 'assistant'; text: string; at: number }
  | { kind: 'tool'; toolUseId: string; name: string; summary: string; done: boolean; isError: boolean; at: number }
  // 轮次分组边界 —— 网页据此把已结束轮次的中间步骤折叠,不落这条会导致
  // 每次打开会话拉取的历史 timeline 被当成一整个未结束的轮次(见 §2.10)。
  | { kind: 'turn_end'; at: number };

export interface SessionSummary {
  localId: string;
  claudeId: string | null;
  name: string;
  /** claude 自己给会话起的标题,首轮对话后才有。 */
  title: string | null;
  workspace: string;
  state: SessionState;
  transport: TransportKind;
  /** tmux 会话名,供 CLI attach;stream-json 会话为 null。 */
  tmuxName: string | null;
  /** 接管模式下承载 claude 的 pane;其余为 null。 */
  paneId: string | null;
  turns: number;
  costUsd: number;
  model: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  fileCount: number;
  additions: number;
  deletions: number;
  /** 会话创建时刻,固定不变 —— 左栏按它排序,不像 lastActivity 那样随每次
   *  事件跳动(见 spec §2.17)。 */
  createdAt: number;
  lastActivity: number;
  lastAction: string;
  /** 最早一个未返回结果的工具调用发起时间;无挂起时为 null。
   *  用于前端识别「已发出但卡住」—— 常见于本地权限系统等待 TTY 确认、
   *  而 AskUserQuestion 之外的工具不再经网页批准(见 spec §2.3a)的场景。 */
  pendingToolSince: number | null;
  /** 任务清单的完成度(TodoWrite 或 Task* 均可来源);从未用过时为 null。 */
  todoProgress: { done: number; total: number } | null;
}

/**
 * 落盘的会话快照 —— 只含元数据,不含 timeline。
 * 对话内容本就写在 transcriptPath 指向的转写文件里,重复存一份只会
 * 造出两个可能不同步的历史来源(详见 docs/spec.md)。
 */
export interface PersistedSession {
  localId: string;
  claudeId: string | null;
  name: string;
  title: string | null;
  workspace: string;
  transportKind: TransportKind;
  tmuxName: string | null;
  /**
   * 接管模式下承载会话的 pane。tmux 会话本身活在 daemon 之外(见 §2.5),
   * 重启后如果这个 pane 还在,应该重新接回 TmuxTransport 而非直接判 exited ——
   * 不落这个字段就无从判断,只能一律标 exited(哪怕 claude 进程其实还活着)。
   */
  paneId: string | null;
  turns: number;
  costUsd: number;
  fileCount: number;
  createdAt: number;
  lastActivity: number;
  lastAction: string;
  /** 会话进程已不在(总是如此 —— 只有重启后失去进程的会话才落这份快照)。 */
  transcriptPath: string | null;
}

export interface Session {
  localId: string;
  claudeId: string | null;
  name: string;
  title: string | null;
  workspace: string;
  state: SessionState;
  transport: SessionTransport;
  transportKind: TransportKind;
  tmuxName: string | null;
  paneId: string | null;
  /** daemon 级 hook 配置文件,CLI / transport 启动 claude 时用 --settings 指向它。 */
  settingsPath: string;
  turns: number;
  costUsd: number;
  /** 实际生效的模型 id,来自 stream-json system.init 或转写行,启动初期为 null。 */
  model: string | null;
  /** 最新一条 assistant 消息的 prompt token 总量(含 cache),header 用它算占用百分比。 */
  contextTokens: number | null;
  /** 当前 model 对应的窗口总量,只在 result 消息里给出,同一模型内保持不变。 */
  contextWindow: number | null;
  files: Map<string, FileChange>;
  commands: CommandRun[];
  timeline: TimelineItem[];
  createdAt: number;
  lastActivity: number;
  lastAction: string;
  /** 未结束的工具调用,用于把结果回填到时间线。 */
  openTools: Map<string, TimelineItem & { kind: 'tool' }>;
  /** claudeId 一旦确定即可推出,供退出后按需重读对话历史(见 backend/transcript.ts)。 */
  transcriptPath: string | null;
  /** 从 sessions.json 加载的记录,没有真实进程 —— files/commands/timeline 现读 transcript 时才补全。 */
  fromDisk: boolean;
  /** TodoWrite 最近一次调用给出的全量清单 —— 该工具语义是整份替换,不是增量。 */
  todos: TodoItem[];
  /**
   * TaskCreate/TaskUpdate/TaskGet 那套任务工具的状态,按 taskId 增量维护
   * (与 TodoWrite 全量替换的语义不同)。同一会话通常只会用其中一套工具,
   * #summarize / 详情页把两个来源合并成一份只读视图给前端,前端不关心来源。
   */
  tasks: Map<string, TodoItem>;
  /** TaskCreate 调用发出但结果未回,等 tool_result 里解出 taskId 才能建档。 */
  pendingTaskCreates: Map<string, { subject: string; activeForm: string }>;
  /**
   * 已发送但尚未收到 turn_end 的轮次计数。网页不禁用输入框,允许在上一轮
   * 还没结束时就发下一条消息 —— 若 turn_end 无条件把 state 设回 ready,
   * 上一轮的收尾会盖掉下一轮已经在跑的 busy,header 显示"就绪"但实际
   * 还有轮次在处理。turn_end 只在计数归零(没有轮次还挂着)时才置 ready。
   */
  pendingTurns: number;
}

export type ManagerEvent =
  | { type: 'session_added'; session: SessionSummary }
  | { type: 'session_updated'; session: SessionSummary }
  | { type: 'session_event'; localId: string; event: SessionEvent };

/** SessionEnd 钩子的 reason 取值,见 spec §2.9。 */
const REASON_LABEL: Record<string, string> = {
  clear: '会话已清空',
  logout: '已登出',
  prompt_input_exit: '用户退出',
  resume: '已转为恢复',
  bypass_permissions_disabled: '免批准模式关闭',
  other: '已退出',
};

/** TaskCreate 的 tool_result 是人话确认文本,taskId 只能从里面解析。 */
const TASK_CREATED_RE = /Task #(\S+) created/;

/** TodoWrite 全量清单与 TaskCreate/TaskUpdate 增量 Map 合并成一份视图,前端不关心来源。 */
export function mergedTodos(s: Pick<Session, 'todos' | 'tasks'>): TodoItem[] {
  return s.todos.length ? s.todos : [...s.tasks.values()];
}

const FILE_TOOLS: Record<string, FileChange['kind']> = {
  Edit: 'edit',
  Write: 'new',
  NotebookEdit: 'edit',
};

/** #absorb 与历史重放共用的数据形状 —— 只含可从事件流派生的字段,不含 state/lastAction 等运行时态。 */
interface ReplayTarget {
  timeline: TimelineItem[];
  openTools: Map<string, TimelineItem & { kind: 'tool' }>;
  files: Map<string, FileChange>;
  commands: CommandRun[];
  turns: number;
  costUsd: number;
  /** todos/tasks/pendingTaskCreates 与 Session 同名字段同构,见 §2.12。 */
  todos: TodoItem[];
  tasks: Map<string, TodoItem>;
  pendingTaskCreates: Map<string, { subject: string; activeForm: string }>;
}

/**
 * 把一个事件归约进 timeline/files/commands/todos。#absorb 与「exited 会话按需
 * 重读 transcript」共用此函数 —— 避免像 spec §2.10 那次事故一样,两条路径各写
 * 一份归约逻辑、字段结构悄悄分叉,只在运行时表现为数据缺失。todos 归约同理并入
 * 这里(§2.12):否则 exited 会话重新打开时任务清单会凭空消失。
 */
function reduceEvent(t: ReplayTarget, ev: SessionEvent, now: () => number): void {
  switch (ev.kind) {
    // 网页发送的消息由 sessionManager.send() 直接 push,不走这里;这条
    // case 只服务转写文件观测到的终端直接输入(见 transcript.ts)。
    case 'user':
      t.timeline.push({ kind: 'user', text: ev.text, at: now() });
      break;

    case 'assistant_text':
      t.timeline.push({ kind: 'assistant', text: ev.text, at: now() });
      break;

    case 'tool_use': {
      const summary = summarizeInput(ev.name, ev.input);
      const item: TimelineItem & { kind: 'tool' } = {
        kind: 'tool',
        toolUseId: ev.toolUseId,
        name: ev.name,
        summary,
        done: false,
        isError: false,
        at: now(),
      };
      t.timeline.push(item);
      t.openTools.set(ev.toolUseId, item);

      const kind = FILE_TOOLS[ev.name];
      if (kind) {
        const input = (ev.input ?? {}) as Record<string, unknown>;
        const path = typeof input.file_path === 'string' ? input.file_path : '';
        // 已存在的记录保持首次判定(new 优先于后续 edit)
        if (path && !t.files.has(path)) t.files.set(path, { path, kind, at: now() });
      }

      // TodoWrite 是整份清单替换,不是增量 —— 直接覆盖即可,
      // 不需要跟历史条目合并。
      if (ev.name === 'TodoWrite') {
        const todos = (ev.input as Record<string, unknown> | undefined)?.todos;
        if (Array.isArray(todos)) t.todos = todos as TodoItem[];
      }

      // Task* 系列(部分环境用它替代 TodoWrite)是增量式:TaskCreate 的
      // tool_use 阶段还没有 taskId(要等 tool_result 解析),先记生成信息;
      // TaskUpdate 有 taskId,直接改已建档的任务状态。
      if (ev.name === 'TaskCreate') {
        const input = (ev.input ?? {}) as Record<string, unknown>;
        t.pendingTaskCreates.set(ev.toolUseId, {
          subject: typeof input.subject === 'string' ? input.subject : '',
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : '',
        });
      } else if (ev.name === 'TaskUpdate') {
        const input = (ev.input ?? {}) as Record<string, unknown>;
        const taskId = typeof input.taskId === 'string' ? input.taskId : '';
        const existing = taskId ? t.tasks.get(taskId) : undefined;
        if (existing) {
          if (input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed') {
            existing.status = input.status;
          }
          if (typeof input.subject === 'string') existing.content = input.subject;
          if (typeof input.activeForm === 'string') existing.activeForm = input.activeForm;
        }
      }
      break;
    }

    case 'tool_result': {
      const open = t.openTools.get(ev.toolUseId);
      if (open) {
        open.done = true;
        // AskUserQuestion 唯一的回传通道是 deny+reason(见 spec §5.1),
        // Claude Code 因此把它标成 is_error —— 那是协议限制,不是真的失败。
        open.isError = open.name === 'AskUserQuestion' ? false : ev.isError;
        t.openTools.delete(ev.toolUseId);

        if (open.name === 'Bash') {
          t.commands.push({
            toolUseId: ev.toolUseId,
            command: open.summary,
            output: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
            isError: ev.isError,
            at: now(),
          });
        }

        // TaskCreate 的 taskId 只在这段确认文本里给出(如 "Task #4 created
        // successfully: ..."),tool_use 阶段拿不到,只能等结果回填建档。
        if (open.name === 'TaskCreate' && !ev.isError) {
          const pending = t.pendingTaskCreates.get(ev.toolUseId);
          const text = typeof ev.content === 'string' ? ev.content : '';
          const match = text.match(TASK_CREATED_RE);
          const taskId = match?.[1];
          if (pending && taskId) {
            t.tasks.set(taskId, {
              id: taskId,
              content: pending.subject,
              activeForm: pending.activeForm,
              status: 'pending',
            });
          }
          t.pendingTaskCreates.delete(ev.toolUseId);
        }
      }
      break;
    }

    case 'turn_end':
      t.turns++;
      if (ev.costUsd) t.costUsd += ev.costUsd;
      t.timeline.push({ kind: 'turn_end', at: now() });
      break;
  }
}

export interface ReplayedHistory {
  timeline: TimelineItem[];
  files: FileChange[];
  commands: CommandRun[];
  turns: number;
  costUsd: number;
  todos: TodoItem[];
}

/**
 * exited 会话没有内存态时按需重读转写文件 —— sessions.json 只存元数据
 * (见 backend/store.ts),对话内容单一来源是 Claude Code 自己写的转写文件。
 * 时间戳统一退回文件读取时刻:转写行本身不带时间字段,不影响排序(读的是原始顺序)。
 */
export async function replayTranscriptTimeline(transcriptPath: string): Promise<ReplayedHistory> {
  const t: ReplayTarget = {
    timeline: [],
    openTools: new Map(),
    files: new Map(),
    commands: [],
    turns: 0,
    costUsd: 0,
    todos: [],
    tasks: new Map(),
    pendingTaskCreates: new Map(),
  };
  const now = Date.now();
  for (const ev of await replayTranscript(transcriptPath)) {
    reduceEvent(t, ev, () => now);
  }
  return {
    timeline: t.timeline,
    files: [...t.files.values()],
    commands: t.commands,
    todos: mergedTodos(t),
    turns: t.turns,
    costUsd: t.costUsd,
  };
}

/**
 * 从磁盘加载的历史会话没有真实进程,占位实现供 Session.transport 落位。
 * alive() 恒 false —— liveness 巡检据此不会误把它当活会话反复探测。
 */
class NullTransport implements SessionTransport {
  readonly sessionId: string | null = null;
  async start(): Promise<void> {}
  send(): void {}
  interrupt(): void {}
  async stop(): Promise<void> {}
  async alive(): Promise<boolean> { return false; }
  onEvent(): () => void { return () => {}; }
}

export class SessionManager {
  #sessions = new Map<string, Session>();
  #byClaudeId = new Map<string, string>();
  #listeners: ((e: ManagerEvent) => void)[] = [];
  #hookSettingsPath: string;
  #store: SessionStore;

  /**
   * requestedPort 是持久化目录的 key(见 daemon.ts stateDir),必须用「请求
   * 端口」而非「实际监听端口」,否则默认端口偶尔因占用而偏移时,上次启动写的
   * sessions.json 会因为目录名对不上而读不到。
   *
   * hookSettingsPath 指向 daemon 级 hook 配置文件,所有会话经 --settings 共用 ——
   * 文件内容(含实际监听端口)由 daemon.ts 在监听成功后写,这里只需要路径。
   */
  constructor(requestedPort: number, hookSettingsPath: string) {
    this.#hookSettingsPath = hookSettingsPath;
    this.#store = new SessionStore(requestedPort, () => this.#persistedAll());
    this.#loadPersisted(requestedPort);
    // 构造函数不能是 async,先同步把全部历史记录标 exited 让 SessionManager
    // 立刻可用,tmux 接管会话的重新探活异步补上(见 #reclaimTmuxSessions)。
    // 空窗期内这些会话在网页上短暂显示"已退出" —— 存活巡检对 exited 会话
    // 直接跳过(#sweep 的 continue 条件),不会跟这里的异步重建产生竞态。
    void this.#reclaimTmuxSessions();
  }

  /**
   * 后端重启后,tmux 接管模式的会话可能其实还活着 —— pane 独立于 daemon
   * 存活(见 §2.5)。#loadPersisted 无从判断,一律先标 exited;这里逐个
   * 探测 pane 是否还在,还在就重建 TmuxTransport 接回去,状态交给 start()
   * 的正常流程(#waitReady 探到 TUI 已就绪会很快返回,不是从头等首屏)。
   *
   * paneId 缺失时先反查一次(见 §2.16):PersistedSession.paneId 是后加的
   * 字段,旧数据落盘时它还不存在,磁盘记录本身补不全 —— 必须从操作系统当前
   * 状态倒推。查到就顺手补回 s.paneId,让接下来 #persistedAll() 落盘时
   * 一并写回磁盘,不必每次重启都重新反查。
   */
  async #reclaimTmuxSessions(): Promise<void> {
    const all = [...this.#sessions.values()].filter((s) => s.fromDisk && s.transportKind === 'tmux');
    if (!all.length) return;

    // 全局反查一次,同时喂给下面两处用途:paneId 缺失的补全,以及
    // paneId 已知的仍要核实 —— pane 容器还在不代表里面还是这个会话的 claude
    // 进程(用户可能已在 pane 内退出 claude 回到 shell,paneExists 单看
    // pane 容器会误判"还活着",#waitReady 又只认屏幕上的 ❯ 提示符,connect
    // 到 shell 提示符同样会被判定就绪 —— 见 daemon restart 后 exited 会话
    // 显示成 ready 的问题)。
    const claimed = await findClaimedPanes();
    for (const s of all) {
      if (!s.claudeId) continue;
      const pane = claimed.get(s.claudeId);
      if (!s.paneId) { if (pane) s.paneId = pane; continue; }
      if (pane !== s.paneId) s.paneId = null;  // pane 已不再跑这个会话,交回 exited
    }

    const candidates = all.filter((s) => s.paneId);
    if (!candidates.length) return;

    await Promise.all(
      candidates.map(async (s) => {
        const transport = new TmuxTransport({
          cwd: s.workspace,
          settingsPath: s.settingsPath,
          paneId: s.paneId!,
          sessionId: s.claudeId ?? undefined,
        });
        s.transport = transport;
        s.fromDisk = false;
        transport.onEvent((ev) => this.#absorb(s, ev));

        try {
          await transport.start();
        } catch (err) {
          console.error(`[session ${s.localId}] 重新接管 pane ${s.paneId} 失败:`, err);
          this.#markExited(s, '重新接管失败');
        }
      }),
    );
    this.#store.scheduleSave();  // paneId 反查补全的结果落盘,下次重启不必再猜
  }

  /** 启动时把历史记录接回内存,标 exited(进程已经不在,只是记录还在)。 */
  #loadPersisted(requestedPort: number): void {
    for (const p of loadSessions(requestedPort)) {
      if (this.#sessions.has(p.localId)) continue;  // 理论上不会撞,防御一下
      const session: Session = {
        localId: p.localId,
        claudeId: p.claudeId,
        name: p.name,
        title: p.title,
        workspace: p.workspace,
        state: 'exited',
        transport: new NullTransport(),
        transportKind: p.transportKind,
        tmuxName: p.tmuxName,
        paneId: p.paneId,
        // 重启后仅用于 #reclaimTmuxSessions 重建 TmuxTransport;此时 pane 里的
        // claude 早已带着启动时的 hook 配置在跑,--settings 只在启动读一次,
        // 这个值实际不影响已恢复的会话。指向当前 daemon 的 hook 文件即可。
        settingsPath: this.#hookSettingsPath,
        turns: p.turns,
        costUsd: p.costUsd,
        model: null,
        contextTokens: null,
        contextWindow: null,
        files: new Map(),
        commands: [],
        timeline: [],
        // 旧数据没有 createdAt(字段是后加的),拿 lastActivity 顶替 —— 不精确
        // 但好过完全没有排序依据;新记录从 create() 起就一直有准确值。
        createdAt: p.createdAt ?? p.lastActivity,
        lastActivity: p.lastActivity,
        lastAction: p.lastAction,
        openTools: new Map(),
        transcriptPath: p.transcriptPath,
        fromDisk: true,
        todos: [],
        tasks: new Map(),
        pendingTaskCreates: new Map(),
        pendingTurns: 0,
      };
      this.#sessions.set(p.localId, session);
      if (p.claudeId) this.#byClaudeId.set(p.claudeId, p.localId);
    }
  }

  #persistedAll(): PersistedSession[] {
    return [...this.#sessions.values()].map((s) => ({
      localId: s.localId,
      claudeId: s.claudeId,
      name: s.name,
      title: s.title,
      workspace: s.workspace,
      transportKind: s.transportKind,
      tmuxName: s.tmuxName,
      paneId: s.paneId,
      turns: s.turns,
      costUsd: s.costUsd,
      fileCount: s.files.size,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      lastAction: s.lastAction,
      transcriptPath: s.transcriptPath,
    }));
  }

  onEvent(fn: (e: ManagerEvent) => void): void {
    this.#listeners.push(fn);
  }

  #emit(e: ManagerEvent): void {
    for (const fn of this.#listeners) fn(e);
  }

  list(): SessionSummary[] {
    return [...this.#sessions.values()].map((s) => this.#summarize(s));
  }

  get(localId: string): Session | undefined {
    return this.#sessions.get(localId);
  }

  /** 钩子只带 claudeId,需要反查本地会话。 */
  byClaudeId(claudeId: string): Session | undefined {
    const localId = this.#byClaudeId.get(claudeId);
    return localId ? this.#sessions.get(localId) : undefined;
  }

  #summarize(s: Session): SessionSummary {
    let additions = 0;
    let deletions = 0;
    for (const f of s.files.values()) {
      if (f.kind === 'delete') deletions++;
      else additions++;
    }
    let pendingToolSince: number | null = null;
    for (const t of s.openTools.values()) {
      if (pendingToolSince === null || t.at < pendingToolSince) pendingToolSince = t.at;
    }
    let todoProgress: SessionSummary['todoProgress'] = null;
    const todos = mergedTodos(s);
    if (todos.length) {
      const done = todos.filter((t) => t.status === 'completed').length;
      todoProgress = { done, total: todos.length };
    }
    return {
      localId: s.localId,
      claudeId: s.claudeId,
      name: s.name,
      title: s.title,
      workspace: s.workspace,
      state: s.state,
      transport: s.transportKind,
      tmuxName: s.tmuxName,
      paneId: s.paneId,
      turns: s.turns,
      costUsd: s.costUsd,
      model: s.model,
      contextTokens: s.contextTokens,
      contextWindow: s.contextWindow,
      fileCount: s.files.size,
      additions,
      deletions,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      lastAction: s.lastAction,
      pendingToolSince,
      todoProgress,
    };
  }

  /**
   * 周期巡检承载体存活。
   *
   * tmux 会话的退出没有任何事件:用户在自己的 pane 里按 Ctrl-D 退出 claude,
   * 后端只会停在最后一次 turn_end 留下的 ready,界面上永远显示「就绪」。
   * 返回停止函数,供关闭时清理。
   */
  startLivenessWatch(intervalMs = 4000): () => void {
    const timer = setInterval(() => void this.#sweep(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #sweep(): Promise<void> {
    for (const s of this.#sessions.values()) {
      if (s.state === 'exited' || !s.transport.alive) continue;
      if (await s.transport.alive()) continue;
      this.#markExited(s, '进程已退出');
    }
  }

  /**
   * SessionEnd 钩子到达时调用。比存活巡检快且带退出原因,
   * 但覆盖不了 kill -9 与直接关掉 pane —— 那些情况钩子不会发,仍靠巡检兜底。
   */
  endByClaudeId(claudeId: string, reason: string): void {
    const s = this.byClaudeId(claudeId);
    if (!s) return;
    this.#markExited(s, REASON_LABEL[reason] ?? `已退出(${reason})`);
  }

  /** 会话记录保留,交给用户在网页上关闭 —— 自动摘除会让改动记录一并消失。 */
  #markExited(s: Session, lastAction: string): void {
    if (s.state === 'exited') return;
    s.state = 'exited';
    s.lastAction = lastAction;
    s.lastActivity = Date.now();
    this.#emit({ type: 'session_updated', session: this.#summarize(s) });
    this.#store.scheduleSave();
  }

  /** 状态变更由外部(权限引擎)触发时调用,例如出现待批准项。 */
  setState(localId: string, state: SessionState): void {
    const s = this.#sessions.get(localId);
    if (!s || s.state === state) return;
    s.state = state;
    s.lastActivity = Date.now();
    this.#emit({ type: 'session_updated', session: this.#summarize(s) });
  }

  async create(workspace: string, opts: CreateOptions = {}): Promise<Session> {
    const localId = randomUUID();
    const settingsPath = this.#hookSettingsPath;
    const kind = opts.transport ?? 'stream-json';

    const transport =
      kind === 'tmux'
        ? new TmuxTransport({
            cwd: workspace,
            settingsPath,
            sessionName: opts.tmuxName,
            paneId: opts.paneId,
            sessionId: opts.sessionId,
          })
        : new StreamJsonTransport({
            cwd: workspace,
            settingsPath,
            extraArgs: opts.model ? ['--model', opts.model] : undefined,
          });

    const session: Session = {
      localId,
      claudeId: null,
      name: opts.name ?? basename(workspace),
      title: null,
      workspace,
      state: 'starting',
      transport,
      transportKind: kind,
      tmuxName: transport instanceof TmuxTransport ? transport.tmuxName : null,
      paneId: opts.paneId ?? null,
      settingsPath,
      turns: 0,
      costUsd: 0,
      // opts.model 指定时結果已确定,不必等 system.init 回填,减少 header 空窗期。
      model: opts.model ?? null,
      contextTokens: null,
      contextWindow: null,
      files: new Map(),
      commands: [],
      timeline: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastAction: '正在启动',
      openTools: new Map(),
      transcriptPath: null,
      fromDisk: false,
      todos: [],
      tasks: new Map(),
      pendingTaskCreates: new Map(),
      pendingTurns: 0,
    };

    this.#sessions.set(localId, session);
    transport.onEvent((ev) => this.#absorb(session, ev));

    this.#emit({ type: 'session_added', session: this.#summarize(session) });
    this.#store.scheduleSave();

    // 接管模式下 claude 尚未启动(CLI 拿到 settings 路径后才启动),
    // start() 会一直等到 TUI 就绪 —— 必须放行,否则注册请求要挂到超时。
    if (opts.paneId) {
      void transport.start().catch((err) => {
        console.error('[session] 接管启动失败:', err);
      });
    } else {
      await transport.start();
    }
    return session;
  }

  /** 把 transport 事件吸收进会话状态,同时向上广播。 */
  #absorb(s: Session, ev: SessionEvent): void {
    s.lastActivity = Date.now();

    switch (ev.kind) {
      case 'session': {
        // 两个会话认领同一 claudeId 会让批准请求路由到错误的会话,
        // 后果是网页上批准 A 却放行 B —— 宁可告警也不静默覆盖。
        const owner = this.#byClaudeId.get(ev.sessionId);
        if (owner && owner !== s.localId) {
          console.error(
            `[session] claudeId ${ev.sessionId} 已属于 ${owner},拒绝改判给 ${s.localId}`,
          );
          break;
        }
        s.claudeId = ev.sessionId;
        this.#byClaudeId.set(ev.sessionId, s.localId);
        s.transcriptPath = transcriptPathFor(s.workspace, ev.sessionId);
        break;
      }

      case 'title':
        // 与 name 并存而非覆盖 —— name(目录名)仍用于分组与路径识别
        s.title = ev.title;
        break;

      case 'model':
        s.model = ev.model;
        break;

      // 运行时展示态,不进 reduceEvent/ReplayTarget —— exited 会话重放
      // transcript 时重新计算「当前上下文占用」没有意义,那是活跃进程才有的状态。
      case 'usage':
        s.contextTokens = ev.inputTokens;
        break;

      case 'context_window':
        if (ev.model === s.model) s.contextWindow = ev.window;
        break;

      // timeline/files/commands/todos 的实际写入统一交给下面的 reduceEvent()
      // (#absorb 与「exited 会话重放 transcript」共用,见其函数注释);
      // 这里只处理 lastAction,那是运行时展示态,不属于可从事件流派生的历史。
      case 'tool_use':
        s.lastAction = `${ev.name} ${summarizeInput(ev.name, ev.input)}`.slice(0, 90);
        break;

      case 'turn_end':
        // 网页不禁用输入框,上一轮结束时下一轮可能已经在跑(见 pendingTurns
        // 字段注释)—— 只有没有轮次还挂着时才能把 state 收回 ready,否则会
        // 把下一轮的 busy 盖掉,header 显示"就绪"但实际还在处理。
        s.pendingTurns = Math.max(0, s.pendingTurns - 1);
        if (s.pendingTurns === 0) {
          s.state = 'ready';
          // 与 interrupt() 里网页发起中断的文案保持一致 —— 用户在终端
          // 直接按 Escape 时走的是这条路径,而非那个方法。
          s.lastAction = ev.interrupted ? '已中断,等待输入' : '等待输入';
        }
        break;

      case 'status':
        if (ev.state === 'busy') s.state = 'busy';
        else if (ev.state === 'ready' && s.state === 'starting') s.state = 'ready';
        else if (ev.state === 'exited') {
          s.state = 'exited';
          s.lastAction = '进程已退出';
        }
        break;

      // transport.send() 对应的注入本身失败(如 tmux 注入超时、stdin 不可写)——
      // 这次尝试不会再有 turn_end 来配对,pendingTurns 若不在此收回,会永久
      // 卡在 >0,turn_end 分支的 === 0 判断再也不成立,会话就此再也回不到
      // ready(除了这条错误路径,没有别处会让 pendingTurns 减少)。
      case 'error':
        console.error(`[session ${s.localId}] transport error: ${ev.message}`);
        if (s.pendingTurns > 0) {
          s.pendingTurns--;
          if (s.pendingTurns === 0 && s.state !== 'exited') {
            s.state = 'ready';
            s.lastAction = '等待输入';
          }
        }
        break;
    }
    reduceEvent(s, ev, Date.now);

    this.#emit({ type: 'session_event', localId: s.localId, event: ev });
    this.#emit({ type: 'session_updated', session: this.#summarize(s) });
    this.#store.scheduleSave();
  }

  send(localId: string, text: string): boolean {
    const s = this.#sessions.get(localId);
    if (!s) return false;
    s.timeline.push({ kind: 'user', text, at: Date.now() });
    // 每条 prompt 对应一次 turn_end,先记下再发送,避免跟 transport 的
    // status:busy 事件时序产生竞态(见 pendingTurns 字段注释)。
    s.pendingTurns++;
    s.transport.send(text);
    return true;
  }

  /**
   * 用户主动中断当前轮次 —— 视为「这轮不算了」,不再等 transcript 里
   * 可能不会再来的 turn_end。若不在这里清空 pendingTurns,中断信号
   * 发给 CLI 后 state 仍停在 busy,composer 会继续把新消息堆进草稿
   * 队列,用户看着"已中断"却还是发不出下一条消息。
   */
  interrupt(localId: string): void {
    const s = this.#sessions.get(localId);
    if (!s || s.state === 'exited') return;
    s.transport.interrupt();
    s.pendingTurns = 0;
    s.state = 'ready';
    s.lastAction = '已中断,等待输入';
    this.#emit({ type: 'session_updated', session: this.#summarize(s) });
    this.#store.scheduleSave();
  }

  /** 用户在网页上主动删除会话 —— 记录本身也从持久化里摘除,不留痕迹。 */
  async close(localId: string): Promise<void> {
    const s = this.#sessions.get(localId);
    if (!s) return;
    await s.transport.stop();
    if (s.claudeId) this.#byClaudeId.delete(s.claudeId);
    this.#sessions.delete(localId);
    // 立即落盘而非等 debounce —— 否则紧接着的进程退出会让这条
    // 「已删除」的记录因为磁盘上还是旧快照而在下次启动时复活。
    this.#store.saveNow();
  }

  /**
   * 后端进程退出(SIGINT/SIGTERM)时调用 —— 只停子进程,记录留着标 exited。
   * 与 close() 语义不同:close() 是用户主动删除,这里是宿主进程退出,
   * 目的正是让下次启动时左栏仍能看到这些会话(持久化的意义所在)。
   */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map(async (s) => {
        await s.transport.stop();
        this.#markExited(s, s.lastAction);
      }),
    );
    this.#store.saveNow();
  }
}
