import { describe, it, expect } from "vitest";
import { classifyError, isRecoverable } from "../src/core/error-classifier.js";

describe("error classifier", () => {
  it("classifies network failures as transient", () => {
    const c = classifyError("fetch failed: ECONNREFUSED 127.0.0.1:443");
    expect(c.cls).toBe("network");
    expect(c.transient).toBe(true);
    expect(isRecoverable(c)).toBe(true);
  });

  it("classifies rate limits as transient with longer backoff", () => {
    const c = classifyError("429 Too Many Requests");
    expect(c.cls).toBe("rate_limit");
    expect(c.transient).toBe(true);
  });

  it("classifies auth failures as non-recoverable", () => {
    const c = classifyError("401 Unauthorized: invalid api key");
    expect(c.cls).toBe("auth");
    expect(isRecoverable(c)).toBe(false);
  });

  it("classifies budget exhaustion as non-recoverable", () => {
    const c = classifyError("credit balance exhausted");
    expect(c.cls).toBe("budget");
    expect(isRecoverable(c)).toBe(false);
  });

  it("treats unknown non-zero exit codes as retryable crashes", () => {
    const c = classifyError("something cryptic", 137);
    expect(c.transient).toBe(true);
  });

  it("classifies timeouts", () => {
    expect(classifyError("request ETIMEDOUT").cls).toBe("timeout");
  });

  it("unknown message without exit code is unknown and not auto-transient", () => {
    const c = classifyError(undefined, null);
    expect(c.cls).toBe("unknown");
  });

  it("never fabricates a class from empty input", () => {
    expect(classifyError(null, null).cls).toBe("unknown");
  });
});
