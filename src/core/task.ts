/** Core task types and the canonical task state machine. */

export const TASK_STATES = [
  "REGISTERED",
  "RUNNING",
  "INTERRUPTED",
  "RECOVERING",
  "COMPLETED",
  "BLOCKED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** Runtime sub-signals the watchdog distinguishes (not persisted as task state). */
export type AgentLiveness = "RUNNING" | "IDLE" | "INTERRUPTED" | "UNKNOWN" | "COMPLETED" | "BLOCKED";

/** Allowed task state transitions. */
export const ALLOWED_TRANSITIONS: Record<TaskState, TaskState[]> = {
  REGISTERED: ["RUNNING", "INTERRUPTED", "CANCELLED"],
  RUNNING: ["INTERRUPTED", "COMPLETED", "CANCELLED", "BLOCKED"],
  INTERRUPTED: ["RECOVERING", "RUNNING", "COMPLETED", "BLOCKED", "CANCELLED"],
  RECOVERING: ["RUNNING", "INTERRUPTED", "BLOCKED", "CANCELLED"],
  BLOCKED: ["RECOVERING", "RUNNING", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface Checkpoint {
  /** Human/agent-readable summary of verified progress. */
  summary: string;
  /** Structured details: files touched, steps done, next steps. */
  details?: Record<string, unknown>;
  /** Whether the checkpoint content was explicitly verified (not just last output). */
  verified: boolean;
}

export interface TaskRecord {
  id: string;
  agentType: string;
  adapterId: string;
  sessionId: string | null;
  processPid: number | null;
  workingDirectory: string;
  description: string;
  state: TaskState;
  progress: string | null;
  lastError: string | null;
  errorClass: string | null;
  checkpoint: Checkpoint | null;
  recoveryAttempts: number;
  recoveryOwner: string | null;
  recoveryOwnerExpiresAt: number | null;
  nextRecoveryAt: number | null;
  maxAttempts: number;
  maxRecoveryDurationMs: number | null;
  lastActivityAt: number;
  interruptionDetectedAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
  blockedAt: number | null;
}

/** States in which the watchdog actively monitors a task. */
export const ACTIVE_STATES: TaskState[] = ["REGISTERED", "RUNNING", "INTERRUPTED", "RECOVERING", "BLOCKED"];

export interface TaskInput {
  taskId: string;
  agentType: string;
  adapterId: string;
  sessionId?: string | null;
  processPid?: number | null;
  workingDirectory: string;
  description: string;
  maxAttempts?: number;
}
