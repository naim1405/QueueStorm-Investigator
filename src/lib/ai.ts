import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { GenerateAITextParams } from "../interface";
import config from "../config/index"

const googleAI = createGoogleGenerativeAI({
  apiKey: config['GEMINI_API_KEY']!,
});

export const generateAIText = async ({
  system,
  prompt,
}: GenerateAITextParams): Promise<string> => {
  const { text } = await generateText({
    model: googleAI("gemini-2.5-flash"),
    system,
    prompt,
  });

  return text;
};
