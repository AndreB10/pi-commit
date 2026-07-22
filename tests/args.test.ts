import { describe, expect, it } from "vitest";
import { literalPathspec, normalizeRequestedPaths, parseCommandArguments } from "../src/args.js";

describe("folder arguments", () => {
  it("parses no arguments", () => {
    expect(parseCommandArguments("   ")).toEqual([]);
  });

  it("parses multiple and quoted folders", () => {
    expect(parseCommandArguments('/folder1 "/folder two" \'/folder three\'')).toEqual([
      "/folder1",
      "/folder two",
      "/folder three",
    ]);
  });

  it("handles escaped spaces", () => {
    expect(parseCommandArguments("/folder\\ one /folder2")).toEqual(["/folder one", "/folder2"]);
  });

  it("rejects malformed quoting", () => {
    expect(() => parseCommandArguments("'/folder")).toThrow("unmatched quote");
    expect(() => parseCommandArguments("/folder\\")).toThrow("escape character");
  });

  it("normalizes repository-root paths and removes duplicates", () => {
    expect(normalizeRequestedPaths(["/packages/web", "packages/api", "/packages/web"], "/repo")).toEqual([
      "packages/web",
      "packages/api",
    ]);
  });

  it("rejects traversal, absolute drive paths, and overlaps", () => {
    expect(() => normalizeRequestedPaths(["/../outside"], "/repo")).toThrow("escapes the repository");
    expect(() => normalizeRequestedPaths(["C:\\outside"], "/repo")).toThrow("repository-relative");
    expect(() => normalizeRequestedPaths(["/packages", "/packages/web"], "/repo")).toThrow("overlap");
  });

  it("uses literal top-level Git pathspecs", () => {
    expect(literalPathspec("packages/[web]")).toBe(":(top,literal)packages/[web]");
  });
});
