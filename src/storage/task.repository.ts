/** Task persistence + checkpoint storage. */
import type { Checkpoint, TaskInput, TaskRecord, TaskState } from "../core/task.js";
import { applyTransition } from "../core/state-machine.js";
import type { Database } from "./database.js";
import type { EventRepository } from "./event.repository.js";
import type { Logger } from "../core/logger.js";
import { safeJsonParse, isUniqueConstraintError, DuplicateTaskError } from "./json.js";

type Row = Record<string, unknown>;

function rowToTask(r: Row, logger?: Logger): TaskRecord {
  return {
    id: String(r.id),
    agentType: String(r.agent_type),
    adapterId: String(r.adapter_id),
    sessionId: r.session_id == null ? null : String(r.session_id),
    processPid: r.process_pid == null ? null : Number(r.process_pid),
    workingDirectory: String(r.working_directory),
    description: String(r.description),
    state: String(r.state) as TaskRecord["state"],
    progress: r.progress == null ? null : String(r.progress),
    lastError: r.last_error == null ? null : String(r.last_error),
    errorClass: r.error_class == null ? null : String(r.error_class),
    checkpoint:
      r.checkpoint_summary == null
        ? null
        : {
            summary: String(r.checkpoint_summary),
            details: r.checkpoint_details
              ? (safeJsonParse(String(r.checkpoint_details), `tasks:${String(r.id)}:checkpoint_details`, logger) ?? undefined)
              : undefined,
            verified: Number(r.checkpoint_verified) === 1,
          },
    recoveryAttempts: Number(r.recovery_attempts),
    recoveryOwner: r.recovery_owner == null ? null : String(r.recovery_owner),
    recoveryOwnerExpiresAt: r.recovery_owner_expires_at == null ? null : Number(r.recovery_owner_expires_at),
    nextRecoveryAt: r.next_recovery_at == null ? null : Number(r.next_recovery_at),
    maxAttempts: Number(r.max_attempts),
    maxRecoveryDurationMs: r.max_recovery_duration_ms == null ? null : Number(r.max_recovery_duration_ms),
    lastActivityAt: Number(r.last_activity_at),
    interruptionDetectedAt: r.interruption_detected_at == null ? null : Number(r.interruption_detected_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
    cancelledAt: r.cancelled_at == null ? null : Number(r.cancelled_at),
    blockedAt: r.blocked_at == null ? null : Number(r.blocked_at),
  };
}

export class TaskRepository {
  constructor(
    private readonly db: Database,
    private readonly events: EventRepository,
    private readonly logger?: Logger,
  ) {}

  create(input: TaskInput, now = Date.now()): TaskRecord {
    try {
      return this.createInternal(input, now);
    } catch (err) {
      // Register directly and translate the UNIQUE violation into a friendly
      // domain error instead of leaking raw SQLite messages to MCP callers.
      if (isUniqueConstraintError(err)) throw new DuplicateTaskError(input.taskId);
      throw err;
    }
  }

  private createInternal(input: TaskInput, now: number): TaskRecord {
    return this.db.transaction(() => {
      this.db.db
        .prepare(
          `INSERT INTO tasks (id, agent_type, adapter_id, session_id, process_pid, working_directory,
             description, state, max_attempts, max_recovery_duration_ms, last_activity_at,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'REGISTERED', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.taskId,
          input.agentType,
          input.adapterId,
          input.sessionId ?? null,
          input.processPid ?? null,
          input.workingDirectory,
          input.description,
          input.maxAttempts ?? 5,
          null, // max_recovery_duration_ms: no per-task runtime limit by default
          now,
          now,
          now,
        );
      this.events.append(input.taskId, "task_registered", "mcp", {
        agentType: input.agentType,
        workingDirectory: input.workingDirectory,
      });
      return this.getOrThrow(input.taskId);
    });
  }

  get(taskId: string): TaskRecord | null {
    const row = this.db.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    return row ? rowToTask(row, this.logger) : null;
  }

  private getOrThrow(taskId: string): TaskRecord {
    const task = this.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found after write`);
    return task;
  }

  listByStates(states: string[]): TaskRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db.db
      .prepare(`SELECT * FROM tasks WHERE state IN (${placeholders})`)
      .all(...states) as Row[];
    return rows.map((r) => rowToTask(r, this.logger));
  }

  /**
   * Atomic guarded state transition. Throws IllegalTransitionError on invalid
   * moves; same-state transitions are no-ops.
   */
  transition(
    taskId: string,
    to: TaskState,
    extra?: { lastError?: string | null; errorClass?: string | null },
  ): TaskRecord {
    return this.db.transaction(() => this.transitionInternal(taskId, to, extra));
  }

  private transitionInternal(
    taskId: string,
    to: TaskState,
    extra?: { lastError?: string | null; errorClass?: string | null },
  ): TaskRecord {
    const row = this.db.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    if (!row) throw new Error(`Task ${taskId} not found`);
    const current = String(row.state) as TaskState;
    const now = Date.now();
    const target = current === to ? to : applyTransition(taskId, current, to);
    if (current === target && !extra) return rowToTask(row, this.logger);

    const sets: string[] = ["state = ?", "updated_at = ?"];
    const params: Array<string | number | null> = [target, now];
    if (extra?.lastError !== undefined) {
      sets.push("last_error = ?");
      params.push(extra.lastError);
    }
    if (extra?.errorClass !== undefined) {
      sets.push("error_class = ?");
      params.push(extra.errorClass);
    }
    if (target === "COMPLETED") {
      sets.push("completed_at = ?");
      params.push(now);
    }
    if (target === "CANCELLED") {
      sets.push("cancelled_at = ?");
      params.push(now);
    }
    if (target === "BLOCKED") {
      sets.push("blocked_at = ?");
      params.push(now);
    }
    if (target === "RUNNING") {
      sets.push("recovery_owner = NULL", "recovery_owner_expires_at = NULL");
    }
    if (target === "INTERRUPTED") {
      sets.push("interruption_detected_at = ?");
      params.push(now);
    }
    params.push(taskId);
    this.db.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return this.getOrThrow(taskId);
  }

  /**
   * Atomically record progress, transitioning REGISTERED -> RUNNING first
   * when needed. A crash can no longer leave progress persisted without the
   * RUNNING state (or the opposite). Returns the fresh task record.
   */
  transitionWithProgress(taskId: string, progress: string): TaskRecord {
    return this.db.transaction(() => {
      this.transitionIfRegistered(taskId);
      this.setProgress(taskId, progress);
      return this.getOrThrow(taskId);
    });
  }

  /**
   * Atomically save a checkpoint, transitioning REGISTERED -> RUNNING first
   * when needed, so state, tasks row and checkpoint history stay consistent.
   */
  transitionWithCheckpoint(taskId: string, checkpoint: Checkpoint): TaskRecord {
    return this.db.transaction(() => {
      this.transitionIfRegistered(taskId);
      this.setCheckpointInternal(taskId, checkpoint, Date.now());
      return this.getOrThrow(taskId);
    });
  }

  /** REGISTERED -> RUNNING side effect shared by progress/checkpoint writes. */
  private transitionIfRegistered(taskId: string): void {
    const row = this.db.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as
      | { state: string }
      | undefined;
    if (!row) throw new Error(`Task ${taskId} not found`);
    if (String(row.state) === "REGISTERED") {
      this.transitionInternal(taskId, "RUNNING");
      this.events.append(taskId, "state_changed", "mcp", { to: "RUNNING" });
    }
  }

  setProgress(taskId: string, progress: string, now = Date.now()): void {
    this.db.db
      .prepare("UPDATE tasks SET progress = ?, last_activity_at = ?, updated_at = ? WHERE id = ?")
      .run(progress, now, now, taskId);
  }

  touchActivity(taskId: string, now = Date.now()): void {
    this.db.db
      .prepare("UPDATE tasks SET last_activity_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, taskId);
  }

  setSession(taskId: string, sessionId: string | null): void {
    this.db.db
      .prepare("UPDATE tasks SET session_id = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, Date.now(), taskId);
  }

  setProcessPid(taskId: string, pid: number | null): void {
    this.db.db
      .prepare("UPDATE tasks SET process_pid = ?, updated_at = ? WHERE id = ?")
      .run(pid, Date.now(), taskId);
  }

  setCheckpoint(taskId: string, checkpoint: Checkpoint, now = Date.now()): void {
    this.db.transaction(() => this.setCheckpointInternal(taskId, checkpoint, now));
  }

  private setCheckpointInternal(taskId: string, checkpoint: Checkpoint, now: number): void {
    this.db.db
      .prepare(
        `UPDATE tasks SET checkpoint_summary = ?, checkpoint_details = ?, checkpoint_verified = ?,
           checkpoint_updated_at = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        checkpoint.summary,
        checkpoint.details ? JSON.stringify(checkpoint.details) : null,
        checkpoint.verified ? 1 : 0,
        now,
        now,
        now,
        taskId,
      );
    this.db.db
      .prepare(
        "INSERT INTO checkpoints (task_id, summary, details, verified, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        taskId,
        checkpoint.summary,
        checkpoint.details ? JSON.stringify(checkpoint.details) : null,
        checkpoint.verified ? 1 : 0,
        now,
      );
  }

  // --- recovery ownership: single active owner per task ---

  /**
   * Atomically claim recovery ownership. Succeeds only when the task is
   * unowned, already owned by the same owner, or the previous lease expired.
   */
  claimRecovery(taskId: string, owner: string, leaseMs: number, now = Date.now()): boolean {
    const res = this.db.db
      .prepare(
        `UPDATE tasks SET recovery_owner = ?, recovery_owner_expires_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('INTERRUPTED','BLOCKED','RUNNING')
           AND (recovery_owner IS NULL OR recovery_owner = ? OR recovery_owner_expires_at < ?)`,
      )
      .run(owner, now + leaseMs, now, taskId, owner, now);
    return Number(res.changes) === 1;
  }

  renewRecoveryLease(taskId: string, owner: string, leaseMs: number, now = Date.now()): boolean {
    const res = this.db.db
      .prepare(
        `UPDATE tasks SET recovery_owner_expires_at = ?, updated_at = ?
         WHERE id = ? AND recovery_owner = ? AND recovery_owner_expires_at >= ?`,
      )
      .run(now + leaseMs, now, taskId, owner, now);
    return Number(res.changes) === 1;
  }

  releaseRecoveryOwner(taskId: string, owner: string): void {
    this.db.db
      .prepare(
        `UPDATE tasks SET recovery_owner = NULL, recovery_owner_expires_at = NULL, updated_at = ?
         WHERE id = ? AND recovery_owner = ?`,
      )
      .run(Date.now(), taskId, owner);
  }

  incrementRecoveryAttempts(taskId: string, now = Date.now()): number {
    this.db.db
      .prepare("UPDATE tasks SET recovery_attempts = recovery_attempts + 1, updated_at = ? WHERE id = ?")
      .run(now, taskId);
    const row = this.db.db.prepare("SELECT recovery_attempts FROM tasks WHERE id = ?").get(taskId) as
      | { recovery_attempts: number }
      | undefined;
    return Number(row?.recovery_attempts ?? 0);
  }

  scheduleNextRecovery(taskId: string, at: number | null): void {
    this.db.db
      .prepare("UPDATE tasks SET next_recovery_at = ?, updated_at = ? WHERE id = ?")
      .run(at, Date.now(), taskId);
  }

  markInterruptionDetected(taskId: string, at: number): void {
    this.db.db
      .prepare("UPDATE tasks SET interruption_detected_at = ?, updated_at = ? WHERE id = ?")
      .run(at, at, taskId);
  }

  /**
   * Startup reconciliation: clear recovery leases that expired while the
   * watchdog was down and return stale RECOVERING tasks to INTERRUPTED so
   * they can be re-claimed by a (new) watchdog instance.
   */
  reconcileStaleOwners(now = Date.now()): number {
    const res = this.db.db
      .prepare(
        `UPDATE tasks SET state = 'INTERRUPTED', recovery_owner = NULL, recovery_owner_expires_at = NULL, updated_at = ?
         WHERE state = 'RECOVERING' AND (recovery_owner_expires_at IS NULL OR recovery_owner_expires_at < ?)`,
      )
      .run(now, now);
    return Number(res.changes);
  }
}
