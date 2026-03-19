/**
 * TaskQueue — JSONL-backed persistent task queue
 *
 * Storage layout:
 *   ~/.openclaw/tasks/
 *     active/                   <- individual task JSON files (flat, by task ID)
 *     queue.jsonl               <- append-only audit log of all task events
 *     activity.jsonl            <- activity ledger (all system events)
 *     suggestions/              <- individual suggestion JSON files
 *
 * Design:
 *   - Individual JSON files for fast reads (no scanning)
 *   - JSONL for append-only audit trail
 *   - In-memory write serialization (single Node.js process)
 *   - Status transition validation
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { invalidateAgentSummaryCache } from "./agent-summary.js";
import type {
  TaskDefinition,
  TaskComment,
  TaskCreateRequest,
  TaskUpdateRequest,
  TaskListQuery,
  TaskCheckpoint,
  TaskResult,
  TaskStatus,
  TaskPriority,
  ActivityEntry,
  ActivityType,
  Suggestion,
  OutputValidationFailure,
} from "./types.js";
import { generateTaskId } from "./types.js";

// ─── State Machine ───────────────────────────────────────────────

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["in_progress", "blocked", "failed"],
  in_progress: ["completed", "failed", "blocked"],
  blocked: ["pending", "in_progress", "failed"],
  completed: ["approved", "rejected", "archived", "failed", "pending"],
  failed: ["pending", "archived"], // retry or archive
  approved: ["archived", "failed", "pending"], // archive or flag silent failure
  rejected: ["pending", "archived"], // back to queue with feedback, or archive
  archived: [], // terminal
};

// Priority sort order (lower = higher priority)
const PRIORITY_ORDER: Record<TaskPriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

// ─── TaskQueue Class ─────────────────────────────────────────────

export class TaskQueue {
  private baseDir: string;
  private tasksDir: string;
  private queueFile: string;
  private activityFile: string;
  private activityDir: string;
  private suggestionsDir: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.tasksDir = join(baseDir, "active");
    this.queueFile = join(baseDir, "queue.jsonl");
    this.activityFile = join(baseDir, "activity.jsonl");
    this.activityDir = join(homedir(), ".openclaw", "activity");
    this.suggestionsDir = join(baseDir, "suggestions");
  }

  /** Ensure directories and files exist. Call once on startup. */
  async initialize(): Promise<void> {
    await fs.mkdir(this.tasksDir, { recursive: true });
    await fs.mkdir(this.suggestionsDir, { recursive: true });
    await fs.mkdir(this.activityDir, { recursive: true });
    for (const file of [this.queueFile, this.activityFile]) {
      try {
        await fs.access(file);
      } catch {
        await fs.writeFile(file, "");
      }
    }
  }

  // ─── Task CRUD ───────────────────────────────────────────────

  /** Create a new task. Returns the full TaskDefinition with generated ID. */
  async create(
    request: TaskCreateRequest,
    dispatchedBy: string = "archon",
  ): Promise<TaskDefinition> {
    const now = new Date().toISOString();
    const task: TaskDefinition = {
      id: generateTaskId(),
      title: request.title,
      description: request.description,
      assignee: request.assignee,
      dispatchedBy,
      dispatchedAt: now,
      priority: request.priority,
      status: "pending",
      model: request.model,
      timeout: request.timeout ?? 30,
      maxTurns: request.maxTurns ?? 50,
      checkpointInterval: 10,
      inputs: request.inputs ?? [],
      outputPath: request.outputPath,
      requiresApproval: request.requiresApproval ?? true,
      approvalGates: request.approvalGates?.map((g) => ({
        ...g,
        status: "pending" as const,
      })),
      checkpoints: [],
      tags: request.tags,
      dependsOn: request.dependsOn,
    };

    await this.serialize(async () => {
      await this.writeTask(task);
      await this.appendQueue({
        type: "task:created",
        taskId: task.id,
        assignee: task.assignee,
        priority: task.priority,
        timestamp: now,
      });
    });

    await this.logActivity({
      type: "task",
      action: "task:created",
      agent: dispatchedBy,
      taskId: task.id,
      details: {
        title: task.title,
        assignee: task.assignee,
        priority: task.priority,
      },
    });

    // Write to date-partitioned activity ledger (E1)
    this.appendDateLedger({
      taskId: task.id,
      agent: task.assignee,
      action: "task_created",
      to: "pending",
      title: task.title,
    }).catch(() => {});

    return task;
  }

  /** Get a task by ID. Returns null if not found. */
  async get(taskId: string): Promise<TaskDefinition | null> {
    try {
      const data = await fs.readFile(this.taskPath(taskId), "utf-8");
      return JSON.parse(data) as TaskDefinition;
    } catch {
      return null;
    }
  }

  /** Update a task. Validates state transitions. Returns updated task. */
  async update(taskId: string, update: TaskUpdateRequest): Promise<TaskDefinition> {
    return this.serialize(async () => {
      const task = await this.get(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      // Status transition
      const previousStatus = task.status;
      if (update.status && update.status !== task.status) {
        if (!this.isValidTransition(task.status, update.status)) {
          throw new Error(`Invalid status transition: ${task.status} \u2192 ${update.status}`);
        }
        task.status = update.status;

        // Set archivedAt timestamp when archiving
        if (update.status === "archived") {
          task.archivedAt = new Date().toISOString();
        }

        // Write to date-partitioned activity ledger (E1: knowledge feedback loop)
        this.appendDateLedger({
          taskId: task.id,
          agent: task.assignee,
          action: "status_change",
          from: previousStatus,
          to: update.status,
          title: task.title,
          feedback: task.feedback,
          outputPath: task.outputPath,
          tokensSummary: task.result
            ? { input: task.result.totalTokens.input, output: task.result.totalTokens.output }
            : undefined,
        }).catch(() => {
          // Non-critical
        });
      }

      // Field updates
      if (update.feedback !== undefined) {
        task.feedback = update.feedback;
      }
      if (update.blockedBy !== undefined) {
        task.blockedBy = update.blockedBy;
      }
      if (update.blockedReason !== undefined) {
        task.blockedReason = update.blockedReason;
      }

      // Checkpoint append
      if (update.checkpoint) {
        task.checkpoints.push({
          ...update.checkpoint,
          timestamp: new Date().toISOString(),
        });
      }

      await this.writeTask(task);
      await this.appendQueue({
        type: "task:updated",
        taskId: task.id,
        changes: Object.keys(update),
        newStatus: task.status,
        timestamp: new Date().toISOString(),
      });

      return task;
    });
  }

  /** List tasks with optional filters. Sorted by priority then dispatch time. */
  async list(query: TaskListQuery = {}): Promise<TaskDefinition[]> {
    const files = await fs.readdir(this.tasksDir).catch(() => []);
    const tasks: TaskDefinition[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const data = await fs.readFile(join(this.tasksDir, file), "utf-8");
        const task = JSON.parse(data) as TaskDefinition;

        // Apply filters
        if (query.agentId && task.assignee !== query.agentId) {
          continue;
        }
        if (query.status && task.status !== query.status) {
          continue;
        }
        if (query.priority && task.priority !== query.priority) {
          continue;
        }
        if (query.tag && (!task.tags || !task.tags.includes(query.tag))) {
          continue;
        }
        if (query.from && task.dispatchedAt < query.from) {
          continue;
        }
        if (query.to && task.dispatchedAt > query.to) {
          continue;
        }

        tasks.push(task);
      } catch {
        // skip corrupt files silently
      }
    }

    // Sort: P0 before P1 before P2, then oldest first within same priority
    tasks.sort((a, b) => {
      const prio = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (prio !== 0) {
        return prio;
      }
      return a.dispatchedAt.localeCompare(b.dispatchedAt);
    });

    // Pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    return tasks.slice(offset, offset + limit);
  }

  // ─── Convenience Methods ─────────────────────────────────────

  /**
   * Get the next pending task for an agent.
   * Checks dependencies and returns highest-priority eligible task.
   */
  async getNextPending(agentId: string): Promise<TaskDefinition | null> {
    const tasks = await this.list({ agentId, status: "pending" });
    for (const task of tasks) {
      if (await this.areDependenciesMet(task)) {
        return task;
      }
    }
    return null;
  }

  /** Start a task: moves pending -> in_progress. */
  async start(taskId: string): Promise<TaskDefinition> {
    const task = await this.update(taskId, { status: "in_progress" });
    await this.logActivity({
      type: "task",
      action: "task:started",
      agent: task.assignee,
      taskId,
      details: { title: task.title },
    });
    return task;
  }

  /** Add a progress checkpoint to a running task. */
  async addCheckpoint(
    taskId: string,
    checkpoint: Omit<TaskCheckpoint, "timestamp">,
  ): Promise<void> {
    await this.update(taskId, { checkpoint });
  }

  /** Mark a task as completed with its result. */
  async complete(taskId: string, result: TaskResult): Promise<void> {
    await this.serialize(async () => {
      const task = await this.get(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      // If approval required, go to "completed" (awaiting review)
      // If no approval needed, go straight to "approved"
      task.status = task.requiresApproval ? "completed" : "approved";
      task.result = result;
      await this.writeTask(task);

      await this.appendQueue({
        type: "task:completed",
        taskId,
        outputPath: result.outputPath,
        outputLines: result.outputLines,
        totalCost: result.totalCost,
        timestamp: new Date().toISOString(),
      });
    });

    const task = await this.get(taskId);
    await this.logActivity({
      type: "task",
      action: "task:completed",
      agent: task?.assignee,
      taskId,
      details: {
        outputPath: result.outputPath,
        outputLines: result.outputLines,
        summary: result.summary,
      },
      cost: {
        inputTokens: result.totalTokens.input,
        outputTokens: result.totalTokens.output,
        totalCost: result.totalCost,
        model: result.model,
      },
    });

    // Write to date-partitioned activity ledger with full token summary (E1)
    this.appendDateLedger({
      taskId,
      agent: task?.assignee ?? "unknown",
      action: "task_completed",
      from: "in_progress",
      to: task?.status ?? "completed",
      title: task?.title,
      outputPath: result.outputPath,
      tokensSummary: {
        input: result.totalTokens.input,
        output: result.totalTokens.output,
      },
    }).catch(() => {});
  }

  /** Mark a task as failed. */
  async fail(taskId: string, error: string): Promise<void> {
    const task = await this.update(taskId, { status: "failed" });
    await this.logActivity({
      type: "task",
      action: "task:failed",
      agent: task.assignee,
      taskId,
      details: { error },
    });
  }

  /** Approve a completed task (human review). */
  async approve(taskId: string): Promise<TaskDefinition> {
    const task = await this.update(taskId, { status: "approved" });
    await this.logActivity({
      type: "approval",
      action: "task:approved",
      taskId,
      details: { approvedBy: "shouvik" },
    });
    return task;
  }

  /** Reject a completed task with feedback. Moves to "rejected". */
  async reject(taskId: string, reason: string): Promise<TaskDefinition> {
    const task = await this.update(taskId, {
      status: "rejected",
      feedback: reason,
    });
    await this.logActivity({
      type: "approval",
      action: "task:rejected",
      taskId,
      details: { rejectedBy: "shouvik", reason },
    });
    return task;
  }

  /** Requeue a rejected task back to pending. */
  async requeue(taskId: string): Promise<TaskDefinition> {
    const task = await this.update(taskId, { status: "pending" });
    await this.logActivity({
      type: "task",
      action: "task:requeued",
      agent: task.assignee,
      taskId,
      details: { feedback: task.feedback },
    });
    return task;
  }

  // ─── Archive & Validation ────────────────────────────────────

  /**
   * Archive old tasks in terminal states (completed, failed, rejected)
   * that are older than the specified number of days.
   * Returns the count of archived tasks.
   */
  async archiveOldTasks(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const cutoffIso = cutoff.toISOString();

    const archivableStatuses = new Set<TaskStatus>(["completed", "failed", "rejected"]);
    const files = await fs.readdir(this.tasksDir).catch(() => []);
    let archivedCount = 0;

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const data = await fs.readFile(join(this.tasksDir, file), "utf-8");
        const task = JSON.parse(data) as TaskDefinition;

        if (!archivableStatuses.has(task.status)) {
          continue;
        }

        // Use result.completedAt for completed tasks, dispatchedAt as fallback
        const taskDate = task.result?.completedAt ?? task.dispatchedAt;
        if (taskDate >= cutoffIso) {
          continue;
        }

        // Transition to archived
        await this.update(task.id, { status: "archived" });
        archivedCount++;
      } catch {
        // skip corrupt files
      }
    }

    if (archivedCount > 0) {
      await this.logActivity({
        type: "system",
        action: "tasks:auto_archived",
        details: {
          count: archivedCount,
          olderThanDays,
          cutoff: cutoffIso,
        },
      });
    }

    return archivedCount;
  }

  /**
   * Validate output files for all completed/approved tasks that have an outputPath.
   * Returns list of tasks whose output files are missing from disk.
   */
  async validateOutputFiles(): Promise<OutputValidationFailure[]> {
    const files = await fs.readdir(this.tasksDir).catch(() => []);
    const failures: OutputValidationFailure[] = [];
    const home = homedir();

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const data = await fs.readFile(join(this.tasksDir, file), "utf-8");
        const task = JSON.parse(data) as TaskDefinition;

        // Only check completed and approved tasks with an outputPath
        if (task.status !== "completed" && task.status !== "approved") {
          continue;
        }
        if (!task.outputPath) {
          continue;
        }

        // Expand ~ to home directory
        const resolvedPath = task.outputPath.startsWith("~")
          ? join(home, task.outputPath.slice(1))
          : task.outputPath;

        if (!existsSync(resolvedPath)) {
          failures.push({
            taskId: task.id,
            title: task.title,
            outputPath: task.outputPath,
            assignee: task.assignee,
            completedAt: task.result?.completedAt,
          });
        }
      } catch {
        // skip corrupt files
      }
    }

    if (failures.length > 0) {
      await this.logActivity({
        type: "system",
        action: "tasks:output_validation",
        details: {
          checked: "completed+approved tasks with outputPath",
          failureCount: failures.length,
          failedTaskIds: failures.map((f) => f.taskId),
        },
      });
    }

    return failures;
  }

  // ─── Dependency Checking ─────────────────────────────────────

  /** Check if all dependencies of a task are met (completed or approved). */
  async areDependenciesMet(task: TaskDefinition): Promise<boolean> {
    if (!task.dependsOn || task.dependsOn.length === 0) {
      return true;
    }
    for (const depId of task.dependsOn) {
      const dep = await this.get(depId);
      if (!dep || (dep.status !== "completed" && dep.status !== "approved")) {
        return false;
      }
    }
    return true;
  }

  // --- Date-Partitioned Activity Ledger ---

  /**
   * Append an entry to the date-partitioned activity ledger.
   * Writes to ~/.openclaw/activity/YYYY-MM-DD.jsonl
   */
  private async appendDateLedger(entry: {
    taskId: string;
    agent: string;
    action: string;
    from?: string;
    to?: string;
    title?: string;
    feedback?: string;
    outputPath?: string;
    tokensSummary?: { input: number; output: number };
  }): Promise<void> {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const ledgerFile = join(this.activityDir, `${dateStr}.jsonl`);
    const record = {
      timestamp: now.toISOString(),
      ...entry,
    };
    await fs.appendFile(ledgerFile, JSON.stringify(record) + "\n");
  }

  // ─── Activity Ledger ─────────────────────────────────────────

  /** Append an entry to the activity ledger. */
  async logActivity(entry: Omit<ActivityEntry, "timestamp">): Promise<void> {
    const full: ActivityEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    await fs.appendFile(this.activityFile, JSON.stringify(full) + "\n");
  }

  /** Query the activity ledger with filters. Returns most recent first. */
  async queryActivity(
    params: {
      type?: ActivityType;
      agent?: string;
      taskId?: string;
      from?: string;
      to?: string;
      limit?: number;
    } = {},
  ): Promise<ActivityEntry[]> {
    let data: string;
    try {
      data = await fs.readFile(this.activityFile, "utf-8");
    } catch {
      return [];
    }

    const entries: ActivityEntry[] = [];
    for (const line of data.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as ActivityEntry;
        if (params.type && entry.type !== params.type) {
          continue;
        }
        if (params.agent && entry.agent !== params.agent) {
          continue;
        }
        if (params.taskId && entry.taskId !== params.taskId) {
          continue;
        }
        if (params.from && entry.timestamp < params.from) {
          continue;
        }
        if (params.to && entry.timestamp > params.to) {
          continue;
        }
        entries.push(entry);
      } catch {
        // skip corrupt lines
      }
    }

    entries.reverse(); // most recent first
    return entries.slice(0, params.limit ?? 100);
  }

  // ─── Suggestions ─────────────────────────────────────────────

  /** Create a cross-vertical suggestion. */
  async createSuggestion(
    input: Omit<Suggestion, "id" | "createdAt" | "status">,
  ): Promise<Suggestion> {
    const suggestion: Suggestion = {
      ...input,
      id: `SUG-${Date.now().toString(36).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const file = join(this.suggestionsDir, `${suggestion.id}.json`);
    await fs.writeFile(file, JSON.stringify(suggestion, null, 2));
    await this.logActivity({
      type: "system",
      action: "suggestion:created",
      agent: input.sourceAgent,
      details: {
        title: input.title,
        targetAgent: input.targetAgent,
      },
    });
    return suggestion;
  }

  /** List suggestions, optionally filtered by status. */
  async listSuggestions(status?: Suggestion["status"]): Promise<Suggestion[]> {
    const files = await fs.readdir(this.suggestionsDir).catch(() => []);
    const suggestions: Suggestion[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const data = await fs.readFile(join(this.suggestionsDir, file), "utf-8");
        const s = JSON.parse(data) as Suggestion;
        if (status && s.status !== status) {
          continue;
        }
        suggestions.push(s);
      } catch {
        // skip corrupt files
      }
    }
    return suggestions.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Update a suggestion (status change or add discussion entry). */
  async updateSuggestion(
    id: string,
    update: { status?: Suggestion["status"]; discussion?: string },
  ): Promise<Suggestion> {
    const file = join(this.suggestionsDir, `${id}.json`);
    const data = await fs.readFile(file, "utf-8");
    const suggestion = JSON.parse(data) as Suggestion;
    if (update.status) {
      suggestion.status = update.status;
    }
    if (update.discussion) {
      suggestion.discussion = suggestion.discussion ?? [];
      suggestion.discussion.push(update.discussion);
    }
    await fs.writeFile(file, JSON.stringify(suggestion, null, 2));
    return suggestion;
  }

  // ─── Task Comments ──────────────────────────────────────────

  /** Get all comments for a task. */
  async getComments(taskId: string): Promise<TaskComment[]> {
    const task = await this.get(taskId);
    return task?.comments ?? [];
  }

  /** Add a comment to a task. Returns the new comment. */
  async addComment(taskId: string, author: string, text: string): Promise<TaskComment> {
    return this.serialize(async () => {
      const task = await this.get(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const comment: TaskComment = {
        id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        author,
        text,
        createdAt: new Date().toISOString(),
      };
      if (!task.comments) {
        task.comments = [];
      }
      task.comments.push(comment);
      await this.writeTask(task);
      return comment;
    });
  }

  // ─── Deliverable Revisions ────────────────────────────────────

  /** Get revisions for a task from sidecar file. */
  async getRevisions(taskId: string): Promise<
    Array<{
      version: number;
      savedAt: string;
      savedBy: string;
      contentLength: number;
      summary: string;
    }>
  > {
    const revPath = join(this.tasksDir, `${taskId}-revisions.json`);
    try {
      const data = await fs.readFile(revPath, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /** Add a revision entry for a task deliverable. */
  async addRevision(
    taskId: string,
    revision: {
      savedBy: string;
      contentLength: number;
      summary: string;
    },
  ): Promise<{
    version: number;
    savedAt: string;
    savedBy: string;
    contentLength: number;
    summary: string;
  }> {
    const revPath = join(this.tasksDir, `${taskId}-revisions.json`);
    const existing = await this.getRevisions(taskId);
    const entry = {
      version: existing.length + 1,
      savedAt: new Date().toISOString(),
      ...revision,
    };
    existing.push(entry);
    await fs.writeFile(revPath, JSON.stringify(existing, null, 2));
    return entry;
  }

  // ─── Stats ───────────────────────────────────────────────────

  /** Get aggregate task statistics (for dashboard/cost tracking). */
  async getStats(): Promise<{
    total: number;
    byStatus: Partial<Record<TaskStatus, number>>;
    byAgent: Record<string, number>;
    byPriority: Partial<Record<TaskPriority, number>>;
    totalCost: number;
    costByAgent: Record<string, number>;
  }> {
    const tasks = await this.list({});
    const byStatus: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const costByAgent: Record<string, number> = {};
    let totalCost = 0;

    for (const task of tasks) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
      byAgent[task.assignee] = (byAgent[task.assignee] ?? 0) + 1;
      byPriority[task.priority] = (byPriority[task.priority] ?? 0) + 1;
      if (task.result) {
        totalCost += task.result.totalCost;
        costByAgent[task.assignee] = (costByAgent[task.assignee] ?? 0) + task.result.totalCost;
      }
    }

    return {
      total: tasks.length,
      byStatus: byStatus as Partial<Record<TaskStatus, number>>,
      byAgent,
      byPriority: byPriority as Partial<Record<TaskPriority, number>>,
      totalCost,
      costByAgent,
    };
  }

  // ─── Internal Helpers ────────────────────────────────────────

  private taskPath(taskId: string): string {
    return join(this.tasksDir, `${taskId}.json`);
  }

  private async writeTask(task: TaskDefinition): Promise<void> {
    await fs.writeFile(this.taskPath(task.id), JSON.stringify(task, null, 2));
    invalidateAgentSummaryCache();
  }

  private async appendQueue(event: Record<string, unknown>): Promise<void> {
    await fs.appendFile(this.queueFile, JSON.stringify(event) + "\n");
  }

  private isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  /**
   * Serialize write operations to prevent concurrent file corruption.
   * Since Node.js is single-threaded, we only need promise chaining.
   */
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let resolve!: () => void;
    this.writeLock = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}
