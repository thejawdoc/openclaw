/**
 * Agent Status API Handlers
 *
 * Returns agent health, current task, cost data.
 */

import fs from "node:fs";
import type { TaskQueue } from "../../tasks/TaskQueue.js";
import type { AgentStatusResponse } from "../../tasks/types.js";
import { loadConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";

export type AgentHandlerDeps = {
  taskQueue: TaskQueue;
};

// GET /api/agents
export async function handleListAgents(
  deps: AgentHandlerDeps,
): Promise<{ status: number; body: unknown }> {
  const cfg = loadConfig();
  const agentList = cfg.agents?.list ?? [];
  const agents: AgentStatusResponse[] = [];

  for (const agent of agentList) {
    const agentId = normalizeAgentId(agent.id);
    const response = await buildAgentStatus(deps, agentId, agent);
    agents.push(response);
  }

  return { status: 200, body: agents };
}

// GET /api/agents/:id
export async function handleGetAgent(
  deps: AgentHandlerDeps,
  agentId: string,
): Promise<{ status: number; body: unknown }> {
  const cfg = loadConfig();
  const agentList = cfg.agents?.list ?? [];
  const agent = agentList.find((a) => normalizeAgentId(a.id) === agentId);

  if (!agent) {
    return { status: 404, body: { error: "Agent not found", agentId } };
  }

  const response = await buildAgentStatus(deps, agentId, agent);
  return { status: 200, body: response };
}

async function buildAgentStatus(
  deps: AgentHandlerDeps,
  agentId: string,
  agentConfig: Record<string, unknown>,
): Promise<AgentStatusResponse> {
  // Find current active task
  const activeTasks = await deps.taskQueue.list({
    agentId,
    status: "in_progress",
    limit: 1,
  });
  const activeTask = activeTasks[0];

  // Find blocked tasks
  const blockedTasks = await deps.taskQueue.list({
    agentId,
    status: "blocked",
    limit: 1,
  });

  // Determine agent status
  let status: AgentStatusResponse["status"] = "idle";
  if (activeTask) {
    status = "working";
  } else if (blockedTasks.length > 0) {
    status = "blocked";
  }

  // Calculate costs from completed tasks
  const allTasks = await deps.taskQueue.list({ agentId });
  const costs = calculateCosts(allTasks);

  // Determine lastHeartbeat from session file mtime
  let lastHeartbeat: string | undefined;
  try {
    const sessionsStorePath = resolveDefaultSessionStorePath(agentId);
    const stat = fs.statSync(sessionsStorePath);
    lastHeartbeat = stat.mtime.toISOString();
  } catch {
    // No sessions file — agent has never run
  }

  // Determine sandbox tier
  const sandbox = agentConfig.sandbox as Record<string, unknown> | undefined;
  const sandboxMode = sandbox?.mode as string | undefined;
  const sandboxEnabled = sandboxMode !== "off";
  let tier: 0 | 1 | 2 = 2;
  if (!sandboxEnabled) {
    tier = 0;
  } else {
    const docker = sandbox?.docker as Record<string, unknown> | undefined;
    if (docker?.network === "none" || docker?.readOnlyRoot === true) {
      tier = 1;
    }
  }

  // Get model
  const model = ((agentConfig.model as Record<string, unknown>)?.primary as string) ?? "unknown";

  // Use the newer of task dispatch date and session file mtime for lastActivity
  const taskActivity = allTasks.length > 0 ? allTasks[0].dispatchedAt : undefined;
  const lastActivity = lastHeartbeat && taskActivity
    ? (new Date(lastHeartbeat) > new Date(taskActivity) ? lastHeartbeat : taskActivity)
    : lastHeartbeat ?? taskActivity;

  return {
    id: agentId,
    status,
    currentTask: activeTask
      ? {
          id: activeTask.id,
          title: activeTask.title,
          progress:
            activeTask.checkpoints.length > 0
              ? activeTask.checkpoints[activeTask.checkpoints.length - 1].progress
              : 0,
        }
      : undefined,
    lastHeartbeat,
    lastActivity,
    model,
    sandbox: {
      enabled: sandboxEnabled,
      tier,
    },
    costs,
  };
}

function calculateCosts(
  tasks: Array<{
    result?: { totalCost: number; completedAt?: string };
    checkpoints: Array<{ cost: number; timestamp: string }>;
  }>,
): { today: number; thisWeek: number; thisMonth: number } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
  ).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  let today = 0;
  let thisWeek = 0;
  let thisMonth = 0;

  for (const task of tasks) {
    if (!task.result) {
      continue;
    }
    const completedAt = task.result.completedAt ?? "";
    const cost = task.result.totalCost;

    if (completedAt >= monthStart) {
      thisMonth += cost;
      if (completedAt >= weekStart) {
        thisWeek += cost;
        if (completedAt >= todayStart) {
          today += cost;
        }
      }
    }
  }

  return { today, thisWeek, thisMonth };
}
