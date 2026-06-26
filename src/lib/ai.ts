import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { GenerateAITextParams } from "../interface";
import config from "../config";
import { analyzerSystemPrompt } from "../app/modules/analyzer/analyzer.services";

const apiKeys = config.geminiApiKeys;

if (apiKeys.length === 0) {
  throw new Error("No Gemini API keys configured");
}

let currentIndex = 0;

const getNextApiKey = (): string => {
  const apiKey = apiKeys[currentIndex];

  currentIndex = (currentIndex + 1) % apiKeys.length;

  if (!apiKey) {
    throw new Error("No Gemini API key available");
  }

  return apiKey;
};

export const generateAIText = async ({
  system,
  prompt,
}: GenerateAITextParams): Promise<string> => {
  let lastError: unknown;

  for (let i = 0; i < apiKeys.length; i++) {
    try {
      const googleAI = createGoogleGenerativeAI({
        apiKey: getNextApiKey(),
      });

      const { text } = await generateText({
        model: googleAI("gemini-2.5-flash"),
        system,
        prompt,
      });

      return text;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

export type GenerateAIBatchParams = {
  apiKey: string;
  inputs: Record<string, unknown>[];
};

export const generateAIBatch = async ({
  apiKey,
  inputs,
}: GenerateAIBatchParams): Promise<unknown[]> => {
  if (inputs.length === 0) return [];

  const googleAI = createGoogleGenerativeAI({ apiKey });

  const { text } = await generateText({
    model: googleAI("gemini-2.5-flash"),
    system: analyzerSystemPrompt,
    prompt: JSON.stringify({ INPUTS: inputs }),
  });

  // Strip accidental markdown fences.
  const cleaned = text.replace(/```json|```/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `AI batch returned non-JSON: ${(err as Error).message}; head=${cleaned.slice(0, 200)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`AI batch returned non-array response`);
  }

  return parsed;
};