/**
 * Suggestion Queue API Handlers
 *
 * Cross-vertical suggestion management.
 */

import type { TaskQueue } from "../../tasks/TaskQueue.js";
import type { Suggestion } from "../../tasks/types.js";

export type SuggestionHandlerDeps = {
  taskQueue: TaskQueue;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
};

// GET /api/suggestions
export async function handleListSuggestions(
  deps: SuggestionHandlerDeps,
  query: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const status = query.get("status") as Suggestion["status"] | null;
  const suggestions = await deps.taskQueue.listSuggestions(status ?? undefined);
  return { status: 200, body: suggestions };
}

// PATCH /api/suggestions/:id
export async function handleUpdateSuggestion(
  deps: SuggestionHandlerDeps,
  suggestionId: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: "Request body must be a JSON object" } };
  }

  const req = body as Record<string, unknown>;
  const status = req.status as Suggestion["status"] | undefined;
  const discussion = typeof req.discussion === "string" ? req.discussion : undefined;

  if (!status && !discussion) {
    return { status: 400, body: { error: "Must provide 'status' and/or 'discussion' field" } };
  }

  const validStatuses = ["pending", "accepted", "dismissed", "discussed"];
  if (status && !validStatuses.includes(status)) {
    return {
      status: 400,
      body: { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
    };
  }

  try {
    const updated = await deps.taskQueue.updateSuggestion(suggestionId, {
      status,
      discussion,
    });

    if (status === "accepted") {
      deps.broadcast(
        "suggestion:accepted",
        { suggestionId, taskId: updated.relatedTaskId },
        { dropIfSlow: true },
      );
    }

    return { status: 200, body: updated };
  } catch (err) {
    const message = String(err);
    if (message.includes("not found")) {
      return { status: 404, body: { error: "Suggestion not found", suggestionId } };
    }
    return { status: 500, body: { error: message } };
  }
}
