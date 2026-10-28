import { describe, it, expect } from "vitest";
import * as path from "node:path";
import os from "node:os";
import { normalizeWorkingDirectory, assertAllowedDirectory } from "../src/config.js";

const tmp = os.tmpdir();

describe("working directory validation", () => {
  it("rejects relative paths", () => {
    expect(() => normalizeWorkingDirectory("relative/path")).toThrow(/absolute/i);
  });

  it("rejects empty", () => {
    expect(() => normalizeWorkingDirectory("")).toThrow();
    expect(() => normalizeWorkingDirectory("   ")).toThrow();
  });

  it("accepts absolute paths", () => {
    const p = normalizeWorkingDirectory(path.join(tmp, "proj"));
    expect(path.isAbsolute(p)).toBe(true);
  });
});

describe("allowed directories", () => {
  const base = path.join(tmp, "uar-projects");

  it("rejects paths outside configured roots", () => {
    const other = path.join(tmp, "uar-projects-other");
    expect(() => assertAllowedDirectory(other, [base])).toThrow(/outside/i);
  });

  it("allows nested paths inside configured roots", () => {
    const inner = path.join(base, "project-a", "src");
    expect(() => assertAllowedDirectory(inner, [base])).not.toThrow();
  });

  it("allows everything when no roots are configured", () => {
    expect(() => assertAllowedDirectory(path.join(tmp, "anything"), [])).not.toThrow();
  });

  it("prevents sibling-directory confusion", () => {
    const sibling = base + "-evil";
    expect(() => assertAllowedDirectory(sibling, [base])).toThrow(/outside/i);
  });
});
