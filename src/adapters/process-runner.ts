/** Safe child-process launching: argument arrays only, no shell strings. */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LaunchResult } from "./adapter.interface.js";

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  logFile?: string | null;
}

/** Environment variables that must never reach a child process. */
const SECRET_ENV_PATTERNS: RegExp[] = [
  /secret/i,
  /token/i,
  /password|passwd/i,
  /credential/i,
  /(^|_)api_?key($|_)/i,
  /(^|_)key$/i,
];

/**
 * Provider API keys agent CLIs legitimately need to run. Everything else that
 * looks like a secret (GITHUB_TOKEN, DATABASE_URL with passwords, webhook
 * tokens, ...) is removed from the child environment.
 */
const PROVIDER_API_KEY_ALLOWLIST: RegExp[] = [
  /^ANTHROPIC_API_KEY$/i,
  /^CLAUDE_CODE_OAUTH_TOKEN$/i,
  /^OPENAI_API_KEY$/i,
  /^OPENROUTER_API_KEY$/i,
  /^GEMINI_API_KEY$/i,
  /^GOOGLE_(API_KEY|GENERATIVE_AI_API_KEY)$/i,
  /^AZURE_OPENAI_API_KEY$/i,
  /^XAI_API_KEY$/i,
  /^MISTRAL_API_KEY$/i,
  /^DEEPSEEK_API_KEY$/i,
  /^AWS_ACCESS_KEY_ID$/i,
  /^AWS_SECRET_ACCESS_KEY$/i,
  /^AWS_SESSION_TOKEN$/i,
];

/** Internal-only config variables the child must never see. */
const INTERNAL_ENV_PATTERN = /^(RECOVERY_DB_PATH|RECOVERY_LOG_FILE)$/i;

/**
 * Strip credential-like variables from the child environment. Agent API keys
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) are preserved because agent CLIs
 * authenticate through them; everything else that looks like a secret goes.
 */
export function sanitizeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (INTERNAL_ENV_PATTERN.test(key)) {
      delete env[key];
      continue;
    }
    if (PROVIDER_API_KEY_ALLOWLIST.some((re) => re.test(key))) continue;
    if (SECRET_ENV_PATTERNS.some((re) => re.test(key))) delete env[key];
  }
  return env;
}

/** Kill a child process (and its tree) cross-platform. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    // SIGTERM/SIGKILL cannot terminate foreign process trees on Windows;
    // taskkill /T is the reliable way to kill the whole tree.
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, timeout: 10_000, stdio: "ignore" });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }
  // Escalate after a short grace period.
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 5000).unref();
}

export function launchProcess(spec: SpawnSpec): LaunchResult {
  const { command, args, cwd, timeoutMs, logFile } = spec;

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  let appendLog: ((chunk: string) => void) | null = null;
  if (logFile) {
    fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
    appendLog = (chunk: string) => {
      try {
        fs.appendFileSync(logFile, chunk);
      } catch {
        /* ignore log write failures */
      }
    };
  }

  const child = spawn(command, args, {
    cwd,
    shell: false, // never a shell: no injection from task metadata
    env: sanitizeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const alive = (): boolean => child.exitCode === null && !settled;

  child.stdout?.on("data", (d: Buffer) => {
    const text = d.toString();
    stdout += text;
    if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000); // cap memory
    appendLog?.(text);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const text = d.toString();
    stderr += text;
    if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    appendLog?.(text);
  });

  const cancel = (): void => {
    if (!alive()) return;
    killTree(child.pid ?? -1);
  };

  const exited = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
    (resolve) => {
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (alive()) killTree(child.pid ?? -1);
        }, timeoutMs);
        timer.unref();
      }
      child.on("error", (err) => {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code: null, signal: null, stdout, stderr: stderr + String(err) });
      });
      child.on("close", (code, signal) => {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ code, signal, stdout, stderr });
      });
    },
  );

  return { pid: child.pid ?? -1, exited, cancel };
}
