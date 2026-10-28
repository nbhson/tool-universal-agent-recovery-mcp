/**
 * Claude Code adapter.
 *
 * Verified against official CLI reference (https://code.claude.com/docs/en/cli-reference, checked 2026-10):
 * - `claude -p "query"` — non-interactive (print mode) run.
 * - `claude -r "<session>" "query"` / `--resume <id>` — resume session by ID.
 * - `claude -c -p "query"` — continue most recent conversation.
 * - `--output-format json` — structured result (has `subtype`, e.g. "success").
 *
 * Capabilities verified: resume via `--resume <id> -p`, new session via `-p`,
 * completion detection from `--output-format json` result. Session inspection
 * has no documented non-interactive command, so `inspectSession` is false and
 * resume verification is attempted directly (failure falls back to new session).
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

export interface ClaudeCodeAdapterOptions {
  /** Binary name or absolute path. Default: "claude". */
  bin?: string;
  logFile?: string | null;
  timeoutMs?: number;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  readonly agentType = "claude-code";
  readonly capabilities: AdapterCapabilities = {
    detect: true,
    inspectSession: false, // no documented non-interactive session list
    resumeSession: true,
    launchNew: true,
    restoreContext: true,
    processHealth: true,
    gracefulCancel: true,
    completionDetection: true,
  };

  constructor(private readonly opts: ClaudeCodeAdapterOptions = {}) {}

  private get bin(): string {
    return resolveExecutable(this.opts.bin ?? "claude");
  }

  async detect(): Promise<boolean> {
    try {
      const res = execFileSync(this.bin, ["--version"], { timeout: 10_000, shell: false });
      return String(res).trim().length > 0;
    } catch {
      return false;
    }
  }

  async isProcessAlive(pid: number): Promise<boolean> {
    return isPidAlive(pid);
  }

  async resumeSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult> {
    if (!options.sessionId) {
      throw new Error("resumeSession requires sessionId");
    }
    // Verified: claude -r "<session>" "query" (print mode via -p for headless)
    return launchProcess({
      command: this.bin,
      args: [
        "--resume",
        options.sessionId,
        "--print",
        "--output-format",
        "json",
        "--disallowedTools",
        "mcp__*",
        options.instruction,
      ],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.opts.timeoutMs,
      logFile: options.logFile ?? this.opts.logFile ?? null,
    });
  }

  async startNewSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult> {
    return launchProcess({
      command: this.bin,
      args: ["--print", "--output-format", "json", options.instruction],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.opts.timeoutMs,
      logFile: options.logFile ?? this.opts.logFile ?? null,
    });
  }

  /** Parse `--output-format json` result: success when `is_error` is falsy. */
  detectCompletion(output: string): boolean | null {
    if (!output || output.trim() === "") return null;
    try {
      const parsed = JSON.parse(output) as { subtype?: string; is_error?: boolean };
      return parsed.is_error === true ? false : true;
    } catch {
      return null; // unparseable output: undeterminable
    }
  }
}
