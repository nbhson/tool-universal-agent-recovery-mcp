import { describe, it, expect } from "vitest";
import { canTransition, ALLOWED_TRANSITIONS, TASK_STATES } from "../src/core/task.js";
import { applyTransition, IllegalTransitionError } from "../src/core/state-machine.js";

describe("task state machine", () => {
  it("allows the documented happy path", () => {
    expect(canTransition("REGISTERED", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "INTERRUPTED")).toBe(true);
    expect(canTransition("INTERRUPTED", "RECOVERING")).toBe(true);
    expect(canTransition("RECOVERING", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "COMPLETED")).toBe(true);
  });

  it("allows blocked -> recovering after human intervention", () => {
    expect(canTransition("BLOCKED", "RECOVERING")).toBe(true);
  });

  it("rejects terminal transitions", () => {
    expect(canTransition("COMPLETED", "RUNNING")).toBe(false);
    expect(canTransition("COMPLETED", "INTERRUPTED")).toBe(false);
    expect(canTransition("CANCELLED", "RUNNING")).toBe(false);
  });

  it("rejects REGISTERED -> COMPLETED (must pass verification path)", () => {
    expect(canTransition("REGISTERED", "COMPLETED")).toBe(false);
  });

  it("applyTransition throws on illegal move", () => {
    expect(() => applyTransition("t1", "CANCELLED", "RUNNING")).toThrow(IllegalTransitionError);
    expect(() => applyTransition("t1", "REGISTERED", "COMPLETED")).toThrow(IllegalTransitionError);
  });

  it("applyTransition allows same-state no-op", () => {
    expect(applyTransition("t1", "RUNNING", "RUNNING")).toBe("RUNNING");
  });

  it("every state has a transition map entry", () => {
    for (const s of TASK_STATES) {
      expect(Array.isArray(ALLOWED_TRANSITIONS[s])).toBe(true);
    }
  });
});
