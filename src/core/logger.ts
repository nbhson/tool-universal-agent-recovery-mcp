/** Structured JSON logging with secret redaction. */
import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_PATTERNS = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /api[-_]?key$/i,
  /^token$/i,
  /[-_]?token$/i,
  /secret/i,
  /password/i,
  /credential/i,
];

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Redact anything that looks like a bearer token or key assignment.
    return value
      .replace(/(Bearer|sk-|ghp_|github_pat_)[A-Za-z0-9._-]+/gi, "[REDACTED]")
      .replace(/(authorization\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_PATTERNS.some((p) => p.test(k)) ? "[REDACTED]" : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  level: LogLevel;
  child(component: string): Logger;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  logFile?: string | null;
  component?: string;
}

function writeLine(line: string, logFile: string | null): void {
  // Always to stderr: stdout may be reserved for MCP JSON-RPC or CLI output.
  process.stderr.write(line + "\n");
  if (logFile) {
    try {
      // Synchronous append keeps ordering; volume is low.
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, line + "\n");
    } catch {
      // Never crash on logging failures.
    }
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const logFile = opts.logFile ?? null;
  const component = opts.component ?? "app";
  const threshold = LEVELS[level];

  const log = (lv: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lv] < threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level: lv,
      component,
      msg,
      ...(data ? { data: redactValue(data) as Record<string, unknown> } : {}),
    };
    writeLine(JSON.stringify(entry), logFile);
  };

  return {
    level,
    child: (c: string) => createLogger({ level, logFile, component: `${component}:${c}` }),
    debug: (m, d) => log("debug", m, d),
    info: (m, d) => log("info", m, d),
    warn: (m, d) => log("warn", m, d),
    error: (m, d) => log("error", m, d),
  };
}
