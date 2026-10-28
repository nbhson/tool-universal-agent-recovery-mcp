import { canTransition, type TaskState } from "./task.js";

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly to: TaskState,
    public readonly taskId: string,
  ) {
    super(`Illegal task state transition ${from} -> ${to} for task ${taskId}`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Applies a state transition. The caller is responsible for persistence;
 * this function validates and returns the target state.
 * Transitions to the same state are treated as no-ops.
 */
export function applyTransition(taskId: string, from: TaskState, to: TaskState): TaskState {
  if (from === to) return from;
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to, taskId);
  }
  return to;
}
