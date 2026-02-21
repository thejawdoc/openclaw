/**
 * TaskScheduler — Periodic task queue polling
 *
 * Runs independently from the heartbeat system. Checks the task queue
 * for pending tasks on a configurable interval and dispatches them
 * via TaskRunner.
 *
 * Also performs periodic maintenance:
 *   - Auto-archives old terminal tasks (every hour)
 *   - Validates output files for completed tasks (every hour)
 *
 * Why separate from heartbeat:
 *   - Heartbeat events don't include agentId (no way to target)
 *   - Task execution is fundamentally different from heartbeat keepalive
 *   - Independent polling allows different intervals
 *   - Cleaner separation of concerns
 *
 * Integration points:
 *   1. Gateway startup creates and starts the scheduler
 *   2. task_dispatch tool calls scheduler.wakeAgent(agentId) for immediate pickup
 *   3. requestHeartbeatNow() still works as a general wake signal
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskQueue } from "./TaskQueue.js";
import type { TaskRunner } from "./TaskRunner.js";

export type TaskSchedulerDeps = {
  taskRunner: TaskRunner;
  taskQueue: TaskQueue;
  /** Resolve the list of agent IDs from config */
  getAgentIds: () => string[];
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  log: {
    debug: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
};

export type TaskSchedulerOptions = {
  /** Polling interval in milliseconds (default: 30000 = 30s) */
  intervalMs?: number;
  /** Maintenance interval in milliseconds (default: 3600000 = 1 hour) */
  maintenanceIntervalMs?: number;
  /** Auto-archive tasks older than N days (default: 7) */
  archiveAfterDays?: number;
  /** Whether to start polling immediately (default: true) */
  autoStart?: boolean;
};

const DEFAULT_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_MAINTENANCE_INTERVAL_MS = 3_600_000; // 1 hour
const DEFAULT_ARCHIVE_AFTER_DAYS = 7;

export class TaskScheduler {
  private deps: TaskSchedulerDeps;
  private intervalMs: number;
  private maintenanceIntervalMs: number;
  private archiveAfterDays: number;
  private timer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private running = false;
  private maintenanceRunning = false;
  private stopped = false;
  /** Pending wake requests (agent IDs to check immediately) */
  private pendingWakes: Set<string> = new Set();
  /** Track last morning brief date to avoid duplicates */
  private lastBriefDate: string | null = null;
  /** Immediate wake timer (short debounce) */
  private wakeTimer: NodeJS.Timeout | null = null;

  constructor(deps: TaskSchedulerDeps, options: TaskSchedulerOptions = {}) {
    this.deps = deps;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.archiveAfterDays = options.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS;
    if (options.autoStart !== false) {
      this.start();
    }
  }

  /** Start the periodic polling loop and maintenance loop. */
  start(): void {
    if (this.stopped || this.timer) {
      return;
    }

    this.deps.log.info({ intervalMs: this.intervalMs }, "task-scheduler: started");

    // Initial check on startup (after a short delay to let gateway finish init)
    setTimeout(() => this.tick(), 120_000); // jawdoc: delay initial sweep to unblock HTTP

    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.(); // Don't prevent process exit

    // Start maintenance loop (auto-archive + output validation)
    // First maintenance run after 60 seconds (let system stabilize)
    setTimeout(() => this.maintenanceTick(), 60_000);
    this.maintenanceTimer = setInterval(() => this.maintenanceTick(), this.maintenanceIntervalMs);
    this.maintenanceTimer.unref?.();

    this.deps.log.info(
      {
        maintenanceIntervalMs: this.maintenanceIntervalMs,
        archiveAfterDays: this.archiveAfterDays,
      },
      "task-scheduler: maintenance loop started",
    );
  }

  /** Stop the scheduler. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    this.deps.log.info({}, "task-scheduler: stopped");
  }

  /**
   * Wake a specific agent to check for tasks immediately.
   * Called by task_dispatch after creating a new task.
   * Debounced to 500ms to coalesce multiple dispatches.
   */
  wakeAgent(agentId: string): void {
    this.pendingWakes.add(agentId);

    if (this.wakeTimer) {
      return;
    } // Already scheduled

    this.wakeTimer = setTimeout(async () => {
      this.wakeTimer = null;
      const agents = [...this.pendingWakes];
      this.pendingWakes.clear();

      for (const id of agents) {
        try {
          await this.deps.taskRunner.checkAndRun(id);
        } catch (err) {
          this.deps.log.error(
            { err: String(err), agentId: id },
            "task-scheduler: wake check failed",
          );
        }
      }
    }, 500);
    this.wakeTimer.unref?.();
  }

  /** Wake ALL agents to check for tasks immediately. */
  wakeAll(): void {
    for (const agentId of this.deps.getAgentIds()) {
      this.wakeAgent(agentId);
    }
  }

  /** Single poll cycle: check all agents for pending tasks. */
  private async tick(): Promise<void> {
    if (this.running || this.stopped) {
      return;
    }
    this.running = true;

    try {
      const agentIds = this.deps.getAgentIds();
      for (const agentId of agentIds) {
        if (this.stopped) {
          break;
        }
        try {
          await this.deps.taskRunner.checkAndRun(agentId);
        } catch (err) {
          this.deps.log.error({ err: String(err), agentId }, "task-scheduler: agent check failed");
        }
      }
    } catch (err) {
      this.deps.log.error({ err: String(err) }, "task-scheduler: tick failed");
    } finally {
      this.running = false;
    }
  }

  /**
   * Maintenance tick: auto-archive old tasks and validate output files.
   * Runs on a separate interval (default: hourly).
   */
  private async maintenanceTick(): Promise<void> {
    if (this.maintenanceRunning || this.stopped) {
      return;
    }
    this.maintenanceRunning = true;

    try {
      // 1. Auto-archive old terminal tasks
      try {
        const archivedCount = await this.deps.taskQueue.archiveOldTasks(this.archiveAfterDays);
        if (archivedCount > 0) {
          this.deps.log.info(
            { archivedCount, olderThanDays: this.archiveAfterDays },
            "task-scheduler: auto-archived old tasks",
          );
        }
      } catch (err) {
        this.deps.log.error({ err: String(err) }, "task-scheduler: auto-archive failed");
      }

      // 2. Validate output files for completed/approved tasks
      try {
        const failures = await this.deps.taskQueue.validateOutputFiles();
        if (failures.length > 0) {
          this.deps.log.warn(
            {
              failureCount: failures.length,
              taskIds: failures.map((f) => f.taskId),
            },
            "task-scheduler: found tasks with missing output files",
          );

          // Mark tasks with missing outputs as failed
          for (const failure of failures) {
            try {
              await this.deps.taskQueue.update(failure.taskId, {
                status: "failed",
                feedback: `Output file missing: ${failure.outputPath}`,
              });
              this.deps.log.warn(
                { taskId: failure.taskId, outputPath: failure.outputPath },
                "task-scheduler: marked task as failed due to missing output",
              );
            } catch (err) {
              // Transition may not be valid for all states, log and continue
              this.deps.log.error(
                { err: String(err), taskId: failure.taskId },
                "task-scheduler: could not mark task as failed",
              );
            }
          }
        }
      } catch (err) {
        this.deps.log.error({ err: String(err) }, "task-scheduler: output validation failed");
      }
      // 3. Morning brief — run once daily after 6 AM
      try {
        await this.morningBriefCheck();
      } catch (err) {
        this.deps.log.error({ err: String(err) }, "task-scheduler: morning brief failed");
      }

      // 4. Suggestion generation — cross-vertical analysis (F4)
      try {
        await this.generateSuggestions();
      } catch (err) {
        this.deps.log.error({ err: String(err) }, "task-scheduler: suggestion generation failed");
      }
    } finally {
      this.maintenanceRunning = false;
    }
  }

  /**
   * F4: Generate cross-vertical suggestions from recent completed tasks.
   * Looks for patterns: repeated failures, complementary work across agents,
   * tasks that could benefit from chaining, and optimization opportunities.
   */
  private async generateSuggestions(): Promise<void> {
    const tasks = await this.deps.taskQueue.list({});
    const now = Date.now();
    const ONE_DAY = 86_400_000;

    // Get recent completed tasks (last 24h)
    const recentCompleted = tasks.filter(
      (t) =>
        t.status === "completed" &&
        t.result?.completedAt &&
        now - new Date(t.result.completedAt).getTime() < ONE_DAY,
    );

    // Get recent failures (last 24h)
    const recentFailed = tasks.filter(
      (t) => t.status === "failed" && now - new Date(t.dispatchedAt).getTime() < ONE_DAY,
    );

    // Get existing pending suggestions to avoid duplicates
    const existingSuggestions = await this.deps.taskQueue.listSuggestions("pending");
    const existingTitles = new Set(existingSuggestions.map((s) => s.title));

    const newSuggestions: Array<{
      title: string;
      description: string;
      sourceAgent: string;
      targetAgent: string;
      relatedTaskId?: string;
    }> = [];

    // Pattern 1: Repeated failures by same agent — suggest investigation
    const failuresByAgent: Record<string, number> = {};
    for (const task of recentFailed) {
      failuresByAgent[task.assignee] = (failuresByAgent[task.assignee] ?? 0) + 1;
    }
    for (const [agent, count] of Object.entries(failuresByAgent)) {
      if (count >= 2) {
        const title = `Investigate repeated failures for ${agent}`;
        if (!existingTitles.has(title)) {
          newSuggestions.push({
            title,
            description: `${agent} has ${count} failed tasks in the last 24h. Consider reviewing agent configuration, tool access, or task complexity.`,
            sourceAgent: "archon",
            targetAgent: agent,
          });
        }
      }
    }

    // Pattern 2: Completed work that could feed into other verticals
    for (const task of recentCompleted) {
      // Toothsome work that could inform content
      if (task.assignee.includes("toothsome") && task.title.toLowerCase().includes("feature")) {
        const title = `Create content about new Toothsome feature: ${task.title.slice(0, 60)}`;
        if (!existingTitles.has(title)) {
          newSuggestions.push({
            title,
            description: `Completed Toothsome task "${task.title}" may warrant a blog post or social media content.`,
            sourceAgent: task.assignee,
            targetAgent: "content-head",
            relatedTaskId: task.id,
          });
        }
      }

      // High-cost tasks that could be optimized
      if (task.result && task.result.totalCost > 1.0) {
        const title = `Optimize high-cost task: ${task.title.slice(0, 60)}`;
        if (!existingTitles.has(title)) {
          newSuggestions.push({
            title,
            description: `Task "${task.title}" cost $${task.result.totalCost.toFixed(2)}. Consider using a lower-tier model or breaking into smaller tasks.`,
            sourceAgent: task.assignee,
            targetAgent: "archon",
            relatedTaskId: task.id,
          });
        }
      }
    }

    // Create suggestions (max 3 per cycle to avoid noise)
    let created = 0;
    for (const suggestion of newSuggestions.slice(0, 3)) {
      try {
        await this.deps.taskQueue.createSuggestion(suggestion);
        created++;
      } catch (err) {
        this.deps.log.warn(
          { err: String(err), title: suggestion.title },
          "task-scheduler: failed to create suggestion",
        );
      }
    }

    if (created > 0) {
      this.deps.log.info(
        { created, total: newSuggestions.length },
        "task-scheduler: generated new suggestions",
      );
    }
  }

  /**
   * E2: Morning brief — reads yesterday's activity ledger, formats
   * a summary, and broadcasts it as a daily:brief event.
   * Only runs once per day, after 6 AM.
   */
  private async morningBriefCheck(): Promise<void> {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Already sent today?
    if (this.lastBriefDate === todayStr) {
      return;
    }

    // Only after 6 AM
    if (now.getHours() < 6) {
      return;
    }

    const yesterday = new Date(now.getTime() - 86_400_000);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const ledgerPath = join(homedir(), ".openclaw", "activity", yesterdayStr + ".jsonl");

    let lines: string[];
    try {
      const raw = await fs.readFile(ledgerPath, "utf-8");
      lines = raw.trim().split("\n").filter(Boolean);
    } catch {
      // No activity yesterday
      this.lastBriefDate = todayStr;
      this.deps.log.debug({}, "task-scheduler: no activity ledger for yesterday, skipping brief");
      return;
    }

    // Parse and aggregate
    let created = 0,
      completed = 0,
      failed = 0,
      statusChanges = 0;
    let totalInputTokens = 0,
      totalOutputTokens = 0;
    const agentActivity: Record<string, number> = {};

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.action === "task_created") {
          created++;
        } else if (entry.action === "task_completed") {
          completed++;
          if (entry.tokensSummary) {
            totalInputTokens += entry.tokensSummary.input ?? 0;
            totalOutputTokens += entry.tokensSummary.output ?? 0;
          }
        } else if (entry.action === "status_change") {
          statusChanges++;
          if (entry.to === "failed") {
            failed++;
          }
        }
        if (entry.agent) {
          agentActivity[entry.agent] = (agentActivity[entry.agent] ?? 0) + 1;
        }
      } catch {
        // Skip malformed entries
      }
    }

    const brief = {
      date: yesterdayStr,
      summary: {
        tasksCreated: created,
        tasksCompleted: completed,
        tasksFailed: failed,
        totalStatusChanges: statusChanges,
        totalEvents: lines.length,
        tokens: { input: totalInputTokens, output: totalOutputTokens },
      },
      agentActivity,
      message: [
        `Daily Brief for ${yesterdayStr}:`,
        `  ${created} tasks created, ${completed} completed, ${failed} failed`,
        `  ${lines.length} total events across ${Object.keys(agentActivity).length} agents`,
        totalInputTokens > 0
          ? `  Tokens: ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };

    this.deps.broadcast("daily:brief", brief, { dropIfSlow: true });
    this.lastBriefDate = todayStr;
    this.deps.log.info(
      { date: yesterdayStr, created, completed, failed, events: lines.length },
      "task-scheduler: morning brief sent",
    );
  }

  /** Update polling interval (e.g. from config reload). */
  updateInterval(intervalMs: number): void {
    if (intervalMs === this.intervalMs) {
      return;
    }
    this.intervalMs = intervalMs;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      this.timer.unref?.();
    }
    this.deps.log.info({ intervalMs }, "task-scheduler: interval updated");
  }
}
