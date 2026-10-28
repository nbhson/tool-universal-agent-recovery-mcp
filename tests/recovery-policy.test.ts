import { describe, it, expect } from "vitest";
import { computeBackoff, hasRetryBudget, isDueForRecovery } from "../src/watchdog/recovery-policy.js";

describe("retry policy", () => {
  it("grows exponentially with attempts", () => {
    const samples = [1, 2, 4, 8].map((a) => computeBackoff(a, { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 1_000_000 }, () => 0.9999));
    expect(samplesNonDecreasing(samples)).toBe(true);
  });

  it("applies full jitter within [base, cap]", () => {
    for (let i = 0; i < 50; i++) {
      const v = computeBackoff(3, { maxAttempts: 5, backoffBaseMs: 100, backoffMaxMs: 400 });
      expect(v).toBeGreaterThanOrEqual(100); // >= base (jitter range [base, cap])
      expect(v).toBeLessThanOrEqual(400); // base * 2^2 = 800 capped at max 400
    }
  });

  it("caps the backoff at backoffMaxMs", () => {
    const v = computeBackoff(50, { maxAttempts: 10, backoffBaseMs: 1000, backoffMaxMs: 60_000 }, () => 1);
    expect(v).toBeLessThanOrEqual(60_000);
  });

  it("respects retry budgets", () => {
    expect(hasRetryBudget({ recoveryAttempts: 2, maxAttempts: 3 })).toBe(true);
    expect(hasRetryBudget({ recoveryAttempts: 3, maxAttempts: 3 })).toBe(false);
  });

  it("is due when no cooldown scheduled", () => {
    expect(isDueForRecovery(null, Date.now())).toBe(true);
    expect(isDueForRecovery(Date.now() - 1, Date.now())).toBe(true);
    expect(isDueForRecovery(Date.now() + 60_000, Date.now())).toBe(false);
  });
});

function samplesNonDecreasing(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    if (xs[i]! < xs[i - 1]!) return false;
  }
  return true;
}
