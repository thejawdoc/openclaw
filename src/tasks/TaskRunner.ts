/**
 * TaskRunner — Executes tasks by spawning isolated agent sessions
 *
 * Bridges the task queue with OpenClaw's existing runIsolatedAgentJob.
 * Called during heartbeat to check for pending tasks and run them.
 *
 * Flow:
 *   1. Heartbeat fires → TaskRunner.checkAndRun(agentId)
 *   2. Picks highest-priority pending task with met dependencies
 *   3. Marks task as in_progress
 *   4. Builds a CronJob from the task + constructs the agent message
 *   5. Calls runIsolatedAgentJob (existing OpenClaw infra)
 *   6. On return, marks task completed/failed
 *   7. Broadcasts WebSocket events for Mission Control
 *
 * Note: Checkpoints during execution are handled by the task_update tool,
 * which the agent calls from within its session. TaskRunner only handles
 * the top-level lifecycle.
 */

import { promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import type { CronJob } from "../cron/types.js";
import type { TaskQueue } from "./TaskQueue.js";
import type { TaskDefinition, TaskResult, WSEvent } from "./types.js";
import { logComms } from "../agents/comms-logger.js";
import { startSpan, endSpan } from "../agents/trace-logger.js";

// ─── Dependencies ────────────────────────────────────────────────

export type RunIsolatedResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  outputText?: string;
  error?: string;
  sessionId?: string;
  sessionKey?: string;
  /** Token usage from the model provider (populated by runCronIsolatedAgentTurn) */
  meta?: {
    agentMeta?: {
      usage?: { input?: number; output?: number };
      model?: string;
      provider?: string;
    };
  };
};

/**
 * Cost-per-million-token pricing table.
 * Loaded from pricing.json at startup, with keyword-match fallback for unknown models.
 */
import pricingData from "../agents/pricing.json" with { type: "json" };

const PRICING_TABLE = pricingData as Record<string, { input: number; output: number }>;

/** Keyword-based fallback for models not in pricing.json (per million tokens) */
const MODEL_COST_FALLBACK: Record<string, { input: number; output: number }> = {
  opus: { input: 15.0, output: 75.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 0.25, output: 1.25 },
  kimi: { input: 1.0, output: 3.0 },
  qwen: { input: 0.0, output: 0.0 },
  default: { input: 3.0, output: 15.0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Try exact match from pricing.json first
  const exactRates = PRICING_TABLE[model];
  if (exactRates) {
    return (
      (inputTokens / 1_000_000) * exactRates.input + (outputTokens / 1_000_000) * exactRates.output
    );
  }
  // Keyword match fallback
  const lowerModel = model.toLowerCase();
  const key = Object.keys(MODEL_COST_FALLBACK).find((k) => lowerModel.includes(k)) ?? "default";
  const rates = MODEL_COST_FALLBACK[key];
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

export type TaskRunnerLogger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type TaskRunnerDeps = {
  taskQueue: TaskQueue;
  runIsolatedAgentJob: (params: { job: CronJob; message: string }) => Promise<RunIsolatedResult>;
  requestHeartbeatNow: (opts?: { reason?: string }) => void;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  log: TaskRunnerLogger;
  /** Read file line count for result verification */
  countFileLines?: (path: string) => Promise<number>;
};

// ─── TaskRunner Class ────────────────────────────────────────────

export class TaskRunner {
  private deps: TaskRunnerDeps;
  /** Tracks which agent is running which task (prevents double-dispatch) */
  private runningTasks: Map<string, string> = new Map();

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Called during heartbeat for a given agent.
   * Checks for pending tasks and runs the highest-priority eligible one.
   * Returns immediately if the agent is already running a task.
   */
  async checkAndRun(agentId: string): Promise<void> {
    // Guard: don't start a new task if one is already running
    if (this.runningTasks.has(agentId)) {
      this.deps.log.debug(
        { agentId, currentTask: this.runningTasks.get(agentId) },
        "task-runner: agent already busy, skipping",
      );
      return;
    }

    const task = await this.deps.taskQueue.getNextPending(agentId);
    if (!task) {
      this.deps.log.debug({ agentId }, "task-runner: no pending tasks");
      return;
    }

    // Run the task (non-blocking from heartbeat perspective)
    this.runTask(task).catch((err) => {
      this.deps.log.error(
        { err: String(err), taskId: task.id, agentId },
        "task-runner: unhandled error in runTask",
      );
    });
  }

  /**
   * Execute a specific task. Handles full lifecycle:
   * pending → in_progress → completed/failed
   */
  async runTask(task: TaskDefinition): Promise<void> {
    const { taskQueue, log } = this.deps;
    const { id: taskId, assignee: agentId } = task;

    // Mark in_progress
    this.runningTasks.set(agentId, taskId);
    try {
      await taskQueue.start(taskId);
    } catch (err) {
      this.runningTasks.delete(agentId);
      log.error({ err: String(err), taskId }, "task-runner: failed to start task");
      return;
    }

    // Broadcast task started
    this.broadcastEvent({
      type: "task:started",
      taskId,
      agent: agentId,
    });

    log.info(
      { taskId, agentId, priority: task.priority, title: task.title },
      "task-runner: starting task",
    );

    // Log inter-agent communication: dispatch → agent
    logComms({
      from: task.dispatchedBy,
      to: agentId,
      type: "dispatch",
      taskId,
      message: `Dispatched task: ${task.title}`,
    }).catch(() => {});

    const startedAt = Date.now();

    try {
      // Build the CronJob structure and message
      const job = this.buildJobFromTask(task);
      const message = this.buildTaskMessage(task);

      // Trace: start the main execution span
      const execSpan = startSpan(taskId, agentId, "task_lifecycle", "task_execution", task.title);

      // Run the isolated agent session
      const result = await this.deps.runIsolatedAgentJob({ job, message });

      const durationMs = Date.now() - startedAt;

      if (result.status === "ok") {
        // Verify output exists
        const outputLines = await this.verifyOutput(task.outputPath);

        // Extract actual token usage from the isolated agent session
        const usage = result.meta?.agentMeta?.usage;
        const inputTokens = usage?.input ?? 0;
        const outputTokens = usage?.output ?? 0;
        const modelUsed = result.meta?.agentMeta?.model ?? task.model ?? "default";
        const cost = estimateCost(modelUsed, inputTokens, outputTokens);

        const taskResult: TaskResult = {
          completedAt: new Date().toISOString(),
          outputPath: task.outputPath,
          outputLines,
          summary: result.summary ?? result.outputText ?? "Task completed",
          totalTokens: { input: inputTokens, output: outputTokens },
          totalCost: cost,
          model: modelUsed,
        };

        await taskQueue.complete(taskId, taskResult);

        // Trace: end execution span with success
        endSpan(execSpan, {
          output: taskResult.summary,
          tokens: taskResult.totalTokens,
          cost: taskResult.totalCost,
        }).catch(() => {});

        // E4: Append completion summary to agent MEMORY.md (knowledge feedback loop)
        const updatedTask = await taskQueue.get(taskId);
        if (updatedTask) {
          await this.appendAgentMemory(updatedTask);
        }
        log.info(
          {
            taskId,
            agentId,
            durationMs,
            outputLines,
            outputPath: task.outputPath,
          },
          "task-runner: task completed",
        );

        // Broadcast completion
        this.broadcastEvent({
          type: "task:completed",
          taskId,
          result: taskResult,
        });

        // If approval needed, broadcast that too
        if (task.requiresApproval) {
          this.broadcastEvent({
            type: "task:approval_needed",
            taskId,
            gates: task.approvalGates ?? [],
          });
        }
      } else if (result.status === "error") {
        endSpan(execSpan, { error: result.error ?? "Unknown error" }).catch(() => {});
        await taskQueue.fail(taskId, result.error ?? "Unknown error");
        log.error({ taskId, agentId, error: result.error, durationMs }, "task-runner: task failed");

        this.broadcastEvent({
          type: "task:failed",
          taskId,
          error: result.error ?? "Unknown error",
        });
      } else {
        // skipped
        endSpan(execSpan, { error: "Task was skipped by the agent runtime" }).catch(() => {});
        log.warn({ taskId, agentId, durationMs }, "task-runner: task skipped by agent");
        await taskQueue.fail(taskId, "Task was skipped by the agent runtime");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      try {
        await taskQueue.fail(taskId, error);
      } catch {
        // If we can't even fail the task, just log
      }
      log.error({ err: error, taskId, agentId }, "task-runner: unhandled error during execution");

      this.broadcastEvent({
        type: "task:failed",
        taskId,
        error,
      });
    } finally {
      this.runningTasks.delete(agentId);
    }
  }

  /** Check if an agent is currently executing a task. */
  isAgentBusy(agentId: string): boolean {
    return this.runningTasks.has(agentId);
  }

  /** Get the current running task ID for an agent. */
  getRunningTaskId(agentId: string): string | undefined {
    return this.runningTasks.get(agentId);
  }

  /** Get all currently running tasks. */
  getRunningTasks(): Map<string, string> {
    return new Map(this.runningTasks);
  }

  /**
   * E4: Append task completion summary to agent MEMORY.md.
   * Knowledge feedback loop -- agents learn from completed work.
   */
  private async appendAgentMemory(task: TaskDefinition): Promise<void> {
    try {
      const agentDir = pathJoin(homedir(), ".openclaw", "agents", task.assignee);
      const memoryFile = pathJoin(agentDir, "MEMORY.md");

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);

      const summaryText = task.result?.summary
        ? task.result.summary.slice(0, 200).replace(/\n/g, " ")
        : "No summary available";

      const entry = [
        "",
        `## Task: ${task.title} (completed ${dateStr})`,
        `Output: ${task.outputPath}`,
        `Summary: ${summaryText}`,
        "",
      ].join("\n");

      await fsPromises.appendFile(memoryFile, entry);
      this.deps.log.debug(
        { agentId: task.assignee, taskId: task.id },
        "task-runner: appended task summary to agent MEMORY.md",
      );
    } catch (err) {
      this.deps.log.warn(
        { err: String(err), agentId: task.assignee, taskId: task.id },
        "task-runner: failed to append to agent MEMORY.md",
      );
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────

  /**
   * Build a CronJob structure from a TaskDefinition.
   * This lets us reuse the existing runIsolatedAgentJob infrastructure.
   */
  private buildJobFromTask(task: TaskDefinition): CronJob {
    const now = Date.now();
    return {
      id: `task:${task.id}`,
      agentId: task.assignee,
      name: `Task: ${task.title}`,
      description: task.description,
      enabled: true,
      deleteAfterRun: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: task.description,
        model: task.model,
        timeoutSeconds: (task.timeout ?? 30) * 60,
      },
      delivery: { mode: "none" },
      state: {},
    };
  }

  /**
   * Build the complete message the agent receives.
   * Includes task context, instructions, input paths, and output expectations.
   */
  private buildTaskMessage(task: TaskDefinition): string {
    const lines: string[] = [];

    lines.push(`# Task: ${task.title}`);
    lines.push(`**Task ID:** ${task.id}`);
    lines.push(`**Priority:** ${task.priority}`);
    lines.push(`**Dispatched by:** ${task.dispatchedBy}`);
    lines.push("");

    lines.push("## Instructions");
    lines.push(task.description);
    lines.push("");

    if (task.inputs.length > 0) {
      lines.push("## Input Files (read these first)");
      for (const input of task.inputs) {
        lines.push(`- ${input}`);
      }
      lines.push("");
    }

    lines.push("## Output Requirements");
    lines.push(`Write your deliverable to: \`${task.outputPath}\``);
    lines.push("The file must exist and be non-empty when you are done.");
    lines.push("");

    if (task.feedback) {
      lines.push("## Previous Feedback (address this)");
      lines.push(task.feedback);
      lines.push("");
    }

    if (task.approvalGates && task.approvalGates.length > 0) {
      lines.push("## Approval Gates");
      lines.push("The following actions require approval before execution:");
      for (const gate of task.approvalGates) {
        lines.push(`- **${gate.type}**: ${gate.description}`);
      }
      lines.push("");
    }

    lines.push("## Progress Reporting");
    lines.push("Use the `task_update` tool to report progress checkpoints.");
    lines.push(
      `Report every ${task.checkpointInterval ?? 10} turns with: progress percentage, summary of what's done, what's remaining.`,
    );
    lines.push("");

    lines.push("## Completion");
    lines.push("When finished, ensure the output file exists at the path above.");
    lines.push("The system will automatically verify the file and mark the task complete.");

    return lines.join("\n");
  }

  /**
   * Verify the output file exists and count its lines.
   * Returns 0 if the file doesn't exist (the task still completes,
   * but the reviewer will see 0 lines in Mission Control).
   */
  private async verifyOutput(outputPath: string): Promise<number> {
    if (this.deps.countFileLines) {
      try {
        return await this.deps.countFileLines(outputPath);
      } catch {
        return 0;
      }
    }
    // Fallback: try to read with fs
    try {
      const { promises: fs } = await import("node:fs");
      const content = await fs.readFile(outputPath, "utf-8");
      return content.split("\n").length;
    } catch {
      return 0;
    }
  }

  /** Broadcast a WebSocket event to connected clients. */
  private broadcastEvent(event: WSEvent): void {
    try {
      this.deps.broadcast("task", event, { dropIfSlow: true });
    } catch {
      // Non-critical — don't let broadcast failures affect task execution
    }
  }
}
