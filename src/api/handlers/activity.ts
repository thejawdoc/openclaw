/**
 * Activity Ledger API Handler
 *
 * Queries the activity ledger with date/agent/type filters.
 */

import type { TaskQueue } from "../../tasks/TaskQueue.js";

export type ActivityHandlerDeps = {
  taskQueue: TaskQueue;
};

// GET /api/activity
export async function handleQueryActivity(
  deps: ActivityHandlerDeps,
  query: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const from = query.get("from") ?? undefined;
  const to = query.get("to") ?? undefined;
  const agent = query.get("agent") ?? undefined;
  const type = query.get("type") as
    | "task"
    | "approval"
    | "agent"
    | "alert"
    | "system"
    | "cost"
    | undefined;
  const limit = query.has("limit") ? parseInt(query.get("limit")!, 10) : 100;
  const entries = await deps.taskQueue.queryActivity({
    from,
    to,
    agent,
    type,
    limit,
  });

  return { status: 200, body: entries };
}
