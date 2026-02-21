/**
 * Mission Control API Router
 *
 * Handles all /api/* HTTP requests for Mission Control.
 * Registered as a plugin HTTP handler in the gateway.
 *
 * Security:
 *   - Localhost only (gateway binds to 127.0.0.1)
 *   - Write endpoints (POST, PATCH, PUT) require X-MC-Token header
 *   - Rate limiting: 100 req/min
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/io.js";
import type { RunCronAgentTurnResult } from "../cron/isolated-agent.js";
import { readJsonBody } from "../gateway/hooks.js";
import type { TaskQueue } from "../tasks/TaskQueue.js";
import { handleQueryActivity } from "./handlers/activity.js";
import { handleListAgents, handleGetAgent } from "./handlers/agents.js";
import {
  handleChat,
  handleChatHistory,
  handleChatSessions,
  type ChatHandlerDeps,
} from "./handlers/chat.js";
import { handleQueryComms } from "./handlers/comms.js";
import { handleGetCosts } from "./handlers/costs.js";
import { handleReadDeliverable, handleWriteDeliverable } from "./handlers/deliverables.js";
import { handleListSuggestions, handleUpdateSuggestion } from "./handlers/suggestions.js";
import {
  handleListTasks,
  handleGetTask,
  handleCreateTask,
  handleUpdateTask,
  handleTaskStats,
  handleArchiveOldTasks,
  handleValidateOutputs,
  handleGetComments,
  handleAddComment,
  handleGetRevisions,
  handleAddRevision,
  handleGetTrace,
} from "./handlers/tasks.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MB

// ─── Rate Limiting ───────────────────────────────────────────────

const rateLimitWindow = 60_000; // 1 minute
const rateLimitMax = 100;
let requestTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((ts) => now - ts < rateLimitWindow);
  if (requestTimestamps.length >= rateLimitMax) {
    return true;
  }
  requestTimestamps.push(now);
  return false;
}

// ─── CORS ────────────────────────────────────────────────────────

function resolveCorsOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin ?? "";
  // Allow MC on both ports (3000 = original, 3001 = MC v2)
  if (origin === "http://localhost:3000" || origin === "http://localhost:3001") {
    return origin;
  }
  return "http://localhost:3001";
}

// ─── Response Helpers ────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", origin ?? "http://localhost:3001");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-MC-Token");
  res.end(JSON.stringify(body));
}

function sendCors(res: ServerResponse, origin: string): void {
  res.statusCode = 204;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-MC-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.end();
}

// ─── Router Factory ──────────────────────────────────────────────

export type ApiRouterDeps = {
  taskQueue: TaskQueue;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  writeToken?: string;
  runAgentTurn?: (params: {
    agentId: string;
    message: string;
    sessionKey: string;
  }) => Promise<RunCronAgentTurnResult>;
};

export function createApiRouter(deps: ApiRouterDeps) {
  const { taskQueue, broadcast, writeToken, runAgentTurn } = deps;

  const taskDeps = { taskQueue, broadcast };
  const agentDeps = { taskQueue };
  const activityDeps = { taskQueue };
  const suggestionDeps = { taskQueue, broadcast };
  const costDeps = { taskQueue };
  const chatDeps: ChatHandlerDeps | undefined = runAgentTurn
    ? { runAgentTurn, broadcast }
    : undefined;

  /**
   * Returns true if the request was handled (caller should stop processing).
   * Returns false if this isn't an API request (caller tries next handler).
   */
  return async function handleApiRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Only handle /api/ prefixed paths
    if (!pathname.startsWith("/api/")) {
      return false;
    }

    const origin = resolveCorsOrigin(req);

    // CORS preflight
    if (req.method === "OPTIONS") {
      sendCors(res, origin);
      return true;
    }

    // Rate limiting
    if (isRateLimited()) {
      sendJson(res, 429, { error: "Rate limit exceeded. Max 100 requests per minute." }, origin);
      return true;
    }

    // Write auth check for mutating methods
    const isWrite = req.method === "POST" || req.method === "PATCH" || req.method === "PUT";
    if (isWrite && writeToken) {
      const providedToken = req.headers["x-mc-token"] as string | undefined;
      if (providedToken !== writeToken) {
        sendJson(res, 401, { error: "Missing or invalid X-MC-Token header" }, origin);
        return true;
      }
    }

    // Parse path segments: /api/resource/id/subresource
    const apiPath = pathname.slice(4); // Remove "/api"
    const segments = apiPath.split("/").filter(Boolean);

    try {
      const result = await routeRequest(req.method ?? "GET", segments, url.searchParams, req, {
        taskDeps,
        agentDeps,
        activityDeps,
        suggestionDeps,
        costDeps,
        chatDeps,
      });

      if (!result) {
        sendJson(res, 404, { error: "Not found", path: pathname }, origin);
        return true;
      }

      sendJson(res, result.status, result.body, origin);
      return true;
    } catch (err) {
      sendJson(res, 500, { error: `Internal server error: ${String(err)}` }, origin);
      return true;
    }
  };
}

// ─── Route Dispatch ──────────────────────────────────────────────

type RouteResult = { status: number; body: unknown } | null;

type RouteDeps = {
  taskDeps: {
    taskQueue: TaskQueue;
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  };
  agentDeps: { taskQueue: TaskQueue };
  activityDeps: { taskQueue: TaskQueue };
  suggestionDeps: {
    taskQueue: TaskQueue;
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  };
  costDeps: { taskQueue: TaskQueue };
  chatDeps?: ChatHandlerDeps;
};

async function routeRequest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  req: IncomingMessage,
  deps: RouteDeps,
): Promise<RouteResult> {
  const [resource, id, subResource] = segments;

  // ─── /api/tasks ────────────────────────────────────────────
  if (resource === "tasks") {
    if (!id) {
      if (method === "GET") {
        return handleListTasks(deps.taskDeps, query);
      }
      if (method === "POST") {
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        if (!body.ok) {
          return { status: 400, body: { error: body.error } };
        }
        return handleCreateTask(deps.taskDeps, body.value);
      }
      return null;
    }
    if (id === "stats" && method === "GET") {
      return handleTaskStats(deps.taskDeps);
    }
    if (id === "archive-old" && method === "POST") {
      return handleArchiveOldTasks(deps.taskDeps, query);
    }
    if (id === "validate-outputs" && method === "POST") {
      return handleValidateOutputs(deps.taskDeps);
    }
    // Sub-resources: /api/tasks/:id/comments, /api/tasks/:id/revisions
    if (subResource === "comments") {
      if (method === "GET") {
        return handleGetComments(deps.taskDeps, id);
      }
      if (method === "POST") {
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        if (!body.ok) {
          return { status: 400, body: { error: body.error } };
        }
        return handleAddComment(deps.taskDeps, id, body.value);
      }
      return null;
    }
    if (subResource === "trace" && method === "GET") {
      return handleGetTrace(deps.taskDeps, id);
    }
    if (subResource === "revisions") {
      if (method === "GET") {
        return handleGetRevisions(deps.taskDeps, id);
      }
      if (method === "POST") {
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        if (!body.ok) {
          return { status: 400, body: { error: body.error } };
        }
        return handleAddRevision(deps.taskDeps, id, body.value);
      }
      return null;
    }
    if (!subResource && method === "GET") {
      return handleGetTask(deps.taskDeps, id);
    }
    if (!subResource && method === "PATCH") {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      if (!body.ok) {
        return { status: 400, body: { error: body.error } };
      }
      return handleUpdateTask(deps.taskDeps, id, body.value);
    }
    return null;
  }

  // ─── /api/agents ───────────────────────────────────────────
  if (resource === "agents") {
    if (!id && method === "GET") {
      return handleListAgents(deps.agentDeps);
    }
    if (id && method === "GET") {
      return handleGetAgent(deps.agentDeps, id);
    }
    return null;
  }

  // ─── /api/activity ─────────────────────────────────────────
  if (resource === "activity" && method === "GET") {
    return handleQueryActivity(deps.activityDeps, query);
  }

  // ─── /api/chat ─────────────────────────────────────────────
  if (resource === "chat" && id === "history" && method === "GET") {
    return handleChatHistory(query);
  }
  if (resource === "chat" && id === "sessions" && method === "GET") {
    return handleChatSessions();
  }
  if (resource === "chat" && method === "POST") {
    if (!deps.chatDeps) {
      return {
        status: 503,
        body: { error: "Chat not available \u2014 agent session runner not configured" },
      };
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      return { status: 400, body: { error: body.error } };
    }
    return handleChat(deps.chatDeps, body.value as Record<string, unknown>);
  }

  // ─── /api/deliverables ─────────────────────────────────────
  if (resource === "deliverables") {
    // The file path is everything after /api/deliverables/
    // Absolute paths start with empty string from leading /
    const filePath = "/" + segments.slice(1).join("/");
    // Decode URI components for paths with spaces
    const decoded = decodeURIComponent(filePath);

    if (method === "GET") {
      return handleReadDeliverable(decoded);
    }
    if (method === "PUT") {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      if (!body.ok) {
        return { status: 400, body: { error: body.error } };
      }
      return handleWriteDeliverable(decoded, body.value);
    }
    return null;
  }

  // ─── /api/comms ──────────────────────────────────────────
  if (resource === "comms" && method === "GET") {
    return handleQueryComms(query);
  }

  // ─── /api/suggestions ──────────────────────────────────────
  if (resource === "suggestions") {
    if (!id && method === "GET") {
      return handleListSuggestions(deps.suggestionDeps, query);
    }
    if (id && method === "PATCH") {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      if (!body.ok) {
        return { status: 400, body: { error: body.error } };
      }
      return handleUpdateSuggestion(deps.suggestionDeps, id, body.value);
    }
    return null;
  }

  // --- /api/health -----------------------------------------------
  // jawdoc: lightweight health — skip full agent enumeration to keep event loop free
  if (resource === "health" && method === "GET") {
    const cfg = loadConfig();
    const agentCount = cfg.agents?.list?.length ?? 0;
    const stats = await handleTaskStats(deps.taskDeps);
    return {
      status: 200,
      body: {
        status: "ok",
        uptime: process.uptime(),
        agents: { total: agentCount, online: agentCount },
        tasks: stats?.body ?? {},
        timestamp: new Date().toISOString(),
      },
    };
  }

  // ─── /api/costs ────────────────────────────────────────────
  if (resource === "costs" && method === "GET") {
    return handleGetCosts(deps.costDeps);
  }

  return null;
}
