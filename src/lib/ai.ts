import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { GenerateAITextParams } from "../interface";
import config from "../config";

const apiKeys = config.geminiApiKeys;

if (apiKeys.length === 0) {
  throw new Error("No Gemini API keys configured");
}

let currentIndex = 0;

const getNextApiKey = (): string => {
  const apiKey = apiKeys[currentIndex];

  console.log(`Using Gemini API key: ${apiKey} and index: ${currentIndex}`);

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
      console.error(`Gemini key failed. Trying next key...`);
    }
  }

  throw lastError;
};