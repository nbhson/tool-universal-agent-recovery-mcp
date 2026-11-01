/**
 * Multi-process lease worker for the leader-lock race test.
 *
 * IMPORTANT: the SQL statements below intentionally mirror
 * src/storage/leader-lock.ts (tryAcquire / renew / release). They are
 * duplicated here because a plain `node` child process cannot import the
 * TypeScript sources. If you change the lock SQL in the source, mirror it
 * here — this fixture is what proves the statements stay atomic across
 * real processes.
 *
 * Usage: node lease-worker.mjs <dbPath> <workerId> <iterations> <leaseMs>
 * Prints one JSON line on stdout: {"worker":..,"iterations":..,"claims":..}
 */
import { DatabaseSync } from "node:sqlite";

const [dbPath, workerId, iterationsArg, leaseMsArg] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const leaseMs = Number(leaseMsArg);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec(`CREATE TABLE IF NOT EXISTS lease_claims (
  worker TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);`);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let claims = 0;
for (let i = 0; i < iterations; i++) {
  const now = Date.now();
  // tryAcquire (fails while someone else holds an unexpired lease)…
  let owned =
    Number(
      acquireStmt.run(JSON.stringify({ instanceId: workerId, expiresAt: now + leaseMs }), now)
        .changes,
    ) === 1;
  // …or renew (only valid while we still own the lease — atomic single UPDATE).
  if (!owned) {
    owned =
      Number(
        renewStmt.run(JSON.stringify({ instanceId: workerId, expiresAt: now + leaseMs }), workerId)
          .changes,
      ) === 1;
  }
  if (owned) {
    claimStmt.run(workerId, now, now + leaseMs);
    claims++;
  }
  // Periodically release so both workers keep contending for the lock.
  if (i % 3 === 0) {
    releaseStmt.run(workerId);
    truncateStmt.run(now, workerId, now);
  }
  await sleep(Math.floor(Math.random() * 3));
}

db.close();
process.stdout.write(JSON.stringify({ worker: workerId, iterations, claims }) + "\n");
