/**
 * SessionManager —— 管理多个工作区会话。
 *
 * 每个会话:一个 SessionTransport 实例 + 独立的 settings 文件 + 累积的活动记录。
 * 按 Claude Code 分配的 session_id 建索引,供权限引擎与 WebSocket 路由使用。
 *
 * 注意会话 ID 有两个:
 *  - localId  由本服务生成,启动瞬间即可用,UI 用它寻址
 *  - claudeId 由 Claude Code 分配(UUID),启动后才知道,钩子载荷用它
 * 钩子到达时只有 claudeId,故需维护 claudeId -> localId 的映射。
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { StreamJsonTransport } from './streamJson.ts';
import { TmuxTransport } from './tmuxTransport.ts';
import { HOOK_TIMEOUT_S } from './permissions.ts';
import { summarizeInput } from './risk.ts';
import type { SessionEvent, SessionTransport } from './transport.ts';

/**
 * PreToolUse hook 的拦截范围。`*` 会连读操作也拦下网页审批,
 * 且拦截发生在 Claude Code 内置权限判断之前,内置 allow 规则/权限模式全部失效
 * (实测确认:hook 无条件触发,不是内置引擎判断"需要询问"后才转发)。
 * 默认收窄到 AskUserQuestion —— 保留主动提问上网页,把其余工具还给内置权限系统。
 * 需要恢复全量监管时改回 '*' 即可。
 */
const ENABLE_FULL_APPROVAL = false;
const APPROVAL_MATCHER = ENABLE_FULL_APPROVAL ? '*' : 'AskUserQuestion';

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
  fileCount: number;
  additions: number;
  deletions: number;
  lastActivity: number;
  lastAction: string;
  /** 最早一个未返回结果的工具调用发起时间;无挂起时为 null。
   *  用于前端识别「已发出但卡住」—— 常见于本地权限系统等待 TTY 确认、
   *  而 AskUserQuestion 之外的工具不再经网页批准(见 spec §2.3a)的场景。 */
  pendingToolSince: number | null;
  /** 任务清单的完成度(TodoWrite 或 Task* 均可来源);从未用过时为 null。 */
  todoProgress: { done: number; total: number } | null;
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
  /** 注入了钩子的 settings 文件,CLI 启动 claude 时要用 --settings 指向它。 */
  settingsPath: string;
  turns: number;
  costUsd: number;
  files: Map<string, FileChange>;
  commands: CommandRun[];
  timeline: TimelineItem[];
  lastActivity: number;
  lastAction: string;
  /** 未结束的工具调用,用于把结果回填到时间线。 */
  openTools: Map<string, TimelineItem & { kind: 'tool' }>;
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

export class SessionManager {
  #sessions = new Map<string, Session>();
  #byClaudeId = new Map<string, string>();
  #listeners: ((e: ManagerEvent) => void)[] = [];
  #port: () => number;
  #host: string;

  /** 端口取函数而非定值 —— 监听时可能因占用递增,钩子 URL 必须用最终值。 */
  constructor(host: string, port: () => number) {
    this.#host = host;
    this.#port = port;
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
      fileCount: s.files.size,
      additions,
      deletions,
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
    const settingsPath = this.#writeSettings(workspace);
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
        : new StreamJsonTransport({ cwd: workspace, settingsPath });

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
      files: new Map(),
      commands: [],
      timeline: [],
      lastActivity: Date.now(),
      lastAction: '正在启动',
      openTools: new Map(),
      todos: [],
      tasks: new Map(),
      pendingTaskCreates: new Map(),
    };

    this.#sessions.set(localId, session);
    transport.onEvent((ev) => this.#absorb(session, ev));

    this.#emit({ type: 'session_added', session: this.#summarize(session) });

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
        break;
      }

      case 'assistant_text':
        s.timeline.push({ kind: 'assistant', text: ev.text, at: Date.now() });
        break;

      case 'title':
        // 与 name 并存而非覆盖 —— name(目录名)仍用于分组与路径识别
        s.title = ev.title;
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
          at: Date.now(),
        };
        s.timeline.push(item);
        s.openTools.set(ev.toolUseId, item);
        s.lastAction = `${ev.name} ${summary}`.slice(0, 90);

        // TodoWrite 是整份清单替换,不是增量 —— 直接覆盖即可,
        // 不需要跟历史条目合并。
        if (ev.name === 'TodoWrite') {
          const todos = (ev.input as Record<string, unknown> | undefined)?.todos;
          if (Array.isArray(todos)) s.todos = todos as TodoItem[];
        }

        // Task* 系列(部分环境用它替代 TodoWrite)是增量式:TaskCreate 的
        // tool_use 阶段还没有 taskId(要等 tool_result 解析),先记生成信息;
        // TaskUpdate 有 taskId,直接改已建档的任务状态。
        if (ev.name === 'TaskCreate') {
          const input = (ev.input ?? {}) as Record<string, unknown>;
          s.pendingTaskCreates.set(ev.toolUseId, {
            subject: typeof input.subject === 'string' ? input.subject : '',
            activeForm: typeof input.activeForm === 'string' ? input.activeForm : '',
          });
        } else if (ev.name === 'TaskUpdate') {
          const input = (ev.input ?? {}) as Record<string, unknown>;
          const taskId = typeof input.taskId === 'string' ? input.taskId : '';
          const existing = taskId ? s.tasks.get(taskId) : undefined;
          if (existing) {
            if (input.status === 'pending' || input.status === 'in_progress' || input.status === 'completed') {
              existing.status = input.status;
            }
            if (typeof input.subject === 'string') existing.content = input.subject;
            if (typeof input.activeForm === 'string') existing.activeForm = input.activeForm;
          }
        }

        // 文件类工具:记入改动列表
        const kind = FILE_TOOLS[ev.name];
        if (kind) {
          const input = (ev.input ?? {}) as Record<string, unknown>;
          const path = typeof input.file_path === 'string' ? input.file_path : '';
          if (path) {
            // 已存在的记录保持首次判定(new 优先于后续 edit)
            if (!s.files.has(path)) s.files.set(path, { path, kind, at: Date.now() });
          }
        }
        break;
      }

      case 'tool_result': {
        const open = s.openTools.get(ev.toolUseId);
        if (open) {
          open.done = true;
          open.isError = ev.isError;
          s.openTools.delete(ev.toolUseId);

          // Bash 结果留档,供「终端输出」页签
          if (open.name === 'Bash') {
            s.commands.push({
              toolUseId: ev.toolUseId,
              command: open.summary,
              output: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
              isError: ev.isError,
              at: Date.now(),
            });
          }

          // TaskCreate 的 taskId 只在这段确认文本里给出(如 "Task #4 created
          // successfully: ..."),tool_use 阶段拿不到,只能等结果回填建档。
          if (open.name === 'TaskCreate' && !ev.isError) {
            const pending = s.pendingTaskCreates.get(ev.toolUseId);
            const text = typeof ev.content === 'string' ? ev.content : '';
            const match = text.match(TASK_CREATED_RE);
            const taskId = match?.[1];
            if (pending && taskId) {
              s.tasks.set(taskId, {
                id: taskId,
                content: pending.subject,
                activeForm: pending.activeForm,
                status: 'pending',
              });
            }
            s.pendingTaskCreates.delete(ev.toolUseId);
          }
        }
        break;
      }

      case 'turn_end':
        s.turns++;
        if (ev.costUsd) s.costUsd += ev.costUsd;
        s.state = 'ready';
        s.lastAction = '等待输入';
        s.timeline.push({ kind: 'turn_end', at: Date.now() });
        break;

      case 'status':
        if (ev.state === 'busy') s.state = 'busy';
        else if (ev.state === 'ready' && s.state === 'starting') s.state = 'ready';
        else if (ev.state === 'exited') {
          s.state = 'exited';
          s.lastAction = '进程已退出';
        }
        break;
    }

    this.#emit({ type: 'session_event', localId: s.localId, event: ev });
    this.#emit({ type: 'session_updated', session: this.#summarize(s) });
  }

  send(localId: string, text: string): boolean {
    const s = this.#sessions.get(localId);
    if (!s) return false;
    s.timeline.push({ kind: 'user', text, at: Date.now() });
    s.transport.send(text);
    return true;
  }

  async close(localId: string): Promise<void> {
    const s = this.#sessions.get(localId);
    if (!s) return;
    await s.transport.stop();
    if (s.claudeId) this.#byClaudeId.delete(s.claudeId);
    this.#sessions.delete(localId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }

  /**
   * 写入 settings —— 合并而非覆盖。
   * 该文件常已被用户占用(model / permissions / 插件 / statusLine),
   * 直接赋值会静默毁掉用户配置与已有钩子。
   */
  #writeSettings(workspace: string): string {
    const dir = join(workspace, '.claude');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'settings.local.json');

    let existing: Record<string, any> = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        console.warn(`[settings] ${path} 解析失败,以空配置为基础`);
      }
    }

    const hookEntry = {
      type: 'http' as const,
      url: `http://${this.#host}:${this.#port()}/api/claude-event`,
      // 显式设短于默认 600s。真正的兜底在 permissions.ts:
      // 钩子自然超时 = 放行(实测),绝不能依赖它。
      timeout: HOOK_TIMEOUT_S,
    };

    const isOurs = (h: any) =>
      h?.type === 'http' && typeof h.url === 'string' && h.url.includes('/api/claude-event');
    const appendHook = (groups: any[] | undefined, matcher?: string) => {
      const kept = (groups ?? [])
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) }))
        .filter((g: any) => g.hooks.length > 0);
      return [...kept, matcher ? { matcher, hooks: [hookEntry] } : { hooks: [hookEntry] }];
    };

    const merged = {
      ...existing,
      hooks: {
        ...(existing.hooks ?? {}),
        PreToolUse: appendHook(existing.hooks?.PreToolUse, APPROVAL_MATCHER),
        Stop: appendHook(existing.hooks?.Stop),
        SessionEnd: appendHook(existing.hooks?.SessionEnd, '*'),
      },
    };

    writeFileSync(path, JSON.stringify(merged, null, 2), { mode: 0o600 });
    return path;
  }
}
