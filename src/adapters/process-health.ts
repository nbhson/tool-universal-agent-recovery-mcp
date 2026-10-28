/** Generic cross-platform process liveness probe. */
import { spawnSync } from "node:child_process";

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 probes existence without killing; works on POSIX.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists but not ours
    // On Windows, process.kill(pid, 0) may throw other codes; fall back to tasklist.
    if (process.platform === "win32") return isPidAliveWindows(pid);
    return false;
  }
}

function isPidAliveWindows(pid: number): boolean {
  try {
    const res = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      timeout: 5000,
      shell: false,
    });
    return res.status === 0 && String(res.stdout).includes(String(pid));
  } catch {
    return false;
  }
}
