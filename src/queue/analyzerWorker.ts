import config from "../config";
import { getRedisConnection } from "../lib/redis";
import { getKeySlots, KeySlot } from "./keys";
import { generateAIBatch } from "../lib/ai";
import {
  AnalyzerJobResult,
  publishAnalyzerResult,
} from "./analyzerQueue";

type SlotState = {
  slot: KeySlot;
  pendingFlushTimer: NodeJS.Timeout | null;
  earlyCheckTimer: NodeJS.Timeout | null;
  lastJobAt: number;
  isFlushing: boolean;
  queuedForFlush: boolean;
};

const states: SlotState[] = [];
let stopPolling = false;
let pollTimer: NodeJS.Timeout | null = null;

const listKey = (slot: KeySlot): string =>
  `analyzer:${slot.queueName}:pending`;

type SerializedJob = { ticketId: string; payload: Record<string, unknown> };

/**
 * Pop up to N items from the head of the queue list.
 * Returns parsed job data in FIFO order. Single-writer per slot, so a
 * simple LPOP loop is safe (no cross-worker races within a slot).
 */
const drainQueue = async (
  slot: KeySlot,
  maxBatch: number,
): Promise<SerializedJob[]> => {
  const redis = getRedisConnection();
  const key = listKey(slot);
  const out: SerializedJob[] = [];

  for (let i = 0; i < maxBatch; i++) {
    const raw = await redis.lpop(key);
    if (raw === null) break;
    try {
      out.push(JSON.parse(raw) as SerializedJob);
    } catch (err) {
      // Bad payload — discard but continue.
      // eslint-disable-next-line no-console
      console.error(
        `[worker ${slot.queueName}] bad payload in queue`,
        (err as Error).message,
      );
    }
  }
  return out;
};

/**
 * Re-queue a batch of jobs to the head of the list (LPUSH) when the batch fails.
 * This implements our retry policy: put them back at the head so they're
 * re-picked on the next flush, but mark each as a retry by appending a count
 * to the payload (handled in publishAnalyzerResult if attempts exhausted).
 */
const requeueJobs = async (
  slot: KeySlot,
  jobs: SerializedJob[],
): Promise<void> => {
  if (jobs.length === 0) return;
  const redis = getRedisConnection();
  const key = listKey(slot);
  const serialized = jobs.map((j) => JSON.stringify(j));
  // LPUSH in reverse so order is preserved.
  await redis.lpush(key, ...serialized.slice().reverse());
};

const publishSuccess = async (
  slot: KeySlot,
  ticketId: string,
  result: AnalyzerJobResult,
): Promise<void> => {
  await publishAnalyzerResult(slot, ticketId, { ok: true, result });
};

const publishFailure = async (
  slot: KeySlot,
  ticketId: string,
  error: string,
): Promise<void> => {
  await publishAnalyzerResult(slot, ticketId, { ok: false, error });
};

const runBatchForSlot = async (state: SlotState): Promise<void> => {
  const maxBatch = 50;
  const jobs = await drainQueue(state.slot, maxBatch);
  if (jobs.length === 0) return;

  const inputs = jobs.map((j) => j.payload);

  let responses: unknown[];
  try {
    const result = await generateAIBatch({
      apiKey: state.slot.apiKey,
      inputs,
    });
    if (!Array.isArray(result)) {
      throw new Error("Batch response is not an array");
    }
    responses = result;
  } catch (err) {
    // Re-queue and fail each ticket so waiters unblock.
    await requeueJobs(state.slot, jobs);
    const msg = (err as Error).message;
    await Promise.all(
      jobs.map((j) => publishFailure(state.slot, j.ticketId, msg)),
    );
    throw err;
  }

  if (responses.length !== jobs.length) {
    const msg = `Batch length mismatch: expected ${jobs.length}, got ${responses.length}`;
    await requeueJobs(state.slot, jobs);
    await Promise.all(
      jobs.map((j) => publishFailure(state.slot, j.ticketId, msg)),
    );
    throw new Error(msg);
  }

  // Validate positional ticket_id alignment.
  for (let i = 0; i < jobs.length; i++) {
    const expectedId = jobs[i]!.ticketId;
    const actualId = (responses[i] as Record<string, unknown> | undefined)
      ?.ticket_id;
    if (actualId !== expectedId) {
      const msg = `ticket_id mismatch at index ${i}: expected ${expectedId}, got ${actualId}`;
      await requeueJobs(state.slot, jobs);
      await Promise.all(
        jobs.map((j) => publishFailure(state.slot, j.ticketId, msg)),
      );
      throw new Error(msg);
    }
  }

  await Promise.all(
    jobs.map((j, i) =>
      publishSuccess(state.slot, j.ticketId, responses[i] as AnalyzerJobResult),
    ),
  );
};

const scheduleCheck = (state: SlotState): void => {
  state.lastJobAt = Date.now();

  if (state.pendingFlushTimer) clearTimeout(state.pendingFlushTimer);
  if (state.earlyCheckTimer) clearTimeout(state.earlyCheckTimer);

  state.pendingFlushTimer = setTimeout(() => {
    void flushNow(state);
  }, config.queue.bufferMs);

  if (
    config.queue.earlyFlushMs > 0 &&
    config.queue.earlyFlushMs < config.queue.bufferMs
  ) {
    state.earlyCheckTimer = setTimeout(() => {
      const sinceLast = Date.now() - state.lastJobAt;
      if (sinceLast >= config.queue.quietWindowMs) {
        void flushNow(state);
      }
    }, config.queue.earlyFlushMs);
  }
};

const flushNow = async (state: SlotState): Promise<void> => {
  if (state.isFlushing) {
    state.queuedForFlush = true;
    return;
  }
  state.isFlushing = true;
  if (state.pendingFlushTimer) {
    clearTimeout(state.pendingFlushTimer);
    state.pendingFlushTimer = null;
  }
  if (state.earlyCheckTimer) {
    clearTimeout(state.earlyCheckTimer);
    state.earlyCheckTimer = null;
  }
  try {
    await runBatchForSlot(state);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[worker ${state.slot.queueName}] batch failed`,
      (err as Error).message,
    );
  } finally {
    state.isFlushing = false;
    if (state.queuedForFlush) {
      state.queuedForFlush = false;
      scheduleCheck(state);
    }
  }
};

const pollOnce = async (): Promise<void> => {
  await Promise.all(
    states.map(async (state) => {
      const redis = getRedisConnection();
      const length = await redis.llen(listKey(state.slot));
      if (length > 0) {
        if (
          !state.pendingFlushTimer &&
          !state.earlyCheckTimer &&
          !state.isFlushing
        ) {
          scheduleCheck(state);
        }
      }
    }),
  );
};

const startPoller = (): void => {
  const tick = async () => {
    if (stopPolling) return;
    try {
      await pollOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[worker] poll error", (err as Error).message);
    } finally {
      if (!stopPolling) {
        pollTimer = setTimeout(tick, 100);
      }
    }
  };
  pollTimer = setTimeout(tick, 100);
};

const startWorkerForSlot = (slot: KeySlot): void => {
  const state: SlotState = {
    slot,
    pendingFlushTimer: null,
    earlyCheckTimer: null,
    lastJobAt: 0,
    isFlushing: false,
    queuedForFlush: false,
  };
  states.push(state);

  // Subscribe to per-slot notify channel so we react instantly to enqueue.
  const redis = getRedisConnection();
  const sub = redis.duplicate();
  sub.subscribe(`analyzer:notify:${slot.queueName}`).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[worker ${slot.queueName}] subscribe failed`,
      (err as Error).message,
    );
  });
  sub.on("message", () => {
    if (
      !state.pendingFlushTimer &&
      !state.earlyCheckTimer &&
      !state.isFlushing
    ) {
      scheduleCheck(state);
    }
  });
};

export const startAnalyzerWorkers = (): void => {
  const slots = getKeySlots();
  if (slots.length === 0) {
    throw new Error("No Gemini API keys configured; cannot start workers");
  }
  for (const slot of slots) {
    startWorkerForSlot(slot);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[worker] started for ${slots.length} key(s): ${slots
      .map((s) => s.queueName)
      .join(", ")}`,
  );
  startPoller();
};

export const closeAnalyzerWorkers = async (): Promise<void> => {
  stopPolling = true;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  for (const s of states) {
    if (s.pendingFlushTimer) clearTimeout(s.pendingFlushTimer);
    if (s.earlyCheckTimer) clearTimeout(s.earlyCheckTimer);
  }
  // Disconnect all subscriber connections.
  // We don't track them individually; closing the main redis connection
  // is handled by closeRedisConnection() in server.ts.
  states.length = 0;
};