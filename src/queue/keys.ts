import config from "../config";

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

// Round-robin counter — used as a tie-breaker when all queue depths are equal.
let rrCounter = 0;

export const pickNextKeySlot = (): KeySlot => {
  if (keys.length === 0) {
    throw new Error("No Gemini API keys configured");
  }
  const slot = keys[rrCounter % keys.length]!;
  rrCounter = (rrCounter + 1) >>> 0;
  return slot;
};

/**
 * Pick the slot whose queue currently has the most pending items.
 * This maximizes batching (more items per LLM call) at the cost of
 * uneven key utilization — desirable when the bottleneck is per-key
 * request rate and you want to amortize LLM calls.
 *
 * Caller supplies a `getDepth(slot)` async function (typically `redis.llen`).
 */
export const pickSlotByQueueDepth = async (
  getDepth: (slot: KeySlot) => Promise<number>,
): Promise<KeySlot> => {
  if (keys.length === 0) {
    throw new Error("No Gemini API keys configured");
  }
  let bestSlot = keys[rrCounter % keys.length]!;
  let bestDepth = await getDepth(bestSlot);
  rrCounter = (rrCounter + 1) >>> 0;
  for (const slot of keys) {
    if (slot === bestSlot) continue;
    const d = await getDepth(slot);
    if (d > bestDepth) {
      bestDepth = d;
      bestSlot = slot;
    }
  }
  return bestSlot;
};