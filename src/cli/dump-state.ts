/**
 * State dump CLI for debugging the supervisor: `uar-state`.
 *
 * Prints a JSON snapshot of the recovery database: every task (state, lease
 * holder, retry counts, next scheduled recovery), the watchdog leader lock,
 * and per-state summary counts. Read-only — never writes to the database.
 *
 * Usage:
 *   uar-state                       # pretty JSON, default DB path
 *   uar-state --db /path/to/recovery.db
 *   uar-state --task <taskId>       # single task with recent events
 *   uar-state --compact             # single-line JSON (for piping to jq)
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "../storage/database.js";
import { loadConfig } from "../config.js";
import { safeJsonParse } from "../storage/json.js";

interface DumpTask {
  id: string;
  state: string;
  agentType: string;
  adapterId: string;
  sessionId: string | null;
  processPid: number | null;
  workingDirectory: string;
  description: string;
  progress: string | null;
  lastError: string | null;
  errorClass: string | null;
  checkpointSummary: string | null;
  checkpointVerified: boolean;
  recoveryAttempts: number;
  maxAttempts: number;
  recoveryOwner: string | null;
  recoveryOwnerExpiresAt: string | null;
  leaseExpired: boolean;
  nextRecoveryAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function parseArgs(argv: string[]): { db?: string; task?: string; compact: boolean } {
  const args: { db?: string; task?: string; compact: boolean } = { compact: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i];
    else if (a === "--task") args.task = argv[++i];
    else if (a === "--compact") args.compact = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: uar-state [--db <path>] [--task <taskId>] [--compact]\n" +
          "  --db <path>    SQLite database path (default: RECOVERY_DB_PATH or ./data/recovery.db)\n" +
          "  --task <id>    Dump a single task, including its recent events\n" +
          "  --compact      Single-line JSON (for piping to jq)\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`uar-state: unknown argument '${a}' (see --help)\n`);
      process.exit(2);
    }
  }
  return args;
}

export function dumpState(db: Database, taskId?: string): Record<string, unknown> {
  const now = Date.now();

  // Leader lock (watchdog supervisor lease).
  const lockRow = db.db.prepare("SELECT value FROM meta WHERE key = 'watchdog_lock'").get() as
    | { value: string }
    | undefined;
  let leaderLock: Record<string, unknown> = { holder: null, note: "no watchdog holds the lease" };
  if (lockRow) {
    const parsed = safeJsonParse(lockRow.value, "watchdog_lock") as
      | { instanceId?: string; expiresAt?: number }
      | null;
    if (parsed && typeof parsed.instanceId === "string" && typeof parsed.expiresAt === "number") {
      leaderLock = {
        holder: parsed.instanceId,
        expiresAt: iso(parsed.expiresAt),
        expired: parsed.expiresAt < now,
        note: parsed.expiresAt < now ? "lease expired — another watchdog can take over" : "active",
      };
    } else {
      leaderLock = { holder: null, note: "corrupt lock value (will self-heal on next watchdog tick)" };
    }
  }

  // Tasks.
  const rows = (
    taskId
      ? db.db.prepare("SELECT * FROM tasks WHERE id = ?").all(taskId)
      : db.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all()
  ) as Array<Record<string, unknown>>;

  const tasks: DumpTask[] = rows.map((r) => {
    const expiresAt = r.recovery_owner_expires_at == null ? null : Number(r.recovery_owner_expires_at);
    return {
      id: String(r.id),
      state: String(r.state),
      agentType: String(r.agent_type),
      adapterId: String(r.adapter_id),
      sessionId: r.session_id == null ? null : String(r.session_id),
      processPid: r.process_pid == null ? null : Number(r.process_pid),
      workingDirectory: String(r.working_directory),
      description: String(r.description),
      progress: r.progress == null ? null : String(r.progress),
      lastError: r.last_error == null ? null : String(r.last_error),
      errorClass: r.error_class == null ? null : String(r.error_class),
      checkpointSummary: r.checkpoint_summary == null ? null : String(r.checkpoint_summary),
      checkpointVerified: Number(r.checkpoint_verified) === 1,
      recoveryAttempts: Number(r.recovery_attempts),
      maxAttempts: Number(r.max_attempts),
      recoveryOwner: r.recovery_owner == null ? null : String(r.recovery_owner),
      recoveryOwnerExpiresAt: iso(expiresAt),
      leaseExpired: expiresAt != null && expiresAt < now,
      nextRecoveryAt: iso(r.next_recovery_at == null ? null : Number(r.next_recovery_at)),
      lastActivityAt: iso(Number(r.last_activity_at)) as string,
      createdAt: iso(Number(r.created_at)) as string,
      updatedAt: iso(Number(r.updated_at)) as string,
    };
  });

  // Per-state counts for a quick health glance.
  const byState: Record<string, number> = {};
  for (const t of tasks) byState[t.state] = (byState[t.state] ?? 0) + 1;

  const dump: Record<string, unknown> = {
    dumpedAt: new Date(now).toISOString(),
    leaderLock,
    taskCount: tasks.length,
    tasksByState: byState,
    tasks,
  };

  if (taskId) {
    const eventRows = db.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 50")
      .all(taskId) as Array<Record<string, unknown>>;
    dump.events = eventRows.map((r) => ({
      id: Number(r.id),
      type: String(r.type),
      level: String(r.level),
      actor: String(r.actor),
      data: r.data ? safeJsonParse(String(r.data), `events:${String(r.id)}`) : null,
      createdAt: iso(Number(r.created_at)),
    }));
  }

  return dump;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const config = loadConfig();
  const dbPath = args.db ?? config.dbPath;

  let db: Database;
  try {
    db = new Database(path.resolve(dbPath));
  } catch (err) {
    process.stderr.write(
      `uar-state: cannot open database '${dbPath}': ${err instanceof Error ? err.message : String(err)}\n` +
        "Hint: the MCP server or watchdog may hold an exclusive lock, or the path is wrong.\n",
    );
    process.exit(1);
  }

  try {
    const dump = dumpState(db, args.task);
    if (args.task && (dump.tasks as unknown[]).length === 0) {
      process.stderr.write(`uar-state: task '${args.task}' not found\n`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(dump, null, args.compact ? 0 : 2) + "\n");
  } catch (err) {
    process.stderr.write(
      `uar-state: dump failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  } finally {
    db.close();
  }
}

/** Entry point when executed directly (`uar-state` / `npm run dump`). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
