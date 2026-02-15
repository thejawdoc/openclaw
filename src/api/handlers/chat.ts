/**
 * Chat Handler — POST /api/chat
 *
 * Routes messages to Archon (or specified agent) via runCronIsolatedAgentTurn.
 * Returns synchronous response; broadcasts chat:response via WebSocket for MC.
 */

import type { RunCronAgentTurnResult } from "../../cron/isolated-agent.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type ChatHandlerDeps = {
  runAgentTurn: (params: {
    agentId: string;
    message: string;
    sessionKey: string;
    onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  }) => Promise<RunCronAgentTurnResult>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
};


const CHAT_DIR = join(homedir(), ".openclaw", "chat");

async function ensureChatDir(): Promise<void> {
  await fs.mkdir(CHAT_DIR, { recursive: true });
}

async function appendChatMessage(sessionId: string, entry: {
  role: "user" | "assistant";
  content: string;
  agentId: string;
  timestamp: string;
}): Promise<void> {
  await ensureChatDir();
  const file = join(CHAT_DIR, sessionId + ".jsonl");
  await fs.appendFile(file, JSON.stringify(entry) + "\n");
}

// GET /api/chat/history?sessionId=X
export async function handleChatHistory(
  query: URLSearchParams,
): Promise<{ status: number; body: unknown }> {
  const sessionId = query.get("sessionId");
  if (!sessionId) {
    return { status: 400, body: { error: "Missing sessionId parameter" } };
  }

  await ensureChatDir();
  const file = join(CHAT_DIR, sessionId + ".jsonl");
  try {
    const raw = await fs.readFile(file, "utf-8");
    const messages = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { status: 200, body: { sessionId, messages } };
  } catch {
    return { status: 200, body: { sessionId, messages: [] } };
  }
}

// GET /api/chat/sessions — list recent chat sessions
export async function handleChatSessions(): Promise<{ status: number; body: unknown }> {
  await ensureChatDir();
  try {
    const files = await fs.readdir(CHAT_DIR);
    const sessions = files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(".jsonl", ""))
      .sort()
      .reverse()
      .slice(0, 50);
    return { status: 200, body: { sessions } };
  } catch {
    return { status: 200, body: { sessions: [] } };
  }
}

export async function handleChat(
  deps: ChatHandlerDeps,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const message = body.message as string | undefined;
  if (!message?.trim()) {
    return { status: 400, body: { error: "Missing required field: message" } };
  }

  const context = body.context as Record<string, unknown> | undefined;
  const agentId = (context?.agentId as string) || "archon";

  // Session continuity
  const sessionId =
    (context?.sessionId as string) ||
    `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sessionKey = `mc:chat:${sessionId}`;

  // Load chat history for persistent conversation context
  let historyContext = "";
  try {
    await ensureChatDir();
    const historyFile = join(CHAT_DIR, sessionId + ".jsonl");
    const raw = await fs.readFile(historyFile, "utf-8").catch(() => "");
    if (raw.trim()) {
      const lines = raw.trim().split("\n").filter(Boolean);
      // Keep last 20 messages to avoid context overflow
      const recent = lines.slice(-20);
      const formatted = recent.map((line) => {
        try {
          const msg = JSON.parse(line);
          const role = msg.role === "user" ? "User" : "Assistant";
          return `${role}: ${msg.content}`;
        } catch {
          return "";
        }
      }).filter(Boolean).join("\n\n");
      if (formatted) {
        historyContext = `[Chat History (${recent.length} messages)]\n${formatted}\n\n`;
      }
    }
  } catch {
    // No history — first message in session
  }

  // Build context-aware prompt for the agent
  let prompt = "";
  const contextParts: string[] = [];
  if (context) {
    if (context.currentPage) {
      contextParts.push(`Viewing: ${context.currentPage}`);
    }
    if (context.taskId) {
      contextParts.push(`Task: ${context.taskId}`);
    }
    if (context.deliverablePath) {
      contextParts.push(`Deliverable: ${context.deliverablePath}`);
    }
  }

  if (contextParts.length > 0 || historyContext) {
    const sections: string[] = [];
    if (contextParts.length > 0) {
      sections.push(`[Mission Control Context]\n${contextParts.join("\n")}`);
    }
    if (historyContext) {
      sections.push(historyContext);
    }
    sections.push(`[User Message]\n${message}`);
    prompt = sections.join("\n\n");
  } else {
    prompt = message;
  }

  // Persist user message (F2)
  const timestamp = new Date().toISOString();
  appendChatMessage(sessionId, {
    role: "user",
    content: message,
    agentId,
    timestamp,
  }).catch(() => {}); // Non-blocking

  // Broadcast start event
  deps.broadcast("chat:started", {
    sessionId,
    agentId,
    preview: message.slice(0, 100),
  });

  // Stream text chunks to connected WebSocket clients as they arrive
  const onBlockReply = (payload: { text?: string; mediaUrls?: string[] }) => {
    if (payload.text) {
      deps.broadcast("chat:chunk", {
        sessionId,
        agentId,
        text: payload.text,
        complete: false,
      }, { dropIfSlow: true });
    }
  };

  try {
    const result = await deps.runAgentTurn({
      agentId,
      message: prompt,
      sessionKey,
      onBlockReply,
    });

    if (result.status === "error") {
      deps.broadcast("chat:response", {
        sessionId,
        agentId,
        error: result.error || "Agent session failed",
        complete: true,
      });
      return {
        status: 500,
        body: {
          success: false,
          sessionId,
          error: result.error || "Agent session failed",
        },
      };
    }

    const responseText = result.outputText || result.summary || "";

    // Broadcast complete response for WS listeners
    deps.broadcast("chat:response", {
      sessionId,
      agentId,
      message: responseText,
      complete: true,
    });

    // Persist assistant response
    appendChatMessage(sessionId, {
      role: "assistant",
      content: responseText,
      agentId,
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    return {
      status: 200,
      body: {
        success: true,
        sessionId,
        agentId,
        message: responseText,
      },
    };
  } catch (err) {
    deps.broadcast("chat:response", {
      sessionId,
      agentId,
      error: String(err),
      complete: true,
    });
    return {
      status: 500,
      body: {
        success: false,
        sessionId,
        error: `Chat error: ${String(err)}`,
      },
    };
  }
}
