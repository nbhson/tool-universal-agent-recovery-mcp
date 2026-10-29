/**
 * Enterprise-hardening tests:
 *  - corrupt JSON in database rows must never crash the server/watchdog
 *  - duplicate task registration yields a friendly domain error
 *  - state transition + progress/checkpoint writes are atomic
 *  - agent output log directory is configurable via UAR_LOG_DIR
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import { Database } from "../src/storage/database.js";
import { EventRepository } from "../src/storage/event.repository.js";
import { TaskRepository } from "../src/storage/task.repository.js";
import { DuplicateTaskError } from "../src/storage/json.js";
import { buildMcpServer, type ServerContext } from "../src/mcp/server.js";
import { createLogger } from "../src/core/logger.js";
import { loadConfig } from "../src/config.js";

const INPUT = {
  taskId: "task-1",
  agentType: "mock",
  adapterId: "mock",
  workingDirectory: "/work/proj",
  description: "do the thing",
};

function makeRepo() {
  const db = new Database(":memory:");
  db.migrate();
  const logger = createLogger({ level: "error" });
  const events = new EventRepository(db, logger);
  const tasks = new TaskRepository(db, events, logger);
  return { db, events, tasks };
}

describe("corrupt JSON resilience", () => {
  let env: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    env = makeRepo();
  });

  it("task.get falls back safely on corrupt checkpoint_details", () => {
    const t = env.tasks.create(INPUT);
    env.db.db
      .prepare("UPDATE tasks SET checkpoint_summary = ?, checkpoint_details = ? WHERE id = ?")
      .run("summary", "{not valid json", t.id);
    const after = env.tasks.get(t.id);
    expect(after).not.toBeNull();
    expect(after?.checkpoint?.summary).toBe("summary");
    expect(after?.checkpoint?.details).toBeUndefined();
  });

  it("task.get falls back safely when checkpoint_details holds a non-object", () => {
    const t = env.tasks.create(INPUT);
    env.db.db
      .prepare("UPDATE tasks SET checkpoint_details = ? WHERE id = ?")
      .run('["array","not","object"]', t.id);
    expect(env.tasks.get(t.id)?.checkpoint?.details).toBeUndefined();
  });

  it("listByStates survives corrupt rows instead of crashing", () => {
    const t = env.tasks.create(INPUT);
    env.db.db.prepare("UPDATE tasks SET checkpoint_details = ? WHERE id = ?").run("}{", t.id);
    expect(() => env.tasks.listByStates(["REGISTERED"])).not.toThrow();
    expect(env.tasks.listByStates(["REGISTERED"])[0]?.checkpoint?.details).toBeUndefined();
  });

  it("events.listForTask falls back to data: null on corrupt JSON", () => {
    const t = env.tasks.create(INPUT);
    env.events.append(t.id, "progress", "agent", { at: "x" });
    env.db.db.prepare("UPDATE events SET data = ? WHERE type = 'progress'").run("truncat");
    const list = env.events.listForTask(t.id);
    expect(list).toHaveLength(2);
    expect(list[0]?.data).toBeNull();
    expect(list[1]?.data).toEqual({ agentType: "mock", workingDirectory: "/work/proj" });
  });
});

describe("duplicate task registration", () => {
  let env: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    env = makeRepo();
  });

  it("repository.create throws DuplicateTaskError on UNIQUE violation", () => {
    env.tasks.create(INPUT);
    expect(() => env.tasks.create(INPUT)).toThrow(DuplicateTaskError);
  });

  it("register_task returns a friendly error including the current state", async () => {
    const db = new Database(":memory:");
    db.migrate();
    const logger = createLogger({ level: "error" });
    const events = new EventRepository(db, logger);
    const tasks = new TaskRepository(db, events, logger);
    const config = loadConfig({ RECOVERY_ALLOWED_DIRS: "/work" });
    const ctx: ServerContext = { db, tasks, events, config, logger };
    const server = buildMcpServer(ctx);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(ct), client.connect(st)]);

    const call = async (args: Record<string, unknown>) => {
      const res = await client.callTool({ name: "register_task", arguments: args });
      return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { ok: boolean; error?: string };
    };

    const wd = "/work/proj";
    const first = await call({ taskId: "dup", adapterId: "opencode", workingDirectory: wd, description: "x" });
    expect(first.ok).toBe(true);

    const again = await call({ taskId: "dup", adapterId: "opencode", workingDirectory: wd, description: "x" });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already exists \(state: REGISTERED\)/);

    // And after the task moves on, the error reports the fresh state.
    tasks.transition("dup", "RUNNING");
    const third = await call({ taskId: "dup", adapterId: "opencode", workingDirectory: wd, description: "x" });
    expect(third.error).toMatch(/already exists \(state: RUNNING\)/);

    await client.close();
    await server.close();
    db.close();
  });
});

describe("atomic transition + write combinations", () => {
  let env: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    env = makeRepo();
  });

  it("transitionWithProgress moves REGISTERED to RUNNING and persists progress", () => {
    const t = env.tasks.create(INPUT);
    const after = env.tasks.transitionWithProgress(t.id, "50% done");
    expect(after.state).toBe("RUNNING");
    expect(after.progress).toBe("50% done");
  });

  it("transitionWithProgress keeps progress writes on non-REGISTERED tasks", () => {
    const t = env.tasks.create(INPUT);
    env.tasks.transition(t.id, "RUNNING");
    const after = env.tasks.transitionWithProgress(t.id, "later step");
    expect(after.state).toBe("RUNNING");
    expect(after.progress).toBe("later step");
  });

  it("transitionWithCheckpoint moves REGISTERED to RUNNING and persists the checkpoint", () => {
    const t = env.tasks.create(INPUT);
    const after = env.tasks.transitionWithCheckpoint(t.id, {
      summary: "step 1 done",
      details: { files: ["a.ts"] },
      verified: true,
    });
    expect(after.state).toBe("RUNNING");
    expect(after.checkpoint?.summary).toBe("step 1 done");
    expect(after.checkpoint?.verified).toBe(true);
    const events = env.events.listForTask(t.id).map((e) => e.type);
    expect(events).toContain("state_changed");
    expect(events).toContain("task_registered");
  });

  it("transitionWithCheckpoint on a RUNNING task does not duplicate state_changed", () => {
    const t = env.tasks.create(INPUT);
    env.tasks.transition(t.id, "RUNNING");
    env.tasks.transitionWithCheckpoint(t.id, { summary: "s", verified: false });
    const changed = env.events.listForTask(t.id).filter((e) => e.type === "state_changed");
    expect(changed).toHaveLength(0);
  });
});

describe("log directory configuration", () => {
  it("defaults to logs/agent-output (previous behavior)", () => {
    expect(loadConfig({}).logDir).toBe(path.join("logs", "agent-output"));
  });

  it("honours UAR_LOG_DIR override", () => {
    expect(loadConfig({ UAR_LOG_DIR: "/var/log/uar" }).logDir).toBe("/var/log/uar");
  });

  it("falls back to the default on empty UAR_LOG_DIR", () => {
    expect(loadConfig({ UAR_LOG_DIR: "   " }).logDir).toBe(path.join("logs", "agent-output"));
  });
});
