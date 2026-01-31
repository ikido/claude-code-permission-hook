import OpenAI from "openai";
import { loadConfig, getApiKey } from "./config.js";
import {
  LLMResponse,
  LLMResponseSchema,
  DEFAULT_SYSTEM_PROMPT,
  CURRENT_SYSTEM_PROMPT_VERSION,
} from "./types.js";

export async function queryLLM(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectRoot?: string,
): Promise<LLMResponse> {
  const config = loadConfig();
  const apiKey = getApiKey();

  if (!apiKey) {
    // No API key, conservative deny
    return {
      decision: "deny",
      reason: "No LLM API key configured - cannot make intelligent decision",
    };
  }

  const client = new OpenAI({
    apiKey,
    baseURL: config.llm.baseUrl,
  });

  // Use the saved prompt if it's up-to-date (or user opted out of auto-updates).
  // Otherwise use the latest built-in prompt so users get improvements automatically.
  let systemPrompt = config.llm.systemPrompt;
  if (
    config.llm.systemPromptVersion < CURRENT_SYSTEM_PROMPT_VERSION &&
    config.autoUpdateSystemPrompt
  ) {
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }

  const userPrompt = `Evaluate this tool request for auto-approval:

Tool: ${toolName}
Project Root: ${projectRoot || "unknown"}
Input: ${JSON.stringify(toolInput, null, 2)}

Should this be automatically approved or denied?`;

  try {
    // Models that support reasoning control via OpenRouter
    const REASONING_MODELS = new Set([
      "openai/gpt-5.2",
    ]);

    const params: Record<string, unknown> = {
      model: config.llm.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
    };

    if (
      config.llm.provider === "openrouter" &&
      REASONING_MODELS.has(config.llm.model)
    ) {
      params.reasoning = { effort: "none" };
    }

    const response = await client.chat.completions.create(
      params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return {
        decision: "deny",
        reason: "Empty LLM response",
      };
    }

    // Parse and validate response
    const parsed = JSON.parse(content);
    return LLMResponseSchema.parse(parsed);
  } catch (error) {
    // On any error, conservative deny
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      decision: "deny",
      reason: `LLM error: ${message}`,
    };
  }
}
