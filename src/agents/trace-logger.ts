/**
 * Trace Event Logger — records spans for task execution tracing.
 *
 * Writes JSONL trace files to ~/.openclaw/traces/{taskId}.jsonl
 * Each line is a TraceSpan (completed) or partial span (in-flight).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────

export type TraceSpanType =
  | "llm_call"
  | "tool_use"
  | "memory_search"
  | "file_read"
  | "file_write"
  | "error"
  | "task_lifecycle";

export interface TraceSpan {
  spanId: string;
  taskId: string;
  agentId: string;
  type: TraceSpanType;
  name: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  input?: string;
  output?: string;
  tokens?: { input: number; output: number };
  cost?: number;
  error?: string;
}

// ─── Trace Directory ────────────────────────────────────────────

const TRACE_DIR = join(homedir(), ".openclaw", "traces");

async function ensureTraceDir(): Promise<void> {
  await fs.mkdir(TRACE_DIR, { recursive: true });
}

function traceFilePath(taskId: string): string {
  return join(TRACE_DIR, `${taskId}.jsonl`);
}

// ─── Public API ─────────────────────────────────────────────────

let spanCounter = 0;

/** Start a new trace span. Returns the span object (call endSpan when done). */
export function startSpan(
  taskId: string,
  agentId: string,
  type: TraceSpanType,
  name: string,
  input?: string,
): TraceSpan {
  spanCounter++;
  return {
    spanId: `span-${Date.now()}-${spanCounter}`,
    taskId,
    agentId,
    type,
    name,
    startTime: new Date().toISOString(),
    input: input ? input.slice(0, 500) : undefined,
  };
}

/** End a span and write it to the trace file. */
export async function endSpan(
  span: TraceSpan,
  result: {
    output?: string;
    tokens?: { input: number; output: number };
    cost?: number;
    error?: string;
  },
): Promise<void> {
  await ensureTraceDir();
  span.endTime = new Date().toISOString();
  span.durationMs = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
  span.output = result.output ? result.output.slice(0, 500) : undefined;
  span.tokens = result.tokens;
  span.cost = result.cost;
  span.error = result.error;

  const line = JSON.stringify(span) + "\n";
  await fs.appendFile(traceFilePath(span.taskId), line);
}

/** Write a complete span in one call (for events that are instantaneous). */
export async function writeSpan(
  span: Omit<TraceSpan, "spanId"> & { spanId?: string },
): Promise<void> {
  await ensureTraceDir();
  const full: TraceSpan = {
    spanId: span.spanId ?? `span-${Date.now()}-${++spanCounter}`,
    ...span,
  };
  const line = JSON.stringify(full) + "\n";
  await fs.appendFile(traceFilePath(full.taskId), line);
}

/** Read all trace spans for a task. */
export async function readTrace(taskId: string): Promise<TraceSpan[]> {
  try {
    const data = await fs.readFile(traceFilePath(taskId), "utf-8");
    const spans: TraceSpan[] = [];
    for (const line of data.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        spans.push(JSON.parse(line));
      } catch {
        // skip corrupt lines
      }
    }
    return spans;
  } catch {
    return [];
  }
}
