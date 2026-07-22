import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelRef } from "./types.js";

interface StoredConfig {
  version: 1;
  model?: ModelRef;
}

export interface ConfigStore {
  load(): Promise<ModelRef | undefined>;
  save(model: ModelRef): Promise<void>;
}

export function createFileConfigStore(path: string): ConfigStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredConfig>;
        if (
          parsed.version === 1 &&
          parsed.model &&
          typeof parsed.model.provider === "string" &&
          typeof parsed.model.id === "string"
        ) {
          return parsed.model;
        }
        return undefined;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
        throw error;
      }
    },

    async save(model) {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      const config: StoredConfig = { version: 1, model };
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, path);
    },
  };
}
