/** Watchdog leader lock: prevents duplicate recovery workers via a leased row. */
import type { Database } from "./database.js";
import type { Logger } from "../core/logger.js";

export class LeaderLock {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  /** Try to become the active watchdog. Returns true when this instance holds the lease. */
  tryAcquire(instanceId: string, leaseMs: number, now = Date.now()): boolean {
    try {
      const res = this.db.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('watchdog_lock', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value
           WHERE json_extract(meta.value, '$.expiresAt') < ?`,
        )
        .run(JSON.stringify({ instanceId, expiresAt: now + leaseMs }), now);
      return Number(res.changes) === 1;
    } catch (err) {
      // A corrupt lock value makes json_extract throw ("malformed JSON"),
      // which would crash every watchdog tick. Reset the poisoned row and
      // retry acquisition once — worst case two watchdogs briefly race, and
      // the per-task claimRecovery() lease still guarantees single-owner
      // recoveries.
      this.logger?.warn("leader lock reset after corrupt value", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.db.db.prepare("DELETE FROM meta WHERE key = 'watchdog_lock'").run();
      return this.acquireUnchecked(instanceId, leaseMs, now);
    }
  }

  private acquireUnchecked(instanceId: string, leaseMs: number, now: number): boolean {
    const res = this.db.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('watchdog_lock', ?)")
      .run(JSON.stringify({ instanceId, expiresAt: now + leaseMs }));
    return Number(res.changes) === 1;
  }

  /**
   * Renew only while still owning the lease, in one atomic statement.
   * A read-then-write implementation would race with another process
   * acquiring the expired lease in between and overwriting its lock.
   */
  renew(instanceId: string, leaseMs: number, now = Date.now()): boolean {
    try {
      const res = this.db.db
        .prepare(
          `UPDATE meta SET value = ? WHERE key = 'watchdog_lock'
           AND json_extract(value, '$.instanceId') = ?`,
        )
        .run(JSON.stringify({ instanceId, expiresAt: now + leaseMs }), instanceId);
      return Number(res.changes) === 1;
    } catch {
      // Corrupt value: json_extract throws and we cannot prove ownership.
      // Return false so the caller re-runs tryAcquire (which self-heals the row).
      return false;
    }
  }

  /** Release only when still owning the lease (atomic; foreign/corrupt locks untouched). */
  release(instanceId: string): void {
    try {
      this.db.db
        .prepare(
          `DELETE FROM meta WHERE key = 'watchdog_lock'
           AND json_extract(value, '$.instanceId') = ?`,
        )
        .run(instanceId);
    } catch {
      /* corrupt value: leave it to tryAcquire's self-healing reset */
    }
  }
}
