/**
 * Task Queue Types — OpenClaw Upgrade
 *
 * Shared type definitions for the task queue system.
 * These types are used by:
 *   - TaskQueue (JSONL storage)
 *   - TaskRunner (session spawning)
 *   - Task tools (task_dispatch, task_status, task_update)
 *   - REST API handlers
 *   - Mission Control frontend (copied into MC project)
 */

// ─── Task Definition ─────────────────────────────────────────────

export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "approved"
  | "rejected"
  | "archived";

export interface TaskDefinition {
  /** Unique task ID, e.g. "TASK-2026-02-11-004" */
  id: string;
  /** Short task title */
  title: string;
  /** Full task description with instructions (markdown) */
  description: string;
  /** Agent ID to execute this task, e.g. "toothsome-head" */
  assignee: string;
  /** Agent ID that created this task, e.g. "archon" */
  dispatchedBy: string;
  /** ISO timestamp when task was dispatched */
  dispatchedAt: string;
  /** Task priority */
  priority: TaskPriority;
  /** Current task status */
  status: TaskStatus;

  // Execution config
  /** Override model for this task (e.g. "anthropic/claude-opus-4-6") */
  model?: string;
  /** Max execution time in minutes (default: 30) */
  timeout?: number;
  /** Max LLM turns (default: 50) */
  maxTurns?: number;
  /** Report progress every N turns (default: 10) */
  checkpointInterval?: number;

  // Input/Output
  /** File paths the agent should read as context */
  inputs: string[];
  /** Where to write the deliverable file */
  outputPath: string;

  // Approval
  /** Does output need human review before marking done? */
  requiresApproval: boolean;
  /** Pre-execution approval checkpoints */
  approvalGates?: ApprovalGate[];

  // Tracking
  /** Progress updates from the agent */
  checkpoints: TaskCheckpoint[];
  /** Final outcome (set on completion) */
  result?: TaskResult;

  // Metadata
  /** Human comments on the task */
  comments?: TaskComment[];
  /** Tags for categorization, e.g. ["monorepo", "gap-analysis"] */
  tags?: string[];
  /** Task IDs that must complete before this one starts */
  dependsOn?: string[];
  /** What is blocking this task (if status=blocked) */
  blockedBy?: string;
  /** Reason for block */
  blockedReason?: string;
  /** Feedback from reviewer (on reject/revise) */
  feedback?: string;
  /** ISO timestamp when task was archived */
  archivedAt?: string;
}

// ─── Approval Gates ──────────────────────────────────────────────

export type ApprovalGateType =
  | "file_write"
  | "external_api"
  | "security_change"
  | "production_deploy"
  | "email_send";

export interface ApprovalGate {
  type: ApprovalGateType;
  description: string;
  requires: "shouvik" | "auto";
  status: "pending" | "approved" | "rejected";
}

// ─── Checkpoints ─────────────────────────────────────────────────

export interface TaskCheckpoint {
  timestamp: string;
  turn: number;
  progress: number; // 0-100
  summary: string;
  tokensUsed: TokenUsage;
  cost: number;
}

export interface TokenUsage {
  input: number;
  output: number;
}

// ─── Task Comments ──────────────────────────────────────────────

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

// ─── Task Result ─────────────────────────────────────────────────

export interface TaskResult {
  completedAt: string;
  outputPath: string;
  outputLines: number;
  summary: string;
  totalTokens: TokenUsage;
  totalCost: number;
  model: string;
}

// ─── Task Queue Events (WebSocket) ───────────────────────────────

export type TaskEvent =
  | { type: "task:created"; task: TaskDefinition }
  | { type: "task:started"; taskId: string; agent: string }
  | { type: "task:checkpoint"; taskId: string; checkpoint: TaskCheckpoint }
  | { type: "task:completed"; taskId: string; result: TaskResult }
  | { type: "task:failed"; taskId: string; error: string }
  | { type: "task:approval_needed"; taskId: string; gates: ApprovalGate[] }
  | { type: "task:approved"; taskId: string }
  | { type: "task:rejected"; taskId: string; reason: string }
  | { type: "task:feedback"; taskId: string; feedback: string }
  | { type: "task:archived"; taskId: string };

export type AgentEvent =
  | { type: "agent:status_change"; agentId: string; status: string }
  | { type: "agent:heartbeat"; agentId: string; timestamp: string };

export type DeliverableEvent = { type: "deliverable:updated"; path: string; agent: string };

export type SuggestionEvent =
  | { type: "suggestion:created"; suggestion: Suggestion }
  | { type: "suggestion:accepted"; suggestionId: string; taskId: string };

export type InboxEvent =
  | { type: "inbox:new_item"; filename: string; preview: string }
  | { type: "inbox:routed"; filename: string; destination: string };

export type CostEvent = {
  type: "cost:threshold";
  agent: string;
  level: "warning" | "critical";
  amount: number;
};

export type AlertEvent = { type: "alert"; severity: "P0" | "P1" | "P2"; message: string };

/** Union of all WebSocket event types */
export type WSEvent =
  | TaskEvent
  | AgentEvent
  | DeliverableEvent
  | SuggestionEvent
  | InboxEvent
  | CostEvent
  | AlertEvent;

// ─── Suggestion Queue ────────────────────────────────────────────

export interface Suggestion {
  id: string;
  sourceAgent: string;
  targetAgent: string;
  title: string;
  description: string;
  relatedTaskId?: string;
  relatedDeliverable?: string;
  createdAt: string;
  status: "pending" | "accepted" | "dismissed" | "discussed";
  discussion?: string[];
}

// ─── Activity Ledger ─────────────────────────────────────────────

export type ActivityType = "task" | "approval" | "agent" | "alert" | "system" | "cost";

export interface ActivityEntry {
  timestamp: string;
  type: ActivityType;
  action: string; // e.g. "task:created", "approval:approved"
  agent?: string;
  taskId?: string;
  details: Record<string, unknown>;
  cost?: {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
    model: string;
  };
}

// ─── API Request/Response Types ──────────────────────────────────

export interface TaskCreateRequest {
  assignee: string;
  title: string;
  description: string;
  outputPath: string;
  priority: TaskPriority;
  inputs?: string[];
  requiresApproval?: boolean;
  model?: string;
  timeout?: number;
  maxTurns?: number;
  dependsOn?: string[];
  tags?: string[];
  approvalGates?: Omit<ApprovalGate, "status">[];
}

export interface TaskUpdateRequest {
  status?: TaskStatus;
  feedback?: string;
  blockedBy?: string;
  blockedReason?: string;
  checkpoint?: Omit<TaskCheckpoint, "timestamp">;
}

export interface TaskListQuery {
  agentId?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tag?: string;
  from?: string; // ISO date
  to?: string; // ISO date
  limit?: number;
  offset?: number;
}

export interface AgentStatusResponse {
  id: string;
  status: "idle" | "working" | "blocked" | "offline";
  blocked?: boolean;
  currentTask?: {
    id: string;
    title: string;
    progress: number;
  };
  lastHeartbeat?: string;
  lastActivity?: string;
  model: string;
  sandbox: {
    enabled: boolean;
    tier: 0 | 1 | 2;
  };
  costs: {
    today: number;
    thisWeek: number;
    thisMonth: number;
  };
  recentActivity?: AgentRecentActivityItem[];
}

export interface AgentRecentActivityItem {
  timestamp: string;
  action: string;
  label: string;
  taskId?: string;
}

export interface CostSummary {
  total: { today: number; thisWeek: number; thisMonth: number };
  byAgent: Record<string, { today: number; thisWeek: number; thisMonth: number }>;
  byModel: Record<string, { tokens: TokenUsage; cost: number }>;
  topTasks: Array<{ id: string; title: string; cost: number; agent: string }>;
}

// ─── Output Validation Result ────────────────────────────────────

export interface OutputValidationFailure {
  taskId: string;
  title: string;
  outputPath: string;
  assignee: string;
  completedAt?: string;
}

// ─── Task ID Generation ──────────────────────────────────────────

export function generateTaskId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const seq = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TASK-${date}-${seq}`;
}
