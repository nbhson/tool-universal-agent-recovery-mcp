/** Friendly error translation for common storage failures. */
import { describe, it, expect } from "vitest";
import { friendlyDbError } from "../src/storage/database.js";

describe("friendlyDbError", () => {
  it("explains SQLITE_BUSY with actionable hints", () => {
    const err = new Error("database is locked") as NodeJS.ErrnoException;
    err.code = "SQLITE_BUSY";
    const out = friendlyDbError(err, "/data/recovery.db");
    expect(out.message).toContain("database is locked");
    expect(out.message).toContain("/data/recovery.db");
    expect(out.message).toMatch(/uar-state|uar-watchdog/);
  });

  it("explains SQLITE_CANTOPEN", () => {
    const err = new Error("unable to open database file") as NodeJS.ErrnoException;
    err.code = "SQLITE_CANTOPEN";
    const out = friendlyDbError(err, "/nope/recovery.db");
    expect(out.message).toContain("Cannot open SQLite database");
    expect(out.message).toContain("RECOVERY_DB_PATH");
  });

  it("explains a corrupt database file", () => {
    const out = friendlyDbError(new Error("file is not a database"), "/data/recovery.db");
    expect(out.message).toMatch(/corrupt|not a SQLite database/);
  });

  it("passes unrelated errors through unchanged", () => {
    const err = new Error("UNIQUE constraint failed: tasks.id");
    expect(friendlyDbError(err, "x")).toBe(err);
    expect(friendlyDbError("weird", "x")).toBe("weird");
  });
});

describe("Database friendly errors on open", () => {
  it("translates an unopenable path into an actionable message", () => {
    // A path inside a non-existent directory that cannot be created (file as parent).
    const out = friendlyDbError(new Error("unable to open database file"), "/proc/x/y.db");
    expect(out.message).toContain("Cannot open SQLite database");
  });
});
