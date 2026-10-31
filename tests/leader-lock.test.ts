/** Unit tests for the watchdog leader lock. */
import { describe, it, expect } from "vitest";
import { Database } from "../src/storage/database.js";
import { LeaderLock } from "../src/storage/leader-lock.js";

describe("LeaderLock", () => {
  it("acquires when free and blocks a second instance", () => {
    const db = new Database(":memory:");
    db.migrate();
    const lock = new LeaderLock(db);
    expect(lock.tryAcquire("wd-a", 60_000, 1_000)).toBe(true);
    expect(lock.tryAcquire("wd-b", 60_000, 1_100)).toBe(false);
    db.close();
  });

  it("allows acquisition after the lease expires", () => {
    const db = new Database(":memory:");
    db.migrate();
    const lock = new LeaderLock(db);
    expect(lock.tryAcquire("wd-a", 1_000, 0)).toBe(true);
    expect(lock.tryAcquire("wd-b", 60_000, 500)).toBe(false);
    expect(lock.tryAcquire("wd-b", 60_000, 1_001)).toBe(true);
    db.close();
  });

  it("renews only for the current owner", () => {
    const db = new Database(":memory:");
    db.migrate();
    const lock = new LeaderLock(db);
    lock.tryAcquire("wd-a", 60_000, 0);
    expect(lock.renew("wd-b", 60_000, 1_000)).toBe(false);
    expect(lock.renew("wd-a", 60_000, 1_000)).toBe(true);
    // Still owned by wd-a after renewal.
    expect(lock.tryAcquire("wd-b", 60_000, 2_000)).toBe(false);
    db.close();
  });

  it("releasing a foreign owner leaves the lock intact", () => {
    const db = new Database(":memory:");
    db.migrate();
    const lock = new LeaderLock(db);
    lock.tryAcquire("wd-a", 60_000, 0);
    lock.release("wd-b");
    expect(lock.tryAcquire("wd-b", 60_000, 1_000)).toBe(false);
    lock.release("wd-a");
    expect(lock.tryAcquire("wd-b", 60_000, 1_000)).toBe(true);
    db.close();
  });

  it("recovers from a corrupt lock value instead of crashing", () => {
    const db = new Database(":memory:");
    db.migrate();
    db.db.prepare("INSERT INTO meta (key, value) VALUES ('watchdog_lock', 'not-json')").run();
    const lock = new LeaderLock(db);
    // json_extract would throw "malformed JSON" on the corrupt row; tryAcquire
    // must reset the poisoned row and acquire instead of propagating the error.
    expect(lock.tryAcquire("wd-a", 60_000, 0)).toBe(true);
    expect(lock.tryAcquire("wd-b", 60_000, 1_000)).toBe(false);
    db.close();
  });
});
