import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { generateCommitSuggestion } from "../src/model.js";
import type { ChangeGroup } from "../src/types.js";

const model = {
  provider: "test",
  id: "small-model",
  api: "openai-completions",
} as Model<Api>;
const group: ChangeGroup = {
  label: "All changes",
  files: [{ indexStatus: " ", worktreeStatus: "M", path: "src/a.ts" }],
  context: "## Changed files\n M src/a.ts",
  truncated: false,
};

function response(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  } as any;
}

describe("model generation", () => {
  it("uses a bounded direct completion request", async () => {
    const complete = vi.fn(async (_model: unknown, _context: any, _options: any) =>
      response("feat(core): add commit suggestions"),
    );
    await expect(generateCommitSuggestion(model, { ok: true, apiKey: "test" }, group, complete as any)).resolves.toBe(
      "feat(core): add commit suggestions",
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][2]).toMatchObject({ temperature: 0, maxTokens: 128, apiKey: "test" });
    expect(complete.mock.calls[0][1].systemPrompt).toContain("Return exactly one line");
  });

  it("retries malformed output once", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(response("Here are some options"))
      .mockResolvedValueOnce(response("fix(core): handle invalid model output"));
    await expect(generateCommitSuggestion(model, { ok: true }, group, complete as any)).resolves.toBe(
      "fix(core): handle invalid model output",
    );
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][1].messages[0].content[0].text).toContain("Here are some options");
  });

  it("fails after two invalid responses", async () => {
    const complete = vi.fn(async () => response("invalid"));
    await expect(generateCommitSuggestion(model, { ok: true }, group, complete as any)).rejects.toThrow(
      "invalid Conventional Commit",
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
