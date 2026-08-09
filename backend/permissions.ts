/**
 * 权限引擎 —— 接收 Claude Code 的 PreToolUse HTTP 钩子,挂起等待网页决策。
 *
 * 实测依据(Claude Code 2.1.226):
 *  - 默认钩子超时约 600s;`timeout` 字段可配置(实测 timeout:10 生效)。
 *  - 超时后行为是 **fail-open**:工具照常执行,permission_denials 为空。
 *  - 延迟响应有效:延迟 6s 返回 deny,工具被成功拦下。
 *
 * 因此本模块【绝不】让钩子请求自然过期:内部截止时间(DECISION_TIMEOUT_MS)
 * 必须短于 settings 里配的 HOOK_TIMEOUT_S,到点主动返回 deny,
 * 把 fail-open 的默认行为翻转成 fail-closed。
 */
import type { Request, Response } from 'express';
import { assessRisk, summarizeInput, type RiskNote } from './risk.ts';

/** 写入 settings 的钩子超时(秒)—— 外层上限。 */
export const HOOK_TIMEOUT_S = 300;

/** 后端自己的决策截止(毫秒)—— 必须短于上面,留出响应回传的余量。 */
export const DECISION_TIMEOUT_MS = 280_000;

export interface PendingApproval {
  toolUseId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  /** 一行摘要:命令原文或文件路径。 */
  summary: string;
  /** 风险说明,无已知风险时为 null。仅辅助判断,非安全保证。 */
  risk: RiskNote | null;
  requestedAt: number;
  /** 内部截止时间戳,UI 用它做倒计时。 */
  deadlineAt: number;
}

export type Decision = 'allow' | 'deny';

interface Waiter {
  info: PendingApproval;
  res: Response;
  timer: NodeJS.Timeout;
  settled: boolean;
}

export type ApprovalListener = (approval: PendingApproval) => void;
export type ResolveListener = (toolUseId: string, decision: Decision, reason: string) => void;
export type SessionEndListener = (sessionId: string, reason: string) => void;

export class PermissionEngine {
  /**
   * 以 tool_use_id 为键 —— 不能只用 session_id。
   * 同一会话可能有多个工具调用并发等待批准,只按会话索引会串。
   */
  #pending = new Map<string, Waiter>();
  #onRequest: ApprovalListener[] = [];
  #onResolve: ResolveListener[] = [];
  #onSessionEnd: SessionEndListener[] = [];

  onApprovalRequested(fn: ApprovalListener): void {
    this.#onRequest.push(fn);
  }

  onApprovalResolved(fn: ResolveListener): void {
    this.#onResolve.push(fn);
  }

  onSessionEnd(fn: SessionEndListener): void {
    this.#onSessionEnd.push(fn);
  }

  /** 当前待批准列表(供新连上的网页客户端补齐状态)。可按会话过滤。 */
  listPending(sessionId?: string): PendingApproval[] {
    const all = [...this.#pending.values()].map((w) => w.info);
    const scoped = sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
    // 等待最久的排最前 —— UI 顶层按紧急度呈现
    return scoped.sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** 某会话的待批准数量,供顶层列表显示角标。 */
  countFor(sessionId: string): number {
    let n = 0;
    for (const w of this.#pending.values()) {
      if (w.info.sessionId === sessionId) n++;
    }
    return n;
  }

  /** Express 处理器:PreToolUse 钩子入口。请求会挂起直到有决策。 */
  handleHookRequest = (req: Request, res: Response): void => {
    const body = req.body as Record<string, unknown>;
    const event = String(body.hook_event_name ?? '');

    // 会话退出的唯一可靠信号:转写文件没有结束标记,末行只是它停下时
    // 恰好在做的事(实测见 spec §2.9)。此事件不参与权限,转出后即放行。
    if (event === 'SessionEnd') {
      const sessionId = String(body.session_id ?? '');
      if (sessionId) {
        const why = String(body.reason ?? 'other');
        for (const fn of this.#onSessionEnd) fn(sessionId, why);
      }
      res.json({});
      return;
    }

    // 非 PreToolUse(Stop / Notification 等)不参与权限,立即放行。
    if (event !== 'PreToolUse') {
      res.json({});
      return;
    }

    const toolUseId = String(body.tool_use_id ?? '');
    const sessionId = String(body.session_id ?? '');
    if (!toolUseId) {
      // 没有 tool_use_id 就无法安全配对决策,直接放行而非静默挂起。
      res.json({});
      return;
    }

    const now = Date.now();
    const toolName = String(body.tool_name ?? 'unknown');
    const toolInput = body.tool_input ?? {};
    const info: PendingApproval = {
      toolUseId,
      sessionId,
      toolName,
      toolInput,
      summary: summarizeInput(toolName, toolInput),
      risk: assessRisk(toolName, toolInput),
      requestedAt: now,
      deadlineAt: now + DECISION_TIMEOUT_MS,
    };

    // fail-closed 兜底:到内部截止仍无人决策 -> 主动拒绝。
    // 若放任钩子自然超时,Claude Code 会放行(实测),这正是要避免的。
    const timer = setTimeout(() => {
      this.#settle(toolUseId, 'deny', '超时未获批准(后端 fail-closed 兜底)');
    }, DECISION_TIMEOUT_MS);

    this.#pending.set(toolUseId, { info, res, timer, settled: false });

    // 客户端(Claude Code)提前断开时清理,避免泄漏。
    res.on('close', () => {
      const w = this.#pending.get(toolUseId);
      if (w && !w.settled) {
        clearTimeout(w.timer);
        this.#pending.delete(toolUseId);
      }
    });

    for (const fn of this.#onRequest) fn(info);
  };

  /** 网页点击批准/拒绝时调用。 */
  decide(toolUseId: string, decision: Decision, reason?: string): boolean {
    const fallback = decision === 'allow' ? '用户在网页批准' : '用户在网页拒绝';
    return this.#settle(toolUseId, decision, reason ?? fallback);
  }

  #settle(toolUseId: string, decision: Decision, reason: string): boolean {
    const waiter = this.#pending.get(toolUseId);
    if (!waiter || waiter.settled) return false;

    waiter.settled = true;
    clearTimeout(waiter.timer);
    this.#pending.delete(toolUseId);

    // 这个响应体形状是实测验证过的 —— hookEventName 不可省略。
    waiter.res.json({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    });

    for (const fn of this.#onResolve) fn(toolUseId, decision, reason);
    return true;
  }

  /**
   * 拒绝挂起项,避免连接悬空。
   * 传 sessionId 只清理该会话 —— 单个会话退出不应影响其他会话。
   */
  drain(sessionId?: string): void {
    for (const [id, w] of [...this.#pending.entries()]) {
      if (sessionId && w.info.sessionId !== sessionId) continue;
      this.#settle(id, 'deny', '会话已结束');
    }
  }
}
