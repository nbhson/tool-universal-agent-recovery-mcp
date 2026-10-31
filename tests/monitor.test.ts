/** Unit tests for watchdog liveness classification. */
import { describe, it, expect } from "vitest";
import { evaluateLiveness } from "../src/watchdog/monitor.js";
import type { TaskRecord } from "../src/core/task.js";

function task(partial: Partial<TaskRecord>): TaskRecord {
  const now = Date.now();
  return {
    id: "t",
    agentType: "mock",
    adapterId: "mock",
    sessionId: null,
    processPid: null,
    workingDirectory: "/work/proj",
    description: "d",
    state: "RUNNING",
    progress: null,
    lastError: null,
    errorClass: null,
    checkpoint: null,
    recoveryAttempts: 0,
    recoveryOwner: null,
    recoveryOwnerExpiresAt: null,
    nextRecoveryAt: null,
    maxAttempts: 3,
    maxRecoveryDurationMs: null,
    lastActivityAt: now,
    interruptionDetectedAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    cancelledAt: null,
    blockedAt: null,
    ...partial,
  };
}

describe("evaluateLiveness", () => {
  const now = 10_000_000;
  const staleMs = 60_000;

  it("flags a dead pid as interrupted", () => {
    const e = evaluateLiveness(task({ processPid: 999_999_999, lastActivityAt: now }), now, staleMs);
    expect(e.liveness).toBe("INTERRUPTED");
    expect(e.interruptionSuspected).toBe(true);
  });

  it("treats an alive pid with a fresh heartbeat as running", () => {
    // Our own pid: guaranteed alive for the duration of the test.
    const e = evaluateLiveness(task({ processPid: process.pid, lastActivityAt: now }), now, staleMs);
    expect(e.liveness).toBe("RUNNING");
    expect(e.interruptionSuspected).toBe(false);
  });

  it("classifies an alive pid with a stale heartbeat as IDLE, never restarts it", () => {
    const e = evaluateLiveness(task({ processPid: process.pid, lastActivityAt: now - 10 * staleMs }), now, staleMs);
    expect(e.liveness).toBe("IDLE");
    expect(e.interruptionSuspected).toBe(false);
  });

  it("treats a fresh heartbeat without a pid as running", () => {
    const e = evaluateLiveness(task({ processPid: null, lastActivityAt: now }), now, staleMs);
    expect(e.liveness).toBe("RUNNING");
    expect(e.interruptionSuspected).toBe(false);
  });

  it("suspects an interruption for a stale heartbeat without a pid", () => {
    const e = evaluateLiveness(task({ processPid: null, lastActivityAt: now - 2 * staleMs }), now, staleMs);
    expect(e.liveness).toBe("UNKNOWN");
    expect(e.interruptionSuspected).toBe(true);
  });

  it("never restarts a task that is already RECOVERING", () => {
    const e = evaluateLiveness(
      task({ processPid: null, state: "RECOVERING", lastActivityAt: now - 2 * staleMs }),
      now,
      staleMs,
    );
    expect(e.liveness).toBe("UNKNOWN");
    expect(e.interruptionSuspected).toBe(false);
  });
});
