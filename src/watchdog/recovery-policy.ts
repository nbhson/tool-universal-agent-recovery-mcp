/**
 * Retry policy: exponential backoff with jitter, retry budgets, cooldowns.
 * All values are persisted through the task record so the policy survives
 * watchdog restarts.
 */
export interface RetryPolicyConfig {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** Exponential backoff with full jitter: random in [base, base * 2^attempt], capped. */
export function computeBackoff(attempt: number, cfg: RetryPolicyConfig, rng: () => number = Math.random): number {
  const exp = Math.min(attempt, 16); // cap exponent
  const ceiling = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * Math.pow(2, exp));
  const min = Math.min(cfg.backoffBaseMs, ceiling);
  return Math.floor(min + rng() * (ceiling - min));
}

/** true when another recovery attempt is allowed within the task's budget. */
export function hasRetryBudget(task: { recoveryAttempts: number; maxAttempts: number }): boolean {
  return task.recoveryAttempts < task.maxAttempts;
}

/** true when the cooldown has elapsed (or none was scheduled). */
export function isDueForRecovery(nextRecoveryAt: number | null, now: number): boolean {
  return nextRecoveryAt == null || nextRecoveryAt <= now;
}
