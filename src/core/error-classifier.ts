/** Failure classification for recovery policy decisions. */

export type ErrorClass =
  | "network" // transient: retries with backoff
  | "timeout" // transient: retries with backoff
  | "rate_limit" // transient: retries with longer backoff
  | "auth" // fatal for auto-recovery: requires human
  | "permission" // fatal for auto-recovery: requires human
  | "budget" // fatal for auto-recovery: requires human
  | "process_crash" // retryable: process died
  | "invalid_input" // fatal: do not retry
  | "unknown";

export interface ClassifiedError {
  cls: ErrorClass;
  transient: boolean;
  reason: string;
}

const PATTERNS: Array<{ re: RegExp; cls: ErrorClass; reason: string }> = [
  { re: /econnrefused|econnreset|enetunreach|ehostunreach|eai_again|dns|getaddrinfo|socket hang up|fetch failed/i, cls: "network", reason: "network-level failure" },
  { re: /etimedout|timed?\s?out|deadline/i, cls: "timeout", reason: "timeout exceeded" },
  { re: /rate.?limit|429|too many requests|overloaded|529/i, cls: "rate_limit", reason: "provider rate limit / overload" },
  { re: /401|unauthorized|invalid api key|authentication|api key/i, cls: "auth", reason: "authentication failure" },
  { re: /403|forbidden|permission denied|not permitted/i, cls: "permission", reason: "permission denied" },
  { re: /credit|balance|billing|budget|quota exceeded/i, cls: "budget", reason: "budget/quota exhausted" },
  { re: /segfault|signal\s?(sigk?ill|sigterm)|killed|abnormal exit|exit code [1-9]/i, cls: "process_crash", reason: "process crashed" },
  { re: /invalid (input|argument|path)|enoent|not a directory|validation/i, cls: "invalid_input", reason: "invalid input" },
];

export function classifyError(raw: string | undefined | null, exitCode?: number | null): ClassifiedError {
  const text = (raw ?? "") + (exitCode != null ? ` exit code ${exitCode}` : "");
  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      const transient = p.cls === "network" || p.cls === "timeout" || p.cls === "rate_limit" || p.cls === "process_crash";
      return { cls: p.cls, transient, reason: p.reason };
    }
  }
  // Non-zero exit codes without a known signature: treat as retryable crashes.
  if (exitCode != null && exitCode !== 0) {
    return { cls: "process_crash", transient: true, reason: `non-zero exit code ${exitCode}` };
  }
  return { cls: "unknown", transient: false, reason: "unclassified failure" };
}

/**
 * Decides whether an interruption is likely transient (worth auto-retrying)
 * or requires human attention. Unknown classes are retried a limited number
 * of times (they go through the normal retry budget).
 */
export function isRecoverable(c: ClassifiedError): boolean {
  return c.cls !== "auth" && c.cls !== "permission" && c.cls !== "budget" && c.cls !== "invalid_input";
}
