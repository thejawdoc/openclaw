/**
 * Gateway Task Queue + API Integration
 *
 * Initializes the task queue system and registers the API router
 * at gateway startup. Provides global accessors for TaskQueue and TaskScheduler.
 *
 * Pattern matches server-cron.ts — build function + module-level state.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import type { CliDeps } from "../cli/deps.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createApiRouter } from "../api/router.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { getChildLogger } from "../logging.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { TaskQueue } from "../tasks/TaskQueue.js";
import { TaskRunner } from "../tasks/TaskRunner.js";
import { TaskScheduler } from "../tasks/TaskScheduler.js";


// Resolve a lighter model for interactive chat (reads from ~/.openclaw/chat-config.json)
function resolveChatModel(_cfg: OpenClawConfig, agentId: string): string | undefined {
  try {
    const chatCfgPath = join(homedir(), ".openclaw", "chat-config.json");
    const raw = readFileSync(chatCfgPath, "utf-8");
    const chatCfg = JSON.parse(raw);
    const agentOverride = chatCfg?.agentOverrides?.[agentId];
    if (typeof agentOverride === "string") return agentOverride;
    const defaultModel = chatCfg?.defaultModel;
    if (typeof defaultModel === "string") return defaultModel;
    return undefined;
  } catch {
    return undefined;
  }
}

const log = getChildLogger({ module: "tasks" });

// ─── Module-level state (singleton) ──────────────────────────────

let _taskQueue: TaskQueue | null = null;
let _taskRunner: TaskRunner | null = null;
let _taskScheduler: TaskScheduler | null = null;

/** Get the global TaskQueue instance. Throws if not initialized. */
export function getTaskQueue(): TaskQueue {
  if (!_taskQueue) {
    throw new Error("TaskQueue not initialized. Call buildGatewayTaskSystem() first.");
  }
  return _taskQueue;
}

/** Get the global TaskRunner instance. Returns null if not initialized. */
export function getTaskRunner(): TaskRunner | null {
  return _taskRunner;
}

/** Get the global TaskScheduler instance. Returns null if not initialized. */
export function getTaskScheduler(): TaskScheduler | null {
  return _taskScheduler;
}

// ─── Builder ─────────────────────────────────────────────────────

export type GatewayTaskState = {
  taskQueue: TaskQueue;
  taskRunner: TaskRunner;
  taskScheduler: TaskScheduler;
};

export async function buildGatewayTaskSystem(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  pluginRegistry?: PluginRegistry;
}): Promise<GatewayTaskState> {
  const { cfg, deps, broadcast, pluginRegistry } = params;
  const taskQueueConfig = cfg.taskQueue;

  // Resolve storage directory
  const storeDir = taskQueueConfig?.store ?? join(process.env.HOME ?? "~", ".openclaw", "tasks");

  // Create and initialize TaskQueue
  const taskQueue = new TaskQueue(storeDir);
  await taskQueue.initialize();
  log.info({ storeDir }, "task queue initialized");

  // Create TaskRunner
  const taskRunner = new TaskRunner({
    taskQueue,
    runIsolatedAgentJob: async ({ job, message }) => {
      const runtimeConfig = loadConfig();
      const agentId = job.agentId
        ? normalizeAgentId(job.agentId)
        : resolveDefaultAgentId(runtimeConfig);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps,
        job,
        message,
        agentId,
        sessionKey: `task:${job.id}`,
        lane: "task",
      });
    },
    requestHeartbeatNow,
    broadcast,
    log,
  });

  // Create TaskScheduler
  const pollIntervalMs = taskQueueConfig?.pollIntervalMs ?? 30_000;
  const taskScheduler = new TaskScheduler(
    {
      taskRunner,
      taskQueue,
      getAgentIds: () => {
        const runtimeConfig = loadConfig();
        const agents = runtimeConfig.agents?.list ?? [];
        return agents.map((a) => normalizeAgentId(a.id)).filter(Boolean);
      },
      broadcast,
      log,
    },
    { intervalMs: pollIntervalMs },
  );

  // Set module-level singletons
  _taskQueue = taskQueue;
  _taskRunner = taskRunner;
  _taskScheduler = taskScheduler;

  // Register API router as plugin HTTP handler
  if (pluginRegistry) {
    const writeToken =
      typeof cfg.api?.auth?.writeToken === "string" ? cfg.api.auth.writeToken : undefined;

    // Chat: wrap runCronIsolatedAgentTurn for the /api/chat endpoint
    const runAgentTurn = async (chatParams: {
      agentId: string;
      message: string;
      sessionKey: string;
      onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
    }) => {
      const { agentId, message, sessionKey, onBlockReply } = chatParams;
      const runtimeConfig = loadConfig();
      const resolvedAgentId = agentId
        ? normalizeAgentId(agentId)
        : resolveDefaultAgentId(runtimeConfig);
      return await runCronIsolatedAgentTurn({
        cfg: runtimeConfig,
        deps,
        job: {
          id: `chat-${Date.now()}`,
          agentId: resolvedAgentId,
          name: "Mission Control Chat",
          enabled: true,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          schedule: { kind: "at", at: new Date().toISOString() },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message, model: resolveChatModel(runtimeConfig, resolvedAgentId) },
          state: {},
        },
        message,
        agentId: resolvedAgentId,
        sessionKey,
        lane: "chat",
        ...(onBlockReply ? { onBlockReply } : {}),
      });
    };

    const handleApiRequest = createApiRouter({
      taskQueue,
      broadcast,
      writeToken,
      runAgentTurn,
    });

    pluginRegistry.httpHandlers.push({
      pluginId: "openclaw-task-api",
      handler: handleApiRequest,
      source: "server-tasks.ts",
    });

    log.info({}, "task API router registered (with chat)");
  }

  log.info({ pollIntervalMs, agents: cfg.agents?.list?.length ?? 0 }, "task system ready");

  return { taskQueue, taskRunner, taskScheduler };
}

/** Stop the task system (for shutdown/reload). */
export function stopTaskSystem(): void {
  _taskScheduler?.stop();
  _taskScheduler = null;
  _taskRunner = null;
  _taskQueue = null;
  log.info({}, "task system stopped");
}
