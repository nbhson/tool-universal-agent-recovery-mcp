/**
 * OpenCode adapter.
 *
 * Verified against official CLI docs (https://opencode.ai/docs/cli/, checked 2026-10):
 * - `opencode run [message..]` — non-interactive run.
 * - `--session <id>` / `-s` — continue a specific session.
 * - `--continue` / `-c` — continue the last session.
 * - `--dir <dir>` — working directory.
 * - `opencode session list --format json` — list sessions.
 *
 * Capabilities verified: session resume via `--session`, session inspection via
 * `session list`. Completion detection is NOT implemented: `run` output has no
 * documented structured completion signal, so completion is verified via MCP
 * tool calls (report_progress / mark_completed), not process output.
 */
import { execFileSync } from "node:child_process";
import type {
  AdapterCapabilities,
  AgentAdapter,
  LaunchOptions,
  LaunchResult,
} from "./adapter.interface.js";
import type { TaskRecord } from "../core/task.js";
import { launchProcess } from "./process-runner.js";
import { isPidAlive } from "./process-health.js";
import { resolveExecutable } from "./command-resolve.js";

export interface OpenCodeAdapterOptions {
  /** Binary name or absolute path. Default: "opencode". */
  bin?: string;
  logFile?: string | null;
  timeoutMs?: number;
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode";
  readonly agentType = "opencode";
  readonly capabilities: AdapterCapabilities = {
    detect: true,
    inspectSession: true,
    resumeSession: true,
    launchNew: true,
    restoreContext: true,
    processHealth: true,
    gracefulCancel: true,
    completionDetection: false,
  };

  constructor(private readonly opts: OpenCodeAdapterOptions = {}) {}

  private get bin(): string {
    return resolveExecutable(this.opts.bin ?? "opencode");
  }

  async detect(): Promise<boolean> {
    try {
      const res = execFileSync(this.bin, ["--version"], {
        timeout: 10_000,
        shell: false,
      });
      return String(res).trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns true/false only from a successful `session list` query;
   * returns null when the CLI itself failed (transient error must not be
   * mistaken for "session deleted" — the watchdog defers recovery instead).
   */
  async sessionExists(sessionId: string): Promise<boolean | null> {
    try {
      const res = execFileSync(resolveExecutable(this.bin), ["session", "list", "--format", "json"], {
        timeout: 15_000,
        shell: false,
        maxBuffer: 10 * 1024 * 1024,
      });
      const sessions = JSON.parse(String(res)) as Array<{ id?: string; sessionID?: string }>;
      return sessions.some((s) => s.id === sessionId || s.sessionID === sessionId);
    } catch {
      return null; // CLI failure: undeterminable, do NOT claim the session is gone
    }
  }

  async isProcessAlive(pid: number): Promise<boolean> {
    return isPidAlive(pid);
  }

  async resumeSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult> {
    if (!options.sessionId) {
      throw new Error("resumeSession requires sessionId");
    }
    // Verified flags: run [message..] --session <id> --dir <dir>
    return launchProcess({
      command: this.bin,
      args: ["run", "--session", options.sessionId, "--dir", options.cwd, options.instruction],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.opts.timeoutMs,
      logFile: options.logFile ?? this.opts.logFile ?? null,
    });
  }

  async startNewSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult> {
    return launchProcess({
      command: this.bin,
      args: ["run", "--dir", options.cwd, options.instruction],
      timeoutMs: options.timeoutMs ?? this.opts.timeoutMs,
      logFile: options.logFile ?? this.opts.logFile,
      cwd: options.cwd,
    });
  }
}
