/**
 * Task Queue Agent Tools
 *
 * Three tools for agents to interact with the task queue:
 *   - task_dispatch: Create and dispatch tasks (Archon → any agent)
 *   - task_status:   Query task status (any agent)
 *   - task_update:   Report progress / update status (executing agent)
 *
 * These tools follow the same pattern as cron-tool.ts, sessions-send-tool.ts, etc.
 * Uses TypeBox for parameter schemas and jsonResult() for responses.
 */

import { Type } from "@sinclair/typebox";
import type { TaskQueue } from "../../tasks/TaskQueue.js";
import type { TaskCreateRequest, TaskPriority, TaskStatus } from "../../tasks/types.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum, optionalStringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readStringParam,
  readNumberParam,
  readStringArrayParam,
} from "./common.js";

// ─── Schemas ─────────────────────────────────────────────────────

const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const TASK_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "blocked",
  "approved",
  "rejected",
] as const;

const TaskDispatchSchema = Type.Object({
  assignee: Type.String({ description: "Agent ID to execute the task (e.g. toothsome-head)" }),
  title: Type.String({ description: "Short task title" }),
  description: Type.String({ description: "Full task description with instructions (markdown)" }),
  outputPath: Type.String({ description: "File path where the deliverable should be written" }),
  priority: stringEnum(PRIORITIES),
  inputs: Type.Optional(Type.Array(Type.String(), { description: "File paths for context" })),
  model: Type.Optional(
    Type.String({ description: "Override model (e.g. anthropic/claude-opus-4-6)" }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Max execution time in minutes", minimum: 1, maximum: 120 }),
  ),
  maxTurns: Type.Optional(Type.Number({ description: "Max LLM turns", minimum: 1, maximum: 200 })),
  requiresApproval: Type.Optional(
    Type.Boolean({ description: "Whether output needs human review (default: true)" }),
  ),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs that must complete first" }),
  ),
  tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
});

const TaskStatusSchema = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Specific task ID to look up" })),
  agentId: Type.Optional(Type.String({ description: "Filter by agent" })),
  status: optionalStringEnum(TASK_STATUSES),
  priority: optionalStringEnum(PRIORITIES),
  limit: Type.Optional(Type.Number({ description: "Max results", minimum: 1, maximum: 50 })),
  includeStats: Type.Optional(Type.Boolean({ description: "Include aggregate statistics" })),
});

const TaskUpdateSchema = Type.Object({
  taskId: Type.String({ description: "Task ID to update" }),
  status: optionalStringEnum(TASK_STATUSES),
  progress: Type.Optional(
    Type.Number({ description: "Progress percentage 0-100", minimum: 0, maximum: 100 }),
  ),
  summary: Type.Optional(Type.String({ description: "Progress summary" })),
  feedback: Type.Optional(Type.String({ description: "Feedback (for reject/revise)" })),
  blockedBy: Type.Optional(Type.String({ description: "What is blocking this task" })),
  blockedReason: Type.Optional(Type.String({ description: "Reason for block" })),
  tokensUsed: Type.Optional(
    Type.Object({
      input: Type.Number({ description: "Input tokens consumed this checkpoint" }),
      output: Type.Number({ description: "Output tokens consumed this checkpoint" }),
    }),
  ),
  cost: Type.Optional(Type.Number({ description: "Estimated cost in USD for this checkpoint" })),
});

// ─── Tool Options ────────────────────────────────────────────────

export type TaskToolOptions = {
  taskQueue: TaskQueue;
  agentSessionKey?: string;
  config?: { agents?: { list?: Array<{ id: string }> } };
  /** Called after task creation to wake the target agent */
  requestHeartbeatNow?: (opts?: { reason?: string }) => void;
};

// ─── task_dispatch ───────────────────────────────────────────────

export function createTaskDispatchTool(opts: TaskToolOptions): AnyAgentTool {
  return {
    label: "Task Dispatch",
    name: "task_dispatch",
    description:
      "Dispatch a task to an agent. Creates a task in the queue and wakes the target agent. " +
      "The agent will pick up the task on its next heartbeat cycle. " +
      "Returns the created task with its ID for tracking.",
    parameters: TaskDispatchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      const assignee = readStringParam(params, "assignee", { required: true });
      const title = readStringParam(params, "title", { required: true });
      const description = readStringParam(params, "description", { required: true });
      const outputPath = readStringParam(params, "outputPath", { required: true });
      const priority = readStringParam(params, "priority", { required: true }) as TaskPriority;

      const inputs = readStringArrayParam(params, "inputs");
      const model = readStringParam(params, "model");
      const timeout = readNumberParam(params, "timeout", { integer: true });
      const maxTurns = readNumberParam(params, "maxTurns", { integer: true });
      const requiresApproval =
        typeof params.requiresApproval === "boolean" ? params.requiresApproval : true;
      const dependsOn = readStringArrayParam(params, "dependsOn");
      const tags = readStringArrayParam(params, "tags");

      // Resolve the dispatching agent
      const dispatchedBy = opts.agentSessionKey
        ? (resolveSessionAgentId({
            sessionKey: opts.agentSessionKey,
            config: opts.config as any,
          }) ?? "archon")
        : "archon";

      const request: TaskCreateRequest = {
        assignee,
        title,
        description,
        outputPath,
        priority,
        inputs,
        model,
        timeout,
        maxTurns,
        requiresApproval,
        dependsOn,
        tags,
      };

      const task = await opts.taskQueue.create(request, dispatchedBy);

      // Wake the target agent so it picks up the task
      if (opts.requestHeartbeatNow) {
        opts.requestHeartbeatNow({
          reason: `task:${task.id} dispatched to ${assignee}`,
        });
      }

      return jsonResult({
        status: "dispatched",
        task: {
          id: task.id,
          title: task.title,
          assignee: task.assignee,
          priority: task.priority,
          status: task.status,
          outputPath: task.outputPath,
          dispatchedAt: task.dispatchedAt,
        },
      });
    },
  };
}

// ─── task_status ─────────────────────────────────────────────────

export function createTaskStatusTool(opts: TaskToolOptions): AnyAgentTool {
  return {
    label: "Task Status",
    name: "task_status",
    description:
      "Query task status. Look up a specific task by ID, or list tasks filtered by " +
      "agent, status, or priority. Optionally include aggregate statistics.",
    parameters: TaskStatusSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      const taskId = readStringParam(params, "taskId");
      const agentId = readStringParam(params, "agentId");
      const status = readStringParam(params, "status") as TaskStatus | undefined;
      const priority = readStringParam(params, "priority") as TaskPriority | undefined;
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;
      const includeStats = typeof params.includeStats === "boolean" ? params.includeStats : false;

      // Single task lookup
      if (taskId) {
        const task = await opts.taskQueue.get(taskId);
        if (!task) {
          return jsonResult({ error: `Task not found: ${taskId}` });
        }
        return jsonResult({ task });
      }

      // List with filters
      const tasks = await opts.taskQueue.list({
        agentId,
        status,
        priority,
        limit,
      });

      const result: Record<string, unknown> = {
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          assignee: t.assignee,
          priority: t.priority,
          status: t.status,
          dispatchedAt: t.dispatchedAt,
          progress: t.checkpoints.length > 0 ? t.checkpoints[t.checkpoints.length - 1].progress : 0,
          outputPath: t.outputPath,
          feedback: t.feedback,
          blockedBy: t.blockedBy,
        })),
      };

      if (includeStats) {
        result.stats = await opts.taskQueue.getStats();
      }

      return jsonResult(result);
    },
  };
}

// ─── task_update ─────────────────────────────────────────────────

export function createTaskUpdateTool(opts: TaskToolOptions): AnyAgentTool {
  return {
    label: "Task Update",
    name: "task_update",
    description:
      "Update a task's progress or status. Use this to report checkpoints while " +
      "executing a task (progress percentage + summary), or to change status " +
      "(e.g. mark as blocked with reason).",
    parameters: TaskUpdateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      const taskId = readStringParam(params, "taskId", { required: true });
      const status = readStringParam(params, "status") as TaskStatus | undefined;
      const progress = readNumberParam(params, "progress", { integer: true });
      const summary = readStringParam(params, "summary");
      const feedback = readStringParam(params, "feedback");
      const blockedBy = readStringParam(params, "blockedBy");
      const blockedReason = readStringParam(params, "blockedReason");

      const task = await opts.taskQueue.get(taskId);
      if (!task) {
        return jsonResult({ error: `Task not found: ${taskId}` });
      }

      // Extract optional token/cost data from agent
      const tokensParam = params.tokensUsed as { input?: number; output?: number } | undefined;
      const costParam = readNumberParam(params, "cost");
      const cpTokens = {
        input: tokensParam?.input ?? 0,
        output: tokensParam?.output ?? 0,
      };

      // Build checkpoint if progress is reported
      const checkpoint =
        progress !== undefined || summary
          ? {
              turn: task.checkpoints.length + 1,
              progress:
                progress ??
                (task.checkpoints.length > 0
                  ? task.checkpoints[task.checkpoints.length - 1].progress
                  : 0),
              summary: summary ?? "Progress update",
              tokensUsed: cpTokens,
              cost: costParam ?? 0,
            }
          : undefined;

      const updated = await opts.taskQueue.update(taskId, {
        status,
        feedback,
        blockedBy,
        blockedReason,
        checkpoint,
      });

      return jsonResult({
        status: "updated",
        task: {
          id: updated.id,
          status: updated.status,
          progress:
            updated.checkpoints.length > 0
              ? updated.checkpoints[updated.checkpoints.length - 1].progress
              : 0,
          checkpoints: updated.checkpoints.length,
          feedback: updated.feedback,
          blockedBy: updated.blockedBy,
        },
      });
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Create all three task tools. Returns an array for spreading into the tools list.
 */
export function createTaskTools(opts: TaskToolOptions): AnyAgentTool[] {
  return [createTaskDispatchTool(opts), createTaskStatusTool(opts), createTaskUpdateTool(opts)];
}
