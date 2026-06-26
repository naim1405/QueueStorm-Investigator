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

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

export default {
  env: process.env['NODE_ENV'],
  port: process.env['PORT'],
  geminiApiKeys,
  redis: {
    host: process.env['REDIS_HOST'] ?? "localhost",
    port: num(process.env['REDIS_PORT'], 6379),
  },
  queue: {
    bufferMs: num(process.env['QUEUE_BUFFER_MS'], 1200),
    earlyFlushMs: num(process.env['QUEUE_EARLY_FLUSH_MS'], 400),
    quietWindowMs: num(process.env['QUEUE_QUIET_WINDOW_MS'], 200),
    maxQueueDepth: num(process.env['QUEUE_MAX_DEPTH'], 200),
    maxRetries: num(process.env['QUEUE_MAX_RETRIES'], 3),
  },
};