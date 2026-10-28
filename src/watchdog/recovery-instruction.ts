/**
 * Builds the recovery instruction sent to an agent when resuming.
 *
 * The instruction must be self-contained: never assume the agent's
 * conversational context survived the interruption. It directs the agent to
 * inspect the repository, verify existing changes, identify unfinished work,
 * avoid repeating non-idempotent operations, and continue the task.
 */
import type { Checkpoint, TaskRecord } from "../core/task.js";

export function buildRecoveryInstruction(task: TaskRecord, checkpoint: Checkpoint | null): string {
  const lines: string[] = [];

  lines.push(
    `You are resuming an interrupted task automatically (no human is present). ` +
      `Your previous session may have been cut off mid-work.`,
  );
  lines.push("");
  lines.push(`# Original task`);
  lines.push(task.description);
  lines.push("");

  if (task.progress) {
    lines.push(`# Last reported progress`);
    lines.push(task.progress);
    lines.push("");
  }

  if (checkpoint) {
    lines.push(`# Saved checkpoint${checkpoint.verified ? " (verified)" : ""}`);
    lines.push(checkpoint.summary);
    if (checkpoint.details) {
      lines.push("```json");
      lines.push(JSON.stringify(checkpoint.details, null, 2));
      lines.push("```");
    }
    lines.push("");
  }

  if (task.lastError) {
    lines.push(`# Last recorded error before the interruption`);
    lines.push(task.lastError);
    lines.push("");
  }

  lines.push(`# Recovery instructions`);
  lines.push(
    [
      "1. Inspect the current state of the repository before changing anything.",
      "2. Verify what work already exists (files, commits, generated artifacts) — it may be partially done.",
      "3. Identify the unfinished remainder of the task and continue from there.",
      "4. Do NOT repeat non-idempotent operations that already succeeded (e.g. do not re-create existing files, re-run completed migrations, or re-install dependencies unnecessarily).",
      "5. If a previous step appears half-applied, repair it to a consistent state first.",
      "6. Continue until the original task is complete; report progress with the recovery MCP tools as you go.",
      "7. Call mark_completed only after verifying the final state.",
    ].join("\n"),
  );

  return lines.join("\n");
}
