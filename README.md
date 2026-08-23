# Project Airlock

> *Both doors never open at once.*

Structures Taiwanese hospital narratives into formal notes (SOAP, discharge
summary, hospital course, …) without any identifier leaving the Mac Mini.

An airlock joins two environments that must never meet. Nothing passes through
carrying what belongs to the other side: identifiers are stripped on the inner
door before the outer one opens onto the cloud, and restored only after it
shuts again.

Created by **Kuan-Yuan Chen**. Built with **Claude Code**.

```
browser ──AES-GCM sealed──▶ Cloudflare ──ciphertext──▶ Mac Mini (M4/16GB)
                                                          │
                                       regex scrub ───────┤  raw PHI never
                                       LM Studio NER ─────┤  leaves this box
                                                          ▼
                                         [PATIENT_1] [MRN_1] … ──▶ Gemini
                                                          │
                                       re-hydrate ────────┤
browser ◀──AES-GCM sealed──  Cloudflare ◀──ciphertext─────┘
```

## Guarantees, and their limits

**What holds.** Cloudflare terminates TLS at its edge, so the tunnel is treated
as hostile. Every payload is sealed in the browser with a per-request
AES-256-GCM key, wrapped with the Mac Mini's RSA-OAEP-2048 public key. The reply
— which does contain re-hydrated PHI — is sealed with the same ephemeral key.
Cloudflare relays ciphertext in both directions. Gemini receives placeholders
only. Postgres stores de-identified text only. The PII↔token map lives in a
volatile `Map` with a 10-minute TTL and is explicitly purged in the request's
`finally` block.

**What does not hold, and you should know it.** The public key is served from
`/api/keys` over the same tunnel it protects. An attacker who controls the edge
could substitute their own key and read everything. This design defeats passive
inspection and incidental logging at the edge — not an active edge adversary.
To close that gap, pin the key: after first run, copy the value from
`/api/keys` into `NEXT_PUBLIC_PINNED_KEY_ID` and have the client refuse any
`keyId` that does not match, or distribute the SPKI out of band.

Two other honest caveats: the NER pass is probabilistic, so the inspector drawer
exists to be read, not skipped; and `[MRN]` matching (`\b\d{7,8}\b`) is
deliberately over-eager and will sometimes swallow an accession number.

## Running it with Docker (recommended)

```bash
lms server start --port 1234          # LM Studio stays on the HOST
lms load google/gemma-4-e4b
docker compose up -d --build
```

That brings up the app and Postgres, applies migrations, and serves on
<http://localhost:3000>.

**LM Studio is deliberately not containerised.** Docker Desktop on macOS runs a
Linux VM with no GPU passthrough, so a containerised model would lose Metal/MLX
acceleration entirely. It runs on the host; the container reaches it at
`host.docker.internal:1234`.

**Set Docker Desktop's VM to 2 GB** (Settings → Resources). Measured on this
box, with `gemma-4-e4b` loaded:

| Docker VM | Stack usage | Host free |
| --- | --- | --- |
| 8 GB (default) | 215 MB | 2.7 GB |
| 2 GB | 215 MB | **6.2 GB** |

The whole stack peaks around 215 MB, so the default 8 GB is pure waste — and on
a 16 GB Mac every gigabyte the VM reserves is a gigabyte the model cannot use.
The full acceptance suite passes 62/62 at 2 GB.

Two things that will bite you:

- **Do not scale the `app` service.** The single-slot compute lock lives in that
  process's memory; a second replica would silently break it.
- **`docker compose` auto-loads `.env` for interpolation**, so a host-specific
  value there can override a compose default. `LMSTUDIO_BASE_URL` is the trap —
  the host's `127.0.0.1` means "this container" inside the container. That one
  is pinned to `DOCKER_LMSTUDIO_URL` in the compose file for exactly this
  reason.

The `airlock-keys` volume holds the RSA identity and **must** persist: a
regenerated keypair breaks decryption for every browser tab still holding the
old public key.

## Setup (running directly on the host)

```bash
npm install
```

**1. Postgres** (audit log, de-identified text only)

```bash
brew install postgresql@17 && brew services start postgresql@17
# postgresql@17 is keg-only; add it to your PATH for psql/createdb:
echo 'export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >> ~/.zshrc
createdb clinical_notes
```

Set `DATABASE_URL` in `.env`, then:

```bash
npm run db:migrate
npm run db:smoke       # inserts and deletes one de-identified row
```

**2. LM Studio** — launch it, load an instruction-following model that handles
Traditional Chinese (Qwen2.5-7B-Instruct or Llama-3.1-8B-Instruct fit 16GB
comfortably), and start the local server on port 1234.

**3. Gemini** — put `GEMINI_API_KEY` in `.env`.

**4. Run**

```bash
npm run dev          # http://localhost:3000
npm run build && npm start
```

**5. Cloudflare Tunnel**

```bash
cloudflared tunnel create clinical-notes
cloudflared tunnel route dns clinical-notes llm.galenchen.uk
cloudflared tunnel --url http://localhost:3000 run clinical-notes
```

Put Cloudflare Access in front of the hostname. Nothing in this app
authenticates the caller — the single-slot lock is a compute guard, not a door.

## Verification

```bash
npm run verify           # offline: crypto, scrubbers, re-hydration, lock
npm run e2e              # against a running server: sealed round-trip
npm run e2e:concurrency  # proves the 429 single-slot limit
npm run e2e:routine      # same note with and without a specialty routine
npm run e2e:system       # full acceptance run: routines, PHI guard, ward note,
                         # audit invariant, input cap, streaming, 429
npm run db:smoke         # audit database round-trip

# whole pipeline with both externals stubbed (no Gemini key, no model needed):
GEMINI_API_KEY=stub GEMINI_BASE_URL=http://localhost:8899 npm run dev
npm run e2e:full
```

`npm run verify` needs no database, no API key, and no model — it stubs LM
Studio on port 11234.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Local Postgres for the audit log |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Cloud formatting layer. Free-tier keys are capped per model per day (20/day on `gemini-3.6-flash` at time of writing). |
| `GEMINI_MODEL` | Default starting rung of the ladder. |
| `GEMINI_MODEL_LADDER` | Optional override of the whole ladder, best first, comma separated. |
| `LMSTUDIO_BASE_URL` / `LMSTUDIO_MODEL` / `LMSTUDIO_TIMEOUT_MS` | Local NER pass |
| `ALLOW_DEGRADED_SCRUB` | `false` (default) aborts the request when the local NER pass is unavailable. Setting `true` permits regex-only scrubbing — it weakens de-identification and the UI shows a standing warning. |
| `KEY_STORE_FILE` | Filename inside `./.keys/` for the RSA keypair |
| `GEMINI_BASE_URL` | Optional endpoint override (egress proxy, regional endpoint, local stub). Unset in normal operation. |

## Layout

| File | Role |
| --- | --- |
| `src/lib/crypto.ts` | Isomorphic WebCrypto. No Node imports — it ships to the browser. |
| `src/lib/keystore.ts` | Server RSA keypair, persisted to `./.keys/` |
| `src/lib/concurrency.ts` | Single-slot lock with stale reclaim |
| `src/lib/scrubber-regex.ts` | Taiwan ID / MRN / phone / ROC+Gregorian dates. Rule order is load-bearing. |
| `src/lib/scrubber-llm.ts` | LM Studio NER, verbatim-span validation, clinical stop-list, fail-closed |
| `src/lib/memory-cache.ts` | `TokenVault` + 10-minute TTL store. **The only place raw PHI lives on the server.** |
| `src/lib/gemini.ts` | Note formats and the placeholder-preserving system prompt |
| `src/lib/db.ts` | Prisma singleton (`@prisma/adapter-pg`) |
| `src/lib/prompts.ts` | Specialty routine CRUD + the guard that keeps PHI out of saved prompts |

## Input budget

The cap is a **safety** limit before it is a performance limit: the local NER
pass runs on a ~4B model with a 34k context, and a note longer than it can
attend to reliably starts losing names — a PHI leak, not a quality dip.

| | |
| --- | --- |
| Comfortable | up to 6,000 characters — a full shift handover fits easily |
| Soft warning | past 6,000, the UI warns and asks you to check the redaction list |
| Hard refusal | past 20,000, the request is rejected client- and server-side |

Both limits live in `src/lib/limits.ts` and are shared by the browser counter
and the server, so the two can never disagree. The live counter reports words
(Latin words plus CJK characters, since Chinese is unspaced) and characters
against the cap.

## Live progress and the queue

`/api/process-note` streams Server-Sent Events, one per pipeline stage, so the
clinician watches real work rather than a spinner. Only the final `result`
event carries the sealed payload; progress events never contain note content.

The server still refuses rather than queues — that is what protects the single
compute slot. The queue is client-side: on a 429 the browser retries every two
seconds while displaying what the Mac Mini is actually busy with, read live from
`/api/status`. `src/lib/concurrency.ts` publishes the held slot's current stage
for exactly this.

## The model ladder

The cloud model is a ladder, best first, ending on the lite models — on the
free tier those carry **500 requests/day** against the flagships' 20, which is
the difference between "the tool died at lunchtime" and "the tool kept working,
in a lighter voice". Pro models are deliberately absent: the free tier grants
them zero quota, so they would only ever be a button that fails.

| Rung | Free-tier RPD |
| --- | --- |
| 3.7 / 3.6 / 3.5 / 3 / 2.5 Flash | 20 each |
| 3.5 Flash Lite, 3.1 Flash Lite | 500 each |
| 2.5 Flash Lite | 20 |

The selector bar on the page picks where a run **starts**. A rung greys out
only once Google has actually refused it — availability is observed, never
predicted — and the cooldown is honest about which kind of refusal it was: a
per-day exhaustion is held until midnight US Pacific, not retried in 25 seconds
because a `retryDelay` hint said so.

When a rung is spent the request walks down from there rather than failing:

```
cloud   running
cloud   running   gemini-3.6-flash quota → gemini-3.5-flash
cloud   done      gemini-3.5-flash
```

The downgrade is **never silent**. It streams as a progress event while it
happens, the button greys out live, the footer shows the downgrade in amber,
and `AuditLog.modelUsed` records the model
that actually wrote the note. A lighter model is a different clinical draft, so
the clinician is told which one they are reading.

Auth failures and safety-filter blocks do **not** trigger fallback — only
quota, overload, and retired-model errors, which are the ones another model can
actually solve.

## Specialty routines

A *routine* is a saved instruction block appended to the Gemini prompt, so each
department encodes its charting habits once — "always call out dialysis access
and dry weight under Objective", "number the Plan, one line per problem". Manage
them from **Manage** next to the routine selector, or over the API:

```
GET    /api/prompts        list
POST   /api/prompts        create   { name, specialty?, instruction, format?, isDefault? }
PATCH  /api/prompts/:id    update
DELETE /api/prompts/:id    delete
```

Instruction precedence, weakest to strongest: the built-in format skeleton, then
the saved routine, then the one-off steer typed under the input box. All three
sit *below* the placeholder rules in the system instruction — a routine cannot
talk the model into inventing a name.

Routines are configuration, not clinical data, and they live in Postgres
forever. The API therefore runs every saved routine through the deterministic
scrubber and **rejects it with HTTP 422 if any identifier matches** — a patient
name pasted into a template would quietly defeat the whole pipeline. The audit
row records which routine was in effect by name.

## The rule that matters

`TokenVault` contents must never be written to Postgres, a file, a log line, or
telemetry. If you add logging to the pipeline route, log `deidentifiedInput` —
never `plaintext`, never `noteText`, never `vault`.
