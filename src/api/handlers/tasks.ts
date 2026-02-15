/**
 * Task API Handlers
 *
 * CRUD + approval/rejection + archive/validation for tasks.
 * Called by the API router.
 */

import type { TaskQueue } from "../../tasks/TaskQueue.js";
import type {
  TaskCreateRequest,
  TaskUpdateRequest,
  TaskListQuery,
  TaskPriority,
  TaskStatus,
} from "../../tasks/types.js";
import { readTrace } from "../../agents/trace-logger.js";

export type TaskHandlerDeps = {
  taskQueue: TaskQueue;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
};

// GET /api/tasks
export async function handleListTasks(
  deps: TaskHandlerDeps,
  query: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const listQuery: TaskListQuery = {};
  if (query.has("agentId")) {
    listQuery.agentId = query.get("agentId")!;
  }
  if (query.has("status")) {
    listQuery.status = query.get("status") as TaskStatus;
  }
  if (query.has("priority")) {
    listQuery.priority = query.get("priority") as TaskPriority;
  }
  if (query.has("tag")) {
    listQuery.tag = query.get("tag")!;
  }
  if (query.has("from")) {
    listQuery.from = query.get("from")!;
  }
  if (query.has("to")) {
    listQuery.to = query.get("to")!;
  }
  if (query.has("limit")) {
    listQuery.limit = parseInt(query.get("limit")!, 10);
  }
  if (query.has("offset")) {
    listQuery.offset = parseInt(query.get("offset")!, 10);
  }

  const tasks = await deps.taskQueue.list(listQuery);
  return { status: 200, body: tasks };
}

// GET /api/tasks/:id
export async function handleGetTask(
  deps: TaskHandlerDeps,
  taskId: string,
): Promise<{ status: number; body: unknown }> {
  const task = await deps.taskQueue.get(taskId);
  if (!task) {
    return { status: 404, body: { error: "Task not found", taskId } };
  }
  return { status: 200, body: task };
}

// POST /api/tasks
export async function handleCreateTask(
  deps: TaskHandlerDeps,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "Request body must be a JSON object" } };
  }

  const req = body as Record<string, unknown>;

  // Validate required fields
  const requiredFields = ["assignee", "title", "description", "outputPath", "priority"];
  for (const field of requiredFields) {
    if (!req[field] || typeof req[field] !== "string") {
      return { status: 400, body: { error: `Missing required field: ${field}` } };
    }
  }

  const validPriorities = ["P0", "P1", "P2", "P3"];
  if (!validPriorities.includes(req.priority as string)) {
    return {
      status: 400,
      body: { error: `Invalid priority. Must be one of: ${validPriorities.join(", ")}` },
    };
  }

  const createReq: TaskCreateRequest = {
    assignee: req.assignee as string,
    title: req.title as string,
    description: req.description as string,
    outputPath: req.outputPath as string,
    priority: req.priority as TaskPriority,
    inputs: Array.isArray(req.inputs) ? (req.inputs as string[]) : [],
    requiresApproval: req.requiresApproval !== false,
    model: typeof req.model === "string" ? req.model : undefined,
    timeout: typeof req.timeout === "number" ? req.timeout : undefined,
    maxTurns: typeof req.maxTurns === "number" ? req.maxTurns : undefined,
    dependsOn: Array.isArray(req.dependsOn) ? (req.dependsOn as string[]) : undefined,
    tags: Array.isArray(req.tags) ? (req.tags as string[]) : undefined,
  };

  // ─── Input path resolution (E3: task chaining) ──────────────
  if (Array.isArray(createReq.inputs) && createReq.inputs.length > 0) {
    const resolvedInputs: string[] = [];
    for (const input of createReq.inputs as string[]) {
      if (typeof input === "string" && input.startsWith("task:")) {
        const refTaskId = input.slice(5); // Remove "task:" prefix
        try {
          const refTask = await deps.taskQueue.get(refTaskId);
          if (refTask?.outputPath) {
            resolvedInputs.push(refTask.outputPath);
          } else {
            return {
              status: 400,
              body: {
                error: `Referenced task ${refTaskId} has no output path`,
                input,
              },
            };
          }
        } catch {
          return {
            status: 400,
            body: {
              error: `Referenced task not found: ${refTaskId}`,
              input,
            },
          };
        }
      } else {
        resolvedInputs.push(input as string);
      }
    }
    createReq.inputs = resolvedInputs;
  }

  // ─── Deduplication check ─────────────────────────────────────
  const force = (req as Record<string, unknown>).force === true;
  if (!force) {
    const existingTasks = await deps.taskQueue.list({ agentId: req.assignee as string });
    const terminalStatuses = new Set(["completed", "failed", "rejected", "archived"]);
    const duplicate = existingTasks.find(
      (t) =>
        t.title === (req.title as string) &&
        t.assignee === (req.assignee as string) &&
        !terminalStatuses.has(t.status),
    );
    if (duplicate) {
      return {
        status: 409,
        body: {
          error: "Duplicate task detected",
          existingTaskId: duplicate.id,
          existingStatus: duplicate.status,
          message: `A task with title "${req.title}" is already assigned to ${req.assignee} (status: ${duplicate.status}). Use force: true to create anyway.`,
        },
      };
    }
  }

  const task = await deps.taskQueue.create(createReq, "mission-control");

  deps.broadcast("task:created", { task }, { dropIfSlow: true });

  return { status: 201, body: task };
}

// PATCH /api/tasks/:id
export async function handleUpdateTask(
  deps: TaskHandlerDeps,
  taskId: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "Request body must be a JSON object" } };
  }

  const req = body as Record<string, unknown>;
  const existing = await deps.taskQueue.get(taskId);
  if (!existing) {
    return { status: 404, body: { error: "Task not found", taskId } };
  }

  // Handle special status transitions
  if (req.status === "approved") {
    const task = await deps.taskQueue.approve(taskId);
    deps.broadcast("task:approved", { taskId }, { dropIfSlow: true });
    return { status: 200, body: task };
  }

  if (req.status === "rejected") {
    const reason = typeof req.reason === "string" ? req.reason : "Rejected via Mission Control";
    const task = await deps.taskQueue.reject(taskId, reason);
    deps.broadcast("task:rejected", { taskId, reason }, { dropIfSlow: true });
    return { status: 200, body: task };
  }

  // Handle archive transition
  if (req.status === "archived") {
    try {
      const task = await deps.taskQueue.update(taskId, { status: "archived" });
      deps.broadcast("task:archived", { taskId }, { dropIfSlow: true });
      return { status: 200, body: task };
    } catch (err) {
      return { status: 400, body: { error: String(err) } };
    }
  }

  // Handle requeue (send back to pending, with optional feedback)
  if (req.status === "pending") {
    try {
      await deps.taskQueue.requeue(taskId);
      if (typeof req.feedback === "string") {
        const updated = await deps.taskQueue.update(taskId, { feedback: req.feedback });
        deps.broadcast("task:feedback", { taskId, feedback: req.feedback }, { dropIfSlow: true });
        return { status: 200, body: updated };
      }
      const updated = await deps.taskQueue.get(taskId);
      deps.broadcast("task:requeued", { taskId }, { dropIfSlow: true });
      return { status: 200, body: updated };
    } catch (err) {
      return { status: 400, body: { error: String(err) } };
    }
  }

  // Generic update
  const updateReq: TaskUpdateRequest = {};
  if (typeof req.status === "string") {
    updateReq.status = req.status as TaskStatus;
  }
  if (typeof req.feedback === "string") {
    updateReq.feedback = req.feedback;
  }
  if (typeof req.blockedBy === "string") {
    updateReq.blockedBy = req.blockedBy;
  }
  if (typeof req.blockedReason === "string") {
    updateReq.blockedReason = req.blockedReason;
  }

  try {
    const updated = await deps.taskQueue.update(taskId, updateReq);
    return { status: 200, body: updated };
  } catch (err) {
    return { status: 400, body: { error: String(err) } };
  }
}

// GET /api/tasks/stats
export async function handleTaskStats(
  deps: TaskHandlerDeps,
): Promise<{ status: number; body: unknown }> {
  const stats = await deps.taskQueue.getStats();
  return { status: 200, body: stats };
}

// POST /api/tasks/archive-old
export async function handleArchiveOldTasks(
  deps: TaskHandlerDeps,
  query: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const days = parseInt(query.get("days") ?? "7", 10);
  if (isNaN(days) || days < 1) {
    return { status: 400, body: { error: "Invalid days parameter. Must be a positive integer." } };
  }

  const count = await deps.taskQueue.archiveOldTasks(days);
  deps.broadcast("tasks:archived", { count, days }, { dropIfSlow: true });

  return {
    status: 200,
    body: {
      archived: count,
      olderThanDays: days,
      message: `Archived ${count} task(s) older than ${days} day(s).`,
    },
  };
}

// GET /api/tasks/:id/comments
export async function handleGetComments(
  deps: TaskHandlerDeps,
  taskId: string,
): Promise<{ status: number; body: unknown }> {
  const task = await deps.taskQueue.get(taskId);
  if (!task) {
    return { status: 404, body: { error: "Task not found", taskId } };
  }
  return { status: 200, body: task.comments ?? [] };
}

// POST /api/tasks/:id/comments
export async function handleAddComment(
  deps: TaskHandlerDeps,
  taskId: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "Request body must be a JSON object" } };
  }
  const req = body as Record<string, unknown>;
  const text = typeof req.text === "string" ? req.text.trim() : "";
  const author = typeof req.author === "string" ? req.author.trim() : "anonymous";
  if (!text) {
    return { status: 400, body: { error: "Missing required field: text" } };
  }
  try {
    const comment = await deps.taskQueue.addComment(taskId, author, text);
    deps.broadcast("task:comment", { taskId, comment }, { dropIfSlow: true });
    return { status: 201, body: comment };
  } catch (err) {
    const message = String(err);
    if (message.includes("not found")) {
      return { status: 404, body: { error: "Task not found", taskId } };
    }
    return { status: 500, body: { error: message } };
  }
}

// GET /api/tasks/:id/revisions
export async function handleGetRevisions(
  deps: TaskHandlerDeps,
  taskId: string,
): Promise<{ status: number; body: unknown }> {
  const task = await deps.taskQueue.get(taskId);
  if (!task) {
    return { status: 404, body: { error: "Task not found", taskId } };
  }
  const revisions = await deps.taskQueue.getRevisions(taskId);
  return { status: 200, body: revisions };
}

// POST /api/tasks/:id/revisions
export async function handleAddRevision(
  deps: TaskHandlerDeps,
  taskId: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "Request body must be a JSON object" } };
  }
  const req = body as Record<string, unknown>;
  const savedBy = typeof req.savedBy === "string" ? req.savedBy.trim() : "anonymous";
  const contentLength = typeof req.contentLength === "number" ? req.contentLength : 0;
  const summary = typeof req.summary === "string" ? req.summary.trim() : "";
  try {
    const revision = await deps.taskQueue.addRevision(taskId, { savedBy, contentLength, summary });
    return { status: 201, body: revision };
  } catch (err) {
    const message = String(err);
    if (message.includes("not found")) {
      return { status: 404, body: { error: "Task not found", taskId } };
    }
    return { status: 500, body: { error: message } };
  }
}

// GET /api/tasks/:id/trace
export async function handleGetTrace(
  _deps: TaskHandlerDeps,
  taskId: string,
): Promise<{ status: number; body: unknown }> {
  const spans = await readTrace(taskId);
  return { status: 200, body: spans };
}

// POST /api/tasks/validate-outputs
export async function handleValidateOutputs(
  deps: TaskHandlerDeps,
): Promise<{ status: number; body: unknown }> {
  const failures = await deps.taskQueue.validateOutputFiles();

  return {
    status: 200,
    body: {
      checked: "completed and approved tasks with outputPath",
      failureCount: failures.length,
      failures,
    },
  };
}
