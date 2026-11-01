/**
 * Leader-lock renewal race: two REAL processes contending for the same lease.
 *
 * Guarantees the invariant behind the atomic renew/release rewrite: at no
 * point may two different processes simultaneously believe they hold an
 * unexpired lease. The old read-then-write renew could overwrite a new
 * owner's lock in the window between SELECT and UPDATE (TOCTOU).
 *
 * The workers duplicate the lock SQL (see tests/fixtures/lease-worker.mjs);
 * the LeaderLock class itself is covered by leader-lock.test.ts.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const execFileP = promisify(execFile);
const workerScript = fileURLToPath(new URL("./fixtures/lease-worker.mjs", import.meta.url));

interface Claim {
  worker: string;
  claimed_at: number;
  expires_at: number;
}

/** Overlapping unexpired leases held by different workers = mutual-exclusion violation. */
function findOverlaps(claims: Claim[]): Array<[Claim, Claim]> {
  // Zero-length claims (claimed and released within the same millisecond)
  // never actually held the lock — exclude them.
  const sorted = claims.filter((c) => c.expires_at > c.claimed_at).sort((a, b) => a.claimed_at - b.claimed_at);
  const overlaps: Array<[Claim, Claim]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.worker === b.worker) continue;
      if (b.claimed_at >= a.expires_at) break; // sorted: later claims only overlap more
      if (b.claimed_at < a.expires_at && a.claimed_at < b.expires_at) overlaps.push([a, b]);
    }
  }
  return overlaps;
}

describe("leader-lock two-process lease contention", { timeout: 30_000 }, () => {
  it("never lets two processes hold the lease at the same time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uar-lock-race-"));
    const dbPath = path.join(dir, "lock.db");

    // Seed the meta table the workers expect.
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    const ITERATIONS = 60;
    const LEASE_MS = 25;
    const [wa, wb] = await Promise.all([
      execFileP(process.execPath, [workerScript, dbPath, "wd-a", String(ITERATIONS), String(LEASE_MS)]),
      execFileP(process.execPath, [workerScript, dbPath, "wd-b", String(ITERATIONS), String(LEASE_MS)]),
    ]);
    const a = JSON.parse(wa.stdout.trim()) as { claims: number };
    const b = JSON.parse(wb.stdout.trim()) as { claims: number };

    // Sanity: the workers genuinely contended (both won the lock at times).
    expect(a.claims).toBeGreaterThan(0);
    expect(b.claims).toBeGreaterThan(0);

    const db = new DatabaseSync(dbPath);
    const claims = db.prepare("SELECT worker, claimed_at, expires_at FROM lease_claims").all() as Claim[];
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });

    const overlaps = findOverlaps(claims);
    expect(overlaps).toEqual([]);
  });
});
