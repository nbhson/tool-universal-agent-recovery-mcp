/** Tests for the supervisor state dump CLI (uar-state). */
import { describe, it, expect } from "vitest";
import { Database } from "../src/storage/database.js";
import { EventRepository } from "../src/storage/event.repository.js";
import { TaskRepository } from "../src/storage/task.repository.js";
import { LeaderLock } from "../src/storage/leader-lock.js";
import { dumpState } from "../src/cli/dump-state.js";

function makeDb(): { db: Database; tasks: TaskRepository; events: EventRepository; lock: LeaderLock } {
  const db = new Database(":memory:");
  db.migrate();
  const events = new EventRepository(db);
  const tasks = new TaskRepository(db, events);
  return { db, tasks, events, lock: new LeaderLock(db) };
}

const INPUT = {
  taskId: "task-1",
  agentType: "mock",
  adapterId: "mock",
  sessionId: "sess-1",
  workingDirectory: "/work/proj",
  description: "do the thing",
};

describe("dumpState", () => {
  it("dumps tasks with lease holder, retry counts and next recovery time", () => {
    const { db, tasks } = makeDb();
    const t = tasks.create(INPUT);
    tasks.transition(t.id, "RUNNING");
    tasks.setProgress(t.id, "half done");
    tasks.transition(t.id, "INTERRUPTED", { lastError: "boom", errorClass: "CRASH" });
    tasks.claimRecovery(t.id, "wd-42", 60_000, Date.now());
    tasks.incrementRecoveryAttempts(t.id);
    tasks.scheduleNextRecovery(t.id, Date.now() + 5_000);

    const dump = dumpState(db) as {
      taskCount: number;
      tasksByState: Record<string, number>;
      leaderLock: { holder: string | null };
      tasks: Array<Record<string, unknown>>;
    };

    expect(dump.taskCount).toBe(1);
    expect(dump.tasksByState).toEqual({ INTERRUPTED: 1 });
    expect(dump.leaderLock.holder).toBeNull(); // no watchdog lease yet
    const task = dump.tasks[0]!;
    expect(task.state).toBe("INTERRUPTED");
    expect(task.recoveryOwner).toBe("wd-42");
    expect(task.leaseExpired).toBe(false);
    expect(task.recoveryAttempts).toBe(1);
    expect(task.maxAttempts).toBe(5);
    expect(task.nextRecoveryAt).toBeTruthy();
    expect(task.lastError).toBe("boom");
    expect(task.progress).toBe("half done");
    db.close();
  });

  it("marks expired leases and dumps the leader lock", () => {
    const { db, tasks, lock } = makeDb();
    const t = tasks.create(INPUT);
    tasks.transition(t.id, "INTERRUPTED");
    tasks.claimRecovery(t.id, "wd-dead", 60_000, Date.now() - 120_000); // expired
    lock.tryAcquire("wd-live", 60_000);

    const dump = dumpState(db) as {
      leaderLock: { holder: string; expired: boolean };
      tasks: Array<{ recoveryOwner: string; leaseExpired: boolean }>;
    };
    expect(dump.leaderLock.holder).toBe("wd-live");
    expect(dump.leaderLock.expired).toBe(false);
    expect(dump.tasks[0]?.recoveryOwner).toBe("wd-dead");
    expect(dump.tasks[0]?.leaseExpired).toBe(true);
    db.close();
  });

  it("handles a corrupt leader-lock value without crashing", () => {
    const { db, tasks } = makeDb();
    tasks.create(INPUT);
    db.db.prepare("INSERT INTO meta (key, value) VALUES ('watchdog_lock', 'not-json')").run();
    const dump = dumpState(db) as { leaderLock: { holder: string | null; note: string } };
    expect(dump.leaderLock.holder).toBeNull();
    expect(dump.leaderLock.note).toMatch(/corrupt/);
    db.close();
  });

  it("single-task mode includes recent events and is empty-safe in caller", () => {
    const { db, tasks, events } = makeDb();
    const t = tasks.create(INPUT);
    events.append(t.id, "progress", "agent", { at: "step 1" });

    const dump = dumpState(db, t.id) as {
      tasks: unknown[];
      events: Array<{ type: string; data: Record<string, unknown> | null }>;
    };
    expect(dump.tasks).toHaveLength(1);
    expect(dump.events.map((e) => e.type)).toContain("progress");
    expect(dump.events.find((e) => e.type === "progress")?.data).toEqual({ at: "step 1" });
    db.close();
  });
});
