/**
 * Recovery Watchdog Supervisor.
 *
 * Independent process. Polls the shared SQLite store, evaluates task
 * liveness, verifies suspected interruptions, and performs recovery through
 * agent adapters — with a single-owner guarantee per task, retry budgets and
 * startup reconciliation. It never depends on the coding agent being alive.
 */
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Logger } from "../core/logger.js";
import type { TaskRecord } from "../core/task.js";
import { ACTIVE_STATES } from "../core/task.js";
import type { RecoveryConfig } from "../config.js";
import { classifyError, isRecoverable } from "../core/error-classifier.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { AgentAdapter, LaunchResult } from "../adapters/adapter.interface.js";
import { Database } from "../storage/database.js";
import { TaskRepository } from "../storage/task.repository.js";
import { EventRepository } from "../storage/event.repository.js";
import { RecoveryAttemptRepository } from "../storage/recovery-attempt.repository.js";
import { LeaderLock } from "../storage/leader-lock.js";
import { evaluateLiveness } from "./monitor.js";
import { computeBackoff, hasRetryBudget, isDueForRecovery } from "./recovery-policy.js";
import { buildRecoveryInstruction } from "./recovery-instruction.js";

export class WatchdogSupervisor {
  private readonly instanceId: string;
  private tickTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Re-entrancy guard: overlapping interval ticks are skipped, not queued. */
  private ticking = false;
  private readonly running = new Map<string, { attemptId: number; startedAt: number; cancel: () => void }>();
  private readonly db: Database;
  private readonly tasks: TaskRepository;
  private readonly events: EventRepository;
  private readonly attempts: RecoveryAttemptRepository;
  private readonly lock: LeaderLock;

  constructor(
    private readonly config: RecoveryConfig,
    private readonly registry: AdapterRegistry,
    private readonly logger: Logger,
  ) {
    this.db = new Database(config.dbPath, logger);
    this.db.migrate();
    this.events = new EventRepository(this.db, logger);
    this.tasks = new TaskRepository(this.db, this.events, logger);
    this.attempts = new RecoveryAttemptRepository(this.db);
    this.lock = new LeaderLock(this.db, logger);
    this.instanceId = `wd-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  }

  // --- lifecycle ---

  async start(): Promise<void> {
    this.logger.info("watchdog starting", {
      instanceId: this.instanceId,
      dbPath: this.config.dbPath,
      recoveryEnabled: this.config.recoveryEnabled,
    });

    // Startup reconciliation: abort attempts left 'started' by dead watchdogs,
    // release stale RECOVERING leases so tasks can be re-claimed.
    this.reconcile(Date.now());

    if (!this.config.recoveryEnabled) {
      this.logger.warn("recovery disabled via RECOVERY_ENABLED=false — monitoring only, no recovery");
    }

    this.tickTimer = setInterval(() => void this.tickGuarded(), this.config.pollIntervalMs);
    this.tickTimer.unref();
    await this.tick();
  }

  /** Manual single tick — used by tests and available for cron-style deployment. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.running.size > 0) {
      this.logger.warn("cancelling in-flight recoveries on shutdown", {
        tasks: [...this.running.keys()],
      });
      for (const entry of this.running.values()) {
        try {
          entry.cancel();
        } catch {
          /* best effort */
        }
      }
    }
    this.logger.info("watchdog shutting down", { runningRecoveries: this.running.size });
    this.lock.release(this.instanceId);
    this.db.close();
  }

  // --- main loop ---

  /**
   * Interval-scheduled tick with a re-entrancy guard: if the previous tick is
   * still running (e.g. a slow recovery), overlapping ticks are skipped rather
   * than queued, so work never piles up behind a stalled loop.
   */
  private async tickGuarded(): Promise<void> {
    if (this.ticking) {
      this.logger.debug("tick skipped: previous tick still running");
      return;
    }
    this.ticking = true;
    try {
      await this.tick();
    } finally {
      this.ticking = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const now = Date.now();
    try {
      // Single active watchdog per database (leased leader lock).
      if (!this.acquireOrRenewLock(now)) return;

      // Reconcile every tick: clear leases/attempts orphaned by dead watchdogs.
      this.reconcile(now);

      const active = this.tasks.listByStates(ACTIVE_STATES);
      let inFlight = this.running.size;
      for (const task of active) {
        if (inFlight >= this.config.maxConcurrent) {
          this.logger.debug("max concurrent recoveries reached; deferring", { inFlight });
          break;
        }
        const handled = await this.evaluateTask(task, now);
        if (handled) inFlight += 1;
      }
    } catch (err) {
      this.logger.error("watchdog tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private acquireOrRenewLock(now: number): boolean {
    if (this.lock.tryAcquire(this.instanceId, this.config.ownerLeaseMs, now)) return true;
    return this.lock.renew(this.instanceId, this.config.ownerLeaseMs, now);
  }

  /**
   * Reconciliation: clear recovery leases that expired while a watchdog was
   * down and abort attempts orphaned by dead owners. Safe to run every tick:
   * in-flight attempts of the live owner are untouched.
   */
  private reconcile(now: number): void {
    const reconciled = this.tasks.reconcileStaleOwners(now);
    const aborted = this.attempts.abortStaleOrphans(now);
    if (reconciled > 0 || aborted > 0) {
      this.logger.warn("reconciliation applied", {
        reconciledTasks: reconciled,
        abortedAttempts: aborted,
      });
    }
  }

  /** Returns true when a recovery was started for this task. */
  private async evaluateTask(task: TaskRecord, now: number): Promise<boolean> {
    if (this.running.has(task.id)) return false;

    if (task.state === "INTERRUPTED" || task.state === "BLOCKED") {
      if (!isDueForRecovery(task.nextRecoveryAt, now)) return false;
    }

    const evaluation = evaluateLiveness(task, now, this.config.staleMs);
    this.logger.debug("liveness", { taskId: task.id, ...evaluation });
    if (!evaluation.interruptionSuspected) return false;

    // Verify before acting: session inspection when the adapter supports it.
    // sessionExists returns null on CLI failure (inspection unavailable) —
    // defer rather than wrongly falling back to a new session.
    const adapter = this.registry.get(task.adapterId);
    if (task.sessionId && adapter.capabilities.inspectSession && adapter.sessionExists) {
      const sessionOk = await adapter.sessionExists(task.sessionId).catch(() => null);
      if (sessionOk === null) {
        this.logger.warn("session inspection unavailable; deferring recovery", { taskId: task.id });
        return false;
      }
      if (!sessionOk) {
        this.logger.info("session no longer exists; will restore from checkpoint", {
          taskId: task.id,
          sessionId: task.sessionId,
        });
      }
    }

    await this.recover(task);
    return true;
  }

  private async recover(task: TaskRecord): Promise<void> {
    const taskId = task.id;
    const now = Date.now();

    if (!this.config.recoveryEnabled) {
      this.logger.info("recovery skipped (disabled)", { taskId });
      return;
    }

    const fresh = this.tasks.get(taskId);
    if (!fresh || !hasRetryBudget(fresh)) {
      try {
        this.tasks.transition(taskId, "BLOCKED");
        this.events.append(taskId, "blocked", "watchdog", { reason: "retry budget exhausted" }, "warn");
      } catch {
        /* transition not legal from current state; skip */
      }
      return;
    }

    // Atomic single-owner claim.
    if (!this.tasks.claimRecovery(taskId, this.instanceId, this.config.ownerLeaseMs, now)) {
      this.logger.debug("task already owned by another recovery worker", { taskId });
      return;
    }

    // RUNNING tasks must pass through INTERRUPTED (recorded, auditable) before
    // recovery; INTERRUPTED/BLOCKED tasks transition directly.
    try {
      if (fresh.state === "RUNNING") {
        this.tasks.transition(taskId, "INTERRUPTED");
        this.events.append(taskId, "interruption_detected", "watchdog", {
          reason: "watchdog verified the interruption",
        });
      }
      this.tasks.transition(taskId, "RECOVERING");
    } catch (err) {
      this.logger.warn("cannot transition to RECOVERING", {
        taskId,
        from: fresh.state,
        error: err instanceof Error ? err.message : String(err),
      });
      this.tasks.releaseRecoveryOwner(taskId, this.instanceId);
      return;
    }
    this.events.append(taskId, "recovery_claimed", "watchdog", { owner: this.instanceId });

    try {
      await this.executeRecovery(taskId);
    } finally {
      this.running.delete(taskId);
    }
  }

  // --- recovery execution ---

  private async executeRecovery(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    const adapter = this.registry.get(task.adapterId);
    const instruction = buildRecoveryInstruction(task, task.checkpoint);
    const logDir = this.config.logDir;
    const logFile = path.join(logDir, `${taskId}-attempt${task.recoveryAttempts + 1}.log`);
    const maxRuntime = task.maxRecoveryDurationMs ?? this.config.maxRuntimeMs;
    const startedAt = Date.now();

    const attemptId = this.attempts.start(taskId, this.instanceId, "resume_session");
    let strategy: "resume_session" | "new_session" | "restart_process" = "resume_session";
    this.running.set(taskId, { attemptId, startedAt, cancel: () => undefined });

    // Keep the ownership lease alive during long recoveries.
    const leaseTimer = setInterval(() => {
      const ok = this.tasks.renewRecoveryLease(taskId, this.instanceId, this.config.ownerLeaseMs);
      if (!ok) this.logger.warn("recovery lease lost", { taskId });
    }, Math.floor(this.config.ownerLeaseMs / 2));
    leaseTimer.unref();

    try {
      let launch: LaunchResult | null = null;

      // 1. Preferred: resume the existing session.
      if (adapter.capabilities.resumeSession && task.sessionId) {
        try {
          launch = await adapter.resumeSession(task, {
            instruction,
            cwd: task.workingDirectory,
            sessionId: task.sessionId,
            timeoutMs: maxRuntime,
            logFile,
          });
          strategy = "resume_session";
        } catch (err) {
          this.logger.warn("resume launch failed; will try fallback", {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
          launch = null;
        }
      }

      // 2. Fallback: fresh session restoring context from the persisted checkpoint.
      if (!launch && adapter.capabilities.launchNew) {
        strategy = "new_session";
        this.events.append(taskId, "recovery_strategy_fallback", "watchdog", {
          from: "resume_session",
          to: "new_session",
          note: task.sessionId ? "existing session could not be resumed" : "no session id available",
        });
        launch = await adapter.startNewSession(task, {
          instruction,
          cwd: task.workingDirectory,
          timeoutMs: maxRuntime,
          logFile,
        });
      }

      if (!launch) {
        throw new Error("no recovery strategy available for this adapter");
      }

      this.attemptStrategy(taskId, attemptId, launch, strategy);

      // Runtime limit enforcement.
      const runtimeTimer = setTimeout(() => {
        this.logger.warn("recovery runtime limit reached; cancelling agent process", {
          taskId,
          maxRuntimeMs: maxRuntime,
        });
        launch.cancel();
      }, maxRuntime);
      runtimeTimer.unref();

      const result = await launch.exited;
      const elapsed = Date.now() - startedAt;
      const timedOut = elapsed >= maxRuntime - 1_000;

      const completed = this.detectCompletion(adapter, result.stdout);

      // Success requires BOTH a clean exit AND evidence the agent resumed
      // work (heartbeat via MCP) or explicitly reported completion.
      const progressed = this.tasks.get(taskId)!.lastActivityAt > startedAt;

      if (!timedOut && exitIsClean(result.code, result.signal) && (completed === true || (completed === null && progressed))) {
        const post = this.tasks.get(taskId)!;
        if (post.state === "RECOVERING") {
          this.attempts.finish(attemptId, "succeeded");
          this.tasks.transition(taskId, "RUNNING");
          this.tasks.scheduleNextRecovery(taskId, null);
          this.events.append(taskId, "recovery_succeeded", "watchdog", {
            strategy,
            exitCode: result.code,
            elapsedMs: elapsed,
          });
          this.logger.info("recovery succeeded", { taskId, strategy, elapsedMs: elapsed });
          return;
        }
        // Agent already moved the task along (e.g. COMPLETED via MCP) — release ownership.
        this.attempts.finish(attemptId, "succeeded");
        this.tasks.releaseRecoveryOwner(taskId, this.instanceId);
        return;
      }

      // --- failure path (skip when the task became terminal during recovery) ---
      const postState = this.tasks.get(taskId)?.state;
      if (postState === "CANCELLED" || postState === "COMPLETED") {
        this.attempts.finish(attemptId, "aborted", `task became ${postState} during recovery`);
        this.events.append(taskId, "recovery_aborted", "watchdog", { state: postState });
        return;
      }

      const detail = (result.stderr || result.stdout || "recovery failed").slice(0, 2000);
      const classified = classifyError(result.stderr || result.stdout, result.code);
      this.attempts.finish(attemptId, "failed", `${classified.cls}: ${detail.slice(0, 500)}`);
      const attemptNo = this.tasks.incrementRecoveryAttempts(taskId);
      const backoff = computeBackoff(attemptNo, this.config);
      this.tasks.scheduleNextRecovery(taskId, Date.now() + backoff);
      this.tasks.transition(taskId, "INTERRUPTED", { lastError: detail, errorClass: classified.cls });
      this.events.append(
        taskId,
        "recovery_failed",
        "watchdog",
        {
          strategy,
          exitCode: result.code,
          timedOut,
          class: classified.cls,
          transient: classified.transient,
          retryInMs: backoff,
          attempt: attemptNo,
        },
        "warn",
      );

      if (!isRecoverable(classified) || attemptNo >= task.maxAttempts) {
        this.tasks.transition(taskId, "BLOCKED");
        this.events.append(
          taskId,
          "blocked",
          "watchdog",
          {
            reason: isRecoverable(classified) ? "retry budget exhausted" : `non-recoverable: ${classified.cls}`,
            attempts: attemptNo,
          },
          "error",
        );
        this.logger.warn("task blocked", { taskId, attempts: attemptNo, class: classified.cls });
      } else {
        this.logger.info("recovery failed; scheduled retry", { taskId, attempt: attemptNo, retryInMs: backoff });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("recovery error", { taskId, error: message });
      this.attempts.finish(attemptId, "failed", message.slice(0, 500));
      const attemptNo = this.tasks.incrementRecoveryAttempts(taskId);
      // Mirror the failure path: apply backoff so a persistently throwing
      // launch cannot hot-loop, and block the task when the budget is spent.
      const backoff = computeBackoff(attemptNo, this.config);
      this.tasks.scheduleNextRecovery(taskId, Date.now() + backoff);
      try {
        this.tasks.transition(taskId, "INTERRUPTED", { lastError: message });
      } catch {
        /* state already moved */
      }
      this.events.append(taskId, "recovery_failed", "watchdog", { error: message }, "error");
      if (attemptNo >= task.maxAttempts) {
        try {
          this.tasks.transition(taskId, "BLOCKED");
          this.events.append(taskId, "blocked", "watchdog", { reason: "retry budget exhausted", attempts: attemptNo }, "error");
          this.logger.warn("task blocked", { taskId, attempts: attemptNo });
        } catch {
          /* transition not legal from current state; skip */
        }
      }
    } finally {
      clearInterval(leaseTimer);
      this.tasks.releaseRecoveryOwner(taskId, this.instanceId);
    }
  }

  private attemptStrategy(
    taskId: string,
    attemptId: number,
    launch: LaunchResult,
    strategy: string,
  ): void {
    this.running.set(taskId, { attemptId, startedAt: Date.now(), cancel: launch.cancel });
    this.events.append(taskId, "recovery_launched", "watchdog", { strategy, pid: launch.pid });
  }

  private detectCompletion(adapter: AgentAdapter, stdout: string): boolean | null {
    if (!adapter.capabilities.completionDetection || !adapter.detectCompletion) return null;
    return adapter.detectCompletion(stdout);
  }
}

function exitIsClean(code: number | null, signal: string | null): boolean {
  // A signal-terminated process (external kill, timeout escalation) or a
  // spawn error (code null) is NOT a clean exit — only code 0 qualifies.
  return signal === null && code === 0;
}
