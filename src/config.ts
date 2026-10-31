/** Configuration loading from environment with safe defaults. */
import * as path from "node:path";

export interface RecoveryConfig {
  dbPath: string;
  allowedDirs: string[];
  recoveryEnabled: boolean;
  staleMs: number;
  maxConcurrent: number;
  maxRuntimeMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  ownerLeaseMs: number;
  pollIntervalMs: number;
  /** Directory where the watchdog writes agent output logs during recovery. */
  logDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  logFile: string | null;
}

/** Normalize and validate a working directory: absolute + resolved. */
export function normalizeWorkingDirectory(dir: string): string {
  if (typeof dir !== "string" || dir.trim() === "") {
    throw new Error("workingDirectory must be a non-empty string");
  }
  const resolved = path.resolve(dir.trim());
  if (!path.isAbsolute(dir.trim())) {
    throw new Error(`workingDirectory must be absolute: ${dir}`);
  }
  return normalizeSeparators(resolved);
}

export function normalizeSeparators(p: string): string {
  return process.platform === "win32" ? p.replaceAll("\\", "/").replace(/\/+$/, "") : p;
}

/** Ensure the directory exists and is inside the configured allowed roots. */
export function assertAllowedDirectory(dir: string, allowedDirs: string[]): void {
  if (allowedDirs.length === 0) return; // unrestricted only when explicitly configured empty
  const target = normalizeSeparators(path.resolve(dir));
  const normalizedAllowed = allowedDirs.map((d) => normalizeSeparators(path.resolve(d)));
  const allowed = normalizedAllowed.some(
    (base) => target === base || target.startsWith(base.endsWith("/") ? base : base + "/"),
  );
  if (!allowed) {
    throw new Error(
      `working directory '${target}' is outside the configured allowed directories; ` +
        `add it to RECOVERY_ALLOWED_DIRS to permit recovery there`,
    );
  }
}

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

function logLevelOf(v: string | undefined): RecoveryConfig["logLevel"] {
  const level = (v ?? "").trim().toLowerCase();
  return LOG_LEVELS.has(level) ? (level as RecoveryConfig["logLevel"]) : "info";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RecoveryConfig {
  const allowedDirs = (env.RECOVERY_ALLOWED_DIRS ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => normalizeSeparators(path.resolve(s)));

  return {
    dbPath: env.RECOVERY_DB_PATH ?? "./data/recovery.db",
    allowedDirs,
    recoveryEnabled: (env.RECOVERY_ENABLED ?? "true").toLowerCase() !== "false",
    staleMs: intOf(env.RECOVERY_STALE_MS, 600_000),
    maxConcurrent: intOf(env.RECOVERY_MAX_CONCURRENT, 2),
    maxRuntimeMs: intOf(env.RECOVERY_MAX_RUNTIME_MS, 3_600_000),
    maxAttempts: intOf(env.RECOVERY_MAX_ATTEMPTS, 5),
    backoffBaseMs: intOf(env.RECOVERY_BACKOFF_BASE_MS, 30_000),
    backoffMaxMs: intOf(env.RECOVERY_BACKOFF_MAX_MS, 1_800_000),
    ownerLeaseMs: intOf(env.RECOVERY_OWNER_LEASE_MS, 300_000),
    pollIntervalMs: intOf(env.RECOVERY_POLL_MS, 30_000),
    // Agent output logs; relative by default (CWD-relative, as before).
    logDir: env.UAR_LOG_DIR && env.UAR_LOG_DIR.trim() !== "" ? env.UAR_LOG_DIR : path.join("logs", "agent-output"),
    logLevel: logLevelOf(env.RECOVERY_LOG_LEVEL),
    logFile: env.RECOVERY_LOG_FILE || null,
  };
}

function intOf(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}
