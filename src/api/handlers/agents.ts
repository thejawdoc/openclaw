import { loadConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getAgentSummary, listAgentSummaries } from "../../tasks/agent-summary.js";
import type { TaskQueue } from "../../tasks/TaskQueue.js";

export type AgentHandlerDeps = {
  taskQueue: TaskQueue;
};

// GET /api/agents
export async function handleListAgents(
  deps: AgentHandlerDeps,
  query?: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const ids = (query?.get("ids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const scope = query?.get("scope")?.trim() ?? "";
  const agents = await listAgentSummaries(deps.taskQueue, {
    ids,
    scope,
  });

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

  const response = await getAgentSummary(deps.taskQueue, agentId);
  if (!response) {
    return { status: 404, body: { error: "Agent not found", agentId } };
  }
  return { status: 200, body: response };
}
