/**
 * 转写文件(jsonl)解析 —— 从 TmuxTransport 抽出,供两处复用:
 *   - TmuxTransport 实时 tail 新增行
 *   - 历史会话按需重放整个文件(sessions.json 不存 timeline 副本,
 *     避免同一份对话数据存在两个不同步的来源,见 docs/spec.md)
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SessionEvent } from './transport.ts';

/**
 * cwd -> 转写目录名(/private/tmp/foo -> -private-tmp-foo)。
 * 两种传输方式共用此规则(实测确认 `claude -p --input-format stream-json`
 * 与 tmux 里的原生 TUI 写同一套路径)。
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function transcriptPathFor(workspace: string, claudeId: string): string {
  return join(homedir(), '.claude', 'projects', encodeProjectDir(workspace), `${claudeId}.jsonl`);
}

/**
 * 模型 -> 上下文窗口总量。stream-json 的 result.modelUsage 会给出这个值,
 * 但转写文件里没有对应字段(那条消息只在 `-p` 进程的 stdout 上出现,不落盘)——
 * tmux 路径只能维护这张表(实测值,见 docs/spec.md)。
 */
const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
};

/**
 * 单行 jsonl -> 事件数组(assistant 消息可含多个内容块,故不是单值)。
 * 白名单解析:转写里还有 mode / permission-mode / file-history-snapshot /
 * attachment 等控制行,不应进入 UI。
 *
 * `lastTitle` 用于去重 —— ai-title 行没有 uuid,同一标题会重复写入多次。
 * 调用方持有并传入上一次的值,函数不维护跨行状态。
 */
export function parseTranscriptLineMulti(
  line: string,
  lastTitle: string | null,
): SessionEvent[] {
  let d: Record<string, any>;
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }

  if (d.isSidechain) return [];

  if (d.type === 'assistant') {
    const events: SessionEvent[] = [];
    const model = d.message?.model;
    if (typeof model === 'string') {
      events.push({ kind: 'model', model });
      const window = MODEL_CONTEXT_WINDOW[model];
      if (window) events.push({ kind: 'context_window', model, window });
    }
    const usage = d.message?.usage;
    if (usage) {
      const inputTokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      events.push({ kind: 'usage', inputTokens });
    }
    for (const b of d.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) {
        events.push({ kind: 'assistant_text', text: b.text });
      } else if (b.type === 'tool_use') {
        events.push({ kind: 'tool_use', toolUseId: b.id, name: b.name, input: b.input });
      }
    }
    // stop_reason 是模型自己对本轮的收尾判断:'tool_use' 表示还要接着调用
    // 工具、后面还有更多 assistant 消息属于同一轮;其他值(end_turn 等)
    // 才是这一轮真正说完了。曾经改用转写里的 last-prompt 行近似判断,
    // 实测它标记的是"CLI 回到顶层输入态"而非"这一轮说完",大多数轮次
    // 等不到它,turn_end 永久缺失。stop_reason 每轮必有恰好一条,可靠。
    if (d.message?.stop_reason && d.message.stop_reason !== 'tool_use') {
      events.push({ kind: 'turn_end', result: '' });
    }
    return events;
  }

  if (d.type === 'user') {
    // 用户输入是字符串,工具结果是数组
    const c = d.message?.content;
    if (Array.isArray(c)) {
      const events: SessionEvent[] = [];
      for (const b of c) {
        if (b.type === 'tool_result') {
          events.push({
            kind: 'tool_result',
            toolUseId: b.tool_use_id,
            content: b.content,
            isError: Boolean(b.is_error),
          });
        }
      }
      return events;
    }
    return [];
  }

  if (d.type === 'ai-title') {
    const title = typeof d.aiTitle === 'string' ? d.aiTitle.trim() : '';
    if (title && title !== lastTitle) return [{ kind: 'title', title }];
    return [];
  }

  return [];
}

/**
 * 重放整个转写文件,按行产出事件序列。
 *
 * 用于 exited 会话按需重建 timeline(sessions.json 只存元数据,见
 * docs/spec.md),调用方通常把返回的事件序列喂给与实时 tail 相同的
 * 状态归约逻辑(SessionManager#absorb),以保证两条路径产出一致的结构。
 */
export async function replayTranscript(path: string): Promise<SessionEvent[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }

  const events: SessionEvent[] = [];
  const seenUuids = new Set<string>();
  let lastTitle: string | null = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.uuid) {
      if (seenUuids.has(d.uuid)) continue;
      seenUuids.add(d.uuid);
    }
    const lineEvents = parseTranscriptLineMulti(line, lastTitle);
    for (const ev of lineEvents) {
      if (ev.kind === 'title') lastTitle = ev.title;
      events.push(ev);
    }
  }
  return events;
}
