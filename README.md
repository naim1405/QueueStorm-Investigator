# QueueStorm Investigator

A Fintech Support Copilot and Ticket Investigation Engine built with **Node.js + Express + TypeScript** and powered by **Google Gemini (via the Vercel AI SDK)**.

The service takes a customer complaint, together with the customer's recent transaction history, and returns a structured JSON triage decision: which transaction is involved, what the evidence says, how severe the case is, which department should own it, a short agent-facing summary, and a safe customer-facing reply.

> The service is an **internal support copilot** — it never approves refunds, reversals, chargebacks, or settlements.

---

## ✨ Features

- 🔍 **Single endpoint** (`POST /analyze-ticket`) for ticket analysis.
- 🤖 **LLM-driven triage** with strict JSON-schema output.
- 🔁 **Round-robin multi-key AI gateway** — requests are distributed across any number of Gemini API keys so one key can be busy answering while others are responding.
- 📈 **Horizontally scalable AI throughput** — drop in more `GEMINI_API_KEY` env vars to scale; no code changes required.
- 🛡️ **Hard-coded safety rails** — refuses to promise refunds, never solicits OTP/PIN/CVV, escalates fraud and phishing automatically.
- 🧱 **Production-ready plumbing** — Helmet, CORS allow-list, rate limiting, request logging (Winston), Prometheus metrics, `/health`, graceful shutdown.
- 🐳 **Docker + docker-compose** for reproducible deploys.

---

## 🧰 Tech Stack

| Layer          | Technology                                                                            |
| -------------- | ------------------------------------------------------------------------------------- |
| Runtime        | Node.js 20 (`node:20-bookworm-slim`)                                                  |
| Language       | TypeScript 5 (strict mode, ESNext modules)                                            |
| HTTP Framework | Express 5                                                                             |
| AI SDK         | [`ai`](https://www.npmjs.com/package/ai) (Vercel AI SDK)                              |
| LLM Provider   | [`@ai-sdk/google`](https://www.npmjs.com/package/@ai-sdk/google) → `gemini-2.5-flash` |
| Validation     | Zod 4 (types) + lightweight manual validators                                         |
| Security       | Helmet, `express-rate-limit`, CORS allow-list                                         |
| Logging        | Winston (+ optional `winston-loki` for Grafana Loki)                                  |
| Metrics        | `prom-client` (`/metrics` endpoint)                                                   |
| Compression    | `compression`                                                                         |
| Container      | Docker + docker-compose                                                               |
| Lint / Format  | ESLint 10 + Prettier                                                                  |

---

## 🧠 AI Approach — Round-Robin Multi-Agent Gateway

The system treats **every configured Gemini API key as an independent "agent"**. Instead of queueing requests behind a single key, the gateway cycles through all available keys for each request:

```
request 1 → GEMINI_API_KEY
request 2 → GEMINI_API_KEY_2
request 3 → GEMINI_API_KEY_3
request 4 → GEMINI_API_KEY     ← cycles back
...
```

### How it works

1. On boot, `src/config/index.ts` scans `process.env` for any variable matching `GEMINI_API_KEY*` (`GEMINI_API_KEY`, `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, …), sorts them lexicographically, and loads them into an in-memory key pool.
2. `src/lib/ai.ts` keeps an in-process cursor (`currentIndex`) and `generateAIText` advances it on every call — `currentIndex = (currentIndex + 1) % apiKeys.length`.
3. **While one key is busy generating**, the next incoming request lands on the next key, so multiple tickets can be processed in parallel against independent provider quotas.
4. **Automatic failover** — if a key throws (rate-limit, network error, quota exhaustion), the loop tries the next key. Only after every key has been attempted does the error surface.
5. **Scaling is configuration-only** — adding `GEMINI_API_KEY_4=...` to `.env` instantly increases throughput by ~1/N of the original latency on the next deploy.

### Why round-robin (not LLM-tool-calling agents)

- Tickets must return a single strict JSON object, not a multi-step plan — multi-agent orchestration overhead would dominate the actual inference.
- Gemini keys already have per-key rate limits; the bottleneck is quota, not compute. Round-robin attacks the quota directly.
- A pure gateway keeps the path deterministic, testable, and cheap to reason about.

---

## 🛡️ Safety Logic

Safety is enforced at three layers: **system prompt**, **response validation**, and **application-level refusal of financial commitments**.

### 1. System-prompt rules (in `analyzer.services.ts`)

The model is told, in plain English, what it is and is **not** allowed to do:

- ❌ Never approve refunds, reversals, recoveries, or settlements.
- ❌ Never guarantee financial outcomes to the customer.
- ❌ Never ask for OTP, PIN, password, CVV, full card number, or security answers.
- ❌ Never return markdown, explanations, or extra fields — only the declared JSON schema.
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

The bigger cost lever is **throughput per key**. Adding a 4th key is roughly free and immediately raises the supported tickets-per-minute ceiling by ~25–33%.

### Why not self-host / fine-tune

- The triage schema is owned by the application — a fine-tune would freeze the schema.
- Round-robin across hosted Gemini keys keeps the deploy stateless and horizontally scalable.
- If a fine-tune becomes valuable later, the AI gateway in `src/lib/ai.ts` is the single integration point to swap.

---

## ⚙️ Setup

### Prerequisites

- **Node.js 20+**
- **npm 10+**
- One or more **Google Gemini API keys** ([get one here](https://aistudio.google.com/apikey))
- (Optional) **Docker + docker-compose** for container runs

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

# --- AI gateway ---
# Add as many keys as you want. They MUST be named GEMINI_API_KEY, GEMINI_API_KEY_2, ...
# The gateway picks them all up automatically (lexicographic order).
GEMINI_API_KEY=AIza...
GEMINI_API_KEY_2=AIza...
GEMINI_API_KEY_3=AIza...
```

> ⚠️ At least **one** `GEMINI_API_KEY*` variable is required — the process exits with `No Gemini API keys configured` otherwise.

### 3. Run

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

```bash
docker compose up --build -d
```

The container exposes the service on **`http://localhost:5000`** with logs written to the `app_log` named volume.

---

## 🚀 Run Commands

| Command                     | What it does                                     |
| --------------------------- | ------------------------------------------------ |
| `npm run dev`               | Start in watch mode with `tsx`                   |
| `npm run build`             | Type-check + emit `dist/`                        |
| `npm start`                 | Run the compiled `dist/server.js` with `nodemon` |
| `npm run lint`              | ESLint over all `.ts` files                      |
| `npm run format`            | Prettier write                                   |
| `docker compose up --build` | Build image and start the `server` container     |

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

1. **API keys are independently rate-limited** — the round-robin assumes each `GEMINI_API_KEY*` has its own quota. If all keys share a quota (e.g. same Google Cloud project without separate billing), the gain is reduced to availability/failover only.
2. **Schema is stable** — downstream consumers can rely on the 13-field response shape.
3. **Transaction history is trusted** — the model is told to treat it as ground truth and the service does not re-verify it. Garbage-in, garbage-out applies.
4. **English / Bangla coverage** — the prompt and validators explicitly support `en`, `bn`, and `mixed`.
5. **Single-tenant deployment** — the service is built as one binary; per-tenant config is out of scope.
6. **Stateless service** — no ticket data is persisted; every call is independent. The `app_log` volume only contains application logs.
7. **Refund / settlement authority lives outside this service** — this is the core safety assumption. The copilot only _classifies and routes_.

---

## ⚠️ Known Limitations

1. **No persistence layer** — there is no database. Tickets, audit trails, and the copilot's decisions are not stored. Add a DB before using this in production.
2. **No authentication / authorization on the API** — `POST /analyze-ticket` is publicly reachable inside the CORS allow-list and rate limiter. Put it behind an API gateway or add auth middleware before exposing it externally.
3. **Round-robin is in-process** — if you scale to multiple Node workers/containers, each one maintains its own cursor. Total throughput still scales linearly, but a single key may temporarily receive bursts from one worker. A shared-state (e.g. Redis) scheduler would be needed for perfectly even distribution across replicas.
4. **No retry queue for permanent failures** — if every key fails, the request fails synchronously. No dead-letter or background retry is implemented.
5. **Strict JSON parsing** — the service strips ` ```json ` fences before `JSON.parse`. Any other markdown wrapper (e.g. ` ``` ` without `json`) will still throw. The prompt forbids markdown, but if a future model version drifts, you will get a 500.
6. **Prompt-only guardrails** — safety relies entirely on the model following the system prompt. There is no secondary classifier or allow-list of `case_type` / `department` values; an adversarial prompt could in principle coerce a different output. The server-side schema validation catches malformed JSON but does not police values.
7. **No cost telemetry** — token usage is not recorded. Add usage tracking via the AI SDK's `usage` callback if you need per-ticket billing or quota dashboards.
8. **Single-language routing** — `customer_reply` is generated in the model's preferred style, not guaranteed in the customer's `language`. Add an explicit "respond in the customer's language" rule to the prompt if this matters.
9. **`/metrics` is unauthenticated** — Prometheus scraping is expected to happen from inside a trusted network.

---

## 📜 License

ISC — see `package.json`.
