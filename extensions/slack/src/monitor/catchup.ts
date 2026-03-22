import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackMessageHandler } from "./message-handler.js";

const SLACK_CATCHUP_DEFAULT_LOOKBACK_SECONDS = 15 * 60;
const SLACK_CATCHUP_DEFAULT_INTERVAL_MS = 30_000;
const SLACK_CATCHUP_HISTORY_LIMIT = 25;

type SlackCatchupState = {
  channels?: Record<string, string>;
};

function isSlackChannelId(value: string): boolean {
  return /^[CGD][A-Z0-9]+$/.test(value);
}

function normalizeSlackTs(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return trimmed;
}

function sanitizeAccountId(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "-");
}

function collectConfiguredChannelIds(ctx: SlackMonitorContext): string[] {
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(ctx.channelsConfig ?? {})) {
    if (entry?.allow === false || !isSlackChannelId(key)) {
      continue;
    }
    seen.add(key);
  }
  return Array.from(seen);
}

async function readCatchupState(filePath: string): Promise<Map<string, string>> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as SlackCatchupState;
    const next = new Map<string, string>();
    for (const [channelId, ts] of Object.entries(raw.channels ?? {})) {
      const normalized = normalizeSlackTs(ts);
      if (isSlackChannelId(channelId) && normalized) {
        next.set(channelId, normalized);
      }
    }
    return next;
  } catch {
    return new Map<string, string>();
  }
}

async function writeCatchupState(filePath: string, state: Map<string, string>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: SlackCatchupState = {
    channels: Object.fromEntries(state.entries()),
  };
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

export async function createSlackHistoryCatchup(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  handleSlackMessage: SlackMessageHandler;
  intervalMs?: number;
  lookbackSeconds?: number;
}) {
  const intervalMs = Math.max(5_000, params.intervalMs ?? SLACK_CATCHUP_DEFAULT_INTERVAL_MS);
  const lookbackSeconds = Math.max(
    60,
    params.lookbackSeconds ?? SLACK_CATCHUP_DEFAULT_LOOKBACK_SECONDS,
  );
  const stateFile = path.join(
    resolveStateDir(),
    "state",
    "slack-catchup",
    `${sanitizeAccountId(params.account.accountId)}.json`,
  );
  const lastSeen = await readCatchupState(stateFile);
  let persistQueue = Promise.resolve();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const persist = () => {
    persistQueue = persistQueue
      .then(() => writeCatchupState(stateFile, lastSeen))
      .catch((err) => {
        params.ctx.runtime.error?.(`slack catchup state persist failed: ${String(err)}`);
      });
    return persistQueue;
  };

  const recordSeen = (channelId: string | undefined, ts?: string) => {
    if (stopped || !channelId || !isSlackChannelId(channelId)) {
      return;
    }
    const normalizedTs = normalizeSlackTs(ts);
    if (!normalizedTs) {
      return;
    }
    const previous = lastSeen.get(channelId);
    if (previous && Number(previous) >= Number(normalizedTs)) {
      return;
    }
    lastSeen.set(channelId, normalizedTs);
    void persist();
  };

  const resolveOldest = (channelId: string) => {
    const existing = lastSeen.get(channelId);
    if (existing) {
      return existing;
    }
    const fallback = Math.max(0, Date.now() / 1000 - lookbackSeconds).toFixed(6);
    return fallback;
  };

  const runOnce = async () => {
    const channelIds = collectConfiguredChannelIds(params.ctx);
    for (const channelId of channelIds) {
      const oldest = resolveOldest(channelId);
      const oldestNumber = Number(oldest);
      const history = await params.ctx.app.client.conversations.history({
        token: params.ctx.botToken,
        channel: channelId,
        oldest,
        inclusive: false,
        limit: SLACK_CATCHUP_HISTORY_LIMIT,
      });
      const rawMessages = Array.isArray(history.messages) ? history.messages : [];
      const messages = rawMessages
        .filter((item): item is SlackMessageEvent & { ts: string } => {
          const ts = normalizeSlackTs((item as { ts?: string }).ts);
          const subtype = typeof item.subtype === "string" ? item.subtype : "";
          return Boolean(
            ts &&
            Number(ts) > oldestNumber &&
            item.type === "message" &&
            typeof item.user === "string" &&
            item.user.length > 0 &&
            !item.bot_id &&
            (!subtype || subtype === "file_share"),
          );
        })
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      for (const message of messages) {
        const event: SlackMessageEvent = {
          ...message,
          channel: channelId,
        };
        await params.handleSlackMessage(event, { source: "message" });
        recordSeen(channelId, message.ts);
      }
    }
    await persistQueue;
  };

  const schedule = () => {
    timer = setInterval(() => {
      void runOnce().catch((err) => {
        params.ctx.runtime.error?.(`slack history catchup failed: ${String(err)}`);
      });
    }, intervalMs);
  };

  const stop = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    runOnce,
    schedule,
    stop,
    recordSeen,
  };
}
