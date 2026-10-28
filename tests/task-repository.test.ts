import { describe, it, expect, beforeEach } from "vitest";
import { Database } from "../src/storage/database.js";
import { EventRepository } from "../src/storage/event.repository.js";
import { TaskRepository } from "../src/storage/task.repository.js";

const INPUT = {
  taskId: "task-1",
  agentType: "mock",
  adapterId: "mock",
  workingDirectory: "/tmp/proj",
  description: "do the thing",
};

function makeRepo() {
  const db = new Database(":memory:");
  db.migrate();
  const events = new EventRepository(db);
  const tasks = new TaskRepository(db, events);
  return { db, events, tasks };
}

describe("task repository", () => {
  let env: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    env = makeRepo();
  });

  it("creates a REGISTERED task", () => {
    const t = env.tasks.create(INPUT);
    expect(t.state).toBe("REGISTERED");
    expect(t.maxAttempts).toBe(5);
    expect(t.recoveryAttempts).toBe(0);
  });

  it("records a checkpoint with history", () => {
    const t = env.tasks.create(INPUT);
    env.tasks.setCheckpoint(t.id, { summary: "step 1 done", details: { files: ["a.ts"] }, verified: true });
    const after = env.tasks.get(t.id)!;
    expect(after.checkpoint?.summary).toBe("step 1 done");
    expect(after.checkpoint?.verified).toBe(true);
  });

  it("guards transitions", () => {
    const t = env.tasks.create(INPUT);
    expect(() => env.tasks.transition(t.id, "COMPLETED")).toThrow();
  });

  it("reports progress and touches activity", () => {
    const t = env.tasks.create(INPUT);
    env.tasks.setProgress(t.id, "50%");
    const after = env.tasks.get(t.id)!;
    expect(after.progress).toBe("50%");
    expect(after.state).toBe("REGISTERED");
  });

  it("releases owner when transitioning to RUNNING", () => {
    const t = env.tasks.create(INPUT);
    env.db.db
      .prepare("UPDATE tasks SET state = 'RECOVERING', recovery_owner = 'wd-a', recovery_owner_expires_at = ? WHERE id = ?")
      .run(Date.now() + 10000, t.id);
    env.tasks.transition(t.id, "RUNNING");
    const after = env.tasks.get(t.id)!;
    expect(after.state).toBe("RUNNING");
    expect(after.recoveryOwner).toBeNull();
  });

  describe("recovery ownership", () => {
    it("enforces a single active owner", () => {
      const t = env.tasks.create(INPUT);
      env.tasks.transition(t.id, "INTERRUPTED");
      expect(env.tasks.claimRecovery(t.id, "wd-a", 60_000)).toBe(true);
      expect(env.tasks.claimRecovery(t.id, "wd-b", 60_000)).toBe(false);
      expect(env.tasks.renewRecoveryLease(t.id, "wd-a", 60_000)).toBe(true);
      expect(env.tasks.renewRecoveryLease(t.id, "wd-b", 60_000)).toBe(false);
    });

    it("allows takeover after lease expiry", () => {
      const t = env.tasks.create(INPUT);
      env.tasks.transition(t.id, "INTERRUPTED");
      expect(env.tasks.claimRecovery(t.id, "wd-a", -1)).toBe(true); // instantly expired lease
      expect(env.tasks.claimRecovery(t.id, "wd-b", 60_000)).toBe(true);
    });

    it("reconciles stale RECOVERING tasks on startup", () => {
      const t = env.tasks.create(INPUT);
      env.tasks.transition(t.id, "INTERRUPTED");
      env.tasks.claimRecovery(t.id, "wd-dead", 60_000);
      env.tasks.transition(t.id, "RECOVERING");
      // Simulate the owner dying: lease expires.
      env.db.db
        .prepare("UPDATE tasks SET recovery_owner_expires_at = ? WHERE id = ?")
        .run(Date.now() - 1, t.id);
      expect(env.tasks.reconcileStaleOwners()).toBe(1);
      const after = env.tasks.get(t.id)!;
      expect(after.state).toBe("INTERRUPTED");
      expect(after.recoveryOwner).toBeNull();
    });
  });

  it("keeps an append-only event log", () => {
    const t = env.tasks.create(INPUT);
    env.events.append(t.id, "progress", "agent", { at: "x" });
    env.events.append(t.id, "checkpoint_saved", "agent", { summary: "s" }, "warn");
    const list = env.events.listForTask(t.id);
    expect(list.length).toBe(3); // task_registered + 2
    expect(list[0]?.type).toBe("checkpoint_saved");
    expect(list[0]?.level).toBe("warn");
  });
});
