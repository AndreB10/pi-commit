import type { Api, Model } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  CommitModelSelector,
  fuzzyFilterModelKeys,
  fuzzyFilterModels,
  MODEL_SELECTOR_VISIBLE_ROWS,
} from "../src/model-selector.js";

function createModel(provider: string, id: string, name = id): Model<Api> {
  return { provider, id, name, api: "openai-completions" } as Model<Api>;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function createSelector(models: Model<Api>[], currentModelKey?: string) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const requestRender = vi.fn();
  const selector = new CommitModelSelector(
    models,
    currentModelKey,
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    onSelect,
    onCancel,
    requestRender,
  );
  return { selector, onSelect, onCancel, requestRender };
}

describe("commit model selector", () => {
  it("shows an eight-row viewport with the current model initially selected", () => {
    const models = Array.from({ length: 20 }, (_, index) =>
      createModel("test", `model-${String(index).padStart(2, "0")}`));
    const { selector } = createSelector(models, "test/model-15");

    expect(MODEL_SELECTOR_VISIBLE_ROWS).toBe(8);
    expect(selector.getSelectedModelKey()).toBe("test/model-15");

    const lines = selector.render(100);
    expect(lines.filter((line) => line.includes("test/model-")).length).toBe(8);
    expect(lines.some((line) => line.includes("→ test/model-15"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
  });

  it("fuzzy-filters as the user types and selects the best match", () => {
    const models = [
      createModel("anthropic", "claude-3-5-sonnet"),
      createModel("google", "gemini-2.5-flash", "Gemini 2.5 Flash"),
      createModel("openai", "gpt-4o"),
    ];
    const { selector, onSelect, requestRender } = createSelector(models);

    for (const character of "gm25f") selector.handleInput(character);

    expect(selector.getSearchQuery()).toBe("gm25f");
    expect(selector.getMatchCount()).toBe(1);
    expect(selector.getSelectedModelKey()).toBe("google/gemini-2.5-flash");
    expect(requestRender).toHaveBeenCalledTimes(5);

    selector.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("google/gemini-2.5-flash");
  });

  it("searches model display names as well as provider/model IDs", () => {
    const flash = createModel("vertex", "models/flash-latest", "Gemini Fast Preview");
    const pro = createModel("vertex", "models/pro-latest", "Gemini Pro");

    expect(fuzzyFilterModels([pro, flash], "gfp")).toEqual([flash]);
    expect(fuzzyFilterModelKeys(["openai/gpt-4o", "google/gemini-2.5-flash"], "gm25f"))
      .toEqual(["google/gemini-2.5-flash"]);
  });
});
