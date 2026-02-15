/**
 * Inter-Agent Communication Logger
 *
 * Logs agent-to-agent communications (dispatches, escalations, QC alerts)
 * to ~/.openclaw/comms/comms.jsonl (append-only).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────

export type CommsType = "dispatch" | "escalation" | "report" | "qc_alert" | "feedback";

export interface CommsEntry {
  id: string;
  from: string;
  to: string;
  type: CommsType;
  taskId?: string;
  message: string;
  timestamp: string;
}

// ─── Storage ────────────────────────────────────────────────────

const COMMS_DIR = join(homedir(), ".openclaw", "comms");
const COMMS_FILE = join(COMMS_DIR, "comms.jsonl");

let commsCounter = 0;

async function ensureCommsDir(): Promise<void> {
  await fs.mkdir(COMMS_DIR, { recursive: true });
}

/** Log an inter-agent communication. */
export async function logComms(entry: Omit<CommsEntry, "id" | "timestamp">): Promise<CommsEntry> {
  await ensureCommsDir();
  commsCounter++;
  const full: CommsEntry = {
    id: `comms-${Date.now()}-${commsCounter}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  await fs.appendFile(COMMS_FILE, JSON.stringify(full) + "\n");
  return full;
}

/** Query communication log with filters. Returns most recent first. */
export async function queryComms(params: {
  from?: string;
  to?: string;
  type?: CommsType;
  since?: string;
  limit?: number;
}): Promise<CommsEntry[]> {
  let data: string;
  try {
    data = await fs.readFile(COMMS_FILE, "utf-8");
  } catch {
    return [];
  }

  const entries: CommsEntry[] = [];
  for (const line of data.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as CommsEntry;
      if (params.from && entry.from !== params.from) {
        continue;
      }
      if (params.to && entry.to !== params.to) {
        continue;
      }
      if (params.type && entry.type !== params.type) {
        continue;
      }
      if (params.since && entry.timestamp < params.since) {
        continue;
      }
      entries.push(entry);
    } catch {
      // skip corrupt lines
    }
  }

  entries.reverse();
  return entries.slice(0, params.limit ?? 100);
}
