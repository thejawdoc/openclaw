export type TaskQueueConfig = {
  enabled?: boolean;
  store?: string;
  pollIntervalMs?: number;
  defaults?: {
    timeout?: number;
    maxTurns?: number;
    checkpointInterval?: number;
    requiresApproval?: boolean;
  };
};
