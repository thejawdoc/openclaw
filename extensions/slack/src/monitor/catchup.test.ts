import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackHistoryCatchup } from "./catchup.js";

describe("createSlackHistoryCatchup", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("dispatches recent human-authored channel messages and persists watermarks", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-catchup-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          ts: "1774154476.836759",
          text: "hello from slack",
          user: "U123",
        },
      ],
    });
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);

    const catchup = await createSlackHistoryCatchup({
      ctx: {
        channelsConfig: { C123: { allow: true } },
        botToken: "xoxb-test",
        app: {
          client: {
            conversations: {
              history,
            },
          },
        },
        runtime: {
          error: vi.fn(),
        },
      } as never,
      account: {
        accountId: "archon",
      } as never,
      handleSlackMessage,
      intervalMs: 60_000,
      lookbackSeconds: 900,
    });

    await catchup.runOnce();
    catchup.stop();

    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        token: "xoxb-test",
      }),
    );
    expect(handleSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "hello from slack",
        user: "U123",
      }),
      { source: "message" },
    );

    const statePath = path.join(stateDir, "state", "slack-catchup", "archon.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      channels: Record<string, string>;
    };
    expect(state.channels.C123).toBe("1774154476.836759");
  });

  it("does not redispatch messages already covered by the persisted watermark", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-catchup-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await fs.mkdir(path.join(stateDir, "state", "slack-catchup"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "state", "slack-catchup", "archon.json"),
      JSON.stringify({ channels: { C123: "1774154476.836759" } }),
      "utf8",
    );

    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          type: "message",
          ts: "1774154476.836759",
          text: "already seen",
          user: "U123",
        },
      ],
    });
    const handleSlackMessage = vi.fn().mockResolvedValue(undefined);

    const catchup = await createSlackHistoryCatchup({
      ctx: {
        channelsConfig: { C123: { allow: true } },
        botToken: "xoxb-test",
        app: {
          client: {
            conversations: {
              history,
            },
          },
        },
        runtime: {
          error: vi.fn(),
        },
      } as never,
      account: {
        accountId: "archon",
      } as never,
      handleSlackMessage,
      intervalMs: 60_000,
      lookbackSeconds: 900,
    });

    await catchup.runOnce();
    catchup.stop();

    expect(handleSlackMessage).not.toHaveBeenCalled();
  });
});
