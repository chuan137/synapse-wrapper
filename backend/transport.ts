/**
 * SessionTransport —— 驱动 Claude Code 的传输层抽象。
 *
 * 阶段一实现:StreamJsonTransport(stdin/stdout 的 NDJSON)。
 * 阶段二预留:TmuxTransport(load-buffer/paste-buffer + 转写文件 tail)。
 *
 * 权限引擎【不】在这个接口里 —— 它走 HTTP 钩子,与传输方式无关。
 * 实测确认:同一套钩子在 stream-json 下正常工作,tmux 下同理。
 * 这是选择 HTTP 钩子(而非 --permission-prompt-tool)换来的性质,不是免费的。
 */

/** 传输层向上广播的事件。UI 只认这些,不关心底层是管道还是 tmux。 */
export type SessionEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'assistant_delta'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }
  | { kind: 'title'; title: string }
  | { kind: 'model'; model: string }
  /**
   * 每条 assistant 消息自带的用量。窗口总量不在这里 —— 协议只在 result
   * 消息的 modelUsage 里给,故 tokens 与 window 分两个事件独立更新,
   * header 合并展示时各自取最新值即可(参照 §2.9 归约思路:宁可拆细,
   * 不强凑一个两边都不一定凑得齐的复合事件)。
   */
  | { kind: 'usage'; inputTokens: number }
  | { kind: 'context_window'; model: string; window: number }
  | { kind: 'turn_end'; result: string; costUsd?: number }
  | { kind: 'status'; state: 'starting' | 'ready' | 'busy' | 'exited'; detail?: string }
  | { kind: 'error'; message: string };

export type SessionEventHandler = (event: SessionEvent) => void;

export interface SessionTransport {
  /** 底层会话 ID(由 Claude Code 分配,UUID)。启动前为 null。 */
  readonly sessionId: string | null;

  /** 启动底层进程 / tmux 会话。 */
  start(): Promise<void>;

  /** 投递一条用户消息。可在任意时刻调用,包括上一轮进行中。 */
  send(text: string): void;

  /** 中断当前轮次。 */
  interrupt(): void;

  /** 关闭会话并释放资源。 */
  stop(): Promise<void>;

  /**
   * 承载体是否还在。
   *
   * 仅 tmux 需要:pane 由用户掌控,他直接退出 claude 时没有任何事件到达后端,
   * 只能靠轮询发现。子进程型传输能收到 exit 事件,不必实现。
   */
  alive?(): Promise<boolean>;

  /**
   * 把承载的终端切到前台。
   *
   * 仅 tmux 需要:stream-json 没有可供切换的终端窗口。只影响当前 attach 的
   * client(`tmux switch-client`),网页本身无法强制操作系统切换终端应用的窗口焦点。
   */
  focus?(): Promise<void>;

  /** 订阅事件流。返回取消订阅的函数。 */
  onEvent(handler: SessionEventHandler): () => void;
}

/** 事件分发的公共实现,供各 transport 复用。 */
export class EventEmitterBase {
  #handlers = new Set<SessionEventHandler>();

  onEvent(handler: SessionEventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  protected emit(event: SessionEvent): void {
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[transport] 事件处理器抛错:', err);
      }
    }
  }
}
