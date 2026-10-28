/**
 * Resolves a bare binary name to a spawnable executable.
 *
 * On Windows, npm-installed CLIs are .cmd/.ps1 shims which cannot be spawned
 * directly with shell:false (Node blocks .cmd spawning for security). This
 * helper finds the real .exe via `where.exe` and caches the result. When only
 * shims exist, callers must set the explicit binary path env (e.g.
 * OPENCODE_BIN) — documented in the README for Windows.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const cache = new Map<string, string>();

export function resolveExecutable(bin: string): string {
  if (path.isAbsolute(bin) || !process.platform.startsWith("win")) return bin;
  const hit = cache.get(bin);
  if (hit) return hit;

  let resolved: string;
  try {
    const out = execFileSync("where.exe", [bin], { timeout: 10_000, shell: false }).toString();
    const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const exe = candidates.find((c) => c.toLowerCase().endsWith(".exe"));
    // .cmd/.ps1 shims cannot be spawned by Node without a shell; only .exe is.
    resolved = exe ?? bin;
  } catch {
    resolved = bin;
  }
  cache.set(bin, resolved);
  return resolved;
}
