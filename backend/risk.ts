/**
 * 危险命令模式识别 —— 为批准界面提供风险说明。
 *
 * 这是【辅助判断】,不是安全保证:规则覆盖不到的危险命令不会被标注。
 * UI 措辞需避免让用户产生「没标红就安全」的错觉。
 */

export interface RiskNote {
  level: 'high' | 'medium';
  /** 给人看的说明,讲清风险在哪,而非复述命令。 */
  text: string;
  /** 命令中需要高亮的片段。 */
  highlight?: string;
}

interface Rule {
  test: RegExp;
  level: RiskNote['level'];
  text: string;
  highlight?: string;
}

const BASH_RULES: Rule[] = [
  {
    test: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
    level: 'high',
    text: '递归删除文件。请确认路径无误 —— 删除不可撤销。',
    highlight: 'rm -rf',
  },
  {
    test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|)sh\b/,
    level: 'high',
    text: '下载并直接执行远程脚本,内容未经审阅。',
  },
  {
    test: /\bsudo\b/,
    level: 'high',
    text: '以管理员权限执行。',
    highlight: 'sudo',
  },
  {
    test: /\bgit\s+push\b[^&|;]*(--force|-f)\b/,
    level: 'high',
    text: '强制推送会覆盖远端历史,可能丢失他人提交。',
    highlight: '--force',
  },
  {
    test: /\bterraform\s+(apply|destroy)\b/,
    level: 'high',
    text: '会直接改动线上基础设施。若带 -auto-approve,还会跳过 terraform 自身的确认步骤。',
  },
  {
    test: /\bkubectl\s+(delete|apply)\b/,
    level: 'high',
    text: '会改动 Kubernetes 集群状态。',
  },
  {
    test: /\bdrop\s+(table|database)\b/i,
    level: 'high',
    text: '删除数据库表或库。',
  },
  {
    test: /\b(npm|yarn|pnpm)\s+publish\b/,
    level: 'high',
    text: '会把包发布到公共仓库,发布后难以撤回。',
  },
  {
    test: /\bgit\s+reset\s+--hard\b/,
    level: 'medium',
    text: '丢弃工作区所有未提交改动。',
    highlight: '--hard',
  },
  {
    test: /\bchmod\s+777\b/,
    level: 'medium',
    text: '将权限放开到任何用户可读写执行。',
  },
  {
    test: />\s*\/dev\/(sd|disk|nvme)/,
    level: 'high',
    text: '直接写入块设备,可能损坏磁盘数据。',
  },
];

/** 涉及敏感路径的写操作。 */
const SENSITIVE_PATH = /(^|\/)\.(ssh|aws|gnupg)\/|(^|\/)\.env(\.|$)|id_rsa|credentials/;

export function assessRisk(toolName: string, toolInput: unknown): RiskNote | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;

  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    for (const rule of BASH_RULES) {
      if (rule.test.test(cmd)) {
        return { level: rule.level, text: rule.text, highlight: rule.highlight };
      }
    }
    return null;
  }

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    if (SENSITIVE_PATH.test(path)) {
      return { level: 'high', text: '写入涉及凭据或密钥的文件。' };
    }
    return null;
  }

  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return { level: 'medium', text: '会向外部网络发起请求。' };
  }

  return null;
}

/** 给 UI 用的一行摘要:命令原文或文件路径。 */
export function summarizeInput(toolName: string, toolInput: unknown): string {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash' && typeof input.command === 'string') return input.command;
  if (toolName === 'AskUserQuestion') return summarizeQuestions(input);
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/** 只显示单行的地方(顶层列表、对话页签)用:第一个问题 + 问题总数。 */
function summarizeQuestions(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const first = questions[0]?.question;
  if (typeof first !== 'string') return 'AskUserQuestion';
  return questions.length > 1 ? `${first}(共 ${questions.length} 个问题)` : first;
}
