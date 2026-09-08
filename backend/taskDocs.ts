/**
 * 主 agent 的交接文档 —— `synapse-tasks` 独立 git repo,落地顺序第 7 步(见
 * docs/design/main-agent-orchestration.md「任务共享文档库」)。
 *
 * 这是 task memory bank,不是用户项目的 docs/:存的是过程记录(某次用主 agent
 * 干这个任务时怎么拆的、子 agent 交了什么),不是设计事实。独立放
 * `~/gb/synapse-tasks`(`SYNAPSE_TASKS_REPO` 覆盖,测试用),不埋进
 * `~/.synapse/` —— 那里全是不进 git 的 daemon 运行时状态,混一个 git repo 进去
 * 徒增困惑。
 *
 * 主 agent 没有 Write/Edit(受限 settings,daemon.ts writeMainAgentSettings),
 * 读写这个 repo 只能经这里暴露的函数(`synapse agent doc` 的后端)—— 内容经
 * `:kind` 白名单校验、路径由 taskId(UUID)+ slug 拼出不可穿越,commit 消息统一。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Project, Task } from './taskStore.ts';

const exec = promisify(execFile);

export type DocKind = 'handoff' | 'progress' | 'changelog';
export const DOC_KINDS: readonly DocKind[] = ['handoff', 'progress', 'changelog'];

/** repo 根路径:SYNAPSE_TASKS_REPO 覆盖(测试隔离用),默认 ~/gb/synapse-tasks。 */
export function tasksRepoRoot(): string {
  return process.env.SYNAPSE_TASKS_REPO
    ? resolve(process.env.SYNAPSE_TASKS_REPO)
    : join(homedir(), 'gb', 'synapse-tasks');
}

/**
 * Project.name → 目录名安全化。与 server.ts 的 projectSlug 同规则(空白转 -、
 * 去掉路径分隔符与开头的点)—— 两处都是「把自由文本变成路径片段」,规则理应一致,
 * 但各自只依赖自己模块的类型,不额外建一个共享工具模块来传一个纯函数。
 */
function projectSlug(name: string | undefined): string {
  const s = (name ?? 'project').replace(/[/\\]+/g, '-').replace(/\s+/g, '-').replace(/^\.+/, '');
  return s || 'project';
}

function taskDir(project: Project | undefined, taskId: string): string {
  return join(tasksRepoRoot(), 'projects', projectSlug(project?.name), taskId);
}

function docPath(project: Project | undefined, taskId: string, kind: DocKind): string {
  return join(taskDir(project, taskId), `${kind}.md`);
}

const CLAUDE_MD = `# synapse-tasks

这个 repo 是 Synapse 主 agent 的任务记忆库(task memory bank)—— 一个主 agent 经
\`synapse agent doc\` 间接读写,人和子 agent 只读。不取代用户项目自己的 \`docs/\`
(那是设计事实),这里存的是**过程记录**:某次用主 agent 干一个任务时怎么拆的、
子 agent 交了什么。

## 目录结构

\`\`\`
projects/<project-slug>/<taskId>/
  handoff.md    目标 / work dir / 验收 / 子任务拆解。子 agent spawn 时拼进首轮 prompt。
  progress.md   进度快照,主 agent 每次子 agent 返回后更新。
  changelog.md  变更记录,append-only,一条对应一个子 agent 的产出。
\`\`\`

三个文件各有一段渲染标记区:

\`\`\`
<!-- synapse:begin state -->
（Synapse 后端从事件日志渲染,不要手写)
<!-- synapse:end -->
\`\`\`

标记区**内**由 Synapse 后端(\`backend/taskDocs.ts\` 的 \`renderState\`)维护;标记区
**外**是主 agent 写的人类叙述,格式建议见 \`.claude/skills/synapse-handoff/SKILL.md\`。

## 何时 commit

每次 \`synapse agent doc\` 写入(\`handoff\`/\`progress\` 整体替换,\`changelog\` 追加)
后自动 \`git add\` + \`git commit\`,提交消息 \`task <id 前 8 位>: <kind>\`。不 push ——
本机单用户场景先不引入远端,需要分享时手动 push。
`;

const SKILL_MD = `---
name: synapse-handoff
description: >-
  写或更新 Synapse 任务的 handoff.md / progress.md / changelog.md 时加载。
  给出三个文件的推荐结构和字段归属。项目自己的 CLAUDE.md 可以改写这里的建议。
---

# Synapse 交接文档的写法

你是任务的主 agent。这三个文件是你的调度记录,也是子 agent 的输入和用户的进度窗口。
只经 \`synapse agent doc <kind>\` 读写 —— 不直接编辑文件,不碰 git。

\`<!-- synapse:begin state --> … <!-- synapse:end -->\` 之间由后端渲染,**不要手写**,
你写的内容一律在标记区外。

## handoff.md —— 子任务分派的依据

子 agent \`spawn\` 时,它这一段会拼进子 agent 的首轮 prompt。写给子 agent 看,不是写给用户。

- **目标** —— 一段话。这个任务做完是什么样。从 Task.goal 起草,按你的理解补全。
- **work dir** —— 子 agent 该在哪个目录工作。多个子任务涉及不同目录就在子任务里分别标。
- **验收** —— 可检验的条目。子 agent 拿这个判断自己做完没。
- **子任务** —— 编号列表。每条:一句话描述 + work dir(若与上面不同)+ 依赖哪条先完成。
  一条子任务对应一次 \`synapse agent spawn\`。
- **约束 / 上下文** —— 子 agent 不看代码就不知道的前提(接口不能改、某文件是生成的…)。

项目的 CLAUDE.md 若要求额外 section(风险登记、依赖图…),照它的。

## progress.md —— 每次子 agent 返回后更新

标记区内是后端渲染的量。你在标记区外写:

- **当前状态** —— 一句话。整个任务推进到哪。
- **最近一轮** —— 上一个返回的子 agent 做了什么、结论是什么、你据此决定下一步做什么。
- **阻塞** —— 卡在什么上。没有就写「无」。
- **下一步** —— 你接下来要 spawn 什么,或在等什么。

## changelog.md —— append-only,一条一个子 agent 产出

\`synapse agent doc changelog\` 是追加。每条:

- 哪个子 agent(binding 前缀)、做了什么、改了哪些文件、怎么验证的、剩余风险。
- 子 agent 异常退出没产出也记一条,写明「未完成」和你的处置(重试 / 换策略 / 搁置)。

不写流水账 —— 一条对应一次有意义的交付,不是每个 turn 一条。
`;

const STATE_BEGIN = '<!-- synapse:begin state -->';
const STATE_END = '<!-- synapse:end -->';

/**
 * 新文件的初始内容:空标记区 + 骨架叙述段。标记区留空 —— 渲染逻辑
 * (`renderState`,从 TaskStore 事件日志派生子 agent 数/turn 数/耗时等)是
 * 落地顺序第 8 步,这里先钉死通道与格式,不早填内容。
 */
function skeleton(kind: DocKind, task: Task): string {
  const title = kind === 'handoff' ? '# Handoff' : kind === 'progress' ? '# Progress' : '# Changelog';
  const seed =
    kind === 'handoff'
      ? `\n## 目标\n\n${task.goal || '(未填写)'}\n\n## 验收\n\n${task.acceptance || '(未填写)'}\n`
      : '\n';
  return `${title}\n\n${STATE_BEGIN}\n${STATE_END}\n${seed}`;
}

async function git(repoRoot: string, args: string[]): Promise<void> {
  await exec('git', ['-C', repoRoot, ...args], { timeout: 10_000 });
}

/** repo 不存在则 `git init` + 落 CLAUDE.md + skill 初版。之后这两份归 repo 自己维护,不再覆盖。 */
async function ensureRepo(repoRoot: string): Promise<void> {
  if (existsSync(join(repoRoot, '.git'))) return;
  mkdirSync(repoRoot, { recursive: true, mode: 0o700 });
  await exec('git', ['init', repoRoot], { timeout: 10_000 });
  writeFileSync(join(repoRoot, 'CLAUDE.md'), CLAUDE_MD);
  const skillDir = join(repoRoot, '.claude', 'skills', 'synapse-handoff');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL_MD);
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-m', 'init synapse-tasks']).catch(() => {
    // 用户机器上 git 未配置 user.name/email 时 commit 会失败 —— repo 已经建好、
    // 文件已经落盘,只是没提交上;后续读写仍能工作,下次写入会带上这次的改动一起提交。
  });
}

/**
 * 起主 agent 前调用 —— `claude --add-dir <synapse-tasks 路径>` 要求目录已存在,
 * 不能等第一次 `synapse agent doc` 写入才 `git init`(那会在主 agent 已经带着
 * `--add-dir` 启动之后才发生,太晚)。幂等,repo 已存在直接返回。
 */
export async function ensureTasksRepo(): Promise<string> {
  const repoRoot = tasksRepoRoot();
  await ensureRepo(repoRoot);
  return repoRoot;
}

/** 读一个文档,不存在则返回按任务字段生成的骨架(不落盘 —— 落盘等第一次 PUT/POST)。 */
export function readDoc(project: Project | undefined, task: Task, kind: DocKind): string {
  const path = docPath(project, task.id, kind);
  if (existsSync(path)) return readFileSync(path, 'utf8');
  return skeleton(kind, task);
}

/**
 * 整体替换 handoff / progress 的标记区外内容(标记区由 renderState 单独维护)。
 * 首次写入前 ensureRepo,写完 commit。
 */
export async function writeDoc(
  project: Project | undefined,
  task: Task,
  kind: 'handoff' | 'progress',
  body: string,
): Promise<void> {
  const repoRoot = tasksRepoRoot();
  await ensureRepo(repoRoot);
  const dir = taskDir(project, task.id);
  mkdirSync(dir, { recursive: true });
  const path = docPath(project, task.id, kind);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : skeleton(kind, task);
  writeFileSync(path, replaceOutsideMarkers(existing, body));
  await commitDoc(repoRoot, task.id, kind);
}

/** changelog 是 append-only —— 新增一段,不覆盖已有内容。 */
export async function appendChangelog(
  project: Project | undefined,
  task: Task,
  entry: string,
): Promise<void> {
  const repoRoot = tasksRepoRoot();
  await ensureRepo(repoRoot);
  const dir = taskDir(project, task.id);
  mkdirSync(dir, { recursive: true });
  const path = docPath(project, task.id, 'changelog');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : skeleton('changelog', task);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  writeFileSync(path, `${existing.trimEnd()}\n\n### ${stamp}\n\n${entry.trim()}\n`);
  await commitDoc(repoRoot, task.id, 'changelog');
}

async function commitDoc(repoRoot: string, taskId: string, kind: DocKind): Promise<void> {
  await git(repoRoot, ['add', '-A']);
  await git(repoRoot, ['commit', '-m', `task ${taskId.slice(0, 8)}: ${kind}`]).catch(() => {
    // 无改动(内容与上次写入完全相同)commit 会失败 —— 不是错误,静默跳过。
  });
}

/**
 * 把 body 塞进标记区外,标记区本身原样保留(内容留给 renderState 单独刷新)。
 * 没有标记区(异常情况,如文件被手动改坏)则整个追加在末尾,不丢用户原内容。
 */
function replaceOutsideMarkers(existing: string, body: string): string {
  const begin = existing.indexOf(STATE_BEGIN);
  const end = existing.indexOf(STATE_END);
  if (begin === -1 || end === -1 || end < begin) {
    return `${existing.trimEnd()}\n\n${body.trim()}\n`;
  }
  const marker = existing.slice(begin, end + STATE_END.length);
  return `${marker}\n\n${body.trim()}\n`;
}

/** 路径不穿越校验:taskId 必须是拼出的 taskDir 的直接子目录,防主 agent 传入的畸形 id。 */
export function isSafeTaskDir(project: Project | undefined, taskId: string): boolean {
  const dir = resolve(taskDir(project, taskId));
  const root = resolve(join(tasksRepoRoot(), 'projects', projectSlug(project?.name)));
  return dir === join(root, taskId) && dirname(dir) === root;
}
