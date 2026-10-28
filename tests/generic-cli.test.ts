/**
 * Generic CLI adapter: template splitting, placeholder rendering, and the
 * security-critical property that prompts are passed as argument arrays.
 */
import { describe, it, expect } from "vitest";
import { splitCommand, GenericCliAdapter, renderTemplate } from "../src/adapters/generic-cli.adapter.js";
import type { TaskRecord } from "../src/core/task.js";
describe("splitCommand", () => {
  it("splits on whitespace", () => {
    expect(splitCommand("myagent run fast")).toEqual(["myagent", "run", "fast"]);
  });

  it("respects double quotes", () => {
    expect(splitCommand('myagent run "two words"')).toEqual(["myagent", "run", "two words"]);
  });

  it("respects single quotes", () => {
    expect(splitCommand("myagent run 'two words'")).toEqual(["myagent", "run", "two words"]);
  });

  it("rejects unbalanced quotes", () => {
    expect(() => splitCommand('myagent run "unbalanced')).toThrow(/quote/i);
  });

  it("keeps shell metacharacters as literal arguments (no shell involved)", () => {
    const argv = splitCommand('myagent run "prompt with ; rm -rf / and $(whoami)"');
    expect(argv).toHaveLength(3);
    expect(argv[2]).toBe("prompt with ; rm -rf / and $(whoami)");
  });
});

describe("generic cli adapter", () => {
  function taskFixture(): TaskRecord {
    return {
      id: "t1", agentType: "generic", adapterId: "generic-cli", sessionId: "s-1",
      processPid: null, workingDirectory: "/work", description: "d", state: "INTERRUPTED",
      progress: null, lastError: null, errorClass: null, checkpoint: null,
      recoveryAttempts: 0, recoveryOwner: null, recoveryOwnerExpiresAt: null,
      nextRecoveryAt: null, maxAttempts: 3, maxRecoveryDurationMs: null,
      lastActivityAt: Date.now(), interruptionDetectedAt: null,
      createdAt: Date.now(), updatedAt: Date.now(),
      completedAt: null, cancelledAt: null, blockedAt: null,
    };
  }

  it("requires session placeholder for resume capability", () => {
    const a = new GenericCliAdapter({ resumeTemplate: "myagent run \"{prompt}\"" });
    expect(a.capabilities.resumeSession).toBe(false);
    const b = new GenericCliAdapter({ resumeTemplate: 'myagent run --resume {session} "{prompt}"' });
    expect(b.capabilities.resumeSession).toBe(true);
  });

  it("is unconfigured without templates", () => {
    expect(new GenericCliAdapter({}).configured).toBe(false);
    expect(new GenericCliAdapter({}).capabilities.launchNew).toBe(false);
  });

  it("renders templates with prompt and session as separate argv entries", async () => {
    const adapter = new GenericCliAdapter({
      resumeTemplate: 'myagent run --resume {session} "{prompt}"',
    });
    // Render directly: spawning a non-existent binary would only prove spawn()
    // received an argument array, which is enforced by process-runner (shell: false).
    const { command, args } = renderTemplate('myagent run --resume {session} "{prompt}"', {
      prompt: "continue; do not restart",
      session: "abc-123",
    });
    expect(command).toBe("myagent");
    expect(args).toEqual(["run", "--resume", "abc-123", "continue; do not restart"]);

    // Launch shape: returns a LaunchResult even when the binary is missing.
    const launch = await adapter.resumeSession(taskFixture(), {
      instruction: "continue; do not restart",
      cwd: process.cwd(),
      sessionId: "abc-123",
    });
    expect(launch.exited).toBeInstanceOf(Promise);
  });

  it("startNewSession fails cleanly without a template", async () => {
    const adapter = new GenericCliAdapter({});
    await expect(adapter.startNewSession(taskFixture(), { instruction: "x", cwd: process.cwd() })).rejects.toThrow(/template/i);
  });

  it("reports unconfigured adapter as unusable", async () => {
    const adapter = new GenericCliAdapter({});
    expect(await adapter.detect()).toBe(false);
    expect(adapter.configured).toBe(false);
  });
});
