# QueueStorm Investigator

A Fintech Support Copilot and Ticket Investigation Engine built with **Node.js + Express + TypeScript** and powered by **Google Gemini (via the Vercel AI SDK)**.

The service takes a customer complaint, together with the customer's recent transaction history, and returns a structured JSON triage decision: which transaction is involved, what the evidence says, how severe the case is, which department should own it, a short agent-facing summary, and a safe customer-facing reply.

> The service is an **internal support copilot** — it never approves refunds, reversals, chargebacks, or settlements.

---

## ✨ Features

- 🔍 **Single endpoint** (`POST /analyze-ticket`) for ticket analysis.
- 🤖 **LLM-driven triage** with strict JSON-schema output.
- 📦 **Batched LLM calls** — multiple tickets queued within the same buffer window are merged into a **single** Gemini request. The model returns an array; we route each response back to its origin ticket.
- 🔀 **Per-key rate-limited AI gateway** — every `GEMINI_API_KEY*` has its own Redis-backed sliding-window call counter. Routing picks the key with the fewest calls in the last 60s and skips keys already at the 5-req/min limit.
- ⚰️ **Dead-key auto-cooldown** — when a key returns "denied access" / "invalid api key", it is marked dead in Redis for 10 minutes and routing skips it.
- 📈 **Horizontally scalable AI throughput** — drop in more `GEMINI_API_KEY` env vars to scale; no code changes required.
- 🛡️ **Hard-coded safety rails** — refuses to promise refunds, never solicits OTP/PIN/CVV, escalates fraud and phishing automatically.
- 🧱 **Production-ready plumbing** — Helmet, CORS allow-list, rate limiting, request logging (Winston), Prometheus metrics, `/health`, graceful shutdown.
- 🐳 **Docker** for the Redis broker (the app runs locally via `npm run dev`).

---

## 🧰 Tech Stack

| Layer          | Technology                                                                            |
| -------------- | ------------------------------------------------------------------------------------- |
| Runtime        | Node.js 22 (`node:22-bookworm-slim`)                                                  |
| Language       | TypeScript 5 (strict mode, ESNext modules)                                            |
| HTTP Framework | Express 5                                                                             |
| AI SDK         | [`ai`](https://www.npmjs.com/package/ai) (Vercel AI SDK)                              |
| LLM Provider   | [`@ai-sdk/google`](https://www.npmjs.com/package/@ai-sdk/google) → `gemini-2.5-flash` |
| Validation     | Zod 4 (types) + lightweight manual validators                                         |
| Queue / Broker | Redis 7 + `ioredis` (raw lists + pub/sub, no BullMQ in the data path)                 |
| Security       | Helmet, `express-rate-limit`, CORS allow-list                                         |
| Logging        | Winston (+ optional `winston-loki` for Grafana Loki)                                  |
| Metrics        | `prom-client` (`/metrics` endpoint)                                                   |
| Compression    | `compression`                                                                         |
| Container      | Docker + docker-compose (Redis only)                                                  |
| Lint / Format  | ESLint 10 + Prettier                                                                  |

> ℹ️ `bullmq` is still in `package.json` for parity with earlier iterations but is **not** used at runtime — the queue is built directly on Redis primitives.

---

## 🧠 AI Approach — Per-Key Rate-Limited Batched Gateway

The service treats **every configured Gemini API key as an independent rate-limited "lane"**. Each lane owns a Redis-backed queue and a worker that batches buffered tickets into a single LLM call. The router picks the lane whose key has the most available capacity.

```
                    ┌────────────────────────────────────────────────┐
                    │            HTTP POST /analyze-ticket           │
                    └──────────────────────┬─────────────────────────┘
                                           │ pickBestKeySlot()
                                           ▼
                  ┌────────────────────────────────────────────┐
                  │  Redis sliding-window call counter per key │
                  │  (ZSET, ZCARD over last 60s)                │
                  │  Skip dead keys & keys at the 5/min limit   │
                  └──────────────────────┬─────────────────────┘
                                         │  picks lowest-count key
                ┌────────────┬───────────┴──────────┬────────────┐
                ▼            ▼                      ▼            ▼
         ┌──────────┐ ┌──────────┐           ┌──────────┐ ┌──────────┐
         │ key 0    │ │ key 1    │  ...      │ key 3    │ │ key 4    │
         │ LIST     │ │ LIST     │           │ LIST     │ │ LIST     │
         │ RPUSH    │ │ RPUSH    │           │ RPUSH    │ │ RPUSH    │
         └────┬─────┘ └────┬─────┘           └────┬─────┘ └────┬─────┘
              │            │                      │            │
              └────────────┴──────────┬───────────┴────────────┘
                                       │
                                       ▼
                        ┌──────────────────────────────┐
                        │  Per-lane worker: adaptive   │
                        │  flush (1200ms buffer,       │
                        │  400ms early-flush if quiet) │
                        └──────────────┬───────────────┘
                                       │  drainQueue() → LPOP loop
                                       ▼
                        ┌──────────────────────────────┐
                        │  generateAIBatch({ apiKey,   │
                        │   inputs: [payload...] })    │
                        │  → single Gemini request     │
                        └──────────────┬───────────────┘
                                       │  JSON array response
                                       ▼
                        ┌──────────────────────────────┐
                        │  positional split by         │
                        │  ticket_id → publish via     │
                        │  Redis pub/sub back to HTTP  │
                        └──────────────────────────────┘
```

### Why batching matters

`gemini-2.5-flash` is rate-limited at **5 requests/minute per key** on the free tier. If every ticket triggered a separate LLM call, the cap would cap throughput at `5 × N_keys` tickets/min regardless of ticket volume. By buffering incoming tickets for a short window (default `1200ms`, early-flush at `400ms` if no new arrival for `200ms`) and merging them into a single call that takes an array of inputs, the system can absorb bursts without burning quota.

The tradeoff is **latency vs. quota**: a single ticket waits up to the buffer window before its call goes out. `earlyFlushMs` keeps the tail latency low — if the lane goes quiet for `quietWindowMs`, the batch fires early.

### How the pieces fit

1. **Boot** — `src/config/index.ts` scans `process.env` for `GEMINI_API_KEY*`, lexicographically ordered. `src/queue/keys.ts` builds a `KeySlot[]` (one per key).
2. **Per lane** — `startAnalyzerWorkers()` starts one worker per slot. Each worker subscribes to its lane's `analyzer:notify:<queueName>` channel for instant reaction, plus a 100ms poller as a safety net.
3. **HTTP request arrives** → `analyzer.services.ts` calls `pickBestKeySlot()`:
   - For each key, check `isKeyDead()` (Redis `GET analyzer:key:N:dead`) and `getKeyCallCount()` (Redis `ZCARD analyzer:key:N:calls` over the last `callWindowMs`).
   - Skip dead keys. Skip keys whose call count has reached `callsPerMinutePerKey`.
   - Among the rest, pick the key with the **lowest** call count (round-robin tiebreak).
4. **Enqueue** — `enqueueAnalyzerJob()` does `RPUSH analyzer:<queueName>:pending` then `PUBLISH analyzer:notify:<queueName>`. Throws `503` if the lane is at `maxQueueDepth` (backpressure).
5. **Buffer & flush** — the lane's worker reacts to either the pub/sub notification or the 100ms poller. It sets a `pendingFlushTimer` (1200ms) and an `earlyCheckTimer` (400ms). When either fires, it drains up to 50 jobs from the head of the list with `LPOP`.
6. **Single LLM call** — `generateAIBatch()` builds one Gemini request whose prompt carries an `INPUTS: [...]` array. The system prompt's **BATCH MODE (MANDATORY)** block tells the model to return a JSON array of the same length, echoing `ticket_id` positionally so we can split.
7. **Distribute results** — `runBatchForSlot()` validates length and positional `ticket_id`, then `publishAnalyzerResult()` does `HSET analyzer:results <ticketId> ...` + `PUBLISH analyzer:result:<ticketId>`. The waiting HTTP request resolves with its own result.
8. **Record the call** — on every attempt (success or fail) the worker `ZADD`s the timestamp to the key's sliding-window counter so future routing decisions see it.

### Why per-key rate-limit routing (not round-robin and not depth-based)

- **Round-robin** distributes evenly but **defeats batching** — single requests scatter across 5 lanes, no batch ever forms.
- **Depth-based routing** funnels into the deepest queue to maximize batching, but **starves healthy keys** and concentrates load onto a key that's already failing.
- **Per-key rate-limited routing** picks the lowest-loaded healthy key. Rapid bursts within the buffer window still hit the same lane (because call count only rises _after_ the LLM call returns), so batching is preserved. As soon as a key hits the 5/min cap, new requests rotate to the next one. A dead key is skipped entirely for `deadKeyCooldownMs` (10 min).

### Why raw Redis (not BullMQ)

BullMQ's `moveToActive` is a private worker-internal API; calling it from outside the Worker class races with the auto-processor and silently drops jobs. Rather than fight BullMQ's lifecycle, the data path is now **Redis primitives + pub/sub**, which gives us:

- `RPUSH` / `LPOP` — FIFO per lane.
- `ZADD` / `ZCARD` / `ZREMRANGEBYSCORE` — sliding-window call counters with TTL-based eviction.
- `HSET` / `HGET` — result stash so late subscribers don't miss a result that arrived between subscribe and listen.
- `PUBLISH` / `SUBSCRIBE` — instant worker wake-up instead of polling-only.

BullMQ remains a dependency for parity with the early iteration but is not imported anywhere in the runtime path.

---

## 🛡️ Safety Logic

Safety is enforced at three layers: **system prompt**, **response validation**, and **application-level refusal of financial commitments**.

### 1. System-prompt rules (in `analyzer.services.ts`)

The model is told, in plain English, what it is and is **not** allowed to do:

- ❌ Never approve refunds, reversals, recoveries, or settlements.
- ❌ Never guarantee financial outcomes to the customer.
- ❌ Never ask for OTP, PIN, password, CVV, full card number, or security answers.
- ❌ Never return markdown, explanations, or extra fields — only the declared JSON schema.
- ❌ In batch mode, never return a single object — always an **array** of the exact length and ticket_id ordering given.
- ✅ Always analyze `transaction_history` before classifying (complaint alone is never enough).
- ✅ If evidence is unclear, emit `"evidence_verdict": "insufficient_data"` and `"human_review_required": true`.

### 2. Mandatory escalation rules

The model **must** set `human_review_required: true` when any of the following are true:

- `evidence_verdict` is `inconsistent` or `insufficient_data`
- `severity` is `high` or `critical`
- `case_type` is `wrong_transfer`, `duplicate_payment`, `agent_cash_in_issue`, or `merchant_settlement_delay`
- Any fraud / phishing indicators exist (`phishing_or_social_engineering`)

Phishing cases additionally force `severity = critical` and route to `department = fraud_risk`.

### 3. Response validation (server-side, in `analyzer.services.ts`)

Before the AI output is returned to the caller, the service re-validates every required field and throws if the schema is violated:

```ts
if (
  !ticket_id ||
  evidence_verdict === undefined ||
  !case_type ||
  !severity ||
  !department ||
  !agent_summary ||
  !recommended_next_action ||
  !customer_reply ||
  typeof human_review_required !== 'boolean' ||
  confidence === undefined
) {
  throw new Error('Invalid response from AI model');
}
```

Confidence is clamped to `0..1` and `reason_codes` is normalised to an array before responding.

### 4. Output guarantees

- `customer_reply` — professional, acknowledges the concern, mentions the matched transaction if any, explains the case will be reviewed. **Cannot** contain promises of money back.
- `agent_summary` — at most 2 sentences, names the complaint, the transaction ID, and the evidence verdict.
- `recommended_next_action` — internal operational guidance only. Never a customer-facing commitment.

---

## 🤖 Model & Cost Reasoning

### Why `gemini-2.5-flash`

| Concern              | Choice                                          | Reason                                                                                   |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Latency              | `flash` over `pro`                              | Support triage is interactive — p50 < 2s matters more than peak reasoning quality.       |
| Cost                 | `flash` is ~10× cheaper per token               | At expected ticket volumes, `pro` would dominate operating cost.                         |
| Structured output    | `flash` handles the JSON-schema prompt reliably | Schema is narrow (≤13 fields) and validated server-side, so any hallucination is caught. |
| Multilingual (en/bn) | `flash` is strong on Bangla                     | Important for the `language: "bn" \| "mixed"` field.                                     |

### Cost shape

A typical request is **~2 KB of system prompt + ~1 KB ticket payload → ~500 B JSON reply**. At Gemini 2.5 Flash pricing that's on the order of **fractions of a US cent per ticket**.

The bigger cost lever is **throughput per key**. Adding a 4th key is roughly free and immediately raises the supported tickets-per-minute ceiling by ~25–33% — but only if the key pool is healthy (no dead keys) and routing actually rotates to it (the sliding-window counter ensures this).

### Why not self-host / fine-tune

- The triage schema is owned by the application — a fine-tune would freeze the schema.
- Per-key rate-limited routing across hosted Gemini keys keeps the deploy stateless and horizontally scalable.
- If a fine-tune becomes valuable later, the AI gateway in `src/lib/ai.ts` is the single integration point to swap.

---

## ⚙️ Setup

### Prerequisites

- **Node.js 22+**
- **npm 10+**
- **Redis 7+** — required for the queue, call counters, and pub/sub. Run it locally or via Docker (`docker compose up -d redis`).
- One or more **Google Gemini API keys** ([get one here](https://aistudio.google.com/apikey))

### 1. Clone & install

```bash
git clone https://github.com/naim1405/ticket-analyzer.git
cd ticket-analyzer
npm install
```

### 2. Configure environment

Create a `.env` file in the project root (use `.env.prod` when `NODE_ENV=production`):

```env
# Server
PORT=5000
NODE_ENV=development

# CORS — comma-separated allow-list
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001

# Cookies
COOKIE_SECRET=replace-me-with-a-long-random-string

# --- Redis broker ---
REDIS_HOST=localhost
REDIS_PORT=6379

# --- Queue tuning (optional) ---
# QUEUE_BUFFER_MS=1200          # max wait before flushing a batch
# QUEUE_EARLY_FLUSH_MS=400      # fire early if the lane has been quiet
# QUEUE_QUIET_WINDOW_MS=200     # "quiet" threshold for early-flush
# QUEUE_MAX_DEPTH=200           # backpressure cap per lane
# QUEUE_MAX_RETRIES=3
# QUEUE_CALLS_PER_MIN_PER_KEY=5 # Gemini free-tier rate limit
# QUEUE_DEAD_KEY_COOLDOWN_MS=600000  # 10 min skip after "denied access"
# QUEUE_CALL_WINDOW_MS=60000    # sliding-window size for the call counter

# --- AI gateway ---
# Add as many keys as you want. They MUST be named GEMINI_API_KEY, GEMINI_API_KEY_2, ...
# The gateway picks them all up automatically (lexicographic order).
GEMINI_API_KEY=AIza...
GEMINI_API_KEY_2=AIza...
GEMINI_API_KEY_3=AIza...
```

> ⚠️ At least **one** `GEMINI_API_KEY*` variable is required — the process exits with `No Gemini API keys configured` otherwise.
> ⚠️ A reachable Redis instance is required — the queue, call counters, and pub/sub all live there. Without it, every request will fail.

### 3. Run

#### Start Redis

```bash
docker compose up -d redis
```

#### Development (hot reload via `tsx` + `nodemon`)

```bash
npm run dev
```

#### Production (compile then run)

```bash
npm run build
npm start
```

#### Docker

The provided `docker-compose.yml` runs **Redis only**. The app is intended to run on the host (`npm run dev` or `npm start`) so logs and dev loops stay simple.

```bash
docker compose up -d redis   # start broker
npm run dev                  # start app locally
```

The app exposes the service on **`http://localhost:5000`**.

---

## 🚀 Run Commands

| Command                      | What it does                                       |
| ---------------------------- | -------------------------------------------------- |
| `npm run dev`                | Start in watch mode with `tsx`                     |
| `npm run build`              | Type-check + emit `dist/`                          |
| `npm start`                  | Run the compiled `dist/server.js` with `nodemon`   |
| `npm run lint`               | ESLint over all `.ts` files                        |
| `npm run format`             | Prettier write                                     |
| `docker compose up -d redis` | Start the Redis broker                             |

---

## 📡 API

### `POST /analyze-ticket`

**Request body**

```json
{
  "ticket_id": "TKT-9001",
  "complaint": "I sent 500 BDT to the wrong number by mistake.",
  "language": "en",
  "channel": "in_app_chat",
  "user_type": "customer",
  "campaign_context": "",
  "transaction_history": [
    {
      "transaction_id": "TXN-9101",
      "timestamp": "2026-06-25T10:15:00Z",
      "type": "transfer",
      "amount": 500,
      "counterparty": "+8801712000000",
      "status": "completed"
    }
  ]
}
```

**Successful response — `200 OK`**

```json
{
  "ticket_id": "TKT-9001",
  "relevant_transaction_id": "TXN-9101",
  "evidence_verdict": "consistent",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports sending 500 BDT to an unintended recipient. Transaction TXN-9101 was identified and available transaction data is consistent with the complaint.",
  "recommended_next_action": "Review transfer details and initiate dispute workflow.",
  "customer_reply": "Thank you for reaching out. We've identified transaction TXN-9101 and your case is being reviewed by our dispute resolution team.",
  "human_review_required": true,
  "confidence": 0.92,
  "reason_codes": ["wrong_transfer", "transaction_match", "evidence_consistent"]
}
```

### Error responses

| Status | When                                                                          |
| ------ | ----------------------------------------------------------------------------- |
| `502`  | The batched Gemini call failed (any of the keys in the lane, after retries).  |
| `503`  | Every key is either marked dead or at its per-minute rate cap — retry later.   |
| `503`  | A lane hit `QUEUE_MAX_DEPTH` (backpressure).                                  |

### Other endpoints

| Path           | Purpose                                        |
| -------------- | ---------------------------------------------- |
| `GET /`        | Liveness ping (returns 200)                    |
| `GET /health`  | Health check (returns `{ status: "ok" }`)      |
| `GET /metrics` | Prometheus metrics (default + HTTP histograms) |

---

## 🧪 Lint / Format

```bash
npm run lint
npm run format
```

---

## 📝 Assumptions

1. **API keys are independently rate-limited** — the per-key counter assumes each `GEMINI_API_KEY*` has its own quota. If all keys share a quota (e.g. same Google Cloud project without separate billing), the gain is reduced to availability/failover only.
2. **Schema is stable** — downstream consumers can rely on the 13-field response shape.
3. **Transaction history is trusted** — the model is told to treat it as ground truth and the service does not re-verify it. Garbage-in, garbage-out applies.
4. **English / Bangla coverage** — the prompt and validators explicitly support `en`, `bn`, and `mixed`.
5. **Single-tenant deployment** — the service is built as one binary; per-tenant config is out of scope.
6. **Stateless service** — no ticket data is persisted; every call is independent. The `redis_data` Docker volume only persists Redis state across broker restarts (call counters, dead-key markers).
7. **Refund / settlement authority lives outside this service** — this is the core safety assumption. The copilot only _classifies and routes_.
8. **Redis is a trusted component** — the broker is expected to be reachable, single-tenant, and not exposed beyond the loopback or VPC.

---

## ⚠️ Known Limitations

1. **No persistence layer** — there is no application database. Tickets, audit trails, and the copilot's decisions are not stored. Add a DB before using this in production.
2. **No authentication / authorization on the API** — `POST /analyze-ticket` is publicly reachable inside the CORS allow-list and rate limiter. Put it behind an API gateway or add auth middleware before exposing it externally.
3. **Batching is per-process, per-lane** — there is one worker per key per process. If you scale to multiple Node workers/containers behind a load balancer, each process has its own `pickBestKeySlot` view; the sliding-window counter is shared via Redis, so cross-process fairness is preserved, but the round-robin tiebreak counter is local.
4. **Whole-batch retry on failure** — if a Gemini call fails after `QUEUE_MAX_RETRIES`, every job in the batch is re-queued at the head of the lane and every waiting HTTP request receives the same error. There is no per-ticket retry budget.
5. **Strict JSON parsing** — the service strips ` ```json ` fences before `JSON.parse`. Any other markdown wrapper (e.g. ` ``` ` without `json`) will still throw. The prompt forbids markdown, but if a future model version drifts, you will get a 500.
6. **Prompt-only guardrails** — safety relies entirely on the model following the system prompt. There is no secondary classifier or allow-list of `case_type` / `department` values; an adversarial prompt could in principle coerce a different output. The server-side schema validation catches malformed JSON but does not police values.
7. **No cost telemetry** — token usage is not recorded. Add usage tracking via the AI SDK's `usage` callback if you need per-ticket billing or quota dashboards.
8. **Single-language routing** — `customer_reply` is generated in the model's preferred style, not guaranteed in the customer's `language`. Add an explicit "respond in the customer's language" rule to the prompt if this matters.
9. **`/metrics` is unauthenticated** — Prometheus scraping is expected to happen from inside a trusted network.
10. **Dead-key detection is heuristic** — the worker greps the error message for `denied access` / `api key not valid` / `invalid api key` / `project has been`. Any wording Gemini doesn't match will keep retrying on a key that should be skipped. Review the regex in `runBatchForSlot` if Gemini changes its error vocabulary.
11. **Pub/sub subscriber connections are not tracked** — each ticket's `waitForAnalyzerJob` opens a short-lived Redis subscriber connection that self-closes on result/timeout. Long-running idle subscribers are not currently an issue, but a memory accounting layer is not built.
12. **Result stash has no TTL cleanup** — `analyzer:results` accumulates `HSET` entries that are removed on read. A crashed subscriber that never reads its ticket would leak one entry until manual `FLUSHDB` or restart.

---

## 📜 License

ISC — see `package.json`.
