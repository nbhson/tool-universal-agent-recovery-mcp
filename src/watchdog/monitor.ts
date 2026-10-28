/**
 * Liveness classification for one task during a watchdog tick.
 *
 * A missing heartbeat alone never proves an agent is dead: it may be running
 * a long test suite. The monitor combines heartbeat staleness and process
 * liveness before declaring an interruption.
 */
import type { AgentLiveness } from "../core/task.js";
import type { TaskRecord } from "../core/task.js";
import { isPidAlive } from "../adapters/process-health.js";

export interface LivenessEvaluation {
  liveness: AgentLiveness;
  /** true when the watchdog should verify + start recovery. */
  interruptionSuspected: boolean;
  reason: string;
}

export function evaluateLiveness(task: TaskRecord, now: number, staleMs: number): LivenessEvaluation {
  const heartbeatAge = now - task.lastActivityAt;

  // 1. Direct process signal (strongest evidence, only when a pid is known).
  if (task.processPid != null) {
    const alive = isPidAlive(task.processPid);
    if (!alive) {
      return {
        liveness: "INTERRUPTED",
        interruptionSuspected: true,
        reason: `process ${task.processPid} no longer exists`,
      };
    }
    if (heartbeatAge < staleMs) {
      return {
        liveness: "RUNNING",
        interruptionSuspected: false,
        reason: "process alive and heartbeat fresh",
      };
    }
    // Process alive but silent for a long time: could be a long test/build.
    // Do NOT restart based on this alone — classify as IDLE.
    return {
      liveness: "IDLE",
      interruptionSuspected: false,
      reason: `process alive but no heartbeat for ${Math.round(heartbeatAge / 1000)}s — treated as IDLE (long-running work), not interrupted`,
    };
  }

  // 2. No pid known: rely on heartbeat staleness only.
  if (heartbeatAge < staleMs) {
    return { liveness: "RUNNING", interruptionSuspected: false, reason: "heartbeat fresh" };
  }
  if (task.state === "RECOVERING") {
    return { liveness: "UNKNOWN", interruptionSuspected: false, reason: "recovery already in progress" };
  }
  return {
    liveness: "UNKNOWN",
    interruptionSuspected: true,
    reason: `no heartbeat for ${Math.round(heartbeatAge / 1000)}s and no process id to verify`,
  };
}
