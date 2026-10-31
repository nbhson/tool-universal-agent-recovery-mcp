/**
 * Watchdog recovery lifecycle tests with the deterministic mock adapter.
 *
 * Covers: confirmed-interruption recovery, slow-but-healthy agents,
 * resume-failure fallback to a new session, retry exhaustion -> BLOCKED,
 * watchdog restart reconciliation, duplicate-supervisor prevention,
 * cancellation during recovery, completed-state protection, and
 * "process exit without progress is not success".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Database } from "../src/storage/database.js";
import { EventRepository } from "../src/storage/event.repository.js";
import { TaskRepository } from "../src/storage/task.repository.js";
import { RecoveryAttemptRepository } from "../src/storage/recovery-attempt.repository.js";
import { LeaderLock } from "../src/storage/leader-lock.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { MockAdapter } from "../src/adapters/mock.adapter.js";
import type { AdapterCapabilities, AgentAdapter, LaunchResult } from "../src/adapters/adapter.interface.js";
import { WatchdogSupervisor } from "../src/watchdog/supervisor.js";
import { createLogger } from "../src/core/logger.js";
import { loadConfig, type RecoveryConfig } from "../src/config.js";

const WD = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";

// ---------- helpers ----------

function testConfig(env: Record<string, string> = {}, dbPath = ":memory:"): RecoveryConfig {
  return loadConfig({
    RECOVERY_DB_PATH: dbPath,
    RECOVERY_ALLOWED_DIRS: process.platform === "win32" ? "C:\\work" : "/work",
    RECOVERY_STALE_MS: "40",
    RECOVERY_POLL_MS: "15",
    RECOVERY_MAX_ATTEMPTS: "3",
    RECOVERY_BACKOFF_BASE_MS: "5",
    RECOVERY_BACKOFF_MAX_MS: "20",
    RECOVERY_OWNER_LEASE_MS: "60000",
    RECOVERY_MAX_CONCURRENT: "2",
    RECOVERY_LOG_LEVEL: "error",
    RECOVERY_ENABLED: "true",
    ...env,
  });
}

interface Harness {
  config: RecoveryConfig;
  dbPath: string;
  supervisor: WatchdogSupervisor;
  mock: MockAdapter;
  /** Separate connection into the same SQLite file for seeding/inspection. */
  db: Database;
  tasks: TaskRepository;
  events: EventRepository;
  attempts: RecoveryAttemptRepository;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
  cleanup(): void;
}

function makeHarness(env: Record<string, string> = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uar-watchdog-"));
  const dbPath = path.join(dir, "test.db");
  const config = testConfig(env, dbPath);
  const registry = new AdapterRegistry();
  const mock = new MockAdapter();
  registry.register(mock);
  const logger = createLogger({ level: process.env.UAR_TEST_LOG_LEVEL as "debug" | "error" || "error" });
  const supervisor = new WatchdogSupervisor(config, registry, logger);

  const db = new Database(dbPath);
  db.migrate();
  const events = new EventRepository(db);
  const tasks = new TaskRepository(db, events);
  const attempts = new RecoveryAttemptRepository(db);

  return {
    config,
    dbPath,
    supervisor,
    mock,
    db,
    tasks,
    events,
    attempts,
    runOnce: () => supervisor.runOnce(),
    stop: () => supervisor.stop(),
    cleanup: () => {
      db.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows may keep the file open briefly */
      }
    },
  };
}

/** Create a RUNNING task with a session, then backdate its heartbeat. */
function seedRunningTask(h: Harness, opts: { sessionId?: string; pid?: number | null } = {}): string {
  const task = h.tasks.create({
    taskId: `task-${Math.random().toString(36).slice(2, 8)}`,
    agentType: "mock",
    adapterId: "mock",
    sessionId: opts.sessionId ?? null,
    processPid: opts.pid ?? null,
    workingDirectory: WD,
    description: "Implement the feature end to end",
    maxAttempts: 3,
  });
  h.tasks.transition(task.id, "RUNNING");
  h.tasks.setProgress(task.id, "initial work done");
  return task.id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000, everyMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return predicate();
}

function state(h: Harness, taskId: string): string {
  return h.tasks.get(taskId)?.state ?? "MISSING";
}

function isDue(h: Harness, taskId: string): boolean {
  const next = h.tasks.get(taskId)?.nextRecoveryAt;
  return next == null || next <= Date.now();
}

// ---------- tests ----------

describe("watchdog recovery lifecycle", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(async () => {
    await h.stop();
    h.cleanup();
  });

  it("recovers a confirmed interruption by resuming the session", async () => {
    h.mock.setScript({ completionSignal: "TASK_DONE", output: "TASK_DONE continued work" });
    const taskId = seedRunningTask(h, { sessionId: "sess-1" });
    backdateTask(h, taskId, 5_000);

    await h.runOnce();

    expect(state(h, taskId)).toBe("RUNNING");
    expect(h.mock.calls.some((c) => c.method === "resumeSession" && (c.args as { sessionId?: string }).sessionId === "sess-1")).toBe(true);
    const events = h.events.listForTask(taskId).map((e) => e.type);
    expect(events).toContain("recovery_succeeded");
  });

  // tasklist-based liveness probing on Windows can be slow; allow ample time.
  it("never restarts a slow but healthy agent (live pid, stale heartbeat)", { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 15000)"], { stdio: "ignore" });
    try {
      const taskId = seedRunningTask(h, { pid: child.pid ?? null });
      backdateTask(h, taskId, 60_000); // very stale heartbeat, but process is alive

      await h.runOnce();
      await h.runOnce();

      expect(state(h, taskId)).toBe("RUNNING");
      expect(h.attempts.listForTask(taskId)).toHaveLength(0);
      expect(h.mock.calls.some((c) => c.method === "resumeSession")).toBe(false);
    } finally {
      child.kill();
    }
  });

  it("falls back to a new session when resume cannot be launched", async () => {
    h.mock.setScript({ resumeThrows: true, completionSignal: "TASK_DONE", output: "TASK_DONE restored from checkpoint" });
    const taskId = seedRunningTask(h, { sessionId: "sess-gone" });
    backdateTask(h, taskId, 5_000);

    await h.runOnce();

    expect(state(h, taskId)).toBe("RUNNING");
    expect(h.mock.calls.some((c) => c.method === "startNewSession")).toBe(true);
    const events = h.events.listForTask(taskId).map((e) => e.type);
    expect(events).toContain("recovery_strategy_fallback");
  });

  it("process exit without progress is NOT treated as success", async () => {
    // Exit 0, no completion signal, and no MCP heartbeat during recovery.
    h.mock.setScript({ output: "exited silently", completionSignal: undefined });
    const taskId = seedRunningTask(h, { sessionId: "sess-2" });
    backdateTask(h, taskId, 5_000);

    await h.runOnce();

    expect(state(h, taskId)).toBe("INTERRUPTED");
    expect(h.tasks.get(taskId)?.recoveryAttempts).toBe(1);
    expect(h.attempts.listForTask(taskId)[0]?.status).toBe("failed");
  });

  it("retries transient failures and recovers on a later attempt", async () => {
    h.mock.setScript({ resumeFailures: 1, completionSignal: "TASK_DONE", output: "TASK_DONE ok" });
    const taskId = seedRunningTask(h, { sessionId: "sess-3" });
    backdateTask(h, taskId, 5_000);

    await h.runOnce(); // first attempt fails (simulated transient failure)
    expect(state(h, taskId)).toBe("INTERRUPTED");
    expect(h.tasks.get(taskId)?.recoveryAttempts).toBe(1);

    await waitFor(() => isDue(h, taskId)); // cooldown (backoff with jitter)
    await h.runOnce(); // retry succeeds
    expect(state(h, taskId)).toBe("RUNNING");
    expect(h.tasks.get(taskId)?.recoveryAttempts).toBe(1); // not incremented on success
  });

  it("marks BLOCKED after retry exhaustion", async () => {
    h.mock.setScript({ exitCode: 1, output: "hard failure: nothing worked" });
    const taskId = seedRunningTask(h, { sessionId: "sess-4" });
    backdateTask(h, taskId, 5_000);

    for (let i = 0; i < 3; i++) {
      await h.runOnce();
      await sleep(30); // let the cooldown expire before the next attempt
    }

    expect(state(h, taskId)).toBe("BLOCKED");
    expect(h.tasks.get(taskId)?.recoveryAttempts).toBe(3);
    const events = h.events.listForTask(taskId).map((e) => e.type);
    expect(events).toContain("blocked");
  });

  it("restores state when a watchdog restarts (startup reconciliation)", async () => {
    h.mock.setScript({ completionSignal: "TASK_DONE", output: "TASK_DONE continued" });
    const taskId = seedRunningTask(h, { sessionId: "sess-5" });
    backdateTask(h, taskId, 5_000);
    // Simulate a dead watchdog that died mid-recovery.
    h.tasks.transition(taskId, "INTERRUPTED");
    h.tasks.claimRecovery(taskId, "wd-dead", 60_000);
    h.tasks.transition(taskId, "RECOVERING");
    const attemptId = h.attempts.start(taskId, "wd-dead", "resume_session");
    h.db.db.prepare("UPDATE tasks SET recovery_owner_expires_at = ? WHERE id = ?").run(Date.now() - 1, taskId);

    // New supervisor starts on the same database and must reconcile + recover.
    await h.runOnce();

    expect(state(h, taskId)).toBe("RUNNING");
    const attempts = h.attempts.listForTask(taskId);
    expect(attempts.some((a) => a.id === attemptId && a.status === "aborted")).toBe(true);
  });

  it("prevents a second supervisor from recovering the same task", async () => {
    h.mock.setScript({ completionSignal: "TASK_DONE", output: "TASK_DONE ok" });
    const taskId = seedRunningTask(h, { sessionId: "sess-6" });
    backdateTask(h, taskId, 5_000);

    await h.runOnce(); // this supervisor holds the leader lock and recovers

    // A second supervisor on the same DB cannot acquire the lock.
    const lock = new LeaderLock(h.db);
    expect(lock.tryAcquire("wd-other", 60_000)).toBe(false);

    const attemptRows = h.attempts.listForTask(taskId).filter((a) => a.status === "succeeded");
    expect(attemptRows).toHaveLength(1);
  });

  it("honours cancellation during recovery", async () => {
    h.mock.setScript({ hang: true });
    const taskId = seedRunningTask(h, { sessionId: "sess-7" });
    backdateTask(h, taskId, 5_000);

    const tickPromise = h.runOnce(); // hangs inside recovery
    await waitFor(() => state(h, taskId) === "RECOVERING");

    h.tasks.transition(taskId, "CANCELLED");
    h.mock.resolveHangingLaunches(0);
    await tickPromise;

    expect(state(h, taskId)).toBe("CANCELLED");
    const events = h.events.listForTask(taskId).map((e) => e.type);
    expect(events).toContain("recovery_aborted");
  });

  it("never recovers completed tasks", async () => {
    const taskId = seedRunningTask(h, { sessionId: "sess-8" });
    h.tasks.transition(taskId, "COMPLETED");
    backdateTask(h, taskId, 60_000);

    await h.runOnce();

    expect(state(h, taskId)).toBe("COMPLETED");
    expect(h.mock.calls.some((c) => c.method === "resumeSession")).toBe(false);
  });

  it("does not recover while heartbeats are fresh", async () => {
    const taskId = seedRunningTask(h, { sessionId: "sess-9" }); // fresh heartbeat

    await h.runOnce();

    expect(state(h, taskId)).toBe("RUNNING");
    expect(h.attempts.listForTask(taskId)).toHaveLength(0);
  });

  it("does not recover when the global switch is off", async () => {
    const disabled = makeHarness({ RECOVERY_ENABLED: "false" });
    try {
      const fresh = seedRunningTask(disabled, { sessionId: "s" });
      backdateTask(disabled, fresh, 5_000);
      await disabled.runOnce();
      expect(state(disabled, fresh)).toBe("RUNNING");
      expect(disabled.attempts.listForTask(fresh)).toHaveLength(0);
    } finally {
      await disabled.stop();
      disabled.cleanup();
    }
  });
});

// ---------- utilities ----------

function backdateTask(h: Harness, taskId: string, msAgo: number): void {
  h.db.db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").run(Date.now() - msAgo, taskId);
}

/** Adapter whose every launch throws — simulates a broken binary / spawn failure. */
class ThrowingAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly agentType = "mock";
  readonly capabilities: AdapterCapabilities = {
    detect: true,
    inspectSession: false,
    resumeSession: true,
    launchNew: true,
    restoreContext: false,
    processHealth: true,
    gracefulCancel: false,
    completionDetection: false,
  };
  launchCalls = 0;
  async detect(): Promise<boolean> {
    return true;
  }
  async resumeSession(): Promise<LaunchResult> {
    this.launchCalls += 1;
    throw new Error("simulated spawn failure");
  }
  async startNewSession(): Promise<LaunchResult> {
    this.launchCalls += 1;
    throw new Error("simulated spawn failure");
  }
}

describe("watchdog launch-exception handling", () => {
  it("applies backoff between failed launches and blocks after exhausting the budget", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uar-throw-"));
    const dbPath = path.join(dir, "test.db");
    const config = testConfig({ RECOVERY_MAX_ATTEMPTS: "2", RECOVERY_BACKOFF_BASE_MS: "5000", RECOVERY_BACKOFF_MAX_MS: "5000" }, dbPath);
    const registry = new AdapterRegistry();
    const throwing = new ThrowingAdapter();
    registry.register(throwing);
    const logger = createLogger({ level: "error" });
    const supervisor = new WatchdogSupervisor(config, registry, logger);

    const db = new Database(dbPath);
    db.migrate();
    const events = new EventRepository(db);
    const tasks = new TaskRepository(db, events);

    try {
      const task = tasks.create({
        taskId: "throw-1",
        agentType: "mock",
        adapterId: "mock",
        sessionId: "sess-x",
        workingDirectory: WD,
        description: "d",
        maxAttempts: 2,
      });
      tasks.transition(task.id, "RUNNING");
      tasks.setProgress(task.id, "work");
      db.db.prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?").run(Date.now() - 5_000, task.id);

      await supervisor.runOnce(); // attempt 1 throws -> INTERRUPTED + backoff scheduled
      const afterFirst = tasks.get(task.id);
      expect(afterFirst?.state).toBe("INTERRUPTED");
      expect(afterFirst?.recoveryAttempts).toBe(1);
      expect(afterFirst?.nextRecoveryAt ?? 0).toBeGreaterThan(Date.now() - 1); // backoff applied
      expect(throwing.launchCalls).toBe(2); // resume + new-session fallback both threw

      // Second launch must wait for the backoff window.
      await supervisor.runOnce();
      expect(throwing.launchCalls).toBe(2);
      expect(tasks.get(task.id)?.recoveryAttempts).toBe(1);

      // Backdate the cooldown, then retry: attempt 2 throws -> budget exhausted -> BLOCKED.
      db.db.prepare("UPDATE tasks SET next_recovery_at = ? WHERE id = ?").run(Date.now() - 1, task.id);
      await supervisor.runOnce();
      const afterSecond = tasks.get(task.id);
      expect(afterSecond?.state).toBe("BLOCKED");
      expect(afterSecond?.recoveryAttempts).toBe(2);
    } finally {
      await supervisor.stop();
      db.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });
});

describe("mock adapter resumeThrows extension", () => {
  it("supports scripted launch-time failures", async () => {
    const mock = new MockAdapter();
    mock.setScript({ resumeThrows: true });
    const task = {
      id: "t",
      agentType: "mock",
      adapterId: "mock",
      sessionId: "s",
      processPid: null,
      workingDirectory: WD,
      description: "d",
      state: "INTERRUPTED" as const,
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
      lastActivityAt: Date.now(),
      interruptionDetectedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      cancelledAt: null,
      blockedAt: null,
    };
    await expect(mock.resumeSession(task, { instruction: "go", cwd: WD })).rejects.toThrow();
  });
});
