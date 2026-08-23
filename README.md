# Zero-Knowledge PHI Clinical Note Assistant

Structures Taiwanese hospital narratives into formal notes (SOAP, discharge
summary, hospital course, …) without any identifier leaving the Mac Mini.

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

## Setup

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
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Cloud formatting layer |
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

## The rule that matters

`TokenVault` contents must never be written to Postgres, a file, a log line, or
telemetry. If you add logging to the pipeline route, log `deidentifiedInput` —
never `plaintext`, never `noteText`, never `vault`.
