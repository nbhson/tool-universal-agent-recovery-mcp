/**
 * Recovery MCP Server — stdio transport.
 *
 * Tools: register_task, report_progress, save_checkpoint, report_interruption,
 * get_task_status, mark_completed, cancel_task.
 *
 * The server only records state; it never launches or kills agents.
 * The independent Watchdog performs recovery.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Database } from "../storage/database.js";
import { TaskRepository } from "../storage/task.repository.js";
import { EventRepository } from "../storage/event.repository.js";
import type { RecoveryConfig } from "../config.js";
import { normalizeWorkingDirectory, assertAllowedDirectory } from "../config.js";
import type { Logger } from "../core/logger.js";
import type { TaskRecord } from "../core/task.js";
import { classifyError } from "../core/error-classifier.js";

export interface ServerContext {
  db: Database;
  tasks: TaskRepository;
  events: EventRepository;
  config: RecoveryConfig;
  logger: Logger;
}

const TASK_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message: string, extra?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message, ...extra }) }], isError: true };
}

function ok(result: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, ...result }) }] };
}

function getTask(ctx: ServerContext, taskId: string) {
  return ctx.tasks.get(taskId);
}

function taskSummary(task: TaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    state: task.state,
    adapterId: task.adapterId,
    sessionId: task.sessionId,
    workingDirectory: task.workingDirectory,
    description: task.description,
    maxAttempts: task.maxAttempts,
    createdAt: new Date(task.createdAt).toISOString(),
  };
}

export function registerTools(server: McpServer, ctx: ServerContext): void {
  const { tasks, events } = ctx;

  // --- register_task ---
  server.registerTool(
    "register_task",
    {
      title: "Register Task",
      description:
        "Register a coding-agent task for monitoring and automatic recovery. " +
        "The agent (or its launcher) calls this when starting a task so the watchdog can resume it after interruptions.",
      inputSchema: {
        taskId: z.string().regex(TASK_ID_REGEX, "task ID may contain letters, digits, '.', '_', '-'").max(128)
          .describe("Unique task identifier"),
        adapterId: z.string().min(1).max(64)
          .describe("Adapter id, e.g. 'opencode', 'claude-code'"),
        agentType: z.string().min(1).max(64).optional()
          .describe("Agent type label (defaults to adapterId)"),
        sessionId: z.string().max(256).nullable().optional()
          .describe("Existing agent session id to resume, when known"),
        processPid: z.number().int().positive().nullable().optional()
          .describe("Agent process id, when launched by the caller"),
        workingDirectory: z.string().min(1)
          .describe("Absolute working directory the agent runs in"),
        description: z.string().min(1).max(20_000)
          .describe("Original task description used as recovery context"),
        maxAttempts: z.number().int().min(1).max(100).optional()
          .describe("Recovery attempt budget (default from configuration)"),
      },
    },
    async (input) => {
      try {
        const workingDirectory = normalizeWorkingDirectory(input.workingDirectory);
        assertAllowedDirectory(workingDirectory, ctx.config.allowedDirs);
        if (ctx.tasks.get(input.taskId)) {
          return fail(`Task '${input.taskId}' already registered`);
        }
        const task = tasks.create({
          taskId: input.taskId,
          adapterId: input.adapterId,
          agentType: input.agentType ?? input.adapterId,
          sessionId: input.sessionId ?? null,
          processPid: input.processPid ?? null,
          workingDirectory,
          description: input.description,
          maxAttempts: input.maxAttempts ?? ctx.config.maxAttempts,
        });
        events.append(input.taskId, "registered", "mcp", { adapterId: input.adapterId });
        return ok({ task: taskSummary(task) });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- report_progress ---
  server.registerTool(
    "report_progress",
    {
      title: "Report Progress",
      description: "Report task progress (acts as a heartbeat). Keeps the watchdog from considering the task stale.",
      inputSchema: {
        taskId: z.string(),
        progress: z.string().min(1).max(10_000).describe("What has been done so far"),
      },
    },
    async ({ taskId, progress }) => {
      const task = getTask(ctx, taskId);
      if (!task) return fail(`Task '${taskId}' not found`);
      if (task.state === "COMPLETED" || task.state === "CANCELLED") {
        return fail(`Task '${taskId}' is ${task.state}; cannot report progress`);
      }
      if (task.state === "REGISTERED") {
        tasks.transition(taskId, "RUNNING");
        events.append(taskId, "state_changed", "mcp", { to: "RUNNING" });
      }
      tasks.setProgress(taskId, progress);
      events.append(taskId, "progress", "agent", { progress: progress.slice(0, 500) });
      return ok({ taskId, state: ctx.tasks.get(taskId)!.state });
    },
  );

  // --- save_checkpoint ---
  server.registerTool(
    "save_checkpoint",
    {
      title: "Save Checkpoint",
      description:
        "Persist verified progress so a new session can continue the task after a restart. " +
        "Include concrete details: steps completed, files touched, next steps. Do not paste raw last output.",
      inputSchema: {
        taskId: z.string(),
        summary: z.string().min(1).max(10_000)
          .describe("Verified progress summary — what is actually done"),
        details: z.record(z.string(), z.unknown()).optional()
          .describe("Structured details: files touched, steps completed, next steps"),
        verified: z.boolean().optional()
          .describe("Whether this checkpoint reflects verified state (default false)"),
      },
    },
    async ({ taskId, summary, details, verified }) => {
      const task = getTask(ctx, taskId);
      if (!task) return fail(`Task '${taskId}' not found`);
      if (task.state === "COMPLETED" || task.state === "CANCELLED") {
        return fail(`Task '${taskId}' is ${task.state}; cannot save checkpoint`);
      }
      if (task.state === "REGISTERED") {
        tasks.transition(taskId, "RUNNING");
        events.append(taskId, "state_changed", "mcp", { to: "RUNNING" });
      }
      tasks.setCheckpoint(taskId, {
        summary,
        details: details as Record<string, unknown> | undefined,
        verified: verified ?? false,
      });
      events.append(taskId, "checkpoint_saved", "agent", { summary: summary.slice(0, 500), verified: verified ?? false });
      return ok({ taskId, checkpointSaved: true });
    },
  );

  // --- report_interruption ---
  server.registerTool(
    "report_interruption",
    {
      title: "Report Interruption",
      description: "Report an error or interruption for a task. The watchdog verifies and schedules recovery.",
      inputSchema: {
        taskId: z.string(),
        error: z.string().min(1).max(10_000).describe("Error or interruption description"),
        exitCode: z.number().int().nullable().optional()
          .describe("Agent process exit code, when known"),
      },
    },
    async ({ taskId, error, exitCode }) => {
      const task = getTask(ctx, taskId);
      if (!task) return fail(`Task '${taskId}' not found`);
      if (["COMPLETED", "CANCELLED"].includes(task.state)) {
        return fail(`Task '${taskId}' is ${task.state}; interruption ignored`);
      }
      const classified = classifyError(error, exitCode ?? null);
      tasks.transition(taskId, "INTERRUPTED", { lastError: error, errorClass: classified.cls });
      tasks.markInterruptionDetected(taskId, Date.now());
      events.append(
        taskId,
        "interruption_reported",
        "agent",
        { error: String(error).slice(0, 1000), class: classified.cls, transient: classified.transient },
        "warn",
      );
      return ok({ taskId, state: "INTERRUPTED", errorClass: classified.cls, transient: classified.transient });
    },
  );

  // --- get_task_status ---
  server.registerTool(
    "get_task_status",
    {
      title: "Get Task Status",
      description: "Get full task status: state, progress, checkpoint, recovery attempts, recent events.",
      inputSchema: {
        taskId: z.string(),
        includeEvents: z.boolean().optional().describe("Include recent event log (default true)"),
      },
    },
    async ({ taskId, includeEvents }) => {
      const task = getTask(ctx, taskId);
      if (!task) return fail(`Task '${taskId}' not found`);
      return ok({
        task: {
          id: task.id,
          state: task.state,
          agentType: task.agentType,
          adapterId: task.adapterId,
          sessionId: task.sessionId,
          processPid: task.processPid,
          workingDirectory: task.workingDirectory,
          description: task.description,
          progress: task.progress,
          lastError: task.lastError,
          errorClass: task.errorClass,
          checkpoint: task.checkpoint,
          recoveryAttempts: task.recoveryAttempts,
          maxAttempts: task.maxAttempts,
          nextRecoveryAt: task.nextRecoveryAt,
          recoveryOwner: task.recoveryOwner,
          lastActivityAt: new Date(task.lastActivityAt).toISOString(),
          createdAt: new Date(task.createdAt).toISOString(),
          completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
          blockedAt: task.blockedAt ? new Date(task.blockedAt).toISOString() : null,
        },
        events: (includeEvents ?? true) ? events.listForTask(taskId, 20) : undefined,
      });
    },
  );

  // --- mark_completed ---
  server.registerTool(
    "mark_completed",
    {
      title: "Mark Completed",
      description:
        "Mark a task completed after verifying the final state. Requires a verification note; " +
        "completion is never inferred from process exit.",
      inputSchema: {
        taskId: z.string(),
        verification: z.string().min(1).max(10_000)
          .describe("How completion was verified (tests run, outputs checked, etc.)"),
      },
    },
    async ({ taskId, verification }) => {
      const task = getTask(ctx, taskId);
      if (!task) return fail(`Task '${taskId}' not found`);
      if (["COMPLETED", "CANCELLED"].includes(task.state)) {
        return fail(`Task '${taskId}' is already ${task.state}`);
      }
      // Guard against drive-by completion: require evidence of work (checkpoint or progress).
      if (!task.checkpoint && !task.progress) {
        return fail(
          `Task '${taskId}' has no checkpoint or progress report; cannot verify completion. ` +
            "Call save_checkpoint/report_progress first.",
        );
      }
      tasks.transition(taskId, "COMPLETED");
      events.append(taskId, "completed", "agent", { verification: String(verification).slice(0, 2000) });
      return ok({ taskId, state: "COMPLETED" });
    },
  );

  // --- cancel_task ---
  server.registerTool(
    "cancel_task",
    {
      title: "Cancel Task",
      description: "Cancel a task and stop any further recovery attempts for it.",
      inputSchema: {
        taskId: z.string(),
        reason: z.string().max(2000).optional(),
      },
    },
    async ({ taskId, reason }) => {
      const task = getTask(ctx, taskId);
      if (!task) return fail(`Task '${taskId}' not found`);
      if (task.state === "CANCELLED") return ok({ taskId, state: "CANCELLED", note: "already cancelled" });
      if (task.state === "COMPLETED") return fail(`Task '${taskId}' is COMPLETED and cannot be cancelled`);
      const previous = task.state;
      tasks.transition(taskId, "CANCELLED");
      tasks.releaseRecoveryOwner(taskId, task.recoveryOwner ?? "");
      events.append(taskId, "cancelled", "agent", { reason: reason ?? null, previousState: previous });
      return ok({ taskId, state: "CANCELLED" });
    },
  );
}

export function buildMcpServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "recovery-mcp", version: "0.1.0" });
  registerTools(server, ctx);
  return server;
}

/** Entry point for `node dist/mcp/server.js`. */
export async function runMcpServer(
  config: RecoveryConfig,
  logger: Logger,
): Promise<void> {
  const db = new Database(config.dbPath, logger);
  db.migrate();
  const events = new EventRepository(db);
  const tasks = new TaskRepository(db, events);
  const ctx: ServerContext = { db, tasks, events, config, logger };

  const server = buildMcpServer(ctx);
  await server.connect(new StdioServerTransport());
  logger.info("recovery MCP server started", { dbPath: config.dbPath });

  const shutdown = (): void => {
    logger.info("mcp server shutting down");
    void server.close().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { fail, ok };
