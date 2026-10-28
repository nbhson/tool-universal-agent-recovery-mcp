/**
 * Demonstration: an interrupted task recovers automatically.
 *
 * Runs the full stack against a temporary SQLite database with a scripted
 * mock agent that "crashes" once and then recovers. Run with:
 *   npm run demo
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "../storage/database.js";
import { EventRepository } from "../storage/event.repository.js";
import { TaskRepository } from "../storage/task.repository.js";
import { RecoveryAttemptRepository } from "../storage/recovery-attempt.repository.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { MockAdapter } from "../adapters/mock.adapter.js";
import { WatchdogSupervisor } from "../watchdog/supervisor.js";
import { createLogger } from "../core/logger.js";
import { loadConfig } from "../config.js";

async function main(): Promise<void> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "uar-demo-"));
  const dbPath = path.join(workDir, "demo.db");

  const config = loadConfig({
    RECOVERY_DB_PATH: dbPath,
    RECOVERY_ALLOWED_DIRS: "",
    RECOVERY_STALE_MS: "300",
    RECOVERY_POLL_MS: "200",
    RECOVERY_MAX_ATTEMPTS: "3",
    RECOVERY_BACKOFF_BASE_MS: "50",
    RECOVERY_BACKOFF_MAX_MS: "50",
  });
  const logger = createLogger({ level: "info", component: "demo" });

  const registry = new AdapterRegistry(logger);
  const mock = new MockAdapter();
  mock.setScript({
    resumeFailures: 1, // first recovery attempt fails transiently
    completionSignal: "TASK_COMPLETE",
    output: "TASK_COMPLETE: all steps verified",
  });
  registry.register(mock);

  const supervisor = new WatchdogSupervisor(config, registry, logger);
  const db = new Database(dbPath);
  db.migrate();
  const events = new EventRepository(db);
  const tasks = new TaskRepository(db, events);
  const attempts = new RecoveryAttemptRepository(db);

  console.log("=== Universal Agent Recovery — automatic recovery demo ===\n");

  // 1. Simulate an agent registering a task and reporting progress.
  const task = tasks.create({
    taskId: "demo-refactor",
    agentType: "mock",
    adapterId: "mock",
    sessionId: "sess-demo-1",
    workingDirectory: process.cwd(),
    description: "Refactor the billing module and update tests",
  });
  tasks.transition(task.id, "RUNNING");
  tasks.setProgress(task.id, "extracted invoice calculation");
  tasks.setCheckpoint(task.id, { summary: "invoice calc extracted; tests pending", verified: true });
  console.log(`[${ts()}] task registered: ${task.id} (session sess-demo-1)`);

  // 2. The agent "dies": heartbeat goes stale, no process id to verify.
  db.db
    .prepare("UPDATE tasks SET last_activity_at = ? WHERE id = ?")
    .run(Date.now() - 10_000, task.id);
  console.log(`[${ts()}] agent interrupted (heartbeat stale)`);

  // 3. Watchdog detects, recovers (first attempt fails, retry succeeds).
  await supervisor.start(); // first tick runs immediately
  await waitUntilDue(task.id, tasks);
  await supervisor.runOnce();
  console.log(`\n[${ts()}] final state: ${tasks.get(task.id)?.state}`);
  console.log(`recovery attempts recorded: ${attempts.listForTask(task.id).length}`);
  console.log("\n--- event log ---");
  for (const e of events.listForTask(task.id).reverse()) {
    console.log(`  ${new Date(e.createdAt).toISOString()}  ${e.level.padEnd(5)} ${e.actor.padEnd(10)} ${e.type}`);
  }

  await supervisor.stop();
  db.close();
  fs.rmSync(workDir, { recursive: true, force: true });

  function ts(): string {
    return new Date().toISOString();
  }

  async function waitUntilDue(taskId: string, repo: TaskRepository): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const next = repo.get(taskId)?.nextRecoveryAt;
      if (next == null || next <= Date.now()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

main().catch((err) => {
  process.stderr.write(`demo failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
