/** Watchdog leader lock: prevents duplicate recovery workers via a leased row. */
import type { Database } from "./database.js";

export class LeaderLock {
  constructor(private readonly db: Database) {}

  /** Try to become the active watchdog. Returns true when this instance holds the lease. */
  tryAcquire(instanceId: string, leaseMs: number, now = Date.now()): boolean {
    const res = this.db.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('watchdog_lock', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE json_extract(meta.value, '$.expiresAt') < ?`,
      )
      .run(JSON.stringify({ instanceId, expiresAt: now + leaseMs }), now);
    return Number(res.changes) === 1;
  }

  renew(instanceId: string, leaseMs: number, now = Date.now()): boolean {
    const row = this.db.db.prepare("SELECT value FROM meta WHERE key = 'watchdog_lock'").get() as
      | { value: string }
      | undefined;
    if (!row) return false;
    try {
      const lock = JSON.parse(row.value) as { instanceId: string; expiresAt: number };
      if (lock.instanceId !== instanceId) return false;
      this.db.db
        .prepare("UPDATE meta SET value = ? WHERE key = 'watchdog_lock'")
        .run(JSON.stringify({ instanceId, expiresAt: now + leaseMs }));
      return true;
    } catch {
      return false;
    }
  }

  release(instanceId: string): void {
    const row = this.db.db.prepare("SELECT value FROM meta WHERE key = 'watchdog_lock'").get() as
      | { value: string }
      | undefined;
    if (!row) return;
    try {
      const lock = JSON.parse(row.value) as { instanceId: string };
      if (lock.instanceId === instanceId) {
        this.db.db.prepare("DELETE FROM meta WHERE key = 'watchdog_lock'").run();
      }
    } catch {
      /* ignore */
    }
  }
}
