/**
 * Inter-Agent Communication API Handler
 */

import { queryComms, type CommsType } from "../../agents/comms-logger.js";

// GET /api/comms?from=&to=&type=&since=&limit=
export async function handleQueryComms(
  query: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const from = query.get("from") ?? undefined;
  const to = query.get("to") ?? undefined;
  const type = (query.get("type") as CommsType) ?? undefined;
  const since = query.get("since") ?? undefined;
  const limit = query.has("limit") ? parseInt(query.get("limit")!, 10) : undefined;

  const entries = await queryComms({ from, to, type, since, limit });
  return { status: 200, body: entries };
}
