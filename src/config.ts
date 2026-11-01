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
  /** Non-fatal configuration problems, e.g. invalid env values replaced by defaults. */
  warnings?: string[];
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

function logLevelOf(v: string | undefined, warnings: string[]): RecoveryConfig["logLevel"] {
  const level = (v ?? "").trim().toLowerCase();
  if (v !== undefined && v !== "" && !LOG_LEVELS.has(level)) {
    warnings.push(`RECOVERY_LOG_LEVEL='${v}' is not one of debug|info|warn|error — using 'info'`);
  }
  return LOG_LEVELS.has(level) ? (level as RecoveryConfig["logLevel"]) : "info";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RecoveryConfig {
  const warnings: string[] = [];
  const allowedDirs = (env.RECOVERY_ALLOWED_DIRS ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => normalizeSeparators(path.resolve(s)));

  const int = (v: string | undefined, def: number, name: string): number => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    if (v !== undefined && v.trim() !== "") {
      warnings.push(`${name}='${v}' is not a positive number — using default ${def}`);
    }
    return def;
  };

  return {
    dbPath: env.RECOVERY_DB_PATH ?? "./data/recovery.db",
    allowedDirs,
    recoveryEnabled: (env.RECOVERY_ENABLED ?? "true").toLowerCase() !== "false",
    staleMs: int(env.RECOVERY_STALE_MS, 600_000, "RECOVERY_STALE_MS"),
    maxConcurrent: int(env.RECOVERY_MAX_CONCURRENT, 2, "RECOVERY_MAX_CONCURRENT"),
    maxRuntimeMs: int(env.RECOVERY_MAX_RUNTIME_MS, 3_600_000, "RECOVERY_MAX_RUNTIME_MS"),
    maxAttempts: int(env.RECOVERY_MAX_ATTEMPTS, 5, "RECOVERY_MAX_ATTEMPTS"),
    backoffBaseMs: int(env.RECOVERY_BACKOFF_BASE_MS, 30_000, "RECOVERY_BACKOFF_BASE_MS"),
    backoffMaxMs: int(env.RECOVERY_BACKOFF_MAX_MS, 1_800_000, "RECOVERY_BACKOFF_MAX_MS"),
    ownerLeaseMs: int(env.RECOVERY_OWNER_LEASE_MS, 300_000, "RECOVERY_OWNER_LEASE_MS"),
    pollIntervalMs: int(env.RECOVERY_POLL_MS, 30_000, "RECOVERY_POLL_MS"),
    // Agent output logs; relative by default (CWD-relative, as before).
    logDir: env.UAR_LOG_DIR && env.UAR_LOG_DIR.trim() !== "" ? env.UAR_LOG_DIR : path.join("logs", "agent-output"),
    logLevel: logLevelOf(env.RECOVERY_LOG_LEVEL, warnings),
    logFile: env.RECOVERY_LOG_FILE || null,
    warnings,
  };
}
