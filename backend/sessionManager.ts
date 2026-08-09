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
import { transcriptPathFor, replayTranscript } from './transcript.ts';
import { loadSessions, SessionStore } from './store.ts';
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
  turns: number;
  costUsd: number;
  fileCount: number;
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
  /** claudeId 一旦确定即可推出,供退出后按需重读对话历史(见 backend/transcript.ts)。 */
  transcriptPath: string | null;
  /** 从 sessions.json 加载的记录,没有真实进程 —— files/commands/timeline 现读 transcript 时才补全。 */
  fromDisk: boolean;
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
}

/**
 * 把一个事件归约进 timeline/files/commands。#absorb 与「exited 会话按需重读
 * transcript」共用此函数 —— 避免像 spec §2.10 那次事故一样,两条路径各写一份
 * 归约逻辑、字段结构悄悄分叉,只在运行时表现为数据缺失。
 */
function reduceEvent(t: ReplayTarget, ev: SessionEvent, now: () => number): void {
  switch (ev.kind) {
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
      break;
    }

    case 'tool_result': {
      const open = t.openTools.get(ev.toolUseId);
      if (open) {
        open.done = true;
        open.isError = ev.isError;
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
  };
  const now = Date.now();
  for (const ev of await replayTranscript(transcriptPath)) {
    reduceEvent(t, ev, () => now);
  }
  return {
    timeline: t.timeline,
    files: [...t.files.values()],
    commands: t.commands,
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
  #port: () => number;
  #host: string;
  #store: SessionStore;

  /**
   * port 是取函数而非定值 —— 监听时可能因占用递增,钩子 URL 必须用最终值。
   * requestedPort 与之不同:它是持久化目录的 key(见 daemon.ts stateDir),
   * 必须用「请求端口」而非「实际监听端口」,否则默认端口偶尔因占用而偏移时,
   * 上次启动写的 sessions.json 会因为目录名对不上而读不到。
   */
  constructor(host: string, port: () => number, requestedPort: number) {
    this.#host = host;
    this.#port = port;
    this.#store = new SessionStore(requestedPort, () => this.#persistedAll());
    this.#loadPersisted(requestedPort);
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
        paneId: null,
        settingsPath: join(p.workspace, '.claude', 'settings.local.json'),
        turns: p.turns,
        costUsd: p.costUsd,
        files: new Map(),
        commands: [],
        timeline: [],
        lastActivity: p.lastActivity,
        lastAction: p.lastAction,
        openTools: new Map(),
        transcriptPath: p.transcriptPath,
        fromDisk: true,
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
      turns: s.turns,
      costUsd: s.costUsd,
      fileCount: s.files.size,
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
      transcriptPath: null,
      fromDisk: false,
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

      case 'tool_use':
        s.lastAction = `${ev.name} ${summarizeInput(ev.name, ev.input)}`.slice(0, 90);
        break;

      case 'turn_end':
        s.state = 'ready';
        s.lastAction = '等待输入';
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
    reduceEvent(s, ev, Date.now);

    this.#emit({ type: 'session_event', localId: s.localId, event: ev });
    this.#emit({ type: 'session_updated', session: this.#summarize(s) });
    this.#store.scheduleSave();
  }

  send(localId: string, text: string): boolean {
    const s = this.#sessions.get(localId);
    if (!s) return false;
    s.timeline.push({ kind: 'user', text, at: Date.now() });
    s.transport.send(text);
    return true;
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
