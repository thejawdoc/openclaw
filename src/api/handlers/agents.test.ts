import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateAgentSummaryCache } from "../../tasks/agent-summary.js";
import type { ActivityEntry, TaskDefinition } from "../../tasks/types.js";

const { loadConfigMock, loadCombinedSessionStoreForGatewayMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  loadCombinedSessionStoreForGatewayMock: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../../gateway/session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: loadCombinedSessionStoreForGatewayMock,
}));

function createTask(partial: Partial<TaskDefinition>): TaskDefinition {
  return {
    id: partial.id ?? "TASK-TEST-001",
    title: partial.title ?? "Test task",
    description: partial.description ?? "desc",
    assignee: partial.assignee ?? "archon",
    dispatchedBy: partial.dispatchedBy ?? "archon",
    dispatchedAt: partial.dispatchedAt ?? "2026-03-19T12:00:00.000Z",
    priority: partial.priority ?? "P1",
    status: partial.status ?? "pending",
    model: partial.model,
    timeout: partial.timeout ?? 30,
    maxTurns: partial.maxTurns ?? 50,
    checkpointInterval: partial.checkpointInterval ?? 10,
    inputs: partial.inputs ?? [],
    outputPath: partial.outputPath ?? "/tmp/out.md",
    requiresApproval: partial.requiresApproval ?? false,
    approvalGates: partial.approvalGates,
    checkpoints: partial.checkpoints ?? [],
    result: partial.result,
    protocol: partial.protocol,
    comments: partial.comments,
    tags: partial.tags,
    dependsOn: partial.dependsOn,
    blockedBy: partial.blockedBy,
    blockedReason: partial.blockedReason,
    feedback: partial.feedback,
    archivedAt: partial.archivedAt,
  };
}

describe("agent status handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invalidateAgentSummaryCache();
    loadConfigMock.mockReturnValue({
      agents: {
        list: [
          { id: "archon", model: { primary: "openai-codex/gpt-5.4" }, sandbox: { mode: "docker" } },
          { id: "biz-ops", model: { primary: "qwen3.5-local" }, sandbox: { mode: "docker" } },
          { id: "extra-head", model: { primary: "qwen3.5-local" }, sandbox: { mode: "off" } },
        ],
      },
    });
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:archon:work": {
          sessionId: "sess-1",
          updatedAt: Date.parse("2026-03-19T12:10:00.000Z"),
        },
        "agent:biz-ops:work": {
          sessionId: "sess-2",
          updatedAt: Date.parse("2026-03-19T12:09:00.000Z"),
        },
      },
    });
  });

  it("supports scope=primary and caches the bulk snapshot", async () => {
    const { handleListAgents } = await import("./agents.js");
    const taskQueue = {
      list: vi.fn(
        async () =>
          [
            createTask({
              id: "TASK-1",
              assignee: "archon",
              status: "in_progress",
              dispatchedAt: "2026-03-19T12:00:00.000Z",
              checkpoints: [
                {
                  timestamp: "2026-03-19T12:11:00.000Z",
                  turn: 1,
                  progress: 60,
                  summary: "working",
                  tokensUsed: { input: 1, output: 1 },
                  cost: 0,
                },
              ],
            }),
          ] as TaskDefinition[],
      ),
      queryActivity: vi.fn(
        async () =>
          [
            {
              timestamp: "2026-03-19T12:12:00.000Z",
              type: "task",
              action: "task:started",
              agent: "archon",
              taskId: "TASK-1",
              details: { title: "Test task" },
            },
          ] as ActivityEntry[],
      ),
    };

    const first = await handleListAgents(
      { taskQueue: taskQueue as never },
      new URLSearchParams("scope=primary"),
    );
    const second = await handleListAgents(
      { taskQueue: taskQueue as never },
      new URLSearchParams("scope=primary"),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((first.body as Array<{ id: string }>).map((row) => row.id)).toEqual([
      "archon",
      "biz-ops",
    ]);
    expect(taskQueue.list).toHaveBeenCalledTimes(1);
    expect(taskQueue.queryActivity).toHaveBeenCalledTimes(1);
  });

  it("supports ids filtering in requested order", async () => {
    const { handleListAgents, handleGetAgent } = await import("./agents.js");
    const taskQueue = {
      list: vi.fn(
        async () =>
          [
            createTask({
              id: "TASK-2",
              assignee: "extra-head",
              status: "blocked",
              blockedReason: "waiting",
            }),
          ] as TaskDefinition[],
      ),
      queryActivity: vi.fn(async () => [] as ActivityEntry[]),
    };

    const listResponse = await handleListAgents(
      { taskQueue: taskQueue as never },
      new URLSearchParams("ids=extra-head,archon"),
    );
    expect(listResponse.status).toBe(200);
    expect((listResponse.body as Array<{ id: string }>).map((row) => row.id)).toEqual([
      "extra-head",
      "archon",
    ]);

    const single = await handleGetAgent({ taskQueue: taskQueue as never }, "extra-head");
    expect(single.status).toBe(200);
    expect(single.body).toMatchObject({
      id: "extra-head",
      status: "blocked",
      blocked: true,
    });
  });
});
