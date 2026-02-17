/**
 * Session learnings hook handler
 *
 * Debounces session:turn-complete events and runs memory-updater.py
 * to extract learnings from recent sessions into MEMORY.md.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";

const log = createSubsystemLogger("hooks/session-learnings");

/** Per-agent debounce timers */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Track agents currently running extraction to prevent overlap */
const runningExtractions = new Set<string>();

/** Default debounce: 2 minutes of inactivity */
const DEFAULT_DEBOUNCE_SECONDS = 120;

/**
 * Find the memory-updater.py script.
 * Checks common locations on the system.
 */
function findUpdaterScript(configPath?: string): string | null {
  if (configPath && fs.existsSync(configPath)) {
    return configPath;
  }
  const candidates = [
    path.join(process.env.HOME || "", "Projects/jawdoc-brain/scripts/memory-updater.py"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Run memory-updater.py for a specific agent.
 */
function runMemoryUpdater(agentId: string, scriptPath: string): void {
  if (runningExtractions.has(agentId)) {
    log.debug("Extraction already running for agent", { agentId });
    return;
  }

  runningExtractions.add(agentId);
  log.info("Starting memory extraction", { agentId, scriptPath });

  const env = { ...process.env, PATH: "/opt/homebrew/bin:" + (process.env.PATH || "") };

  execFile("python3", [scriptPath, agentId], { env, timeout: 120_000 }, (err, stdout, stderr) => {
    runningExtractions.delete(agentId);
    if (err) {
      log.error("Memory extraction failed", {
        agentId,
        error: err.message,
        stderr: stderr?.slice(0, 500),
      });
    } else {
      log.info("Memory extraction completed", {
        agentId,
        stdout: stdout?.slice(0, 200),
      });
    }
  });
}

/**
 * Handle session:turn-complete events.
 * Debounces per agent — after N seconds of no new turns, runs extraction.
 */
const handleTurnComplete: HookHandler = async (event) => {
  if (event.type !== "session" || event.action !== "turn-complete") {
    return;
  }

  const context = event.context || {};
  const cfg = context.cfg as OpenClawConfig | undefined;
  const agentId = (context.agentId as string) || resolveAgentIdFromSessionKey(event.sessionKey);
  const isHeartbeat = context.isHeartbeat as boolean;

  // Read hook config
  const hookConfig = resolveHookConfig(cfg, "session-learnings");
  const skipHeartbeats = hookConfig?.skipHeartbeats !== false; // default true

  // Skip heartbeat turns by default
  if (isHeartbeat && skipHeartbeats) {
    return;
  }

  const debounceSeconds =
    typeof hookConfig?.debounceSeconds === "number" && hookConfig.debounceSeconds > 0
      ? hookConfig.debounceSeconds
      : DEFAULT_DEBOUNCE_SECONDS;

  // Find the updater script
  const scriptPath = findUpdaterScript(hookConfig?.updaterScript as string | undefined);
  if (!scriptPath) {
    log.debug("memory-updater.py not found, skipping");
    return;
  }

  // Clear any existing debounce timer for this agent
  const timerKey = agentId;
  const existingTimer = debounceTimers.get(timerKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new debounce timer
  const timer = setTimeout(() => {
    debounceTimers.delete(timerKey);
    runMemoryUpdater(agentId, scriptPath);
  }, debounceSeconds * 1000);

  debounceTimers.set(timerKey, timer);
  log.debug("Debounce timer set", { agentId, debounceSeconds });
};

export default handleTurnComplete;
