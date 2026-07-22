import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { buildCommitPrompt, SYSTEM_PROMPT, validateCommitMessage } from "./prompt.js";
import type { ChangeGroup, ModelRef } from "./types.js";

export type CompleteFunction = typeof complete;

export interface ResolvedModelAuth {
  ok: true;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function findModelByKey(models: Model<Api>[], key: string): Model<Api> | undefined {
  return models.find((model) => modelKey(model) === key);
}

export function toModelRef(model: Pick<Model<Api>, "provider" | "id">): ModelRef {
  return { provider: model.provider, id: model.id };
}

function responseText(response: AssistantMessage): string {
  return response.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

export async function generateCommitSuggestion(
  model: Model<Api>,
  auth: ResolvedModelAuth,
  group: ChangeGroup,
  completeFn: CompleteFunction = complete,
): Promise<string> {
  let invalidResponse: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await completeFn(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: buildCommitPrompt(group, invalidResponse) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        temperature: 0,
        maxTokens: 128,
      },
    );

    if (response.stopReason === "aborted") throw new Error("Commit-message generation was cancelled");
    const text = responseText(response);
    const valid = validateCommitMessage(text);
    if (valid) return valid;
    invalidResponse = text || "(empty response)";
  }

  throw new Error(`Model returned an invalid Conventional Commit message: ${invalidResponse}`);
}
