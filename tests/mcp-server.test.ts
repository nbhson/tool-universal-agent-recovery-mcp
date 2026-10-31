/**
 * MCP server integration tests over an in-memory transport.
 * Exercises real MCP protocol round-trips for every tool.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Database } from "../src/storage/database.js";
import { EventRepository } from "../src/storage/event.repository.js";
import { TaskRepository } from "../src/storage/task.repository.js";
import { buildMcpServer, type ServerContext } from "../src/mcp/server.js";
import { createLogger } from "../src/core/logger.js";
import { loadConfig } from "../src/config.js";

async function setup() {
  const db = new Database(":memory:");
  db.migrate();
  const logger = createLogger({ level: "error" });
  const events = new EventRepository(db);
  const tasks = new TaskRepository(db, events);
  const config = loadConfig({ RECOVERY_ALLOWED_DIRS: process.platform === "win32" ? "C:\\work" : "/work" });
  const ctx: ServerContext = { db, tasks, events, config, logger };
  const server = buildMcpServer(ctx);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return { ctx, client, db, tasks, events, close: async () => { await client.close(); await server.close(); db.close(); } };
}

type CallResult = { ok?: boolean; error?: string; task?: Record<string, unknown>; __isError?: boolean; [k: string]: unknown };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }> | undefined)?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as CallResult;
  parsed.__isError = res.isError === true;
  return parsed;
}

const WIN = process.platform === "win32";

describe("mcp tools", () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    h = await setup();
  });

  it("1. registers, reports, checkpoints and completes a task", async () => {
    const wd = WIN ? "C:\\work\\proj" : "/work/proj";
    const reg = await call(h.client, "register_task", {
      taskId: "task-1",
      adapterId: "opencode",
      workingDirectory: wd,
      description: "Build the login page",
    });
    expect(reg.ok).toBe(true);
    expect(reg.task?.state).toBe("REGISTERED");

    const prog = await call(h.client, "report_progress", { taskId: "task-1", progress: "scaffolded components" });
    expect(prog.ok).toBe(true);
    expect((prog as unknown as { task?: { state?: string } }).state ?? undefined).toBeDefined();

    const cp = await call(h.client, "save_checkpoint", {
      taskId: "task-1",
      summary: "components scaffolded; styling pending",
      details: { files: ["Login.tsx"] },
      verified: true,
    });
    expect(cp.ok).toBe(true);

    const done = await call(h.client, "mark_completed", { taskId: "task-1", verification: "tests passed" });
    expect(done.ok).toBe(true);

    const status = await call(h.client, "get_task_status", { taskId: "task-1" });
    const task = (status as unknown as { task: { state: string; completedAt: string | null } }).task;
    expect(task.state).toBe("COMPLETED");
    expect(task.completedAt).toBeTruthy();
  });

  it("2. rejects duplicate registration", async () => {
    const wd = WIN ? "C:\\work\\proj" : "/work/proj";
    await call(h.client, "register_task", { taskId: "dup", adapterId: "opencode", workingDirectory: wd, description: "x" });
    const again = await call(h.client, "register_task", { taskId: "dup", adapterId: "opencode", workingDirectory: wd, description: "x" });
    expect(again.ok).toBe(false);
  });

  it("3. rejects working directories outside allowed roots", async () => {
    const evil = WIN ? "C:\\evil" : "/evil";
    const res = await call(h.client, "register_task", {
      taskId: "task-evil",
      adapterId: "opencode",
      workingDirectory: evil,
      description: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/outside|absolute/i);
  });

  it("4. rejects relative working directories", async () => {
    const res = await call(h.client, "register_task", {
      taskId: "task-rel",
      adapterId: "opencode",
      workingDirectory: "relative/path",
      description: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/absolute/i);
  });

  it("5. rejects invalid task ids (injection-style input)", async () => {
    // The SDK surfaces schema violations either as a protocol-level rejection
    // or as an error result; both mean the input was refused.
    let rejected: boolean;
    try {
      const res = await call(h.client, "register_task", {
        taskId: "bad id; DROP TABLE tasks",
        adapterId: "opencode",
        workingDirectory: WIN ? "C:\\work\\proj" : "/work/proj",
        description: "x",
      });
      rejected = res.ok === false || res.__isError === true;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    // The invalid id must not have been persisted.
    expect(h.tasks.get("bad id; DROP TABLE tasks")).toBeNull();
  });

  it("6. refuses mark_completed without any verified work evidence", async () => {
    const wd = WIN ? "C:\\work\\proj" : "/work/proj";
    await call(h.client, "register_task", { taskId: "fresh", adapterId: "opencode", workingDirectory: wd, description: "x" });
    const res = await call(h.client, "mark_completed", { taskId: "fresh", verification: "trust me" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/checkpoint|progress/i);
  });

  it("7. report_interruption classifies and transitions to INTERRUPTED", async () => {
    const wd = WIN ? "C:\\work\\proj" : "/work/proj";
    await call(h.client, "register_task", { taskId: "err", adapterId: "opencode", workingDirectory: wd, description: "x" });
    await call(h.client, "report_progress", { taskId: "err", progress: "started" });
    const res = await call(h.client, "report_interruption", { taskId: "err", error: "fetch failed ECONNRESET", exitCode: 1 });
    expect(res.ok).toBe(true);
    const status = await call(h.client, "get_task_status", { taskId: "err" });
    const task = (status as unknown as { task: { state: string; errorClass: string } }).task;
    expect(task.state).toBe("INTERRUPTED");
    expect(task.errorClass).toBe("network");
  });

  it("8. cancel_task stops recovery from any active state", async () => {
    const wd = WIN ? "C:\\work\\proj" : "/work/proj";
    await call(h.client, "register_task", { taskId: "c1", adapterId: "opencode", workingDirectory: wd, description: "x" });
    await call(h.client, "report_progress", { taskId: "c1", progress: "started" });
    const res = await call(h.client, "cancel_task", { taskId: "c1", reason: "user changed mind" });
    expect(res.ok).toBe(true);
    const status = await call(h.client, "get_task_status", { taskId: "c1" });
    expect((status as unknown as { task: { state: string } }).task.state).toBe("CANCELLED");
    // progress after cancellation is refused
    const prog = await call(h.client, "report_progress", { taskId: "c1", progress: "late" });
    expect(prog.ok).toBe(false);
  });

  it("9. get_task_status 404s cleanly", async () => {
    const res = await call(h.client, "get_task_status", { taskId: "nope" });
    expect(res.ok).toBe(false);
  });

  it("10. report_interruption on a BLOCKED task returns a friendly error", async () => {
    const wd = WIN ? "C:\\work\\proj" : "/work/proj";
    await call(h.client, "register_task", { taskId: "blk", adapterId: "opencode", workingDirectory: wd, description: "x" });
    await call(h.client, "report_progress", { taskId: "blk", progress: "started" });
    // Force the task into BLOCKED (as the watchdog would after exhausting retries).
    h.tasks.transition("blk", "INTERRUPTED", { lastError: "boom" });
    h.tasks.transition("blk", "BLOCKED");
    // BLOCKED -> INTERRUPTED is illegal: must surface as ok:false, not a crash.
    const res = await call(h.client, "report_interruption", { taskId: "blk", error: "still failing" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/BLOCKED/i);
    expect(h.tasks.get("blk")?.state).toBe("BLOCKED");
  });

  it("11. cancel_task is idempotent and completed tasks cannot be cancelled", async () => {
    const wd = WIN ? "C:\\work\\proj" : "/work/proj";
    await call(h.client, "register_task", { taskId: "c2", adapterId: "opencode", workingDirectory: wd, description: "x" });
    const first = await call(h.client, "cancel_task", { taskId: "c2", reason: "no longer needed" });
    expect(first.ok).toBe(true);
    const again = await call(h.client, "cancel_task", { taskId: "c2" });
    expect(again.ok).toBe(true);
    expect((again as { note?: string }).note).toMatch(/already cancelled/i);
    // A completed task refuses cancellation.
    await call(h.client, "register_task", { taskId: "c3", adapterId: "opencode", workingDirectory: wd, description: "x" });
    await call(h.client, "report_progress", { taskId: "c3", progress: "work" });
    await call(h.client, "mark_completed", { taskId: "c3", verification: "verified" });
    const done = await call(h.client, "cancel_task", { taskId: "c3" });
    expect(done.ok).toBe(false);
  });
});
