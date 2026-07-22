import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeRequestedPaths, parseCommandArguments } from "./args.js";
import { createFileConfigStore, type ConfigStore } from "./config.js";
import { ReadOnlyGit } from "./git.js";
import {
  findModelByKey,
  generateCommitSuggestion,
  modelKey,
  toModelRef,
  type CompleteFunction,
} from "./model.js";
import type { CommitSuggestion, ModelRef } from "./types.js";

interface ExtensionDependencies {
  complete?: CompleteFunction;
  configStore?: ConfigStore;
}

function report(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else (type === "error" ? console.error : console.log)(message);
}

function formatSuggestions(suggestions: CommitSuggestion[]): string {
  return suggestions
    .map((suggestion) => (suggestions.length === 1 && suggestion.label === "All changes"
      ? suggestion.message
      : `${suggestion.label}\n${suggestion.message}`))
    .join("\n\n");
}

export function createPiCommitExtension(dependencies: ExtensionDependencies = {}) {
  return function piCommitExtension(pi: ExtensionAPI): void {
    const configStore = dependencies.configStore ?? createFileConfigStore(join(getAgentDir(), "pi-commit.json"));
    const git = new ReadOnlyGit(pi.exec.bind(pi));
    const completeFn = dependencies.complete;
    let selectedModel: ModelRef | undefined;
    let selectedFromFlag = false;
    let availableModelKeys: string[] = [];

    const updateModelStatus = (ctx: ExtensionContext): void => {
      ctx.ui.setStatus("pi-commit-model", selectedModel ? `commit:${selectedModel.id}` : undefined);
    };

    const refreshAvailableModels = async (ctx: ExtensionContext): Promise<Model<Api>[]> => {
      await ctx.modelRegistry.refresh();
      const models = ctx.modelRegistry.getAvailable().sort((left, right) => modelKey(left).localeCompare(modelKey(right)));
      availableModelKeys = models.map(modelKey);
      return models;
    };

    const selectModel = async (
      argument: string,
      ctx: ExtensionContext,
      persist: boolean,
    ): Promise<Model<Api> | undefined> => {
      const models = await refreshAvailableModels(ctx);
      if (models.length === 0) throw new Error("No authenticated models are available. Configure one with /login or models.json.");

      let model: Model<Api> | undefined;
      const requested = argument.trim();
      if (requested) {
        model = findModelByKey(models, requested);
        if (!model) throw new Error(`Commit model is unavailable or unauthenticated: ${requested}`);
      } else {
        if (!ctx.hasUI) throw new Error("Set a commit model with /commit-model provider/model-id or --commit-model.");
        const active = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "none";
        const choice = await ctx.ui.select(`Select commit-message model (current: ${active})`, availableModelKeys);
        if (!choice) return undefined;
        model = findModelByKey(models, choice);
      }

      if (!model) return undefined;
      selectedModel = toModelRef(model);
      if (persist && !selectedFromFlag) await configStore.save(selectedModel);
      updateModelStatus(ctx);
      return model;
    };

    const resolveCommitModel = async (ctx: ExtensionCommandContext): Promise<Model<Api> | undefined> => {
      const models = await refreshAvailableModels(ctx);
      if (selectedModel) {
        const configured = findModelByKey(models, `${selectedModel.provider}/${selectedModel.id}`);
        if (configured) return configured;
        report(ctx, `Configured commit model is unavailable: ${selectedModel.provider}/${selectedModel.id}`, "warning");
      }
      return selectModel("", ctx, true);
    };

    pi.registerFlag("commit-model", {
      description: "Model used only for Conventional Commit message generation (provider/model-id)",
      type: "string",
    });

    pi.registerCommand("commit-model", {
      description: "Select the model used for commit-message suggestions",
      getArgumentCompletions: (prefix) => {
        const matches = availableModelKeys.filter((key) => key.startsWith(prefix));
        return matches.length ? matches.map((key) => ({ value: key, label: key })) : null;
      },
      handler: async (args, ctx) => {
        try {
          const model = await selectModel(args, ctx, true);
          if (model) report(ctx, `Commit-message model: ${modelKey(model)}`, "info");
        } catch (error) {
          report(ctx, error instanceof Error ? error.message : String(error), "error");
        }
      },
    });

    pi.registerCommand("commit", {
      description: "Suggest Conventional Commit messages without staging or committing anything",
      handler: async (args, ctx) => {
        ctx.ui.setStatus("pi-commit", "inspecting changes…");
        try {
          await ctx.waitForIdle();
          const repoRoot = await git.findRepositoryRoot(ctx.cwd);
          const parsedArguments = parseCommandArguments(args);
          const requestedPaths = normalizeRequestedPaths(parsedArguments, repoRoot);
          const groupPaths: Array<string | undefined> = requestedPaths.length ? requestedPaths : [undefined];
          const groups = [];

          for (const path of groupPaths) {
            const group = await git.collectGroup(repoRoot, path || undefined);
            if (group.files.length === 0) {
              report(ctx, `${group.label}: no uncommitted changes`, "warning");
              continue;
            }
            groups.push(group);
          }

          if (groups.length === 0) return;

          const model = await resolveCommitModel(ctx);
          if (!model) {
            report(ctx, "Commit-message generation cancelled", "info");
            return;
          }

          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok) throw new Error(auth.error);

          const suggestions: CommitSuggestion[] = [];
          for (const group of groups) {
            ctx.ui.setStatus("pi-commit", `generating ${group.label}…`);
            const message = await generateCommitSuggestion(model, auth, group, completeFn);
            suggestions.push({ label: group.label, message });
          }

          const output = formatSuggestions(suggestions);
          const safetyNotice = `Generated with ${modelKey(model)}. No files were staged and no commit was created.`;
          if (ctx.hasUI) {
            await ctx.ui.editor("Commit suggestions only — closing this does not commit", output);
            report(ctx, safetyNotice, "info");
          } else {
            console.log(output);
            console.error(safetyNotice);
          }
        } catch (error) {
          report(ctx, error instanceof Error ? error.message : String(error), "error");
        } finally {
          ctx.ui.setStatus("pi-commit", undefined);
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      try {
        const flag = pi.getFlag("commit-model");
        if (typeof flag === "string" && flag.trim()) {
          const slash = flag.indexOf("/");
          if (slash <= 0 || slash === flag.length - 1) throw new Error("--commit-model must be provider/model-id");
          selectedModel = { provider: flag.slice(0, slash), id: flag.slice(slash + 1) };
          selectedFromFlag = true;
        } else {
          selectedModel = await configStore.load();
        }
        availableModelKeys = ctx.modelRegistry.getAvailable().map(modelKey).sort();
        updateModelStatus(ctx);
      } catch (error) {
        report(ctx, `Unable to load pi-commit configuration: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });
  };
}

export default createPiCommitExtension();
