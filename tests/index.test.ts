import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConfigStore } from "../src/config.js";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPiCommitExtension } from "../src/index.js";

const smallModel = {
  provider: "test",
  id: "small/model",
  api: "openai-completions",
} as Model<Api>;

function assistantResponse(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  } as any;
}

function gitResult(stdout = "", code = 0): ExecResult {
  return { stdout, stderr: code ? "error" : "", code, killed: false };
}

function createHarness(configured = true) {
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const gitCalls: string[][] = [];
  const setModel = vi.fn();
  const save = vi.fn(async () => undefined);
  const configStore: ConfigStore = {
    load: vi.fn(async () => configured ? { provider: smallModel.provider, id: smallModel.id } : undefined),
    save,
  };

  const exec = vi.fn(async (command: string, args: string[]) => {
    expect(command).toBe("git");
    gitCalls.push(args);
    const subcommand = args[1];
    if (subcommand === "rev-parse") return gitResult("/repo\n");
    if (subcommand === "status") {
      if (args.includes(":(top,literal)folder1")) return gitResult(" M folder1/a.ts\0");
      if (args.includes(":(top,literal)folder2")) return gitResult(" M folder2/b.ts\0");
      return gitResult(" M src/a.ts\0");
    }
    if (subcommand === "diff") {
      if (args.includes("--stat")) return gitResult(" 1 file changed, 1 insertion(+)\n");
      return gitResult("diff --git a/file b/file\n+change\n");
    }
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  });

  const pi = {
    exec,
    setModel,
    registerFlag: vi.fn(),
    registerCommand: vi.fn((name: string, options: any) => commands.set(name, options)),
    on: vi.fn((name: string, handler: any) => events.set(name, handler)),
    getFlag: vi.fn(() => undefined),
  } as unknown as ExtensionAPI;

  const complete = vi.fn(async (_model: unknown, context: any) => {
    const prompt = context.messages[0].content[0].text as string;
    if (prompt.includes("/folder1")) return assistantResponse("feat(folder1): add first change");
    if (prompt.includes("/folder2")) return assistantResponse("fix(folder2): correct second change");
    return assistantResponse("feat(repo): add repository change");
  });

  const editor = vi.fn(async (_title: string, content: string) => content);
  const select = vi.fn(async () => "test/small/model");
  const notify = vi.fn();
  const setStatus = vi.fn();
  const modelRegistry = {
    refresh: vi.fn(async () => undefined),
    getAvailable: vi.fn(() => [smallModel]),
    getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "test-key" })),
  };
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    mode: "tui",
    modelRegistry,
    waitForIdle: vi.fn(async () => undefined),
    ui: { editor, select, notify, setStatus },
  } as any;

  createPiCommitExtension({ complete: complete as any, configStore })(pi);

  return { commands, events, gitCalls, setModel, save, complete, editor, select, notify, ctx };
}

describe("pi-commit commands", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("generates one general suggestion without changing pi's active model", async () => {
    const harness = createHarness();
    await harness.events.get("session_start")({}, harness.ctx);
    await harness.commands.get("commit").handler("", harness.ctx);

    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.editor).toHaveBeenCalledTimes(1);
    expect(harness.editor.mock.calls[0][1]).toBe("feat(repo): add repository change");
    expect(harness.notify).toHaveBeenCalledWith(
      "Generated with test/small/model. No files were staged and no commit was created.",
      "info",
    );
    expect(harness.setModel).not.toHaveBeenCalled();
  });

  it("generates a separate message for each requested folder", async () => {
    const harness = createHarness();
    await harness.events.get("session_start")({}, harness.ctx);
    await harness.commands.get("commit").handler("/folder1 /folder2", harness.ctx);

    expect(harness.complete).toHaveBeenCalledTimes(2);
    const output = harness.editor.mock.calls[0][1];
    expect(output).toContain("/folder1\nfeat(folder1): add first change");
    expect(output).toContain("/folder2\nfix(folder2): correct second change");
    expect(output.indexOf("/folder1")).toBeLessThan(output.indexOf("/folder2"));

    for (const args of harness.gitCalls) {
      expect(["rev-parse", "status", "diff"]).toContain(args[1]);
      expect(args).not.toContain("commit");
      expect(args).not.toContain("add");
    }
  });

  it("selects and persists a dedicated model without calling pi.setModel", async () => {
    const harness = createHarness(false);
    await harness.events.get("session_start")({}, harness.ctx);
    await harness.commands.get("commit-model").handler("", harness.ctx);

    expect(harness.select).toHaveBeenCalledWith(
      "Select commit-message model (current: none)",
      ["test/small/model"],
    );
    expect(harness.save).toHaveBeenCalledWith({ provider: "test", id: "small/model" });
    expect(harness.setModel).not.toHaveBeenCalled();
  });

  it("skips generation when there are no changes", async () => {
    const harness = createHarness();
    harness.ctx.modelRegistry.getAvailable.mockReturnValue([smallModel]);
    const piExec = async (_command: string, args: string[]) => args[1] === "rev-parse" ? gitResult("/repo\n") : gitResult("");
    // Replace the already-bound implementation by building a fresh harness-like extension.
    const commands = new Map<string, any>();
    const events = new Map<string, any>();
    const pi = {
      exec: vi.fn(piExec),
      registerFlag: vi.fn(),
      registerCommand: vi.fn((name: string, options: any) => commands.set(name, options)),
      on: vi.fn((name: string, handler: any) => events.set(name, handler)),
      getFlag: vi.fn(() => undefined),
    } as unknown as ExtensionAPI;
    const complete = vi.fn();
    createPiCommitExtension({
      complete: complete as any,
      configStore: { load: async () => ({ provider: "test", id: "small/model" }), save: async () => undefined },
    })(pi);
    await events.get("session_start")({}, harness.ctx);
    await commands.get("commit").handler("", harness.ctx);

    expect(complete).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith("All changes: no uncommitted changes", "warning");
  });
});
