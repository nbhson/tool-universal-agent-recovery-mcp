/** Fully scriptable mock adapter for deterministic tests. */
import type {
  AdapterCapabilities,
  AgentAdapter,
  LaunchOptions,
  LaunchResult,
} from "./adapter.interface.js";
import type { TaskRecord } from "../core/task.js";

export interface MockScript {
  /** Initial resume attempts that fail (exit 1) before succeeding. */
  resumeFailures?: number;
  /** Initial new-session launches that fail before succeeding. */
  newSessionFailures?: number;
  /** Simulate a launch that never exits (timeout/cancel handling). */
  hang?: boolean;
  /** Liveness reported by isProcessAlive (default false). */
  processAlive?: boolean;
  /** Simulate the session not existing. */
  sessionMissing?: boolean;
  /** Output emitted on successful runs. */
  output?: string;
  /** Exit code on success (default 0). */
  exitCode?: number;
  /** Substring marking completion in output; detection returns null when absent. */
  completionSignal?: string;
  /** Make resumeSession throw at launch time (simulates unusable session). */
  resumeThrows?: boolean;
}

export class MockAdapter implements AgentAdapter {
  readonly id = "mock";
  readonly agentType = "mock";
  readonly capabilities: AdapterCapabilities = {
    detect: true,
    inspectSession: true,
    resumeSession: true,
    launchNew: true,
    restoreContext: true,
    processHealth: true,
    gracefulCancel: true,
    completionDetection: true,
  };

  readonly calls: Array<{ method: string; args: unknown }> = [];
  script: MockScript = {};
  private resumeFailuresUsed = 0;
  private newFailuresUsed = 0;
  private cancelled = false;
  private hangingCancels: Array<() => void> = [];

  setScript(script: MockScript): void {
    this.script = { ...this.script, ...script };
  }

  wasCancelled(): boolean {
    return this.cancelled;
  }

  /** Resolve all hanging launches (used when a test ends a "hung" process). */
  resolveHangingLaunches(_code = 0): void {
    this.hangingCancels.forEach((fn) => fn());
    this.hangingCancels = [];
  }

  async detect(): Promise<boolean> {
    this.calls.push({ method: "detect", args: undefined });
    return true;
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    this.calls.push({ method: "sessionExists", args: sessionId });
    return !this.script.sessionMissing;
  }

  async isProcessAlive(pid: number): Promise<boolean> {
    this.calls.push({ method: "isProcessAlive", args: pid });
    return this.script.processAlive ?? false;
  }

  async resumeSession(task: TaskRecord, options: LaunchOptions): Promise<LaunchResult> {
    this.calls.push({ method: "resumeSession", args: { taskId: task.id, sessionId: options.sessionId } });
    if (this.script.resumeThrows) {
      throw new Error("simulated resume launch failure");
    }
    if (this.resumeFailuresUsed < (this.script.resumeFailures ?? 0)) {
      this.resumeFailuresUsed += 1;
      return this.failedLaunch(`simulated resume failure ${this.resumeFailuresUsed}`);
    }
    return this.launch();
  }

  async startNewSession(task: TaskRecord, _options: LaunchOptions): Promise<LaunchResult> {
    this.calls.push({ method: "startNewSession", args: { taskId: task.id } });
    if (this.newFailuresUsed < (this.script.newSessionFailures ?? 0)) {
      this.newFailuresUsed += 1;
      return this.failedLaunch(`simulated new-session failure ${this.newFailuresUsed}`);
    }
    return this.launch();
  }

  detectCompletion(output: string): boolean | null {
    if (this.script.completionSignal === undefined) return null;
    return output.includes(this.script.completionSignal);
  }

  cancel(): void {
    this.cancelled = true;
  }

  // --- internals ---

  private launch(): LaunchResult {
    if (this.script.hang) {
      return {
        pid: 424244,
        cancel: () => this.cancel(),
        exited: new Promise((resolve) => {
          this.hangingCancels.push(() =>
            resolve({ code: null, signal: "SIGTERM", stdout: this.script.output ?? "", stderr: "" }),
          );
        }),
      };
    }
    return {
      pid: 424242,
      cancel: () => this.cancel(),
      exited: new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              code: this.script.exitCode ?? 0,
              signal: null,
              stdout: this.script.output ?? "mock agent completed the turn",
              stderr: "",
            }),
          10,
        );
      }),
    };
  }

  private failedLaunch(reason: string): LaunchResult {
    return {
      pid: 424243,
      cancel: () => this.cancel(),
      exited: new Promise((resolve) => {
        setTimeout(() => resolve({ code: 1, signal: null, stdout: "", stderr: `simulated failure: ${reason}` }), 10);
      }),
    };
  }
}
