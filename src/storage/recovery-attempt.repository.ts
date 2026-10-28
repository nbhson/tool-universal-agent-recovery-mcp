/** Recovery attempt persistence. */
import type { Database } from "./database.js";

export type RecoveryStrategy = "resume_session" | "new_session" | "restart_process";
export type AttemptStatus = "started" | "succeeded" | "failed" | "aborted";

export interface AttemptRecord {
  id: number;
  taskId: string;
  owner: string;
  strategy: string;
  status: AttemptStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export class RecoveryAttemptRepository {
  constructor(private readonly db: Database) {}

  start(taskId: string, owner: string, strategy: RecoveryStrategy, now = Date.now()): number {
    const res = this.db.db
      .prepare(
        "INSERT INTO recovery_attempts (task_id, owner, strategy, status, started_at) VALUES (?, ?, ?, 'started', ?)",
      )
      .run(taskId, owner, strategy, now);
    return Number(res.lastInsertRowid);
  }

  finish(attemptId: number, status: AttemptStatus, error?: string, now = Date.now()): void {
    this.db.db
      .prepare("UPDATE recovery_attempts SET status = ?, error = ?, finished_at = ? WHERE id = ?")
      .run(status, error ?? null, now, attemptId);
  }

  /** Attempts that were left 'started' by a dead watchdog; marked aborted on startup. */
  abortStale(owner: string | null, now = Date.now()): number {
    const res = owner
      ? this.db.db
          .prepare("UPDATE recovery_attempts SET status = 'aborted', finished_at = ? WHERE status = 'started' AND owner = ?")
          .run(now, owner)
      : this.db.db
          .prepare("UPDATE recovery_attempts SET status = 'aborted', finished_at = ? WHERE status = 'started'")
          .run(now);
    return Number(res.changes);
  }

  /** Attempts left 'started' whose task is no longer owned by their owner's live lease. */
  abortStaleOrphans(now = Date.now()): number {
    const res = this.db.db
      .prepare(
        `UPDATE recovery_attempts SET status = 'aborted', finished_at = ?
         WHERE status = 'started' AND id IN (
           SELECT a.id FROM recovery_attempts a
           JOIN tasks t ON t.id = a.task_id
           WHERE t.recovery_owner IS NULL
              OR t.recovery_owner != a.owner
              OR t.recovery_owner_expires_at < ?
         )`,
      )
      .run(now, now);
    return Number(res.changes);
  }

  listForTask(taskId: string, limit = 50): AttemptRecord[] {
    const rows = this.db.db
      .prepare("SELECT * FROM recovery_attempts WHERE task_id = ? ORDER BY id DESC LIMIT ?")
      .all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      owner: String(r.owner),
      strategy: String(r.strategy),
      status: String(r.status) as AttemptStatus,
      error: r.error == null ? null : String(r.error),
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    }));
  }
}
