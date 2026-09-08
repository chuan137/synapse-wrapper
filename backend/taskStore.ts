/**
 * 任务管理存储 —— 项目 / 任务 / agent 绑定 / 任务流事件,独立于 SessionManager。
 *
 * SessionManager 只管会话生命周期;这里通过 localId / claudeId 单向引用会话,
 * 不往 Session 塞业务字段(见 docs/spec.md §1.1)。
 *
 * 落盘 <数据目录>/tasks.json,和 sessions.json 同目录(见 spec §1.4)。
 * 数据目录默认 ~/.synapse,SYNAPSE_DATA_DIR 覆盖;单测直接给构造函数传路径,
 * SYNAPSE_TASKS_PATH 是更细一层的独立覆盖(只挪 tasks.json)。
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SYNAPSE_DIR } from './daemon.ts';

export type TaskStatus = 'todo' | 'running' | 'waiting' | 'blocked' | 'done' | 'archived';
export type TaskPriority = 'low' | 'normal' | 'high';
export type AgentRole = 'main' | 'sub';
export type AgentTransportKind = 'tmux' | 'stream-json';

export type TaskEventKind =
  | 'task_created'
  | 'task_updated'
  | 'task_status_changed'
  | 'agent_attached'
  | 'agent_detached'
  | 'agent_started'
  | 'approval_requested'
  | 'approval_resolved'
  | 'turn_completed'
  | 'agent_exited';

export interface Project {
  id: string;
  name: string;
  workspaceRoots: string[];
  goal: string;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  priority: TaskPriority;
  acceptance: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface AgentBinding {
  id: string;
  taskId: string;
  localId: string;
  claudeId: string | null;
  role: AgentRole;
  transportKind: AgentTransportKind;
  createdAt: number;
  endedAt: number | null;
  /**
   * 子 agent 隔离用的 git worktree 绝对路径(`synapse agent spawn --worktree`,
   * spec §1.3 的薄版本)。解绑 / 归档时据此 `git worktree remove`。直接进主
   * 工作区的 agent 为 null。
   */
  worktreePath: string | null;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  agentBindingId: string | null;
  kind: TaskEventKind;
  message: string;
  data: unknown;
  createdAt: number;
  // store 级单调递增序号。createdAt 是毫秒戳,并发 append 会撞;poll --since
  // 要靠一个严格递增、不回退的游标切分「已见 / 未见」,那必须是 seq 不是时间。
  seq: number;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  goal?: string;
  acceptance?: string;
  priority?: TaskPriority;
}

export interface TaskPatch {
  title?: string;
  goal?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  acceptance?: string;
  archivedAt?: number | null;
}

export interface AttachAgentInput {
  taskId: string;
  localId: string;
  claudeId?: string | null;
  role: AgentRole;
  transportKind: AgentTransportKind;
  /**
   * 预生成的 binding id。主 agent 启动时 daemon 要把 binding id 作为
   * SYNAPSE_AGENT_BINDING 注入 claude 进程环境,而进程在 attachAgent 之前
   * 就已 spawn —— 调用方先生成 id、注入、再带着同一个 id attach。
   */
  id?: string;
  /** 子 agent 隔离 worktree 的路径,见 AgentBinding.worktreePath。 */
  worktreePath?: string | null;
}

export interface AppendTaskEventInput {
  taskId: string;
  agentBindingId?: string | null;
  kind: TaskEventKind;
  message: string;
  data?: unknown;
}

interface TasksFile {
  version: 1;
  projects: Project[];
  tasks: Task[];
  agentBindings: AgentBinding[];
  events: TaskEvent[];
  // 已发过的最大事件 seq。落盘,重启后 append 从这里续,不从 events 长度推
  // (事件将来可能裁剪 / 归档,长度会缩,seq 不能跟着回退)。
  eventSeq: number;
}

function emptyFile(): TasksFile {
  return { version: 1, projects: [], tasks: [], agentBindings: [], events: [], eventSeq: 0 };
}

/** 默认路径:SYNAPSE_TASKS_PATH 优先(测试隔离用),否则 <数据目录>/tasks.json。 */
export function tasksPath(): string {
  return process.env.SYNAPSE_TASKS_PATH || join(SYNAPSE_DIR, 'tasks.json');
}

export class TaskStore {
  #path: string;
  #data: TasksFile;
  // 写入串行化 —— 公开方法同步改内存,#save 把落盘接到这条链尾,保证并发写不交错。
  #saveChain: Promise<void> = Promise.resolve();

  constructor(path: string = tasksPath()) {
    this.#path = path;
    this.#data = this.#load();
  }

  #load(): TasksFile {
    if (!existsSync(this.#path)) return emptyFile();
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch (e) {
      console.error(`[taskStore] 读取 ${this.#path} 失败:`, e);
      return emptyFile();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TasksFile>;
      const events = parsed.events ?? [];
      return {
        version: 1,
        projects: parsed.projects ?? [],
        tasks: parsed.tasks ?? [],
        // 旧 binding 没有 worktreePath 字段 —— 补 null(它们没走 --worktree)。
        agentBindings: (parsed.agentBindings ?? []).map((b) => ({
          ...b,
          worktreePath: b.worktreePath ?? null,
        })),
        events,
        // 旧文件没有 eventSeq —— 从已有事件的最大 seq 恢复(升级前的事件没 seq
        // 字段,按 0 计);之后每次 append 都 +1 并落盘,不再回落到这条路径。
        eventSeq: parsed.eventSeq ?? events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0),
      };
    } catch {
      // 不静默覆盖:损坏文件留一份现场,再新建空结构继续跑。
      const corruptPath = `${this.#path}.corrupt-${Date.now()}`;
      try {
        renameSync(this.#path, corruptPath);
        console.error(`[taskStore] ${this.#path} 解析失败,已保留为 ${corruptPath},新建空结构`);
      } catch (e) {
        console.error(`[taskStore] ${this.#path} 解析失败且无法改名:`, e);
      }
      return emptyFile();
    }
  }

  #save(): void {
    const snapshot = JSON.stringify(this.#data, null, 2);
    this.#saveChain = this.#saveChain.then(() => {
      try {
        mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
        const tmp = `${this.#path}.tmp`;
        writeFileSync(tmp, snapshot, { mode: 0o600 });
        renameSync(tmp, this.#path);
      } catch (e) {
        console.error(`[taskStore] 写入 ${this.#path} 失败:`, e);
      }
    });
  }

  /** 等所有已排队的写入落盘 —— 测试与关停前用。 */
  flush(): Promise<void> {
    return this.#saveChain;
  }

  // --- Project ---

  listProjects(): Project[] {
    return this.#data.projects.slice();
  }

  getProject(projectId: string): Project | undefined {
    return this.#data.projects.find((p) => p.id === projectId);
  }

  /** 按绝对路径精确匹配已有 project 的 workspaceRoots,命中即返回,否则新建。 */
  ensureProjectForWorkspace(workspace: string): Project {
    const abs = resolve(workspace);
    const hit = this.#data.projects.find((p) => p.workspaceRoots.includes(abs));
    if (hit) return hit;
    const now = Date.now();
    const project: Project = {
      id: randomUUID(),
      name: basename(abs),
      workspaceRoots: [abs],
      goal: '',
      createdAt: now,
      updatedAt: now,
    };
    this.#data.projects.push(project);
    this.#save();
    return project;
  }

  // --- Task ---

  listTasks(projectId: string, opts?: { includeArchived?: boolean }): Task[] {
    return this.#data.tasks.filter(
      (t) => t.projectId === projectId && (opts?.includeArchived || t.status !== 'archived'),
    );
  }

  getTask(taskId: string): Task | undefined {
    return this.#data.tasks.find((t) => t.id === taskId);
  }

  createTask(input: CreateTaskInput): Task {
    if (!this.getProject(input.projectId)) {
      throw new Error(`project ${input.projectId} 不存在`);
    }
    if (!input.title?.trim()) throw new Error('title 必填');
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      goal: input.goal ?? '',
      status: 'todo',
      priority: input.priority ?? 'normal',
      acceptance: input.acceptance ?? '',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.#data.tasks.push(task);
    this.#save();
    return task;
  }

  updateTask(taskId: string, patch: TaskPatch): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task ${taskId} 不存在`);
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.goal !== undefined) task.goal = patch.goal;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.priority !== undefined) task.priority = patch.priority;
    if (patch.acceptance !== undefined) task.acceptance = patch.acceptance;
    if (patch.archivedAt !== undefined) task.archivedAt = patch.archivedAt;
    task.updatedAt = Date.now();
    this.#save();
    return task;
  }

  // --- AgentBinding ---

  listBindings(taskId: string): AgentBinding[] {
    return this.#data.agentBindings.filter((b) => b.taskId === taskId);
  }

  getBinding(bindingId: string): AgentBinding | undefined {
    return this.#data.agentBindings.find((b) => b.id === bindingId);
  }

  /** 该会话当前的 active 绑定(endedAt === null),任意 task。 */
  bindingForSession(localId: string): AgentBinding | undefined {
    return this.#data.agentBindings.find((b) => b.localId === localId && b.endedAt === null);
  }

  attachAgent(input: AttachAgentInput): AgentBinding {
    if (!this.getTask(input.taskId)) throw new Error(`task ${input.taskId} 不存在`);
    // 一个会话 Phase 1 只能绑一个 active task —— 否则 UI 与事件归属会串。
    const existing = this.bindingForSession(input.localId);
    if (existing) {
      throw new Error(`会话 ${input.localId} 已绑定到 task ${existing.taskId}`);
    }
    const now = Date.now();
    if (input.role === 'main') {
      // 一个 task 最多一个 active main binding —— 先结束旧的。
      for (const b of this.#data.agentBindings) {
        if (b.taskId === input.taskId && b.role === 'main' && b.endedAt === null) {
          b.endedAt = now;
        }
      }
    }
    if (input.id && this.getBinding(input.id)) {
      throw new Error(`binding ${input.id} 已存在`);
    }
    const binding: AgentBinding = {
      id: input.id ?? randomUUID(),
      taskId: input.taskId,
      localId: input.localId,
      claudeId: input.claudeId ?? null,
      role: input.role,
      transportKind: input.transportKind,
      createdAt: now,
      endedAt: null,
      worktreePath: input.worktreePath ?? null,
    };
    this.#data.agentBindings.push(binding);
    this.#save();
    return binding;
  }

  /** 只设 endedAt —— 不动底层会话(见 docs/phase1-task-management.md)。 */
  detachAgent(bindingId: string): void {
    const binding = this.getBinding(bindingId);
    if (!binding) throw new Error(`binding ${bindingId} 不存在`);
    if (binding.endedAt === null) binding.endedAt = Date.now();
    this.#save();
  }

  // --- TaskEvent ---

  appendEvent(input: AppendTaskEventInput): TaskEvent {
    const event: TaskEvent = {
      id: randomUUID(),
      taskId: input.taskId,
      agentBindingId: input.agentBindingId ?? null,
      kind: input.kind,
      message: input.message,
      data: input.data ?? null,
      createdAt: Date.now(),
      seq: ++this.#data.eventSeq,
    };
    this.#data.events.push(event);
    this.#save();
    return event;
  }

  listEvents(taskId: string): TaskEvent[] {
    return this.#data.events.filter((e) => e.taskId === taskId);
  }

  /**
   * 某 binding 自 `sinceSeq`(不含)以来的事件,按 seq 升序。poll --since 的后端。
   * sinceSeq 省略 → 从头。
   */
  eventsForBinding(bindingId: string, sinceSeq = 0): TaskEvent[] {
    return this.#data.events
      .filter((e) => e.agentBindingId === bindingId && e.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq);
  }
}
