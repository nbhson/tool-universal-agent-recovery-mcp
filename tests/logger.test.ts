/** Unit tests for the structured logger and secret redaction. */
import { describe, it, expect } from "vitest";
import { redactValue, createLogger } from "../src/core/logger.js";

describe("redactValue", () => {
  it("redacts secret-looking keys", () => {
    const out = redactValue({ apiKey: "abc", GITHUB_TOKEN: "t", password: "p", mySecretValue: "s" });
    expect(out).toEqual({
      apiKey: "[REDACTED]",
      GITHUB_TOKEN: "[REDACTED]",
      password: "[REDACTED]",
      mySecretValue: "[REDACTED]",
    });
  });

  it("keeps non-secret keys", () => {
    const out = redactValue({ taskId: "t1", progress: "half done", attempts: 2 });
    expect(out).toEqual({ taskId: "t1", progress: "half done", attempts: 2 });
  });

  it("redacts bearer tokens and key prefixes inside strings", () => {
    const out = redactValue({
      msg: "auth failed for Bearer abc123.def456 and sk-xyz987654 ghp_abcdef1234567890",
    }) as { msg: string };
    expect(out.msg).not.toContain("abc123");
    expect(out.msg).not.toContain("xyz987654");
    expect(out.msg).toContain("[REDACTED]");
  });

  it("redacts recursively in nested objects and arrays", () => {
    const out = redactValue({ nested: { token: "x" }, list: [{ password: "y" }] }) as {
      nested: { token: string };
      list: Array<{ password: string }>;
    };
    expect(out.nested.token).toBe("[REDACTED]");
    expect(out.list[0]?.password).toBe("[REDACTED]");
  });

  it("enforces a depth limit", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: "deep" } } } } } } } };
    const out = redactValue(deep, 0) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain("[depth-limit]");
  });

  it("passes primitives through unchanged", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue(true)).toBe(true);
  });
});

describe("createLogger", () => {
  it("respects the level threshold", () => {
    const logger = createLogger({ level: "warn" });
    // debug/info must be suppressed: capture stderr writes.
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      logger.debug("invisible");
      logger.info("invisible too");
      logger.warn("visible", { apiKey: "secret" });
    } finally {
      process.stderr.write = original;
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("visible");
    expect(writes[0]).toContain("[REDACTED]");
  });

  it("builds hierarchical child components", () => {
    const parent = createLogger({ level: "error", component: "parent" });
    const child = parent.child("child");
    expect(child.level).toBe("error");
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      child.error("from child");
    } finally {
      process.stderr.write = original;
    }
    expect(writes[0]).toContain("parent:child");
  });
});
