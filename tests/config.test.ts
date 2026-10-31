import { describe, it, expect } from "vitest";
import * as path from "node:path";
import os from "node:os";
import { normalizeWorkingDirectory, assertAllowedDirectory, loadConfig } from "../src/config.js";

const tmp = os.tmpdir();

describe("working directory validation", () => {
  it("rejects relative paths", () => {
    expect(() => normalizeWorkingDirectory("relative/path")).toThrow(/absolute/i);
  });

  it("rejects empty", () => {
    expect(() => normalizeWorkingDirectory("")).toThrow();
    expect(() => normalizeWorkingDirectory("   ")).toThrow();
  });

  it("accepts absolute paths", () => {
    const p = normalizeWorkingDirectory(path.join(tmp, "proj"));
    expect(path.isAbsolute(p)).toBe(true);
  });
});

describe("allowed directories", () => {
  const base = path.join(tmp, "uar-projects");

  it("rejects paths outside configured roots", () => {
    const other = path.join(tmp, "uar-projects-other");
    expect(() => assertAllowedDirectory(other, [base])).toThrow(/outside/i);
  });

  it("allows nested paths inside configured roots", () => {
    const inner = path.join(base, "project-a", "src");
    expect(() => assertAllowedDirectory(inner, [base])).not.toThrow();
  });

  it("allows everything when no roots are configured", () => {
    expect(() => assertAllowedDirectory(path.join(tmp, "anything"), [])).not.toThrow();
  });

  it("prevents sibling-directory confusion", () => {
    const sibling = base + "-evil";
    expect(() => assertAllowedDirectory(sibling, [base])).toThrow(/outside/i);
  });
});

describe("loadConfig", () => {
  it("applies defaults when the environment is empty", () => {
    const cfg = loadConfig({});
    expect(cfg.dbPath).toBe("./data/recovery.db");
    expect(cfg.recoveryEnabled).toBe(true);
    expect(cfg.staleMs).toBe(600_000);
    expect(cfg.maxAttempts).toBe(5);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.logFile).toBeNull();
    expect(cfg.allowedDirs).toEqual([]);
  });

  it("falls back to defaults for invalid numeric values", () => {
    const cfg = loadConfig({
      RECOVERY_STALE_MS: "not-a-number",
      RECOVERY_MAX_ATTEMPTS: "-3",
      RECOVERY_POLL_MS: "0",
      RECOVERY_BACKOFF_BASE_MS: "NaN",
    });
    expect(cfg.staleMs).toBe(600_000);
    expect(cfg.maxAttempts).toBe(5);
    expect(cfg.pollIntervalMs).toBe(30_000);
    expect(cfg.backoffBaseMs).toBe(30_000);
  });

  it("falls back to 'info' for an unknown log level", () => {
    expect(loadConfig({ RECOVERY_LOG_LEVEL: "verbose" }).logLevel).toBe("info");
    expect(loadConfig({ RECOVERY_LOG_LEVEL: "ERROR" }).logLevel).toBe("error");
  });

  it("disables recovery only on the exact 'false' value", () => {
    expect(loadConfig({ RECOVERY_ENABLED: "false" }).recoveryEnabled).toBe(false);
    expect(loadConfig({ RECOVERY_ENABLED: "0" }).recoveryEnabled).toBe(true);
    expect(loadConfig({ RECOVERY_ENABLED: "" }).recoveryEnabled).toBe(true);
  });

  it("splits allowed dirs on commas and semicolons", () => {
    const cfg = loadConfig({ RECOVERY_ALLOWED_DIRS: "/a, /b ;/c" });
    expect(cfg.allowedDirs).toEqual(["/a", "/b", "/c"]);
  });
});
