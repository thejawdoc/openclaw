import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";

function createRequest(params: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
}): IncomingMessage {
  return {
    url: params.url,
    method: params.method ?? "GET",
    headers: params.headers ?? {},
    socket: {
      remoteAddress: params.remoteAddress ?? "127.0.0.1",
    },
  } as unknown as IncomingMessage;
}

async function createHandler() {
  vi.resetModules();
  const { createApiRouter } = await import("./router.js");
  const taskQueue = {
    getStats: vi.fn(async () => ({ total: 0 })),
  };
  const handler = createApiRouter({
    taskQueue: taskQueue as never,
    broadcast: vi.fn(),
    writeToken: "test-token",
  });
  return { handler, taskQueue };
}

describe("api router rate limiting", () => {
  it("does not rate limit loopback health checks", async () => {
    const { handler } = await createHandler();

    for (let i = 0; i < 105; i += 1) {
      const res = createMockServerResponse();
      const handled = await handler(createRequest({ url: "/api/health" }), res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    }
  });

  it("does not rate limit trusted mission control reads with a valid token", async () => {
    const { handler, taskQueue } = await createHandler();

    for (let i = 0; i < 105; i += 1) {
      const res = createMockServerResponse();
      const handled = await handler(
        createRequest({
          url: "/api/tasks/stats",
          headers: { "x-mc-token": "test-token" },
        }),
        res,
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    }

    expect(taskQueue.getStats).toHaveBeenCalled();
  });

  it("still rate limits untrusted task reads", async () => {
    const { handler } = await createHandler();
    let finalStatus = 200;

    for (let i = 0; i < 105; i += 1) {
      const res = createMockServerResponse();
      const handled = await handler(createRequest({ url: "/api/tasks/stats" }), res);
      expect(handled).toBe(true);
      finalStatus = res.statusCode;
    }

    expect(finalStatus).toBe(429);
  });
});
