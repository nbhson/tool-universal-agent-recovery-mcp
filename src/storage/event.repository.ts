/** Append-only event log for auditability and debugging. */
import type { Database } from "./database.js";
import type { Logger } from "../core/logger.js";
import { safeJsonParse } from "./json.js";

export type EventLevel = "info" | "warn" | "error";

export interface EventRecord {
  id: number;
  taskId: string;
  type: string;
  level: EventLevel;
  actor: string;
  data: Record<string, unknown> | null;
  createdAt: number;
}

export class EventRepository {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  append(
    taskId: string,
    type: string,
    actor: string,
    data?: Record<string, unknown>,
    level: EventLevel = "info",
  ): void {
    this.db.db
      .prepare(
        "INSERT INTO events (task_id, type, level, actor, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(taskId, type, level, actor, data ? JSON.stringify(data) : null, Date.now());
  }

  listForTask(taskId: string, limit = 200): EventRecord[] {
    const rows = this.db.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?")
      .all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: String(r.task_id),
      type: String(r.type),
      level: String(r.level) as EventLevel,
      actor: String(r.actor),
      data: r.data ? safeJsonParse(String(r.data), `events:${String(r.id)}`, this.logger) : null,
      createdAt: Number(r.created_at),
    }));
  }
}
