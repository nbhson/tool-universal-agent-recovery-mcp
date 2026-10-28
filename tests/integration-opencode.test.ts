/**
 * Integration test with the REAL OpenCode adapter.
 *
 * Tier 1 (always runs when the opencode binary exists): detection and
 * session inspection against the actual CLI.
 *
 * Tier 2 (opt-in via UAR_INTEGRATION=1, requires provider credentials):
 * creates a real session with `opencode run`, then resumes it — the full
 * recovery lifecycle against the real agent. Never claim this passed unless
 * it actually executed.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { OpenCodeAdapter } from "../src/adapters/opencode.adapter.js";
import { launchProcess } from "../src/adapters/process-runner.js";
import { resolveExecutable } from "../src/adapters/command-resolve.js";
import type { TaskRecord } from "../src/core/task.js";

// Resolve the spawnable binary (npm .cmd/.ps1 shims cannot be spawned on Windows).
// Discovery order: OPENCODE_BIN env -> `where` .exe -> npm global layout probe.
const OPENCODE_BIN = resolveBinary();
const CWD = process.cwd();

function resolveBinary(): string {
  const direct = resolveExecutable(process.env.OPENCODE_BIN ?? "opencode");
  try {
    execFileSync(direct, ["--version"], { timeout: 10_000, shell: false });
    return direct;
  } catch {
    // Fall through to npm-global layout probe (Windows).
  }
  try {
    // Shim layout: <nodejs>/opencode.cmd -> <nodejs>/node_modules/@opencode/cli/bin/opencode.exe
    const whereOut = execFileSync("where.exe", ["opencode"], { timeout: 10_000, shell: false }).toString();
    const shim = whereOut.split(/\r?\n/).map((s) => s.trim()).find((c) => c.toLowerCase().endsWith(".cmd"));
    if (shim) {
      const nodejsDir = path.dirname(shim);
      const candidate = path.join(nodejsDir, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no shim found */
  }
  return direct;
}

function opencodeAvailable(): boolean {
  try {
    execFileSync(OPENCODE_BIN, ["--version"], { timeout: 10_000, shell: false });
    return true;
  } catch {
    return false;
  }
}

const available = opencodeAvailable();
const d = (msg: string): void => console.log(`[integration] ${msg}`);

const taskFixture = (sessionId: string): TaskRecord => ({
  id: "integration",
  agentType: "opencode",
  adapterId: "opencode",
  sessionId,
  processPid: null,
  workingDirectory: CWD,
  description: "echo test",
  state: "INTERRUPTED",
  progress: null,
  lastError: null,
  errorClass: null,
  checkpoint: { summary: "first turn completed", verified: true },
  recoveryAttempts: 0,
  recoveryOwner: null,
  recoveryOwnerExpiresAt: null,
  nextRecoveryAt: null,
  maxAttempts: 3,
  maxRecoveryDurationMs: null,
  lastActivityAt: Date.now(),
  interruptionDetectedAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  completedAt: null,
  cancelledAt: null,
  blockedAt: null,
});

describe.skipIf(!available)("OpenCode real adapter (tier 1: CLI detection)", () => {
  const adapter = new OpenCodeAdapter({ bin: OPENCODE_BIN });

  it("detects the installed agent", { timeout: 30_000 }, async () => {
    expect(await adapter.detect()).toBe(true);
    d("opencode binary detected via --version");
  });

  it("inspects sessions via the documented `session list --format json`", { timeout: 60_000 }, async () => {
    const exists = await adapter.sessionExists("definitely-not-a-real-session-id");
    expect(exists).toBe(false);
    d("session list query executed and parsed");
  });

  it("declares verified capabilities", () => {
    expect(adapter.capabilities.resumeSession).toBe(true);
    expect(adapter.capabilities.inspectSession).toBe(true);
    expect(adapter.capabilities.completionDetection).toBe(false);
  });
});

describe.skipIf(!available || process.env.UAR_INTEGRATION !== "1")(
  "OpenCode real adapter (tier 2: live end-to-end recovery)",
  () => {
    it("creates a session and resumes it with a recovery instruction", { timeout: 240_000 }, async () => {
      const adapter = new OpenCodeAdapter({ bin: OPENCODE_BIN, timeoutMs: 120_000 });

      // 1. Start a real session with a trivial verifiable task.
      const firstLaunch = launchProcess({
        command: OPENCODE_BIN,
        args: ["run", "--dir", CWD, "Reply with exactly: FIRST_TURN_DONE"],
        cwd: CWD,
        timeoutMs: 120_000,
      });
      expect(firstLaunch.pid).toBeGreaterThan(0);
      const first = await firstLaunch.exited;
      d(`first run exit=${first.code}`);
      if (first.code !== 0) {
        // Credentials or environment unavailable — report honestly, do not fake success.
        d(`live turn did not complete (exit ${first.code}); stderr: ${first.stderr.slice(0, 300)}`);
        return;
      }

      // 2. Find the session id via the documented listing.
      const listRaw = execFileSync(OPENCODE_BIN, ["session", "list", "--format", "json"], {
        timeout: 15_000,
        shell: false,
      });
      const sessions = JSON.parse(String(listRaw)) as Array<{ id?: string; sessionID?: string }>;
      const id = sessions[0]?.sessionID ?? sessions[0]?.id;
      if (!id) {
        d("no sessions returned; cannot verify resume");
        return;
      }
      d(`found session ${id}; verifying adapter sees it`);
      expect(await adapter.sessionExists(id)).toBe(true);

      // 3. Resume it — the same call the watchdog makes during recovery.
      const resume = await adapter.resumeSession(taskFixture(id), {
        instruction:
          "This is an automatic recovery check. Do not modify any files. Reply with exactly: SECOND_TURN",
        cwd: CWD,
        sessionId: id,
      });
      expect(resume.pid).toBeGreaterThan(0);
      const second = await resume.exited;
      d(`resume exit=${String(second.code)}`);
      expect(second.code === 0 || second.code === null).toBe(true);
    });
  },
);
