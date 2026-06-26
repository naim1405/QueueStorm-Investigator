import { getRedisConnection } from "../lib/redis";
import config from "../config";
import { getKeySlots, KeySlot } from "./keys";

export type AnalyzerJobData = {
  ticketId: string;
  payload: Record<string, unknown>;
};

export type AnalyzerJobResult = Record<string, unknown>;

const queueListKey = (slot: KeySlot): string =>
  `analyzer:${slot.queueName}:pending`;

const resultChannel = (ticketId: string): string =>
  `analyzer:result:${ticketId}`;

const resultStashKey = (_slot: KeySlot): string => "analyzer:results";

/**
 * Enqueue a ticket for batched analysis on the slot's queue.
 * Uses a Redis list as the pending queue, with ticketId+payload as JSON.
 * Throws if the queue is at backpressure depth.
 * Publishes a notification so the worker reacts instantly.
 */
export const enqueueAnalyzerJob = async (
  slot: KeySlot,
  data: AnalyzerJobData,
): Promise<void> => {
  const redis = getRedisConnection();
  const listKey = queueListKey(slot);
  const length = await redis.llen(listKey);
  if (length >= config.queue.maxQueueDepth) {
    const err = new Error(
      `Queue ${slot.queueName} at capacity (${length}/${config.queue.maxQueueDepth})`,
    );
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }
  await redis.rpush(listKey, JSON.stringify(data));
  // Notify subscribers (workers) that a job landed.
  await redis.publish(`analyzer:notify:${slot.queueName}`, "1");
};

export const getQueueForKey = (_slot: KeySlot): null => null; // legacy

export const getQueueDepth = async (slot: KeySlot): Promise<number> => {
  const redis = getRedisConnection();
  return redis.llen(queueListKey(slot));
};

/**
 * Wait for a specific ticket's result via Redis pub/sub.
 * Returns the analyzer result, or throws on failure / timeout.
 */
export const waitForAnalyzerJob = async (
  slot: KeySlot,
  ticketId: string,
  timeoutMs: number,
): Promise<AnalyzerJobResult> => {
  const redis = getRedisConnection();
  const stash = resultStashKey(slot);
  const channel = resultChannel(ticketId);

  // Fast path: result already stashed.
  const existing = await redis.hget(stash, ticketId);
  if (existing) {
    const parsed = JSON.parse(existing) as
      | { ok: true; result: AnalyzerJobResult }
      | { ok: false; error: string };
    await redis.hdel(stash, ticketId);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.result;
  }

  // Subscribe and wait.
  const sub = redis.duplicate();
  const result = await new Promise<AnalyzerJobResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Job ${ticketId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (chan: string, msg: string) => {
      if (chan !== channel) return;
      let parsed:
        | { ok: true; result: AnalyzerJobResult }
        | { ok: false; error: string };
      try {
        parsed = JSON.parse(msg);
      } catch {
        reject(new Error("Malformed result message"));
        cleanup();
        return;
      }
      cleanup();
      if (!parsed.ok) reject(new Error(parsed.error));
      else resolve(parsed.result);
    };

    const cleanup = () => {
      clearTimeout(timer);
      sub.off("message", onMessage);
      sub.unsubscribe(channel).catch(() => {});
      sub.quit().catch(() => {});
    };

    sub.subscribe(channel).catch((err) => {
      cleanup();
      reject(err);
    });
    sub.on("message", onMessage);
  });

  return result;
};

/**
 * Publish a job's result so the waiting HTTP request resolves.
 * Worker-side helper.
 */
export const publishAnalyzerResult = async (
  slot: KeySlot,
  ticketId: string,
  payload: { ok: true; result: AnalyzerJobResult } | { ok: false; error: string },
): Promise<void> => {
  const redis = getRedisConnection();
  const stash = resultStashKey(slot);
  const channel = resultChannel(ticketId);
  const msg = JSON.stringify(payload);
  // Stash first so late subscribers can pick it up after a race.
  await redis.hset(stash, ticketId, msg);
  await redis.publish(channel, msg);
  // Best-effort cleanup of stash entries older than 60s.
  // (Not strictly necessary; just keeps the hash small.)
};

export const closeAllQueues = async (): Promise<void> => {
  // Nothing to close — Redis connection is shared.
};

export { getKeySlots };
