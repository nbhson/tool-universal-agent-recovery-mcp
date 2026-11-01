/** SQLite access via the built-in node:sqlite (zero native dependencies). */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../core/logger.js";

export const SCHEMA_VERSION = 1;

/**
 * Translate raw SQLite errors into actionable messages. Without this, users
 * see opaque strings like "database is locked" with no hint about the cause.
 */
export function friendlyDbError(err: unknown, file: string): unknown {
  if (!(err instanceof Error)) return err;
  const msg = err.message;
  const code = (err as NodeJS.ErrnoException).code ?? "";
  if (code === "SQLITE_BUSY" || /database is locked/i.test(msg)) {
    return new Error(
      `SQLite database is locked (${file}). Another process (MCP server or watchdog) ` +
        "is holding a write transaction, or the database is on a network filesystem " +
        "(not supported with WAL). Wait a moment and retry, check for stale `uar-watchdog` " +
        "processes (ps aux | grep uar-watchdog), or inspect the current state with `uar-state`.",
    );
  }
  if (/unable to open database file/i.test(msg) || code === "SQLITE_CANTOPEN") {
    return new Error(
      `Cannot open SQLite database at '${file}'. Check that the directory exists and is ` +
        "writable, and that RECOVERY_DB_PATH is the same for uar-mcp and uar-watchdog.",
    );
  }
  if (/malformed database image|file is not a database/i.test(msg)) {
    return new Error(
      `The database file '${file}' is corrupt or not a SQLite database. ` +
        "If the data is disposable, remove the file (and its -wal/-shm sidecars) and restart.",
    );
  }
  return err;
}

function execWithRetry(db: DatabaseSync, sql: string, attempts = 20, delayMs = 50): void {
  // PRAGMA journal_mode does not honor busy_timeout and can hit SQLITE_BUSY
  // when two processes open a fresh database simultaneously; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec(sql);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_type TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  session_id TEXT,
  process_pid INTEGER,
  working_directory TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'REGISTERED'
    CHECK (state IN ('REGISTERED','RUNNING','INTERRUPTED','RECOVERING','COMPLETED','BLOCKED','CANCELLED')),
  progress TEXT,
  last_error TEXT,
  error_class TEXT,
  checkpoint_summary TEXT,
  checkpoint_details TEXT,
  checkpoint_verified INTEGER NOT NULL DEFAULT 0,
  checkpoint_updated_at INTEGER,
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  recovery_owner TEXT,
  recovery_owner_expires_at INTEGER,
  next_recovery_at INTEGER,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  max_recovery_duration_ms INTEGER,
  last_activity_at INTEGER NOT NULL,
  interruption_detected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER,
  blocked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_next_recovery ON tasks(next_recovery_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  summary TEXT NOT NULL,
  details TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  actor TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);

CREATE TABLE IF NOT EXISTS recovery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started','succeeded','failed','aborted')),
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON recovery_attempts(task_id, started_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export class Database {
  readonly db: DatabaseSync;
  private readonly logger?: Logger;

  constructor(file: string, logger?: Logger) {
    this.logger = logger;
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    this.db = (() => {
      try {
        return new DatabaseSync(file);
      } catch (err) {
        throw friendlyDbError(err, file);
      }
    })();
    // WAL mode survives interrupted writes; busy_timeout serializes
    // concurrent MCP/watchdog writers instead of failing them.
    execWithRetry(this.db, "PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  /** Idempotent schema migrations keyed by a schema version in meta. */
  migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    const current = Number(row?.value ?? 0);
    if (current >= SCHEMA_VERSION) return;

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.exec(SCHEMA);
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(SCHEMA_VERSION));
      this.db.exec("COMMIT;");
      this.logger?.info("database migrated", { from: current, to: SCHEMA_VERSION });
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Run fn inside an IMMEDIATE transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      throw friendlyDbError(err, "this database");
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
