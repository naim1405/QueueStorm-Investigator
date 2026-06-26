import dotenv from "dotenv";
import path from "path";

const envPath =
  process.env['NODE_ENV'] === "production"
    ? path.join(process.cwd(), ".env.prod")
    : path.join(process.cwd(), ".env");

dotenv.config({ path: envPath });

const geminiApiKeys = Object.entries(process.env)
  .filter(([key]) => key.startsWith("GEMINI_API_KEY"))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, value]) => value!)
  .filter(Boolean);

export default {
  env: process.env['NODE_ENV'],
  port: process.env['PORT'],
  geminiApiKeys,
};