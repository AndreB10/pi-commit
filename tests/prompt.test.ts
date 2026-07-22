import { describe, expect, it } from "vitest";
import { buildCommitPrompt, validateCommitMessage } from "../src/prompt.js";
import type { ChangeGroup } from "../src/types.js";

const group: ChangeGroup = {
  label: "/packages/ui",
  path: "packages/ui",
  files: [{ indexStatus: " ", worktreeStatus: "M", path: "packages/ui/button.ts" }],
  context: "## Changed files\n M packages/ui/button.ts",
  truncated: false,
};

describe("commit prompts and validation", () => {
  it("builds a folder-specific prompt with untrusted delimiters", () => {
    const prompt = buildCommitPrompt(group);
    expect(prompt).toContain("repository folder /packages/ui");
    expect(prompt).toContain("Prefer the scope ui");
    expect(prompt).toContain("<git-data>");
  });

  it("accepts strict Conventional Commit subjects", () => {
    expect(validateCommitMessage("feat(ui): add compact navigation controls")).toBe(
      "feat(ui): add compact navigation controls",
    );
    expect(validateCommitMessage("fix(api)!: reject expired sessions")).toBe("fix(api)!: reject expired sessions");
    expect(validateCommitMessage("`docs(readme): explain folder mode`")).toBe("docs(readme): explain folder mode");
    expect(validateCommitMessage("```text\nchore(repo): update dependencies\n```")).toBe(
      "chore(repo): update dependencies",
    );
  });

  it("rejects explanations, missing scopes, unsupported types, and punctuation", () => {
    expect(validateCommitMessage("Here is one:\nfeat(ui): add controls")).toBeUndefined();
    expect(validateCommitMessage("feat: add controls")).toBeUndefined();
    expect(validateCommitMessage("feature(ui): add controls")).toBeUndefined();
    expect(validateCommitMessage("feat(UI): add controls")).toBeUndefined();
    expect(validateCommitMessage("feat(ui): add controls.")).toBeUndefined();
  });

  it("includes an invalid response in the correction prompt", () => {
    expect(buildCommitPrompt(group, "Here are three options")).toContain("<invalid-response>Here are three options</invalid-response>");
  });
});
