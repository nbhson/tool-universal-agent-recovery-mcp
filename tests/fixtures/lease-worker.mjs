/**
 * Multi-process lease worker for the leader-lock race test.
 *
 * IMPORTANT: the lock SQL statements below intentionally mirror
 * src/storage/leader-lock.ts (tryAcquire / renew / release). They are
 * duplicated here because a plain `node` child process cannot import the
 * TypeScript sources. If you change the lock SQL in the source, mirror it
 * here — this fixture is what proves the statements stay atomic across
 * real processes.
 *
 * Timestamps come from a shared Lamport clock (a counter row in the same
 * SQLite database) instead of Date.now(): wall clocks across processes can
 * skew by milliseconds (NTP slew), which would make interval-overlap
 * detection unreliable. Ticks are globally monotonic, so overlap detection
 * is exact.
 *
 * Usage: node lease-worker.mjs <dbPath> <workerId> <iterations> <leaseTicks>
 * Prints one JSON line on stdout: {"worker":..,"iterations":..,"claims":..}
 */
import { DatabaseSync } from "node:sqlite";

const [dbPath, workerId, iterationsArg, leaseTicksArg] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const leaseTicks = Number(leaseTicksArg);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
// journal_mode PRAGMA does not honor busy_timeout under concurrent start; retry.
for (let attempt = 0; ; attempt++) {
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    break;
  } catch (err) {
    if (attempt >= 20) throw err;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
db.exec(`CREATE TABLE IF NOT EXISTS clock (id INTEGER PRIMARY KEY CHECK (id = 1), ts INTEGER NOT NULL);`);
db.exec("INSERT OR IGNORE INTO clock (id, ts) VALUES (1, 0);");
db.exec(`CREATE TABLE IF NOT EXISTS lease_claims (
  worker TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);`);

// Atomically advance the shared logical clock and return the new tick.
const tickStmt = db.prepare("UPDATE clock SET ts = ts + 1 WHERE id = 1 RETURNING ts;");
const tick = () => Number(tickStmt.get().ts);

const acquireStmt = db.prepare(
  `INSERT INTO meta (key, value) VALUES ('watchdog_lock', ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value
   WHERE json_extract(meta.value, '$.expiresAt') < ?`,
);
const renewStmt = db.prepare(
  `UPDATE meta SET value = ? WHERE key = 'watchdog_lock'
   AND json_extract(value, '$.instanceId') = ?`,
);
const releaseStmt = db.prepare(
  `DELETE FROM meta WHERE key = 'watchdog_lock'
   AND json_extract(value, '$.instanceId') = ?`,
);
const claimStmt = db.prepare(
  "INSERT INTO lease_claims (worker, claimed_at, expires_at) VALUES (?, ?, ?)",
);
// Truncate this worker's open claim intervals at release time: a voluntary
// release renounces ownership immediately, before the lease would expire.
const truncateStmt = db.prepare(
  "UPDATE lease_claims SET expires_at = ? WHERE worker = ? AND expires_at > ?",
);

let claims = 0;
for (let i = 0; i < iterations; i++) {
  // tryAcquire (fails while someone else holds an unexpired lease)…
  let t = tick();
  let owned =
    Number(
      acquireStmt.run(JSON.stringify({ instanceId: workerId, expiresAt: t + leaseTicks }), t)
        .changes,
    ) === 1;
  // …or renew (only valid while we still own the lease — atomic single UPDATE).
  if (!owned) {
    t = tick();
    owned =
      Number(
        renewStmt.run(JSON.stringify({ instanceId: workerId, expiresAt: t + leaseTicks }), workerId)
          .changes,
      ) === 1;
  }
  if (owned) {
    claimStmt.run(workerId, t, t + leaseTicks);
    claims++;
  }
  // Periodically release so both workers keep contending for the lock.
  if (i % 3 === 0) {
    const r = tick();
    releaseStmt.run(workerId);
    truncateStmt.run(r, workerId, r);
  }
}

db.close();
process.stdout.write(JSON.stringify({ worker: workerId, iterations, claims }) + "\n");
