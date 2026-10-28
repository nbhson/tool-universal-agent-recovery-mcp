/**
 * Generic CLI adapter.
 *
 * Disabled unless explicitly configured. The user supplies command templates
 * with `{prompt}` and optionally `{session}` placeholders, e.g.:
 *
 *   RECOVERY_GENERIC_CLI_RESUME=myagent run --resume {session} "{prompt}"
 *   RECOVERY_GENERIC_CLI_NEW=myagent run "{prompt}"
 *
 * Templates are split into an argument array (respecting quotes) — never run
 * through a shell. Use only with agents exposing a documented CLI interface.
 */
import type {
  AdapterCapabilities,
  AgentAdapter,
  LaunchOptions,
  LaunchResult,
} from "./adapter.interface.js";
import type { TaskRecord } from "../core/task.js";
import { launchProcess } from "./process-runner.js";
import { isPidAlive } from "./process-health.js";

export interface GenericCliAdapterOptions {
  resumeTemplate?: string | null;
  newTemplate?: string | null;
  logFile?: string | null;
  timeoutMs?: number;
}

/** Split a command template into argv, respecting single/double quotes. */
export function splitCommand(template: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken || current) {
        argv.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (quote) throw new Error("Unbalanced quotes in command template");
  if (hasToken || current) argv.push(current);
  return argv;
}

export class GenericCliAdapter implements AgentAdapter {
  readonly id = "generic-cli";
  readonly agentType = "generic";
  readonly capabilities: AdapterCapabilities;

  constructor(private readonly opts: GenericCliAdapterOptions = {}) {
    this.capabilities = {
      detect: false,
      inspectSession: false,
      resumeSession: Boolean(opts.resumeTemplate?.includes("{session}")),
      launchNew: Boolean(opts.newTemplate),
      restoreContext: Boolean(opts.newTemplate),
      processHealth: true,
      gracefulCancel: true,
      completionDetection: false,
    };
  }

  /** Whether this adapter is usable at all. */
  get configured(): boolean {
    return Boolean(this.opts.resumeTemplate || this.opts.newTemplate);
  }

  async detect(): Promise<boolean> {
    return this.configured;
  }

  async isProcessAlive(pid: number): Promise<boolean> {
    return isPidAlive(pid);
  }

  async resumeSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult> {
    const template = this.opts.resumeTemplate;
    if (!template) throw new Error("generic-cli adapter has no resume template configured");
    if (!options.sessionId) throw new Error("resumeSession requires sessionId");
    const { command, args } = renderTemplate(template, {
      prompt: options.instruction,
      session: options.sessionId,
    });
    return launchProcess({
      command,
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.opts.timeoutMs,
      logFile: options.logFile ?? this.opts.logFile ?? null,
    });
  }

  async startNewSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult> {
    const template = this.opts.newTemplate;
    if (!template) throw new Error("generic-cli adapter has no new-session template configured");
    const { command, args } = renderTemplate(template, { prompt: options.instruction });
    return launchProcess({
      command,
      args,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.opts.timeoutMs,
      logFile: options.logFile ?? this.opts.logFile ?? null,
    });
  }
}

function renderTemplate(
  template: string,
  vars: { prompt: string; session?: string },
): { command: string; args: string[] } {
  const argv = splitCommand(template).map((arg) =>
    arg
      .replaceAll("{prompt}", vars.prompt)
      .replaceAll("{session}", vars.session ?? ""),
  );
  if (argv.length === 0) throw new Error("Empty command template");
  const [command, ...args] = argv;
  return { command: command ?? "", args };
}

export { renderTemplate };
