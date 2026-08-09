/**
 * TmuxTransport —— 在 tmux 里跑原生 claude TUI,后端旁路观察与注入。
 *
 * 相比 StreamJsonTransport:换来原生交互界面、进程存活于后端重启、终端可 attach;
 * 代价是输出需解析转写文件、注入需经 tmux 缓冲区。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watch, type FSWatcher } from 'node:fs';
import { open, writeFile, unlink, readdir, stat, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitterBase, type SessionTransport } from './transport.ts';
import { parseTranscriptLineMulti, encodeProjectDir } from './transcript.ts';

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TmuxOptions {
  cwd: string;
  settingsPath: string;
  sessionName?: string;
  /**
   * 接管已有 pane(如 %3)而非新建会话 —— wrapper 在用户当前 tmux 里就地启动
   * claude 时用它。给定时本类不创建也不销毁会话,只做注入与观察。
   */
  paneId?: string;
  /**
   * 调用方以 `claude --session-id` 指定的会话 ID。给定时直接按它定位转写文件,
   * 不再从目录里猜 —— 同目录并存的两个会话几乎同时创建转写文件,
   * 按 mtime 认领会张冠李戴,批准请求随之路由到错误的会话。
   */
  sessionId?: string;
}

/**
 * 已被认领的转写文件。
 *
 * 同一目录可以并存多个会话(两个 pane 各开一个 claude),它们共用同一个
 * 转写目录。认领若只看「最新 mtime」,两个实例会同时选中同一个文件,
 * 进而上报同一个 session_id —— 后端的 claudeId→localId 映射被后者覆盖,
 * 批准请求就会路由到错误的会话(网页上批准 A,实际放行 B)。
 * 故认领必须全局排他。
 */
const claimedTranscripts = new Set<string>();

export class TmuxTransport extends EventEmitterBase implements SessionTransport {
  #opts: TmuxOptions;
  #tmuxName: string;
  #sessionId: string | null = null;
  #transcriptPath: string | null = null;
  #watcher: FSWatcher | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #offset = 0;
  #buf = '';
  #seenUuids = new Set<string>();
  #title: string | null = null;
  #stopped = false;

  constructor(opts: TmuxOptions) {
    super();
    this.#opts = opts;
    this.#tmuxName = opts.sessionName ?? `synapse_${randomUUID().slice(0, 8)}`;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** wrapper CLI 用它 attach。 */
  get tmuxName(): string {
    return this.#tmuxName;
  }

  /** tmux 命令的目标:接管模式下是 pane,自建模式下是会话名。 */
  get #target(): string {
    return this.#opts.paneId ?? this.#tmuxName;
  }

  /**
   * 预置信任标记,免除启动时的工作区信任对话框。
   *
   * 钩子无法处理此事:信任发生在钩子加载之前(要先信任目录才会读取其
   * settings.local.json)。这是代用户作出的安全决定,故仅对显式指定的目录执行。
   * 返回 true 表示本次新写入,调用方应告知用户。
   */
  static async ensureTrusted(cwd: string): Promise<boolean> {
    const path = join(homedir(), '.claude.json');
    try {
      const cfg = JSON.parse(await readFile(path, 'utf8'));
      cfg.projects ??= {};
      cfg.projects[cwd] ??= {};
      if (cfg.projects[cwd].hasTrustDialogAccepted === true) return false;

      cfg.projects[cwd].hasTrustDialogAccepted = true;
      // 原子替换,避免与运行中的 claude 争写
      const tmp = `${path}.synapse-${randomUUID().slice(0, 8)}`;
      await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      await rename(tmp, path);
      return true;
    } catch {
      return false;  // 不可读写时退回 waitReady 兜底
    }
  }

  async start(): Promise<void> {
    this.emit({ kind: 'status', state: 'starting' });
    await TmuxTransport.ensureTrusted(this.#opts.cwd);

    // 接管模式:claude 由 CLI 在用户自己的 pane 里启动,这里只等它就绪并开始观察
    if (this.#opts.paneId) {
      await this.#waitReady();
      this.#discoverTranscript();
      this.emit({ kind: 'status', state: 'ready' });
      return;
    }

    if (!(await this.#sessionExists())) {
      await exec('tmux', [
        'new-session', '-d',
        '-s', this.#tmuxName,
        '-x', '200', '-y', '50',
        '-c', this.#opts.cwd,
        'claude', '--settings', this.#opts.settingsPath,
      ]);
      await sleep(2500);  // 等首屏渲染,否则 capture 拿到空屏
      await this.#describe();
    }

    await this.#waitReady();
    this.#discoverTranscript();
    this.emit({ kind: 'status', state: 'ready' });
  }

  /** 等 TUI 可输入。启动路径上可能先出现欢迎屏或信任对话框,都发 Enter 推进。 */
  async #waitReady(timeoutMs = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let nudged = 0;

    while (Date.now() < deadline) {
      const screen = await this.capture();

      // 信任对话框的选项前也带 ❯,必须在就绪判断之前识别,
      // 否则提示词会被粘进对话框而丢失。
      if (/trust this folder|trust the files|Security guide/i.test(screen)) {
        await exec('tmux', ['send-keys', '-t', this.#target, 'Enter']).catch(() => {});
        await sleep(2000);
        continue;
      }

      if (/❯\s*(Try "|$)/m.test(screen) || /❯\s*$/m.test(screen.trimEnd())) return;

      if (nudged < 3 && /Welcome back|Tips for getting started/i.test(screen)) {
        await exec('tmux', ['send-keys', '-t', this.#target, 'Enter']).catch(() => {});
        nudged++;
      }

      await sleep(1000);
    }

    this.emit({ kind: 'error', message: 'TUI 启动超时 —— 可能需手动处理(登录或信任提示)' });
  }

  /** 状态栏标明身份与退出方式,否则 attach 进来看不出这是什么会话。 */
  async #describe(): Promise<void> {
    const set = (k: string, v: string) =>
      exec('tmux', ['set-option', '-t', this.#tmuxName, k, v]).catch(() => {});

    await set('status', 'on');
    await set('status-style', 'bg=colour24,fg=colour255');
    await set('status-left', ` synapse · ${this.#opts.cwd.split('/').pop() ?? ''} `);
    await set('status-left-length', '40');
    await set('status-right', 'Ctrl-b d 脱离(会话继续) · 网页端可同步查看与批准');
    await set('status-right-length', '80');
    await exec('tmux', ['rename-window', '-t', this.#tmuxName, 'claude']).catch(() => {});
  }

  async #sessionExists(): Promise<boolean> {
    try {
      await exec('tmux', ['has-session', '-t', this.#tmuxName]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 承载体是否还在。用户关掉 pane 或 kill 会话后,会话记录会变成僵尸,
   * 需要据此摘除。has-session 对 pane ID 不适用,故按模式分别查。
   */
  async alive(): Promise<boolean> {
    const pane = this.#opts.paneId;
    if (!pane) return this.#sessionExists();
    try {
      const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{pane_id}']);
      return stdout.split('\n').includes(pane);
    } catch {
      return false;
    }
  }

  /**
   * 定位转写文件。
   *
   * 调用方指定了 sessionId 时路径是确定的,只需等文件出现(首轮对话后才建)。
   * 否则退回按 mtime 认领 —— 仅在自建会话模式下可靠,同目录并存时会认错。
   */
  #discoverTranscript(): void {
    const dir = join(homedir(), '.claude', 'projects', encodeProjectDir(this.#opts.cwd));
    const startedAt = Date.now();

    const known = this.#opts.sessionId;
    if (known) {
      this.#sessionId = known;
      this.emit({ kind: 'session', sessionId: known });

      const path = join(dir, `${known}.jsonl`);
      const waitFile = async () => {
        if (this.#stopped || this.#transcriptPath) return;
        try {
          await stat(path);
          claimedTranscripts.add(path);
          this.#transcriptPath = path;
          this.#startTailing();
          return;
        } catch {
          // 首轮对话前不存在
        }
        this.#pollTimer = setTimeout(waitFile, 1000);
      };
      void waitFile();
      return;
    }

    const tick = async () => {
      if (this.#stopped || this.#transcriptPath) return;
      try {
        let newest: { path: string; mtime: number } | null = null;
        for (const f of await readdir(dir)) {
          if (!f.endsWith('.jsonl')) continue;
          const p = join(dir, f);
          if (claimedTranscripts.has(p)) continue;  // 已归属其他会话
          const s = await stat(p);
          if (s.mtimeMs < startedAt - 5000) continue;  // 排除旧会话
          if (!newest || s.mtimeMs > newest.mtime) newest = { path: p, mtime: s.mtimeMs };
        }
        if (newest) {
          claimedTranscripts.add(newest.path);
          this.#transcriptPath = newest.path;
          this.#sessionId = newest.path.split('/').pop()!.replace('.jsonl', '');
          this.emit({ kind: 'session', sessionId: this.#sessionId });
          this.#startTailing();
          return;
        }
      } catch {
        // 目录首轮对话前不存在
      }
      this.#pollTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  #startTailing(): void {
    const path = this.#transcriptPath!;
    const pump = () => { void this.#readNew(path); };

    try {
      this.#watcher = watch(path, pump);
    } catch {
      // 退化为纯轮询
    }
    this.#pollTimer = setInterval(pump, 1200);  // watch 会漏事件,补轮询
    pump();
  }

  async #readNew(path: string): Promise<void> {
    let fh;
    try {
      fh = await open(path, 'r');
      const s = await fh.stat();
      if (s.size <= this.#offset) return;

      const buf = Buffer.alloc(s.size - this.#offset);
      await fh.read(buf, 0, buf.length, this.#offset);
      this.#offset = s.size;

      this.#buf += buf.toString('utf8');
      const lines = this.#buf.split('\n');
      this.#buf = lines.pop() ?? '';  // 末行可能截断

      for (const line of lines) {
        if (line.trim()) this.#handleLine(line);
      }
    } catch {
      // 短暂不可读,下个 tick 重试
    } finally {
      await fh?.close();
    }
  }

  /** 解析规则见 backend/transcript.ts(与历史重放共用);这里只管跨行去重与事件下发。 */
  #handleLine(line: string): void {
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }

    if (d.uuid) {
      if (this.#seenUuids.has(d.uuid)) return;  // watch 抖动会重复读
      this.#seenUuids.add(d.uuid);
    }

    for (const ev of parseTranscriptLineMulti(line, this.#title)) {
      if (ev.kind === 'title') this.#title = ev.title;
      this.emit(ev);
      if (ev.kind === 'turn_end') this.emit({ kind: 'status', state: 'ready' });
    }
  }

  send(text: string): void {
    void this.#inject(text);
  }

  async #inject(text: string): Promise<void> {
    const tmp = join(tmpdir(), `synapse_ipc_${randomUUID()}.txt`);
    const bufName = `synapse_${randomUUID().slice(0, 8)}`;
    const keys = (k: string) =>
      exec('tmux', ['send-keys', '-t', this.#target, k]);

    try {
      await this.#waitReady(20_000);
      await keys('C-u').catch(() => {});  // 清掉上次失败注入的残留
      await sleep(150);

      await writeFile(tmp, text, { mode: 0o600 });  // 提示词可能含敏感内容
      await exec('tmux', ['load-buffer', '-b', bufName, tmp]);
      await exec('tmux', ['paste-buffer', '-b', bufName, '-t', this.#target]);
      await sleep(300);
      await keys('Enter');  // 必须与 paste 分开,合并调用不可靠
      this.emit({ kind: 'status', state: 'busy' });
    } catch (err) {
      this.emit({ kind: 'error', message: `注入失败: ${String(err)}` });
    } finally {
      await unlink(tmp).catch(() => {});
      await exec('tmux', ['delete-buffer', '-b', bufName]).catch(() => {});
    }
  }

  interrupt(): void {
    void exec('tmux', ['send-keys', '-t', this.#target, 'Escape']).catch(() => {});
  }

  /** 屏幕内容,供网页显示终端镜像。 */
  async capture(): Promise<string> {
    try {
      const { stdout } = await exec('tmux', ['capture-pane', '-t', this.#target, '-p']);
      return stdout;
    } catch {
      return '';
    }
  }

  /** 默认保留 tmux 会话 —— 存活于后端重启正是选它的理由。 */
  async stop(killSession = false): Promise<void> {
    this.#stopped = true;
    this.#watcher?.close();
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#watcher = null;
    this.#pollTimer = null;
    if (this.#transcriptPath) claimedTranscripts.delete(this.#transcriptPath);

    // 接管模式下 pane 属于用户,任何情况都不能由本类销毁
    if (killSession && !this.#opts.paneId) {
      await exec('tmux', ['kill-session', '-t', this.#tmuxName]).catch(() => {});
      this.emit({ kind: 'status', state: 'exited' });
    }
  }
}
