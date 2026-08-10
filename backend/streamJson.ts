/**
 * StreamJsonTransport —— 常驻 `claude -p --input-format stream-json` 子进程。
 *
 * 实测确认(Claude Code 2.1.226):
 *  - 多轮对话可行:单进程、同一 session_id、上下文跨轮保留。
 *    (`-p` 是「programmatic」不是「一次性」;单轮行为来自 --input-format text)
 *  - --include-partial-messages 提供 token 级增量(stream_event)。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { EventEmitterBase, type SessionTransport } from './transport.ts';

export interface StreamJsonOptions {
  cwd: string;
  settingsPath: string;
  /** 透传给 CLI 的额外参数(如 --model)。 */
  extraArgs?: string[];
}

export class StreamJsonTransport extends EventEmitterBase implements SessionTransport {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #rl: Interface | null = null;
  #sessionId: string | null = null;
  #opts: StreamJsonOptions;

  constructor(opts: StreamJsonOptions) {
    super();
    this.#opts = opts;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  async start(): Promise<void> {
    this.emit({ kind: 'status', state: 'starting' });

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--settings', this.#opts.settingsPath,
      ...(this.#opts.extraArgs ?? []),
    ];

    const proc = spawn('claude', args, {
      cwd: this.#opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#proc = proc;

    this.#rl = createInterface({ input: proc.stdout });
    this.#rl.on('line', (line) => this.#handleLine(line));

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error('[claude stderr]', text);
    });

    proc.on('exit', (code, signal) => {
      this.emit({ kind: 'status', state: 'exited', detail: `code=${code} signal=${signal}` });
    });

    proc.on('error', (err) => {
      this.emit({ kind: 'error', message: `无法启动 claude: ${err.message}` });
    });

    this.emit({ kind: 'status', state: 'ready' });
  }

  #handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: Record<string, any>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // 非 JSON 行(极少见)直接忽略
    }

    switch (msg.type) {
      case 'system': {
        if (msg.session_id && !this.#sessionId) {
          this.#sessionId = msg.session_id;
          this.emit({ kind: 'session', sessionId: msg.session_id });
        }
        if (msg.subtype === 'init' && typeof msg.model === 'string') {
          this.emit({ kind: 'model', model: msg.model });
        }
        break;
      }

      case 'stream_event': {
        // token 级增量,用于打字机效果
        const delta = msg.event?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.emit({ kind: 'assistant_delta', text: delta.text });
        }
        break;
      }

      case 'assistant': {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            this.emit({ kind: 'assistant_text', text: block.text });
          } else if (block.type === 'tool_use') {
            this.emit({
              kind: 'tool_use',
              toolUseId: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        // usage 反映的是这条消息送出前的 prompt 总量,是当前上下文占用
        // 最新近的信号 —— 比等到 result 消息(每轮只有一条)更新得勤。
        const usage = msg.message?.usage;
        if (usage) {
          const inputTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
          this.emit({ kind: 'usage', inputTokens });
        }
        break;
      }

      case 'user': {
        // 工具结果以 user 消息回流
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_result') {
            this.emit({
              kind: 'tool_result',
              toolUseId: block.tool_use_id,
              content: block.content,
              isError: Boolean(block.is_error),
            });
          }
        }
        break;
      }

      case 'result': {
        // contextWindow 只在这里(每轮一条)给出,不在逐条 assistant.usage 里。
        for (const [model, mu] of Object.entries(msg.modelUsage ?? {})) {
          const window = (mu as Record<string, unknown>)?.contextWindow;
          if (typeof window === 'number') this.emit({ kind: 'context_window', model, window });
        }
        this.emit({
          kind: 'turn_end',
          result: typeof msg.result === 'string' ? msg.result : '',
          costUsd: msg.total_cost_usd,
        });
        this.emit({ kind: 'status', state: 'ready' });
        break;
      }
    }
  }

  send(text: string): void {
    if (!this.#proc?.stdin.writable) {
      this.emit({ kind: 'error', message: '会话未就绪,消息未送达' });
      return;
    }
    const msg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    this.#proc.stdin.write(JSON.stringify(msg) + '\n');
    this.emit({ kind: 'status', state: 'busy' });
  }

  interrupt(): void {
    // stream-json 下的中断能力尚未实测确认,先用信号兜底。
    this.#proc?.kill('SIGINT');
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;

    this.#rl?.close();
    if (proc.stdin.writable) proc.stdin.end();

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });

    this.#proc = null;
  }
}
