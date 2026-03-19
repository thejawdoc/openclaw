import { loadConfig } from "../config/config.js";
import { loadCombinedSessionStoreForGateway } from "../gateway/session-utils.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type {
  ActivityEntry,
  AgentRecentActivityItem,
  AgentStatusResponse,
  TaskDefinition,
} from "./types.js";

export const PRIMARY_AGENT_IDS = [
  "archon",
  "biz-ops",
  "toothsome-head",
  "niva-head",
  "content-head",
  "academic-head",
  "personal-head",
  "fap-head",
  "inspector",
] as const;

const CACHE_TTL_MS = 3_000;

type TaskQueueLike = {
  list: (query?: { limit?: number }) => Promise<TaskDefinition[]>;
  queryActivity: (params?: { limit?: number }) => Promise<ActivityEntry[]>;
};

type AgentSummaryRow = AgentStatusResponse;

type AgentAggregate = {
  currentTask?: {
    id: string;
    title: string;
    progress: number;
    dispatchedAt: string;
  };
  blocked: boolean;
  lastSessionAtMs?: number;
  lastTaskActivity?: string;
  recentActivity: AgentRecentActivityItem[];
  costs: {
    today: number;
    thisWeek: number;
    thisMonth: number;
  };
};

let cachedSnapshot: {
  createdAtMs: number;
  rows: AgentSummaryRow[];
} | null = null;

function toIso(ts?: number): string | undefined {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0
    ? new Date(ts).toISOString()
    : undefined;
}

function normalizeRequestedIds(ids?: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids ?? []) {
    const id = normalizeAgentId(raw);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

function buildRecentActivityItem(entry: ActivityEntry): AgentRecentActivityItem {
  const detail = entry.details ?? {};
  const title = typeof detail.title === "string" ? detail.title.trim() : "";
  const summary = typeof detail.summary === "string" ? detail.summary.trim() : "";
  const error = typeof detail.error === "string" ? detail.error.trim() : "";
  const label = title || summary || error || entry.action;
  return {
    timestamp: entry.timestamp,
    action: entry.action,
    label,
    taskId: entry.taskId,
  };
}

function calculateSandboxTier(agentConfig: Record<string, unknown>): {
  enabled: boolean;
  tier: 0 | 1 | 2;
} {
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
  return { enabled: sandboxEnabled, tier };
}

function resolveModel(agentConfig: Record<string, unknown>): string {
  const model = agentConfig.model;
  if (typeof model === "string" && model.trim()) {
    return model.trim();
  }
  if (model && typeof model === "object") {
    const primary = (model as Record<string, unknown>).primary;
    if (typeof primary === "string" && primary.trim()) {
      return primary.trim();
    }
  }
  return "unknown";
}

function resolveLastActivity(aggregate: AgentAggregate): string | undefined {
  const sessionIso = toIso(aggregate.lastSessionAtMs);
  const taskIso = aggregate.lastTaskActivity;
  if (sessionIso && taskIso) {
    return new Date(sessionIso) > new Date(taskIso) ? sessionIso : taskIso;
  }
  return sessionIso ?? taskIso;
}

function filterRows(
  rows: AgentSummaryRow[],
  params?: { ids?: readonly string[]; scope?: string },
): AgentSummaryRow[] {
  const ids = normalizeRequestedIds(params?.ids);
  if (ids.length > 0) {
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  if (params?.scope === "primary") {
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    return PRIMARY_AGENT_IDS.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  return rows;
}

function buildRowsFromSnapshot(
  taskRows: TaskDefinition[],
  activityRows: ActivityEntry[],
): AgentSummaryRow[] {
  const cfg = loadConfig();
  const agentList = cfg.agents?.list ?? [];
  const aggregates = new Map<string, AgentAggregate>();
  const ensureAggregate = (agentId: string): AgentAggregate => {
    const existing = aggregates.get(agentId);
    if (existing) {
      return existing;
    }
    const next: AgentAggregate = {
      blocked: false,
      recentActivity: [],
      costs: { today: 0, thisWeek: 0, thisMonth: 0 },
    };
    aggregates.set(agentId, next);
    return next;
  };

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay(),
  ).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  for (const task of taskRows) {
    const agentId = normalizeAgentId(task.assignee);
    const aggregate = ensureAggregate(agentId);

    if (task.status === "in_progress") {
      const progress =
        task.checkpoints.length > 0 ? task.checkpoints[task.checkpoints.length - 1].progress : 0;
      if (!aggregate.currentTask || task.dispatchedAt > aggregate.currentTask.dispatchedAt) {
        aggregate.currentTask = {
          id: task.id,
          title: task.title,
          progress,
          dispatchedAt: task.dispatchedAt,
        };
      }
    }
    if (task.status === "blocked") {
      aggregate.blocked = true;
    }

    const candidateTimes = [
      task.dispatchedAt,
      task.archivedAt,
      task.result?.completedAt,
      task.checkpoints[task.checkpoints.length - 1]?.timestamp,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const timestamp of candidateTimes) {
      if (!aggregate.lastTaskActivity || timestamp > aggregate.lastTaskActivity) {
        aggregate.lastTaskActivity = timestamp;
      }
    }

    if (!task.result) {
      continue;
    }
    const completedAt = task.result.completedAt ?? "";
    const cost = task.result.totalCost;
    if (completedAt >= monthStart) {
      aggregate.costs.thisMonth += cost;
      if (completedAt >= weekStart) {
        aggregate.costs.thisWeek += cost;
        if (completedAt >= todayStart) {
          aggregate.costs.today += cost;
        }
      }
    }
  }

  for (const entry of activityRows) {
    if (!entry.agent) {
      continue;
    }
    const agentId = normalizeAgentId(entry.agent);
    const aggregate = ensureAggregate(agentId);
    if (aggregate.recentActivity.length >= 3) {
      continue;
    }
    aggregate.recentActivity.push(buildRecentActivityItem(entry));
  }

  const combinedStore = loadCombinedSessionStoreForGateway(cfg).store;
  for (const [key, entry] of Object.entries(combinedStore)) {
    const parsed = parseAgentSessionKey(key);
    const agentId = normalizeAgentId(parsed?.agentId ?? "");
    if (!agentId) {
      continue;
    }
    const updatedAt = typeof entry?.updatedAt === "number" ? entry.updatedAt : 0;
    if (updatedAt <= 0) {
      continue;
    }
    const aggregate = ensureAggregate(agentId);
    aggregate.lastSessionAtMs = Math.max(aggregate.lastSessionAtMs ?? 0, updatedAt);
  }

  return agentList.map((agent) => {
    const agentId = normalizeAgentId(agent.id);
    const aggregate = aggregates.get(agentId) ?? {
      blocked: false,
      recentActivity: [],
      costs: { today: 0, thisWeek: 0, thisMonth: 0 },
    };
    const status: AgentStatusResponse["status"] = aggregate.currentTask
      ? "working"
      : aggregate.blocked
        ? "blocked"
        : "idle";
    const lastHeartbeat = toIso(aggregate.lastSessionAtMs);

    return {
      id: agentId,
      status,
      blocked: aggregate.blocked,
      currentTask: aggregate.currentTask
        ? {
            id: aggregate.currentTask.id,
            title: aggregate.currentTask.title,
            progress: aggregate.currentTask.progress,
          }
        : undefined,
      lastHeartbeat,
      lastActivity: resolveLastActivity(aggregate),
      model: resolveModel(agent as Record<string, unknown>),
      sandbox: calculateSandboxTier(agent as Record<string, unknown>),
      costs: aggregate.costs,
      recentActivity: aggregate.recentActivity,
    };
  });
}

export function invalidateAgentSummaryCache(): void {
  cachedSnapshot = null;
}

async function getCachedSnapshot(taskQueue: TaskQueueLike): Promise<AgentSummaryRow[]> {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.createdAtMs < CACHE_TTL_MS) {
    return cachedSnapshot.rows;
  }

  const [taskRows, activityRows] = await Promise.all([
    taskQueue.list({ limit: 10_000 }),
    taskQueue.queryActivity({ limit: 500 }),
  ]);
  const rows = buildRowsFromSnapshot(taskRows, activityRows);
  cachedSnapshot = {
    createdAtMs: now,
    rows,
  };
  return rows;
}

export async function listAgentSummaries(
  taskQueue: TaskQueueLike,
  params?: { ids?: readonly string[]; scope?: string },
): Promise<AgentSummaryRow[]> {
  const rows = await getCachedSnapshot(taskQueue);
  return filterRows(rows, params);
}

export async function getAgentSummary(
  taskQueue: TaskQueueLike,
  agentId: string,
): Promise<AgentSummaryRow | null> {
  const rows = await getCachedSnapshot(taskQueue);
  const normalizedId = normalizeAgentId(agentId);
  return rows.find((row) => row.id === normalizedId) ?? null;
}
