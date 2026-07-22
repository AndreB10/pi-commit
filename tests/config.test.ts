import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createFileConfigStore } from "../src/config.js";

describe("model configuration", () => {
  it("persists and restores a model reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-commit-config-"));
    const path = join(directory, "nested", "pi-commit.json");
    const store = createFileConfigStore(path);

    expect(await store.load()).toBeUndefined();
    await store.save({ provider: "google", id: "gemini-flash" });
    expect(await store.load()).toEqual({ provider: "google", id: "gemini-flash" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      model: { provider: "google", id: "gemini-flash" },
    });
  });

  it("ignores invalid JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-commit-config-"));
    const path = join(directory, "pi-commit.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "not json"));
    expect(await createFileConfigStore(path).load()).toBeUndefined();
  });
});
