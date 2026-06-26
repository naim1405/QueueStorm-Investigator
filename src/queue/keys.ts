import config from "../config";
import { getRedisConnection } from "../lib/redis";

export type KeySlot = {
  index: number;
  apiKey: string;
  queueName: string;
};

const keys: KeySlot[] = config.geminiApiKeys.map((apiKey, index) => ({
  index,
  apiKey,
  queueName: `analyze-gemini-key-${index}`,
}));

export const getKeySlots = (): KeySlot[] => keys;

// Round-robin counter — used as a tie-breaker when all call counts are equal.
let rrCounter = 0;

export const pickNextKeySlot = (): KeySlot => {
  if (keys.length === 0) {
    throw new Error("No Gemini API keys configured");
  }
  const slot = keys[rrCounter % keys.length]!;
  rrCounter = (rrCounter + 1) >>> 0;
  return slot;
};

// ---------- Per-key call tracking (sliding window via Redis ZSET) ----------
// Each slot has a sorted set keyed by call timestamp (ms). ZREMRANGEBYSCORE
// prunes entries older than the window; ZCARD gives current count.
// Atomic per-key; cross-key ordering is done after the counts are read.

const callZsetKey = (slot: KeySlot): string => `analyzer:key:${slot.index}:calls`;
const deadKeyMarker = (slot: KeySlot): string => `analyzer:key:${slot.index}:dead`;

/** Record one LLM call attempt against this key (success or fail). */
export const recordKeyCall = async (slot: KeySlot): Promise<void> => {
  const redis = getRedisConnection();
  const now = Date.now();
  const key = callZsetKey(slot);
  const windowStart = now - config.queue.callWindowMs;
  // Use a unique member to avoid ZADD dedup collisions: `${now}-${rand}`.
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  // Pipeline: prune old, add new, refresh TTL.
  await redis
    .multi()
    .zremrangebyscore(key, "-inf", windowStart)
    .zadd(key, now, member)
    .pexpire(key, config.queue.callWindowMs + 5_000)
    .exec();
};

/** How many calls this key has made in the last `callWindowMs` ms. */
export const getKeyCallCount = async (slot: KeySlot): Promise<number> => {
  const redis = getRedisConnection();
  const now = Date.now();
  const windowStart = now - config.queue.callWindowMs;
  // Prune first so the count is accurate.
  await redis.zremrangebyscore(callZsetKey(slot), "-inf", windowStart);
  return redis.zcard(callZsetKey(slot));
};

/** Mark a key as dead (denied/quota-permanently-failed) for `deadKeyCooldownMs`. */
export const markKeyDead = async (slot: KeySlot): Promise<void> => {
  const redis = getRedisConnection();
  await redis.set(
    deadKeyMarker(slot),
    Date.now().toString(),
    "PX",
    config.queue.deadKeyCooldownMs,
  );
};

/** True if the key is currently marked dead. */
export const isKeyDead = async (slot: KeySlot): Promise<boolean> => {
  const redis = getRedisConnection();
  const v = await redis.get(deadKeyMarker(slot));
  return v !== null;
};

/**
 * Pick the best key for the next request.
 *
 * Strategy:
 *   1. Skip keys marked dead (denied access, in cooldown).
 *   2. Skip keys already at the per-minute limit.
 *   3. Among the rest, pick the key with the fewest calls in the last
 *      `callWindowMs` ms. Tiebreak with a round-robin counter so we
 *      don't always pick index 0 when all are zero.
 *
 * Batching still happens naturally: rapid-fire requests within the
 * buffer window all see the same low-call-count slot, so they queue
 * onto the same key and the worker batches them into one LLM call.
 */
export const pickBestKeySlot = async (): Promise<KeySlot> => {
  if (keys.length === 0) {
    throw new Error("No Gemini API keys configured");
  }
  const limit = config.queue.callsPerMinutePerKey;
  const candidates: Array<{ slot: KeySlot; count: number }> = [];
  for (const slot of keys) {
    if (await isKeyDead(slot)) continue;
    const count = await getKeyCallCount(slot);
    if (count >= limit) continue;
    candidates.push({ slot, count });
  }
  if (candidates.length === 0) {
    throw new Error(
      "All Gemini API keys are exhausted or marked dead. Retry shortly.",
    );
  }
  // Pick lowest call count, tiebreak with rrCounter.
  candidates.sort(
    (a: { slot: KeySlot; count: number }, b: { slot: KeySlot; count: number }) =>
      a.count - b.count,
  );
  const minCount = candidates[0]!.count;
  const tied = candidates.filter(
    (c: { slot: KeySlot; count: number }) => c.count === minCount,
  );
  const slot = tied[rrCounter % tied.length]!.slot;
  rrCounter = (rrCounter + 1) >>> 0;
  return slot;
};