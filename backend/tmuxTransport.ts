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

/**
 * 网页 textarea 的 Shift+Enter 换行是 `\n`,claude TUI 收到粘贴内容后
 * 落盘到转写文件时把内部换行写成了 `\r`(实测,见 spec §2.18)—— 回显比对
 * 前先归一化,否则精确字符串匹配因换行符不同而永远不命中。
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * 指定 pane 是否还在 tmux 里。独立于任何 TmuxTransport 实例 —— 后端重启后
 * 重新加载持久化会话时,要先判断值不值得重建 TmuxTransport,此时实例还不存在。
 */
export async function paneExists(paneId: string): Promise<boolean> {
  try {
    const { stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{pane_id}']);
    return stdout.split('\n').includes(paneId);
  } catch {
    return false;
  }
}

/**
 * 反查每个 pane 里正在跑的 claude 进程,取其 --session-id。
 *
 * 兜底手段:PersistedSession.paneId 字段是后加的(见 spec §2.16),旧数据落盘
 * 时该字段还不存在,读出来是 undefined。#loadPersisted 光靠磁盘记录补不全
 * 这批历史数据,只能反过来从操作系统当前状态推算 —— pane 的第一层子进程
 * 未必是 claude(wrapper 会先起一层 node 壳再 spawn claude),故用 sessionId
 * 全局定位 claude 进程,再沿 ppid 链向上爬,看落在哪个 pane 的 pane_pid 下。
 */
export async function findClaimedPanes(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const [{ stdout: psOut }, { stdout: paneOut }] = await Promise.all([
      exec('ps', ['-eo', 'pid,ppid,command']),
      exec('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}']),
    ]);

    const panePids = new Map<number, string>();  // pane_pid -> pane_id
    for (const line of paneOut.trim().split('\n')) {
      const [paneId, pidStr] = line.trim().split(/\s+/);
      const pid = Number(pidStr);
      if (paneId && Number.isInteger(pid)) panePids.set(pid, paneId);
    }

    const ppidOf = new Map<number, number>();
    const claudePids: { pid: number; sessionId: string }[] = [];
    for (const line of psOut.trim().split('\n').slice(1)) {  // 首行是表头
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      ppidOf.set(pid, ppid);
      const sidMatch = m[3]!.match(/^claude\b.*--session-id[ =](\S+)/);
      if (sidMatch?.[1]) claudePids.push({ pid, sessionId: sidMatch[1] });
    }

    for (const { pid, sessionId } of claudePids) {
      let cur = pid;
      for (let hops = 0; hops < 20; hops++) {  // 防止 ppid 链异常成环
        const pane = panePids.get(cur);
        if (pane) { result.set(sessionId, pane); break; }
        const next = ppidOf.get(cur);
        if (!next || next === cur) break;
        cur = next;
      }
    }
  } catch {
    // ps/tmux 不可用时返回空表,调用方按"查不到"处理,不影响 #loadPersisted 的默认行为
  }
  return result;
}

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
  /**
   * send() 注入的文本迟早会作为普通 user 行出现在转写文件里 —— 在 tmux
   * 层面它和用户手动敲键盘完全等价,没有字段能区分来源。不去重的话,
   * 网页发的每条消息都会被 #handleLine 当作"终端直接输入"再入一次账,
   * 时间线里同一条消息出现两遍。FIFO 按注入顺序消费,足够应付网页消息
   * 不会乱序抵达转写文件这一前提。
   *
   * 存归一化后的换行(见 #normalizeNewlines):网页 textarea 的 Shift+Enter
   * 换行是 `\n`,但 claude TUI 收到粘贴内容后落盘到转写文件时把内部换行
   * 写成了 `\r`(实测,见 spec §2.18)—— 原样存 `\n` 版本,#handleLine 里
   * 精确 indexOf 比对永远不命中,回显消不掉,网页因此看到重复的两条。
   */
  #pendingEchoes: string[] = [];

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
    let last: Awaited<ReturnType<typeof this.capture>> = { ok: true, screen: '' };

    while (Date.now() < deadline) {
      last = await this.capture();
      if (!last.ok) { await sleep(1000); continue; }
      const screen = last.screen;

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

    // 带上最后一次实际抓到的现场(哪怕是空屏或抓屏失败原因),
    // 否则复现时只有一句笼统提示,无从判断是卡在哪种屏幕状态。
    const evidence = last.ok
      ? `末次屏幕内容:${JSON.stringify(last.screen.slice(0, 500))}`
      : `末次抓屏失败:${last.error}`;
    console.error(`[tmux] #waitReady 超时(target=${this.#target})。${evidence}`);
    this.emit({ kind: 'error', message: `TUI 启动超时 —— 可能需手动处理(登录或信任提示)` });
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
    return paneExists(pane);
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
      if (ev.kind === 'user') {
        const i = this.#pendingEchoes.indexOf(normalizeNewlines(ev.text));
        if (i !== -1) { this.#pendingEchoes.splice(i, 1); continue; }  // send() 自己的回显,调用方已经记过一次
      }
      this.emit(ev);
      if (ev.kind === 'turn_end') this.emit({ kind: 'status', state: 'ready' });
    }
  }

  send(text: string): void {
    this.#pendingEchoes.push(normalizeNewlines(text));
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
      // -p(bracketed paste):不加时 tmux 把 buffer 里的 LF 换成 CR 发给 pane
      // (tmux(1) paste-buffer 的默认行为),claude TUI 把 CR 当提交键处理 ——
      // 多行消息因此被拆成好几轮独立对话,转写文件里多出 queue-operation。
      // -p 告诉已请求 bracketed paste 的应用"这是一次粘贴",内部换行保留
      // 原样,不再触发提交(实测确认,见 spec §2.18)。
      await exec('tmux', ['paste-buffer', '-p', '-b', bufName, '-t', this.#target]);
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

  /** 切到前台 —— 不带 `-c` 默认作用于最近活跃的 client,单终端场景下就是用户那个。 */
  async focus(): Promise<void> {
    await exec('tmux', ['switch-client', '-t', this.#target]).catch(() => {});
  }

  /** 屏幕内容,供网页显示终端镜像。 */
  /**
   * 抓屏失败(target 已消失、tmux 未就绪等)与"屏幕内容为空"必须能区分 ——
   * 混为一谈时 #waitReady 会拿着假的空屏幕死等到超时,报错信息也无从
   * 说明真实原因。调用方按 ok 分支处理,不靠字符串是否为空判断。
   */
  async capture(): Promise<{ ok: true; screen: string } | { ok: false; error: string }> {
    try {
      const { stdout } = await exec('tmux', ['capture-pane', '-t', this.#target, '-p']);
      return { ok: true, screen: stdout };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
