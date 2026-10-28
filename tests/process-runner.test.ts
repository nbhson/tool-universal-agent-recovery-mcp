/**
 * Tests for the safe process launcher: environment sanitization and the
 * cross-platform killTree behaviour (best-effort on non-Windows CI).
 */
import { describe, it, expect } from "vitest";
import { sanitizeEnv, launchProcess } from "../src/adapters/process-runner.js";
import * as path from "node:path";

describe("sanitizeEnv", () => {
  it("removes credential-like variables", () => {
    const env = sanitizeEnv({
      GITHUB_TOKEN: "ghp_x",
      MY_SECRET: "s",
      DB_PASSWORD: "p",
      AWS_CREDENTIAL_PROFILE: "x",
      API_KEY: "k",
      STRIPE_API_KEY: "sk",
      NPM_TOKEN: "t",
      DATABASE_URL_PASSWORD: "p",
      PATH: "keep",
      HOME: "keep",
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.AWS_CREDENTIAL_PROFILE).toBeUndefined();
    expect(env.API_KEY).toBeUndefined();
    expect(env.STRIPE_API_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe("keep");
    expect(env.HOME).toBe("keep");
  });

  it("preserves provider API keys agent CLIs need", () => {
    const env = sanitizeEnv({
      ANTHROPIC_API_KEY: "ak",
      OPENAI_API_KEY: "ak",
      OPENROUTER_API_KEY: "ak",
      GEMINI_API_KEY: "ak",
      AWS_SECRET_ACCESS_KEY: "ak",
      SOMETHING_ELSE: "v",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("ak");
    expect(env.OPENAI_API_KEY).toBe("ak");
    expect(env.OPENROUTER_API_KEY).toBe("ak");
    expect(env.GEMINI_API_KEY).toBe("ak");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("ak");
    expect(env.SOMETHING_ELSE).toBe("v");
  });

  it("strips internal recovery config from the child environment", () => {
    const env = sanitizeEnv({
      RECOVERY_DB_PATH: "./data/recovery.db",
      RECOVERY_LOG_FILE: "./logs/recovery.log",
      PATH: "keep",
    });
    expect(env.RECOVERY_DB_PATH).toBeUndefined();
    expect(env.RECOVERY_LOG_FILE).toBeUndefined();
    expect(env.PATH).toBe("keep");
  });
});

describe("launchProcess", () => {
  const node = process.execPath;

  it("captures stdout and exit code", async () => {
    const launch = launchProcess({
      command: node,
      args: ["-e", "process.stdout.write('hello'); process.exit(0)"],
      cwd: path.dirname(node),
    });
    const result = await launch.exited;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("hello");
  }, 30_000);

  it("reports non-zero exit codes as failures", async () => {
    const launch = launchProcess({
      command: node,
      args: ["-e", "process.stderr.write('boom'); process.exit(3)"],
      cwd: path.dirname(node),
    });
    const result = await launch.exited;
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("boom");
  }, 30_000);

  it("cancel() terminates the process tree", async () => {
    const launch = launchProcess({
      command: node,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: path.dirname(node),
    });
    expect(launch.pid).toBeGreaterThan(0);
    launch.cancel();
    const result = await launch.exited;
    // Windows taskkill /F yields a non-null code; POSIX escalation yields a signal.
    expect(result.code !== 0 || result.signal !== null).toBe(true);
  }, 30_000);

  it("timeout kills a hanging process", async () => {
    const launch = launchProcess({
      command: node,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: path.dirname(node),
      timeoutMs: 500,
    });
    const result = await launch.exited;
    expect(result.code === 0).toBe(false);
  }, 30_000);
});
