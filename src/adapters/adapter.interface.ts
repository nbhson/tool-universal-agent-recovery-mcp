/** Common adapter interface for coding-agent integrations. */
import type { TaskRecord } from "../core/task.js";

/** What a specific agent integration supports. Every capability is explicit
 * so the watchdog can choose fallbacks and documentation can state limits. */
export interface AdapterCapabilities {
  /** Can detect whether the agent binary is installed/available. */
  detect: boolean;
  /** Can verify whether a session id exists. */
  inspectSession: boolean;
  /** Can continue an existing session in a new process. */
  resumeSession: boolean;
  /** Can launch a fresh agent process. */
  launchNew: boolean;
  /** Can restore task context in a new session via persisted checkpoint. */
  restoreContext: boolean;
  /** Can check whether a known pid is still alive. */
  processHealth: boolean;
  /** Can gracefully cancel a launched recovery process. */
  gracefulCancel: boolean;
  /** Can detect task completion from the agent's output. */
  completionDetection: boolean;
}

export interface LaunchOptions {
  /** Instruction / "Continue"-equivalent prompt sent to the agent. */
  instruction: string;
  /** Where the agent should run. */
  cwd: string;
  /** Existing session to resume, when resuming. */
  sessionId?: string | null;
  /** Hard runtime limit; the process is killed when exceeded. */
  timeoutMs?: number;
  /** Where to append agent output. */
  logFile?: string | null;
}

export interface LaunchResult {
  pid: number;
  /** Promise resolving when the process exits. */
  exited: Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>;
  cancel: () => void;
}

export interface AgentAdapter {
  readonly id: string;
  readonly agentType: string;
  readonly capabilities: AdapterCapabilities;

  /** Best-effort check that the agent binary is available. */
  detect(): Promise<boolean>;
  /**
   * Check that a session id exists (when capabilities.inspectSession).
   * Returns false only when the CLI answered and the session is absent;
   * returns null when inspection failed (CLI error, unparsable output) so
   * the caller can defer instead of wrongly falling back to a new session.
   */
  sessionExists?(sessionId: string): Promise<boolean | null>;
  /** Check process liveness (when capabilities.processHealth). */
  isProcessAlive?(pid: number): Promise<boolean>;
  /** Continue an existing session (when capabilities.resumeSession). */
  resumeSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult>;
  /** Start a fresh session restoring context from checkpoint (when capabilities.launchNew). */
  startNewSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult>;
  /** Completion detection, where supported. Returns null when undeterminable. */
  detectCompletion?(output: string): boolean | null;
}
