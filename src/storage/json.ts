/** Corrupt-data-safe JSON parsing for values read back from SQLite. */
import type { Logger } from "../core/logger.js";

/**
 * Parse a JSON object stored in a database column. Corrupt or non-object
 * values never crash the caller: the fallback is returned and a warning is
 * logged instead.
 */
export function safeJsonParse(
  raw: string,
  context: string,
  logger?: Logger,
): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger?.warn("json column did not contain an object; using fallback", { context });
    return null;
  } catch (err) {
    logger?.warn("corrupt JSON in database column; using fallback", {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** True when the error is a SQLite UNIQUE constraint violation. */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** Raised when registering a task whose ID already exists. */
export class DuplicateTaskError extends Error {
  constructor(taskId: string) {
    super(`Task '${taskId}' already exists`);
    this.name = "DuplicateTaskError";
  }
}
