/**
 * Deliverable File API Handlers
 *
 * Read and write deliverable files from disk.
 * Used by Mission Control's inline editor.
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

// Allowed base directories for deliverable access
const ALLOWED_BASES = [
  resolve(process.env.HOME ?? "~", "Vaults/jawdoc-brain"),
  resolve(process.env.HOME ?? "~", "Projects/jawdoc-brain"),
  resolve(process.env.HOME ?? "~", ".openclaw/tasks"),
  resolve(process.env.HOME ?? "~", ".openclaw/agents"),
];

function isAllowedPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  return ALLOWED_BASES.some((base) => resolved.startsWith(base));
}

// GET /api/deliverables/*
export async function handleReadDeliverable(
  filePath: string,
): Promise<{ status: number; body: unknown; contentType?: string }> {
  if (!filePath) {
    return { status: 400, body: { error: "Missing file path" } };
  }

  const resolved = resolve(filePath);
  if (!isAllowedPath(resolved)) {
    return { status: 403, body: { error: "Access denied: path outside allowed directories" } };
  }

  try {
    const stats = await stat(resolved);
    if (!stats.isFile()) {
      return { status: 400, body: { error: "Path is not a file" } };
    }

    const content = await readFile(resolved, "utf-8");
    const lines = content.split("\n").length;

    return {
      status: 200,
      body: {
        path: resolved,
        content,
        lines,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: 404, body: { error: "File not found", path: resolved } };
    }
    return { status: 500, body: { error: `Failed to read file: ${String(err)}` } };
  }
}

// PUT /api/deliverables/*
export async function handleWriteDeliverable(
  filePath: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  if (!filePath) {
    return { status: 400, body: { error: "Missing file path" } };
  }

  const resolved = resolve(filePath);
  if (!isAllowedPath(resolved)) {
    return { status: 403, body: { error: "Access denied: path outside allowed directories" } };
  }

  if (!body || typeof body !== "object") {
    return {
      status: 400,
      body: { error: "Request body must be a JSON object with 'content' field" },
    };
  }

  const content = (body as Record<string, unknown>).content;
  if (typeof content !== "string") {
    return { status: 400, body: { error: "Missing 'content' field (string)" } };
  }

  try {
    await writeFile(resolved, content, "utf-8");
    const stats = await stat(resolved);
    const lines = content.split("\n").length;

    return {
      status: 200,
      body: {
        path: resolved,
        lines,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      },
    };
  } catch (err) {
    return { status: 500, body: { error: `Failed to write file: ${String(err)}` } };
  }
}
