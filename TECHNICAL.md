# Project Airlock — technical manual

Everything below assumes you have read [README.md](README.md) and know what the
product does. This document is the mechanism: what each module is responsible
for, what invariants it holds, how to debug it when it misbehaves, and what every
script in `scripts/` actually exercises.

**Contents**

1. [Where things run](#1-where-things-run)
2. [Repository map](#2-repository-map)
2b. [The system, as a picture](#2b-the-system-as-a-picture)
2c. [Module reference — what goes in, what comes out](#2c-module-reference--what-goes-in-what-comes-out)
3. [The pipeline, stage by stage](#3-the-pipeline-stage-by-stage)
4. [Cryptography](#4-cryptography)
5. [The token vault](#5-the-token-vault)
6. [Pass A — the deterministic scrubber](#6-pass-a--the-deterministic-scrubber)
7. [Pass B — the local NER pass](#7-pass-b--the-local-ner-pass)
8. [The cloud layer and the model ladder](#8-the-cloud-layer-and-the-model-ladder)
8b. [The local destination](#8b-the-local-destination)
8c. [Watching the local model work](#8c-watching-the-local-model-work)
8d. [Bring your own Gemini key](#8d-bring-your-own-gemini-key)
9. [Concurrency: one compute slot](#9-concurrency-one-compute-slot)
10. [Workspaces, and the one rule](#10-workspaces-and-the-one-rule)
10b2. [Sampling, and whose it is](#10b2-sampling-and-whose-it-is)
10c. [Routines, in both workspaces](#10c-routines-in-both-workspaces)
11. [Authentication](#11-authentication)
12. [Persistence](#12-persistence)
13. [The browser client](#13-the-browser-client)
14. [Configuration reference](#14-configuration-reference)
15. [Every script, and what it proves](#15-every-script-and-what-it-proves)
16. [Debugging playbook](#16-debugging-playbook)
17. [Known quirks](#17-known-quirks)
18. [Changing this safely](#18-changing-this-safely)

---

## 1. Where things run

Three trust zones, and the whole design is about the boundaries between them.

| Zone | What runs there | What it may see |
| --- | --- | --- |
| **Browser** | Next.js client, WebCrypto sealing | The raw note; the re-hydrated note |
| **Cloudflare** | Tunnel (`cloudflared`) | Ciphertext only, both directions |
| **Mac Mini** | Next server, Postgres, LM Studio | Everything — this is the only place raw PHI exists on a server |
| **Google** | Gemini | Placeholders only |

The Mac Mini runs three processes: the app container, the Postgres container, and
**LM Studio on the host**. LM Studio is not containerised because Docker Desktop
on macOS runs a Linux VM with no GPU passthrough — a containerised model loses
Metal/MLX acceleration entirely. The container reaches it at
`host.docker.internal:1234`.

The app is a single replica by design. The compute lock lives in that process's
memory, so a second replica would silently break it.

## 2. Repository map

| Path | Role |
| --- | --- |
| `src/lib/crypto.ts` | Isomorphic WebCrypto. **No Node imports** — it ships to the browser. |
| `src/lib/keystore.ts` | Server RSA keypair, persisted to `./.keys/` |
| `src/lib/memory-cache.ts` | `TokenVault` + the 10-minute TTL store. **The only place raw PHI lives on the server.** |
| `src/lib/scrubber-regex.ts` | Deterministic Taiwan PII rules. **Rule order is load-bearing.** |
| `src/lib/scrubber-llm.ts` | LM Studio NER, open tag vocabulary, verbatim-span validation, clinical stop-list, fail-closed |
| `src/lib/gemini.ts` | Note formats, prompt assembly, the placeholder-preserving system instruction, error translation |
| `src/lib/model-registry.ts` | The Gemini ladder and observed availability, **scoped per quota** |
| `src/lib/gemini-key.ts` | Bring-your-own Gemini key: shape, masking, and the one-way quota fingerprint |
| `src/lib/local-format.ts` | The local formatting destination — the same note, written on this Mac |
| `src/lib/lmstudio.ts` | Where LM Studio lives and how long each kind of call may take |
| `src/lib/concurrency.ts` | Single-slot lock with stale reclaim, plus the live stage read-out |
| `src/lib/workspace.ts` | The two workspaces, the one privacy rule, and the clamp both sides run |
| `src/lib/placeholders.ts` | The placeholder-integrity rules every cloud-bound prompt carries |
| `src/lib/limits.ts` | Input budget, shared by browser and server |
| `src/lib/prompts.ts` | Routine CRUD for both workspaces, plus the guard that keeps PHI out of saved prompts |
| `src/lib/auth.ts` | Google sign-in and the mandatory allowlist |
| `src/lib/dev-login.ts` | Rules for the developer password bypass |
| `src/lib/db.ts` | Lazy Prisma singleton behind a proxy |
| `src/lib/pipeline-client.ts` | Client half: seal, POST, parse SSE, open the reply. **The stage ids live here** — it is the wire contract, and `concurrency.ts` re-exports the type rather than declaring a second one. |
| `src/lib/db.ts` | Lazy Prisma singleton behind a proxy |
| `src/lib/utils.ts` | `cn()` — `clsx` + `tailwind-merge` |
| `src/app/api/process-note/route.ts` | The pipeline itself |
| `src/app/api/{status,models,keys,health}/route.ts` | Health, the ladder, the public key, the container probe |
| `src/app/api/{history,prompts,prompt-config}/route.ts` | Past notes, saved routines, and a read-only view of every prompt |
| `src/app/api/auth/` | Auth.js handlers and the developer password bypass |
| `src/app/page.tsx` | The entire UI (single client component plus seven drawers) |
| `src/app/layout.tsx`, `theme-toggle.tsx`, `signin/` | Shell, theme, sign-in |
| `src/app/globals.css` | Theme tokens, drawer animation, focus rings, the touch-target floor |
| `src/generated/prisma/` | Generated client. Never edited, never reviewed — `prisma generate` output. |
| `scripts/` | Verification and acceptance — see [section 15](#15-every-script-and-what-it-proves) |
| `ops/` | Cloudflare Tunnel setup, the hourly backup, and its launchd job |

Each module's exported entry points, with what they take and what they return,
are in [section 2c](#2c-module-reference--what-goes-in-what-comes-out).

## 2b. The system, as a picture

Two diagrams. The first is where the data physically is; the second is what one
request actually does with it.

### Trust boundaries and what crosses them

```
┌──────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                        sees: the real note       │
│                                                                          │
│   page.tsx ── pipeline-client.ts ── crypto.ts                            │
│      │              │                   │                                │
│      │              │                   └── AES-256-GCM key, made fresh  │
│      │              │                       per note, wrapped with the   │
│      │              │                       Mac's RSA-OAEP-2048 pubkey   │
│      │              └── GET /api/keys, POST /api/process-note (SSE back) │
│      └── holds the AES key in memory only; it is never transmitted        │
└──────────────────────────────────────────────────────────────────────────┘
              │  ciphertext  ▲  ciphertext (result + live token stream)
              ▼              │
┌──────────────────────────────────────────────────────────────────────────┐
│ CLOUDFLARE TUNNEL                              sees: opaque bytes        │
│   Terminates HTTPS at its edge — which is exactly why the payload is     │
│   sealed underneath it rather than relying on TLS.                       │
└──────────────────────────────────────────────────────────────────────────┘
              │              ▲
              ▼              │
┌──────────────────────────────────────────────────────────────────────────┐
│ MAC MINI (M4 / 16 GB)              sees: EVERYTHING. The only server     │
│                                    where raw PHI exists, and only in RAM.│
│  ┌────────────────────── app container ──────────────────────────────┐   │
│  │ middleware.ts → auth.ts → api/process-note/route.ts               │   │
│  │      keystore.ts   concurrency.ts   memory-cache.ts (TokenVault)   │   │
│  │      scrubber-regex.ts   scrubber-llm.ts   workspace.ts           │   │
│  │      gemini.ts / local-format.ts   model-registry.ts   prompts.ts │   │
│  └───────────┬──────────────────────────────┬────────────────────────┘   │
│              │ SQL                          │ HTTP, host-only            │
│  ┌───────────▼───────────┐      ┌───────────▼──────────────────────────┐ │
│  │ Postgres container    │      │ LM STUDIO — on the HOST, not Docker  │ │
│  │ DE-IDENTIFIED TEXT    │      │ Docker Desktop on macOS has no GPU   │ │
│  │ ONLY. No raw note.    │      │ passthrough, so a containerised model│ │
│  │ No token map. Ever.   │      │ loses Metal/MLX entirely.            │ │
│  └───────────────────────┘      │ Reads names. Optionally writes notes.│ │
│   bind-mounted to the Mac's     └──────────────────────────────────────┘ │
│   own filesystem, not a                                                  │
│   Docker named volume                                                    │
└──────────────────────────────────────────────────────────────────────────┘
              │  placeholders only, and only if the run is cloud-bound
              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ GOOGLE GEMINI                    sees: [PATIENT_1], [MRN_1], [DATE_3]…   │
│   Never a name, never a chart number. Not "asked not to look" — not sent.│
└──────────────────────────────────────────────────────────────────────────┘
```

### One request, end to end

The branch in the middle is the whole product. It reads off the destination and
nothing else — see [section 10](#10-workspaces-and-the-one-rule).

```
                       POST /api/process-note  (sealed envelope)
                                    │
                    ┌───────────────▼───────────────┐
                    │ auth()      valid session?    │──no──▶ 401 UNAUTHENTICATED
                    └───────────────┬───────────────┘
                    ┌───────────────▼───────────────┐
                    │ acquireLock()   slot free?    │──no──▶ 429 COMPUTE_BUSY
                    └───────────────┬───────────────┘        (+ what it is doing)
                                    │           the response is an SSE stream
                    ┌───────────────▼───────────────┐        from here on
                    │ openRequest()  RSA-unwrap the │──fail─▶ DECRYPT_FAILED
                    │ AES key, then AES-GCM open it │        (client retries once
                    └───────────────┬───────────────┘         with a fresh key)
                    ┌───────────────▼───────────────┐
                    │ parse payload, re-clamp every │──bad──▶ PROMPT_INVALID
                    │ number, budgetedText+measure  │──long─▶ TOO_LONG
                    └───────────────┬───────────────┘
                                    │
                 ┌──────────────────┴───────────────────┐
        cloud    │   isLocalDestination(payload.model)  │   local
     ◀───────────┘                                      └────────────▶
┌────────────────────────────────┐          ┌──────────────────────────────┐
│ regex pass   ─┐                │          │  (no scrub — nothing left    │
│  (switchable) ├─▶ TokenVault   │          │   the box, so there is       │
│ local NER    ─┘   ▲            │          │   nothing to protect it from)│
│  (mandatory, fails closed)     │          │                              │
│                   │            │          │                              │
│ vault.deidentify(note)         │          │ the note, exactly as typed   │
│      = [PATIENT_1] [MRN_1] …   │          │                              │
└────────────┬───────────────────┘          └───────────────┬──────────────┘
             │                                              │
   ┌─────────▼──────────┐                       ┌───────────▼────────────┐
   │ Gemini, walking    │                       │ LM Studio, streaming   │
   │ down the ladder on │                       │ deltas back sealed.    │
   │ quota/overload     │                       │ NEVER falls back to    │
   │                    │                       │ the cloud on failure.  │
   └─────────┬──────────┘                       └───────────┬────────────┘
             │                                              │
   ┌─────────▼──────────┐                                    │
   │ vault.rehydrate()  │  real names back, on this Mac      │
   │ unresolvedTokens() │  drift signal for the inspector    │
   └─────────┬──────────┘                                    │
   ┌─────────▼──────────┐                                    │
   │ AuditLog row —     │  de-identified text ONLY           │
   │ a failed write     │                                    │
   │ never loses a note │                                    │
   └─────────┬──────────┘                                    │
             └───────────────────┬──────────────────────────┘
                    ┌────────────▼─────────────┐
                    │ sealResponse() with the  │
                    │ SAME ephemeral AES key   │──▶ event: result
                    └────────────┬─────────────┘
                    ┌────────────▼─────────────┐
                    │ finally: purgeVault(),   │  runs on every path,
                    │ vault.clear(),           │  including a client
                    │ releaseLock()            │  that hung up
                    └──────────────────────────┘
```

## 2c. Module reference — what goes in, what comes out

One row per exported entry point, in dependency order. "May see" is the strongest
data a module is ever handed; where it says **raw PHI**, that module is inside the
trust boundary and the invariant beside it is what keeps it there.

### Transport and identity

#### `src/lib/crypto.ts` — isomorphic WebCrypto
Ships to the **browser**, so it must contain no Node imports. Same functions run
on both ends of the tunnel, which is why there is one implementation of the
envelope rather than two that can drift.

| Function | In | Out |
| --- | --- | --- |
| `sealRequest(publicKeySpkiB64, plaintext)` | the server's public key, the note | `{ envelope: {encryptedData, encryptedKey, iv}, aesKey }` — the key stays in browser memory |
| `openResponse(aesKey, envelope)` | the retained AES key, the sealed reply | plaintext |
| `openRequest(privateKey, envelope)` | server private key, the envelope | `{ plaintext, aesKey }` — the same ephemeral key, reused to seal the reply |
| `sealResponse(aesKey, plaintext)` | that key, the re-hydrated note | `{ encryptedData, iv }` (no `encryptedKey`: the client already has it) |
| `bytesToBase64` / `base64ToBytes` | bytes / base64 | base64 / bytes |

**May see:** raw PHI, on both sides. **Never:** logs anything.

#### `src/lib/keystore.ts` — the Mac's RSA identity
| Function | In | Out |
| --- | --- | --- |
| `getServerKeys()` | — | `{ privateKey, publicKeySpki, keyId }`, memoised per process |

Reads or creates `./.keys/<KEY_STORE_FILE>` at mode `0600`. **Persisted on
purpose:** a rotating key silently invalidates every public key an open browser
tab is holding. The file contains no PHI — only the server's own key.

#### `src/lib/auth.ts` — Google sign-in
| Function | In | Out |
| --- | --- | --- |
| `auth()` | the request's cookies | `Session \| null` — a real database lookup |
| `isAllowed(email)` | an email | `boolean`, **false when the allowlist is empty** |
| `allowlistConfigured()` | — | `boolean`, for the sign-in page's "not configured yet" notice |
| `handlers` | — | the `GET`/`POST` Auth.js route handlers |

The `session` callback returns only `{id, name, email, image}`. Spreading the
adapter's row would publish `sessionToken` in a JSON response readable by
JavaScript, defeating the httpOnly cookie it lives in.

#### `src/lib/dev-login.ts` — the password bypass's rules
| Function | In | Out |
| --- | --- | --- |
| `devLoginEnabled()` | — | `boolean` — off unless `DEV_LOGIN_ENABLED=true` |
| `devLoginAllowedFromHost(host)` | the `Host` header | `boolean` — localhost only unless `DEV_LOGIN_ALLOW_REMOTE` |
| `sessionCookieName()` | — | `{name, secure}` derived from `AUTH_URL`, not from the transport |

That last one matters more than it looks: behind a tunnel the browser is on
HTTPS while the container is spoken to over HTTP, so a cookie named from the
connection is a cookie Auth.js never reads, and every request is 401 with no
other symptom.

#### `src/middleware.ts` — the cheap filter
| In | Out |
| --- | --- |
| every request not matching `_next/static`, `_next/image`, `favicon.ico` | `next()`, a redirect to `/signin`, or 401 JSON |

Checks that a session **cookie exists**, never that it is valid. It is a filter
for the unauthenticated, **not** an authorisation check — see
[section 11](#11-authentication).

### The de-identification core

#### `src/lib/memory-cache.ts` — `TokenVault` and the TTL store
**The only place raw PHI lives on the server, and it lives in RAM.**

| Member | In | Out |
| --- | --- | --- |
| `assign(category, original, source)` | `"PATIENT"`, `"林淑惠"`, `"llm"` | `"[PATIENT_1]"`; the same input always returns the same token |
| `knows(original)` | a span | `boolean` — stops the NER pass double-tokenising what the rules already took |
| `deidentify(text)` | text with identifiers | the same text with tokens, **one pass**, longest original first |
| `rehydrate(text)` | text with tokens | the same text with identifiers, one pass, longest token first |
| `unresolvedTokens(text)` | the re-hydrated note | tokens the model failed to reproduce — a drift signal |
| `summary(present?)` | optionally, the text to filter by | `{token, category, preview, source}[]`, previews **masked** (`陳*明`) |
| `clear()` | — | — |
| `storeVault(id, vault)` / `purgeVault(id)` / `vaultCount()` | — | — |

Both substitutions are **one pass over an alternation**, and that is load-bearing
rather than tidy: a chain of `split`/`join` re-reads text it has already written,
so a one-character span processed last landed *inside* a placeholder a longer one
had produced (`[MRN_1]` → `[MRN_[OTHER_ID_1]]`), and a mangled placeholder never
rehydrates. `verify-pipeline` section 6b pins this.

**Never:** written to Postgres, to a file, to a log line, or to telemetry.

#### `src/lib/scrubber-regex.ts` — Pass A, deterministic
| Function | In | Out |
| --- | --- | --- |
| `scrubWithRegex(input, vault)` | raw text, a vault to populate | `{text, hits: Record<label, count>, totalReplacements}` |
| `isValidTaiwanId(id)` | a candidate ID | `boolean` — informational only; redaction never depends on it |
| `REGEX_RULES` | — | the ordered rule list. **Order is load-bearing.** |

Deliberately over-eager: a false positive is an odd-looking note, a false
negative is a disclosure. The route uses this for the **vault it populates**, not
for the text it returns — see [section 7](#7-pass-b--the-local-ner-pass).

#### `src/lib/scrubber-llm.ts` — Pass B, probabilistic
| Function | In | Out |
| --- | --- | --- |
| `scrubWithLlm(input, vault, onToken?, sampling?)` | the **original** narrative, a vault, a delta callback, sampling | `{text, entities, hallucinated, rejectedClinical, degraded, latencyMs}` |
| `resolveLocalModel()` | — | the model LM Studio actually has loaded; `LMSTUDIO_MODEL` is a fallback, never an override |
| `checkLmStudioHealth()` | — | `{online, models, busy?, error?}` |
| `lastKnownLmStudioHealth()` | — | the cached answer, for callers that must not probe a busy server |
| `NER_SYSTEM_PROMPT` | — | the prompt itself, so `/api/prompt-config` can show it verbatim |

Throws `LocalScrubUnavailableError` when LM Studio cannot answer, unless
`ALLOW_DEGRADED_SCRUB=true`. **Fails closed by default.**

#### `src/lib/lmstudio.ts` — where the local model lives
| Function | Out |
| --- | --- |
| `lmStudioBaseUrl()` | `LMSTUDIO_BASE_URL`, trailing slashes stripped |
| `lmStudioTimeoutMs()` | 90 s — the NER pass writes a short JSON array |
| `lmStudioFormatTimeoutMs()` | 240 s — formatting writes a whole chart entry |

#### `src/lib/limits.ts` — the input budget, shared by both sides
| Function | In | Out |
| --- | --- | --- |
| `measure(text)` | any text | `{chars, words, overSoft, overHard, fraction}` |

`words` counts Latin words **plus CJK characters individually**, because CJK is
unspaced and a whitespace split reports a 400-character Chinese note as "1 word".
`HARD_CHAR_LIMIT` (20,000) is a **safety** limit: past it the local model starts
missing names.

#### `src/lib/placeholders.ts` — the rules that make the round trip work
| Function | In | Out |
| --- | --- | --- |
| `withPlaceholderKernel(systemInstruction)` | any cloud-bound system instruction | it, plus `PLACEHOLDER_KERNEL` |

Appended to every cloud-bound custom prompt and **is not a setting**: a model
that renumbers `[DATE_2]` leaves a note that cannot be reassembled.

### Deciding what a run does

#### `src/lib/workspace.ts` — the whole model
The rule reads off **one variable**, and every other component asks this module
rather than re-deriving it.

| Function | In | Out |
| --- | --- | --- |
| `deidentifies(localDestination)` | the destination | `!local` — the one rule |
| `audits(localDestination)` | the destination | the same answer, necessarily |
| `patternScrubs(local, requested)` | destination + the switch | whether Pass A runs |
| `stagesFor(local, patternScrub?)` | the destination | the stage ids this run will emit (3 local, 6–7 cloud) |
| `joinForScrub(system, prompt)` | a prompt run's two bodies | the single string the NER pass reads |
| `budgetedText({workspace, narrative, promptRun, localDestination})` | the whole run | the text `measure()` should be applied to |
| `normaliseSampling(raw)` / `normaliseDeidSampling(raw)` | anything off the wire | a clamped `Sampling` |
| `normalisePromptRun(raw)` | anything off the wire | `{systemInstruction, prompt}`, or throws `PromptRunError` |

`budgetedText` exists because the browser counter and the route must agree. On a
cloud prompt run it returns the two bodies joined, since that is what the local
model is actually shown; sizing the prompt alone let two fields, each legally
under its own cap, hand the model twice what it can read.

#### `src/lib/concurrency.ts` — one compute slot
| Function | In | Out |
| --- | --- | --- |
| `acquireLock()` | — | `LockHandle \| null`; reclaims a holder older than 5 minutes |
| `setStage(handle, stage, detail?)` | the handle, a stage id, **non-identifying** detail | — |
| `releaseLock(handle)` | the handle | — ; a stale handle is ignored |
| `currentActivity()` | — | `{stage, label, detail, stageElapsedMs, totalElapsedMs} \| null` |

`detail` is non-identifying **by contract** — `"1,240 characters"`, never note
content. It is read by clients queued behind a run they cannot see.

### Producing the answer

#### `src/lib/gemini.ts` — the cloud layer
| Function | In | Out |
| --- | --- | --- |
| `assemblePrompt({format, template, narrative, skeleton})` | the pieces | the exact user-message text, so a preview cannot drift from what is sent |
| `formatClinicalNote(deidText, format, instructions, sampling, credentials, onFallback?, startModel?)` | **placeholders only**, plus whose quota pays | `{text, model, fallbacks, latencyMs}` |
| `runPromptOnCloud({systemInstruction, prompt, sampling, credentials, …})` | **placeholders only** | the same shape |
| `verifyGeminiKey(apiKey)` | a key | `{ok, usable, missing, error?}` — `models.list`, which spends no generation quota |
| `getClient(apiKey?)` | a key, or nothing | a fresh client for a clinician's key; the memoised one for the instance's |
| `systemInstruction()` / `builtInFormatInstruction(f)` | — | the compiled-in text, for `/api/prompt-config` |
| `isNoteFormat(v)` | anything | type guard |

Throws `GeminiUnavailableError` with a `kind` of `quota` / `overloaded` /
`model` / `auth`. The first three are solved by another model; the last is not.

#### `src/lib/model-registry.ts` — the ladder and what is spendable
| Function | In | Out |
| --- | --- | --- |
| `modelLadder()` | — | the ordered `ModelSpec[]`, or `GEMINI_MODEL_LADDER` |
| `chainFrom(quota, start?)` | a quota and a starting rung | the rungs to try, retired ones dropped |
| `availability(quota)` | a quota | `ModelAvailability[]` for the selector |
| `markUnavailable(quota, model, reason, opts)` | an observed refusal | — ; written through to `ModelCooldown` |
| `markAvailable(quota, model)` | a model that just answered | — |

Availability is **observed, never predicted**: no API reports remaining quota, so
a rung is spent only once Google has actually refused it — and every entry is
scoped to the quota that earned it. See
[section 8d](#8d-bring-your-own-gemini-key).

#### `src/lib/gemini-key.ts` — a clinician's own key
Isomorphic. The editor masks with the same function the route fingerprints with,
so the two cannot disagree about which key is which.

| Function | In | Out |
| --- | --- | --- |
| `normaliseGeminiKey(raw)` | anything pasted | the trimmed key, or throws `GeminiKeyError` naming the paste error |
| `looksLikeGeminiKey(raw)` | anything | `boolean`, for a live editor that should not shout while typing |
| `maskGeminiKey(key)` | a key | `AQ.Ab8RN…Wvpg` — enough to recognise, never enough to use |
| `quotaFingerprint(key?)` | a key, or nothing | 16 hex characters, or the literal `instance` |

**May see:** a third-party credential. **Never:** stores it, logs it, or lets it
reach the audit row. Only `quotaFingerprint`'s output ever reaches Postgres.

The shape check is deliberately loose — see
[section 8d](#8d-bring-your-own-gemini-key) for the key format that broke the
strict one.

#### `src/lib/local-format.ts` — the local destination
| Function | In | Out |
| --- | --- | --- |
| `formatWithLocalModel(text, format, instructions, sampling, onToken?)` | the note as the model will see it — **raw**, because a local run is not de-identified | `{text, model: "local:…", fallbacks: [], latencyMs}` |
| `runPromptLocally({systemInstruction, prompt, sampling, onToken?})` | the raw console | the same shape |
| `localModelLabel(model)` | `google/gemma-4-12b` | `local:google/gemma-4-12b` — so an audit row can never be misread |

Throws `LocalFormatError` and **never falls back to the cloud**. This is the one
place in the pipeline where a failure is deliberately not routed around.

### Storage

#### `src/lib/db.ts` — the Prisma singleton
| Export | Out |
| --- | --- |
| `prisma` | a `Proxy` that constructs the client on first property access |

Lazy on purpose: building the image has no database and no `DATABASE_URL`, and
Next collects route data at build time.

#### `src/lib/prompts.ts` — saved routines, both workspaces
| Function | In | Out |
| --- | --- | --- |
| `listTemplates(userId)` | a user | their routines plus any shared (ownerless) ones |
| `createTemplate(userId, input)` / `updateTemplate(userId, id, input)` | a draft | the saved row, or throws `PromptValidationError` |
| `deleteTemplate(userId, id)` / `getTemplate(userId, id)` | an id | scoped to the owner **or** to ownerless rows |

`assertNoPii` runs every saved body — instruction *and* system instruction —
through the deterministic scrubber and refuses anything that matches. A routine
lives in Postgres forever.

### The wire

#### `src/lib/pipeline-client.ts` — the client half
Isomorphic: the UI and every script drive it identically, which is why the
scripts test the real path rather than a parallel one.

| Function | In | Out |
| --- | --- | --- |
| `runPipeline<T>(opts)` | `{text, format, promptId?, model?, workspace?, promptRun?, sampling?, deidSampling?, patternScrub?, geminiApiKey?, onProgress?, onStream?, onSealed?, headers?, baseUrl?, signal?}` | the decrypted `ProcessNoteResult` |
| `verifyGeminiKey(apiKey, opts?)` | a key | `{ok, usable, missing, error?}`, sealed both ways |
| `isLocalDestination(model)` | a model id | `model === "local"` — route and UI agree through one predicate |
| `stageTitle(stage, local)` / `stageLocus(stage, local)` | a stage id | its label and which trust boundary to draw it in |

Throws `ComputeBusyError` (carrying what the box is doing) or `PipelineError`
(carrying the server's `code`). On `DECRYPT_FAILED` it re-fetches the public key
past any cache and retries **once**.

### HTTP surface

Every route below runs on `runtime = "nodejs"`, and `next.config.ts` puts
`Cache-Control: no-store` on all of `/api/*` — plus `CDN-Cache-Control` and
`Cloudflare-CDN-Cache-Control`, because an edge once cached `/api/auth/csrf` and
replayed it with `Set-Cookie` stripped.

| Route | In | Out | Auth |
| --- | --- | --- | --- |
| `GET /api/health` | — | `{ok: true}` | **public** — the container healthcheck, and it reveals nothing |
| `GET /api/keys` | — | `{publicKey, keyId, algorithm, hash, modulusLength, format}` | cookie only — **public material by design** |
| `GET /api/status` | — | compute slot, LM Studio, database, Gemini config, vault count, build id, dev-login flags | `auth()` |
| `GET /api/models` | `?quota=` (a fingerprint, or absent) | `{models, default, quota, instanceKey}` | `auth()` |
| `POST /api/gemini-key` | a sealed `CryptoEnvelope` containing `{apiKey}` | a **sealed** `{ok, usable, missing, error?}` | `auth()` |
| `GET /api/prompt-config` | — | every prompt both models are given, read-only | `auth()` |
| `POST /api/process-note` | a sealed `CryptoEnvelope` | **SSE**: `progress`, `stream` (sealed), then one `result` (sealed) or one `error` | `auth()` |
| `GET /api/history` | `?q=&format=&cursor=` | de-identified rows, 25 a page, scoped to the caller | `auth()` |
| `DELETE /api/history` | `?id=` | `{ok}`; scoped by `userId` so nobody can delete another's row | `auth()` |
| `GET/POST /api/prompts` | a routine draft | the library, or the created row (422 on PII, 409 on a name clash) | `auth()` |
| `PATCH/DELETE /api/prompts/[id]` | a draft / nothing | the updated row / `{ok}` | `auth()` |
| `POST /api/auth/dev-login` | `{password}` | a real Session cookie | 404 unless enabled, 403 off-localhost |
| `GET/POST /api/auth/[...nextauth]` | — | Auth.js | **public** |

### Browser

| File | Role |
| --- | --- |
| `src/app/layout.tsx` | fonts, metadata (`robots: noindex`), and the inline script that applies the stored theme **before first paint** |
| `src/app/page.tsx` | the entire UI: one client component plus seven drawers |
| `src/app/theme-toggle.tsx` | three-state theme, owned by the DOM and subscribed to via `useSyncExternalStore` |
| `src/app/signin/page.tsx` | Google button, allowlist diagnostics, error translation |
| `src/app/signin/dev-login-form.tsx` | the password form, rendered only when the bypass is enabled |
| `src/lib/utils.ts` | `cn()` — `clsx` + `tailwind-merge` |

## 3. The pipeline, stage by stage

`src/app/api/process-note/route.ts`. Everything below happens inside one POST
handler; the response is a Server-Sent Events stream so the clinician watches
real work rather than a spinner.

```
auth → lock → decrypt → parse+clamp → budget → regex → NER → vault
     → format → re-hydrate → audit → seal → (finally) purge + unlock
```

The format stage goes to Gemini, or to the model already loaded in LM Studio
when the clinician picks the local destination — and **that choice alone decides
what happens either side of it**. Bound for Google: both scrub passes run, the
answer is re-hydrated, and a de-identified row is written. Staying on this Mac:
none of the three happen. See [section 8b](#8b-the-local-destination) and
[section 10](#10-workspaces-and-the-one-rule).

**0. Identity.** `auth()` first, before anything else. An unauthenticated caller
must not even be able to take the compute lock — otherwise an anonymous request
is a denial-of-service against the ward.

**1. Lock.** `acquireLock()`. On refusal the route answers **429** with
`code: COMPUTE_BUSY` and the current activity, plus `Retry-After: 5`. The server
refuses rather than queues; the queue is the client's job.

**2. Decrypt.** Unwrap the ephemeral AES key with the server's RSA private key,
then open the envelope. A failure here emits `code: DECRYPT_FAILED`, which the
client treats as "my public key is stale" and retries once with a fresh key.

**3. Parse and clamp.** If the plaintext starts with `{` it is parsed as a
payload object; otherwise the whole plaintext is the narrative. The fields are
`text`, `format`, `promptId`, `model`, `workspace`, `promptRun`, `sampling`,
`deidSampling` and `patternScrub`. Everything numeric is re-clamped here by
`normaliseSampling` / `normaliseDeidSampling`, and `promptRun` is re-validated
by `normalisePromptRun` — **the browser's own bounds do not count**, because the
payload is assembled client-side and a hand-rolled client can put anything in it.

**4. Input budget.** `measure()` from `limits.ts`, over whatever
`budgetedText()` says this run actually puts in front of the local model. Past
`HARD_CHAR_LIMIT` (20,000 characters) the request is refused with
`code: TOO_LONG`. This is a safety limit before a performance one: the local
model has a bounded context, and a note longer than it can attend to starts
*missing names*.

For a note that is the narrative. For a **cloud** prompt run it is the system
instruction and the prompt **joined**, because that is the single string the
de-identification pass reads. Budgeting the prompt alone let two fields, each
legally under its own 20,000-character cap, hand 40,000 characters to a model
that can only scan 20,000 reliably. For a **local** prompt run nothing is
scanned at all, so only the prompt is bounded.

**5-6. Both scrub passes**, if and only if this run is bound for Google — see
[sections 6](#6-pass-a--the-deterministic-scrubber) and
[7](#7-pass-b--the-local-ner-pass). Fails closed by default. The pattern pass
can be switched off; the NER pass cannot.

**Neither pass rewrites the text.** Both record what they find in the vault, and
`vault.deidentify()` applies the lot afterwards, longest original first. That
ordering is why the two compose instead of shredding each other's work, and why
the NER pass gets to read the note as prose — see
[section 7](#7-pass-b--the-local-ner-pass).

**7. Vault parked.** `storeVault(sessionId, vault)` puts the map in the TTL store
under a fresh UUID. The store is deliberately **write-only** — nothing reads a
vault back out, because a reader could only exist to hand raw PHI to a *later*
request. It buys two things: a handler that dies before its `finally` still has
its mapping wiped by the sweeper within ten minutes, and `/api/status` can
report how many identifier maps are in memory right now.

**8. Format.** `formatClinicalNote()`, or `formatWithLocalModel()` when the
payload's `model` is the `local` sentinel. Only placeholders cross the wire on
the cloud path, and nothing crosses it at all on the local one. Model downgrades
stream as progress events while they happen; the local path has none to make.

**9. Re-hydrate.** `vault.rehydrate(gemini.text)`, then
`vault.unresolvedTokens()` records any placeholder the model failed to reproduce
— a drift signal, surfaced in the inspector.

**10. Audit.** One row of **de-identified text only**. A failed audit write is
logged and streamed as `audit: failed` but never destroys the note — a dead audit
database must not cost a clinician their work.

**11. Seal.** The result object is sealed with the *same* ephemeral AES key and
emitted as the single `result` event. Progress events never carry note content.

**12. `finally`.** `purgeVault()`, `vault.clear()`, `releaseLock()`, close the
stream. This block runs on every path, including client disconnect.

Measured on the live stack (M4 / 16 GB, `gemma-4-12b`, 80-character note):

```
decrypt        <1 ms
regex          <1 ms      3 identifiers
ner           4757 ms     3 names/places
cloud        62235 ms     gemini-3.6-flash
rehydrate      <1 ms      6 tokens restored
audit            4 ms
seal           <1 ms
```

The two model calls are the entire cost. Everything Airlock itself does is
sub-millisecond.

## 4. Cryptography

`src/lib/crypto.ts` (isomorphic) and `src/lib/keystore.ts` (server only).

**Envelope.** Per request:

- a fresh **AES-256-GCM** key, generated in the browser, 96-bit nonce;
- that key wrapped with the server's **RSA-OAEP-2048 / SHA-256** public key;
- ciphertext, wrapped key and IV, all base64, as the POST body.

The reply is sealed with the *same* AES key and a *fresh* IV. The reply contains
re-hydrated PHI, so it must be opaque in transit too.

**Key identity.** `keystore.ts` generates the keypair once and persists it to
`<cwd>/.keys/<KEY_STORE_FILE>` with mode `0600`, memoised on `globalThis` so a
dev hot-reload does not rotate it. `keyId` is the first 16 hex characters of the
SHA-256 of the SPKI, which lets a client notice rotation.

**This must persist.** A regenerated keypair breaks decryption for every browser
tab still holding the old public key. In Docker it is bind-mounted from
`$AIRLOCK_DATA_DIR/keys`.

**What holds.** Cloudflare terminates TLS at its edge and is treated as hostile.
It relays ciphertext both ways. Gemini receives placeholders. Postgres stores
de-identified text.

**What does not hold.** `/api/keys` serves the public key over the same tunnel it
protects. Someone who controls that edge can substitute their own key and read
everything. This design defeats **passive** inspection and incidental logging,
not an active edge adversary. To close it, pin the key: copy the value from
`/api/keys` into `NEXT_PUBLIC_PINNED_KEY_ID` and have the client refuse any
`keyId` that does not match, or distribute the SPKI out of band.

## 5. The token vault

`src/lib/memory-cache.ts`. This is the PDPA-critical module.

Full signatures are in
[section 2c](#2c-module-reference--what-goes-in-what-comes-out).

Invariants that matter:

- **The same identifier always maps to the same token.** A patient named five
  times stays one referent for the cloud model instead of five strangers.
- **Both substitutions are ONE pass over an alternation, longest first.** This
  is not tidiness. `rehydrate` sorts by token length so that replacing `[MRN_1]`
  cannot corrupt `[MRN_11]`; `deidentify` sorts by original length so that a
  surname cannot be replaced before the full name it sits inside. And both do it
  in a single `String.replace` rather than a chain of `split`/`join`, because a
  chain re-reads text it has already written: a one-character span processed
  last landed *inside* a placeholder a longer one had produced, turning
  `[MRN_1]` into `[MRN_[OTHER_ID_1]]`. A mangled placeholder never rehydrates,
  so that is a broken note rather than a cosmetic bug. `verify-pipeline`
  section 6b pins it.
- **Previews are masked.** `mask()` keeps only the first and last character:
  `A123456789` becomes `A********9`. The inspector never shows a full identifier.
- **The TTL store expires at 10 minutes**, swept every 30 seconds, and the sweep
  timer is `unref()`d so it cannot hold the process open.
- **The TTL store is write-only, on purpose.** Nothing reads a vault back out
  and nothing should: re-hydration happens inside the request that built the
  mapping, so a reader could only exist to hand raw PHI to a *later* request.
  What it buys is a backstop — a handler that dies before its `finally` still
  has its mapping swept within ten minutes — and a countable number for the
  status badge.
- **Contents are never persisted.** Not to Postgres, not to a file, not to a log
  line, not to telemetry.

## 6. Pass A — the deterministic scrubber

`src/lib/scrubber-regex.ts`. High precision, runs first, deliberately over-eager:
a false positive costs a slightly odd note, a false negative leaks PHI.

**Rule order is load-bearing** and the file says so. Rules fire in array order:

| # | Rule | Catches | Why it sits here |
| --- | --- | --- | --- |
| 1 | National ID / ARC | `A123456789`, ARC formats | Most specific numeric shape |
| 2 | Phone number | mobile, landline, `+886`, `(02)` forms | Must precede the MRN rule, which would eat `27123456` |
| 3 | Date (Gregorian / ROC) | `2024/08/23`, `113-08-23` | — |
| 4 | Date (CJK) | `113年8月23日` | — |
| 5 | Name beside a staff code | the CJK name after `DOC…` | **Must run before rule 6**, which would replace the anchor it looks behind for |
| 6 | Staff code | `DOC1234X` | Neither 7–8 digits nor a word |
| 7 | Ward and bed | `A092- 36` | — |
| 8 | Date (month/day, no year) | `1/21`, `2/3` | Bounded to real months/days; refuses doses |
| 9 | Medical record number | bare `\d{7,8}` | **Last** — it is the bluntest instrument here |

Every rule gets a **fresh `RegExp`** per pass, because the module-level literals
carry `/g` `lastIndex` state and would otherwise skip matches on the second call.

### The pattern pass is a switch, not a law

`patternScrub`, cloud runs only — a local run de-identifies nothing, so there is
nothing to switch off, and the control is disabled and says so.

It defaults **on**, and a payload that omits it gets on, because on is the safer
of the two. Off, the local model alone is responsible for every identifier
including the structured ones these rules would have caught for certain: the
rules are deterministic where the model is probabilistic.

The argument for offering it at all is that this pass is over-eager by design,
and on some notes the over-eagerness costs more than it saves — a bed number
reading as a month/day, a seven-digit accession reading as an MRN. The argument
against is that "the model catches them anyway" is a measured average, not a
guarantee.

So it is marked while it is off (an amber notice above the input, an amber chip
on the finished note) and recorded on the audit row as
`AuditLog.patternScrub`, defaulted true so every row written before the switch
existed says what was true of it. A note whose de-identification worked
differently has to be traceable as such.

### Shapes that leaked in real use

These rules exist because notes got past the earlier ones. Kept here because the
list is the honest statement of what this layer does and does not catch:

| Shape | Example | Why it was missed |
| --- | --- | --- |
| Staff code | `DOC1234X` | Neither 7–8 digits nor a word |
| Name beside a staff code | `DOC1234X   林建宏` | In a tabular header there is no sentence for the NER to recognise a name by |
| Ward-bed cell | `A092- 36` | Not the `8B病房` form the NER was shown |
| Month/day, no year | `1/21`, `2/3-2/5` | The date rule needs three components |

Month/day is deliberately bounded to real months and days and refuses anything
that reads as a dose (`1/2 tab`, `1/2 vial`), because mangling a paediatric dose
is a patient-safety problem rather than a formatting one. `152/94 mmHg` and
`(L/R) 5+/6+` are unaffected.

**This layer is not a guarantee.** It catches shapes it has been taught.

`isValidTaiwanId()` implements the national-ID checksum but is **not** used for
redaction decisions — over-redaction is the safe failure mode, so a shape match
is enough.

## 7. Pass B — the local NER pass

`src/lib/scrubber-llm.ts`. Talks OpenAI-compatible chat completions to LM Studio
on `LMSTUDIO_BASE_URL` (default `http://localhost:1234/v1`).

### The prompt asks for more than it needs

`NER_SYSTEM_PROMPT` asks for the semantic identifiers regex cannot see — names,
wards, employers, addresses — **and also for the structured ones the regex pass
already covers**. That overlap is deliberate: regex catches shapes it was taught,
and a format it has never met (a passport, an insurance number) has no rule.

The category list is a **suggestion, not a whitelist**. A model that meets an
identifier fitting nothing listed is told to coin its own tag — `PASSPORT`,
`VEHICLE_PLATE`, `BANK_ACCOUNT`. Nothing downstream needs the vocabulary: a token
is a label plus a number, and re-hydration is a literal lookup.

What is **not** negotiable is the shape. `normaliseCategory()` folds anything
outside `[A-Z_]` away and caps the result at 24 characters before it reaches the
vault, so a coined label can never collide with clinical text or break the
placeholder guard `/^\[[A-Z_]+_\d+\]$/`.

Measured on `gemma-4-12b` over a 17-identifier synthetic note, three trials,
temperature 0:

| Prompt | LLM alone | regex → NER |
| --- | --- | --- |
| Six semantic categories (previous) | 9/17 | 15/17 |
| Open vocabulary (current) | **17/17** | **17/17** |

No clinical term was wrongly redacted in either arm.

### It reads the ORIGINAL text, and that is load-bearing

The NER pass is shown the note as written, not the pattern-scrubbed version.
Feeding it text already dense with `[MRN_1]`-style placeholders measurably costs
recall — the model is reading prose, and prose full of bracketed tokens is not
what it was trained on.

Measured on a five-line ward note, same note both ways:

| | patterns applied first | patterns recorded, NER reads the original |
| --- | --- | --- |
| Identifiers caught | 6 — **the attending's name leaked** | 8, nothing leaked |

That was a real leak, on the default path, found by building the switch that
lets you turn the pattern pass off. The deterministic pass still runs first; it
just populates the vault instead of rewriting the input.

A second benefit falls out of it. `deidentify` replaces the longest original
first, so where both passes see the same text the model's semantically correct
span wins: a bed like `08-2床` is tagged `WARD` by the model rather than left as
the `DATE` the month/day rule made of `08-2`. `TokenVault.knows()` stops the
same string being assigned twice under two categories, which would otherwise
make re-hydration order-dependent.

### The two passes deliberately overlap

With the pattern rules on, the model still sees — and often returns — the MRN
and the dates they already caught. That is not waste to be optimised away; it
is the point. The rules know **shapes** and the model knows **meaning**, and
each catches things the other cannot: a passport number has no rule, and a
seven-digit accession has no meaning the model can distinguish from an MRN.
Asking only one of them would mean trusting it alone.

What the overlap must not do is redact anything twice.
`TokenVault.knows(span)` drops any span already assigned under some category,
so one identifier gets one token however many passes found it. Where the spans
merely *overlap* rather than match — the rules take `08-2`, the model takes
`08-2床` — `deidentify` replaces the longest original first, so the model's
semantically correct span wins and the shorter token is simply never used.

`summary()` therefore lists only tokens that actually appear in the text it is
given. Without that filter the redaction list showed entries for tokens the
note does not contain, which reads as a redaction that did not happen.

### Guards on what comes back

Applied in this order to each returned span:

1. **Verbatim check** — `input.includes(span)`. A hallucinated span would create
   a token that never matches and never re-hydrates. Counted as `hallucinated`.
2. **Placeholder guard** — never re-redact a `[CATEGORY_N]` emitted by pass A.
3. **Shape guard** — reject a span containing a newline, or longer than 200
   characters. A newline is the real signal for "the model returned the whole
   paragraph as one name"; a bare length cap is not. This was 60 once, and it
   silently discarded correctly-identified long addresses.
4. **Clinical stop-list** — `CLINICAL_STOPLIST` refuses lab analytes, eponymous
   diseases, scales and devices (`Troponin I`, `Crohn`, `Glasgow`, `Foley`).
   Counted as `rejectedClinical`. Defence in depth; the prompt is the primary
   control.
5. **Dedupe**, then **sort longest span first** before replacement — replacing a
   one-character surname before the full name would shred the latter.

### Transport quirks it handles

- **`json_schema` unsupported** — a `400` retries once with no `response_format`,
  for older LM Studio builds and GGUFs without grammar support.
- **Reasoning models** — a reasoning model with a schema attached answers HTTP
  200 with the whole object in `reasoning_content` and `content` empty. The 400
  branch never fires, so an empty `content` also retries once without the schema.
  Without this the pipeline fails closed on every note and the model looks broken.
- **Truncation** — `max_tokens` defaults to 6144. Too low truncates the JSON
  mid-array, which fails closed and reads to the user as an unexplained 503.
- **Timeout** — `LMSTUDIO_TIMEOUT_MS`, default 90 s, via `AbortController`.

### Fail-closed

If LM Studio is unreachable, or returns nothing parsable,
`LocalScrubUnavailableError` is thrown and the note is **not** sent to the cloud.
`ALLOW_DEGRADED_SCRUB=true` opts into regex-only scrubbing instead; the result
carries `degraded: true` and the UI shows a standing warning.

### Health probing

LM Studio **serialises requests**: `/v1/models` blocks while the model is
generating. So:

- `/api/status` calls `checkLmStudioHealth()` only when the compute lock is free;
  while busy it returns `lastKnownLmStudioHealth()` from a cache, flagged
  `busy: true`. Without this the status badge would read "LM Studio down" for the
  duration of every note.
- A probe that fails within 10 minutes of a known-healthy one means "busy", not
  "down".
- `loadedLmStudioModel()` reports what LM Studio *actually has loaded*, reusing a
  60-second cache, for the read-only prompt view. `LMSTUDIO_MODEL` is what each
  request *asks for*; the two can drift, and when they do the Prompts drawer says
  so rather than quietly naming one of them.

## 8. The cloud layer and the model ladder

`src/lib/gemini.ts` and `src/lib/model-registry.ts`.

### Prompt assembly

`assemblePrompt()` is used by both the real request and any preview, so what the
UI shows cannot drift from what is sent. Precedence, weakest to strongest:

```
format skeleton  (built-in, or "Others" which has none)
  └─ saved routine  ("Departmental charting routine …")
       └─ the de-identified narrative
```

Both sit **below** the system instruction, whose placeholder rules outrank them:
a routine cannot talk the model into inventing a name. There is no third,
free-text layer any more — see
[what replaced what](#what-replaced-what).

### The ladder

Best first, ending on the lite models. On the free tier the lite models carry
**500 requests/day** against the flagships' 20 — the difference between "the tool
died at lunchtime" and "the tool kept working, in a lighter voice". Pro models
are deliberately absent: the free tier grants them zero quota, so they would only
ever be a button that fails. The 2.5-era models are absent because Google returns
`NOT_FOUND` for them on keys issued after their retirement.

`GEMINI_MODEL` picks the starting rung; `GEMINI_MODEL_LADDER` replaces the list
entirely. Both are per instance — a clinician bringing their own key gets the
same ladder, spent against their own allowance.

### Availability is observed, never predicted

No API reports remaining quota, so a rung is marked spent **only after Google has
refused it**. That observation is written to the `ModelCooldown` table so a
container restart does not forget and burn a request per rung rediscovering it.

It is scoped to the **quota** that earned it, not stored globally — see
[section 8d](#8d-bring-your-own-gemini-key). A refusal is a fact about one
Google allowance, and a global table let one exhausted key grey the flagship out
for everybody.

`translateGeminiError()` distinguishes the kinds of refusal, because they need
different answers:

| Google says | `kind` | Cooldown | Falls back? |
| --- | --- | --- | --- |
| `RESOURCE_EXHAUSTED` + `PerDay` | `quota` | until midnight US/Pacific | yes |
| `RESOURCE_EXHAUSTED` (burst) | `quota` | the `retryDelay` hint | yes |
| `UNAVAILABLE` / overloaded | `overloaded` | 30 s | yes |
| `NOT_FOUND` | `model` | until midnight; dropped from the ladder and the selector | yes |
| bad key / `PERMISSION_DENIED` | `auth` | none | **no** |
| empty response (safety filter) | — | none | **no** |

Auth failures and safety blocks are not solved by another model, so they fail
immediately.

**The downgrade is never silent.** It streams as a progress event
(`gemini-3.6-flash quota → gemini-3.5-flash`), the chip greys out live, and
`AuditLog.modelUsed` records the model that actually wrote the note. A lighter
model is a different clinical draft, so the clinician is told which one they are
reading.

## 8b. The local destination

`src/lib/local-format.ts`. The model selector offers one option that is not a
rung of the ladder: **Local**. Choosing it means the model already loaded in LM
Studio writes the note as well as reading it, and the request makes no outbound
call at all.

### Why it is not a third "mode"

The workspace decides *what* the model is asked. This decides *who answers* —
the same question the ladder already answers — so it lives in the same selector
and composes with either workspace unchanged. The wire contract is a sentinel in
the existing `model` field:

```ts
LOCAL_MODEL_ID = "local"        // src/lib/pipeline-client.ts
isLocalDestination(model)       // route and UI agree through one predicate
```

### What does not change

- **`assemblePrompt` is the same function**, so the format skeleton and the
  saved routine compose in the same precedence a cloud note gets.
- **The system instruction is the same one Gemini gets**, so the clinical rules
  that stop a model inventing findings apply here too.

### What does change, and it is the point

**Nothing is de-identified, and nothing is written down.** The rule in
`workspace.ts` reads off the destination alone: a local run has no cloud
boundary to protect and no de-identified copy of itself to store, so neither
scrub pass runs and no audit row is written.

This is a reversal of the original design, which ran both passes locally on the
grounds that the audit log's invariant should hold everywhere. It does still
hold — by the audit log not being written at all, rather than by writing
something and hoping it is safe. The consequence is stated on screen while the
option is selected: **local runs do not appear in History.**

Because nothing was replaced, there is also nothing to re-hydrate and no
placeholder kernel to carry. `unresolvedTokens` is empty and `redactions` is an
empty list, which is the honest answer rather than a missing one.

### What it costs

The formatting model is whatever is loaded locally, so the draft is generally
weaker than a Flash model. A local run holds the single compute slot for **one**
inference, not two, because the de-identification pass does not run.

Measured on `gemma-4-12b` over a short ward note, once the model is warm — the
scrub figures are what a *cloud* run pays, shown for comparison:

```
scrub (regex + NER)   5.5 – 7.5 s     cloud runs only
format (local)       12   – 13.5 s
```

The first run after LM Studio changes model pays a one-off load — 17.5s on the
de-identification pass in one measurement — which is why nothing should be
asking it for a model other than the one already loaded.

### It never falls back to the cloud

`LocalFormatError` is surfaced as `code: LOCAL_FORMAT_FAILED` and the run ends
there. Quietly escalating to Google on a local failure would break exactly the
promise the option exists to make. This is the one place in the pipeline where
a failure is deliberately *not* routed around.

### Prompts and the placeholder kernel

Only a cloud-bound prompt gets the placeholder kernel appended to its system
instruction; a raw local run has nothing to preserve. Sampling for either is
[section 10b2](#10b2-sampling-and-whose-it-is).

### Timeouts

`LMSTUDIO_FORMAT_TIMEOUT_MS`, default **240 s**, separate from the NER pass's
`LMSTUDIO_TIMEOUT_MS` (90 s). The NER pass writes a short JSON array; formatting
writes a whole chart entry, so on a 12B model it can take several times as long.
Sharing one timeout would abort perfectly healthy runs. Both resolve in
`src/lib/lmstudio.ts`, and the format budget is kept under the route's 300 s
`maxDuration` so a slow run fails with a readable message rather than the
platform cutting the stream.

### Which local model answers

`resolveLocalModel()` in `scrubber-llm.ts` is the single resolver, and it
**detects rather than configures**: whatever LM Studio has loaded, falling back
to `LMSTUDIO_MODEL` only when detection fails, and to the literal `local-model`
if there is nothing at all.

It was the other way round once — the pin outranked reality, on the reasoning
that the pin is what the request asks for. That is true and it is exactly the
problem: LM Studio serves one loaded model on a 16GB box, so asking for a
different one makes it swap models mid-request. Measured with a pin naming a
model other than the loaded one, the de-identification pass went from **4.5s to
20s** while the box loaded the pinned model, and the interface named one model
while another wrote the note.

Every stage now shares the resolver — the status badge, the model selector, the
de-identification pass, the formatting pass and the audit row cannot disagree
about which model is doing the work. It is resolved **once per run** in
`scrubWithLlm`, so the retries for a `400` or an empty `content` cannot land on
a different model than the first attempt did.

`/api/status` reports it as `lmStudio.requestModel` beside `lmStudio.models`,
and the Local chip reads like a status badge: a light that is on when LM Studio
answers, and the detected model name next to it. `LMSTUDIO_MODEL` is documented
as a fallback, and the Prompts drawer says so in one quiet line if a value is
set that is not in use.

Nothing overrides detection any more: the model is whatever LM Studio has
loaded, everywhere.

### How it shows up

- `meta.destination` is `"local"` or `"cloud"`.
- `AuditLog.modelUsed` is prefixed: `local:google/gemma-4-12b`. Every cloud rung
  is `gemini-…`, so a bare local model id in that column would leave a reader
  guessing where the note was written.
- The format row in the progress list is titled "Local model formats the note"
  and drawn inside the **Mac** trust boundary rather than the cloud one — the
  stage id stays `cloud`, because the id is the wire contract, but
  `stageTitle()` and `stageLocus()` in `pipeline-client.ts` re-label it.
- `STAGE_LABELS.cloud` in `concurrency.ts` is destination-neutral
  ("Formatting the note"), because queued clients read it without knowing the
  settings of the run they are behind. The detail field names who is writing.
- `meta.geminiMs` keeps its name on the local path. It is the time in the
  formatting stage wherever that ran; renaming it would break the wire contract
  and every History row already written.

## 8c. Watching the local model work

A local model writing a discharge summary can take a minute, and a minute of
spinner is indistinguishable from a hang. Both local calls — the
de-identification pass and the formatting pass — therefore run with
`stream: true`, and every delta reaches the browser as it is produced.

**The stream is sealed.** Progress events are plaintext by design: they carry
stage names and counts and never content. A token stream *is* content, and the
entity list the de-identifier writes is content of the worst kind — it is
literally the identifiers. So each flush is encrypted with the same ephemeral
AES key as the final result, emitted as `event: stream`, and opened in the
browser with the key it already holds. Cloudflare sees ciphertext either way.
The acceptance check asserts this directly by reading the raw response body and
requiring that no identifier appears in it.

**Buffered, not per token.** A GCM seal and a base64 encode per token would cost
more than the inference. The route accumulates deltas and flushes at most every
120ms, then forces a final flush when the stage ends.

**Ordered, on both ends.** Sealing is async too, so two flushes in flight on the
server can resolve in either order — the route therefore chains them onto a
single promise rather than racing them, and `flushStream(true)` awaits that
chain. The client then `await`s each decryption before handing the chunk on.
Either half alone leaves the live view able to print the second half of a
sentence first.

Streaming is local-only. The Gemini path returns whole responses, and the
fallback walk down the ladder assumes it can retry a failed call — which a
half-streamed answer complicates for no benefit the clinician would notice.

## 8d. Bring your own Gemini key

`src/lib/gemini-key.ts`, `src/app/api/gemini-key/route.ts`.

A clinician can paste their own Google AI Studio key so cloud runs spend **their**
free-tier allowance instead of the deployment's shared one. On the free tier that
is the difference between twenty flagship requests a day between everybody and
twenty each.

### Where the key lives, and why

**In the clinician's browser, and nowhere else.** It sits in that browser's
`localStorage`, travels to the Mac Mini inside the *same AES-GCM envelope as the
note*, is used for the life of one request, and is dropped when the handler
returns.

The alternative was an encrypted column in Postgres. That puts a decryptable
third-party credential on the disk of a machine reachable from the internet, and
needs a key-encryption key to protect it — a standing secret to protect a
standing secret, with a rotation story attached. Sending it sealed per request
costs a few hundred bytes and means a stolen database contains nobody's API key.
It is the same discipline the TokenVault is under, for the same reason: the only
place a secret lives on this server is RAM, for one request.

The honest trade, and it is stated in the drawer too: `localStorage` is readable
by any script running on this origin. Airlock loads no third-party scripts and
ships no production source maps, but anyone who can execute script in the page
can also read the note on screen — the key is no softer a target than the
clinical text beside it. If that is not acceptable for your deployment, do not
distribute keys through the browser at all: give the instance its own
`GEMINI_API_KEY` and leave this feature unused.

### It is sealed, including when you check it

The obvious way to validate a key is `POST { apiKey }` as plain JSON. That hands
the credential to Cloudflare in the clear, because Cloudflare terminates TLS at
its edge — the exact threat this application exists to defeat for clinical text.
So `/api/gemini-key` takes the identical `CryptoEnvelope` the pipeline does,
opens it with the server's private key, and seals its answer with the same
ephemeral AES key.

The check calls `models.list`, which is an authenticated read and spends **no
generation quota**. It reports which ladder rungs the key can actually reach: a
key can be valid and still have no access to the models this instance offers — a
restricted key, or a project without the Generative Language API enabled — and
finding that out in the drawer is much kinder than finding it out mid-ward-round.

Saving runs the check first. A key Google refuses is not saved, because saving it
only moves the failure into the middle of a note. A check that *cannot run* — the
network, not the key — offers "Save without checking" instead, so an unreachable
Google is never a reason you cannot configure Airlock.

### The shape check is deliberately loose

The first version demanded `AIza` plus 35 URL-safe characters, which is the AI
Studio format every tutorial shows. **It rejected the very first real key it was
pointed at:** Google also issues 53-character keys beginning `AQ.A`.

A validator that knows one vendor format will refuse a working credential the day
the vendor adds another, and nobody debugging that would suspect the client. So
the check now covers only what is genuinely diagnostic of a *paste error* —
empty, whitespace inside it, absurdly short or long, characters no key of any
format contains — and leaves "is this a real key" to the only party that can
answer it. Both formats are pinned in `npm run verify` §6c.

### Cooldowns are scoped to the quota that earned them

This is the part that makes the feature safe to add rather than merely possible.

Availability is *observed*: a rung is marked spent only once Google has refused
it. A refusal is a fact about **one Google allowance**, not about the model — so
with a global `ModelCooldown` table, one clinician exhausting the flagship greyed
it out for everybody on the instance, and the persisted row survived a restart to
keep doing so. That was already wrong before this feature; with several keys in
play it is wrong in a way that costs other people their working models.

`ModelCooldown` is therefore keyed `(quota, model)`, where `quota` is the literal
`instance` for the deployment's own key or a truncated SHA-256 of a clinician's
own. The in-memory cache is keyed the same way, and `availability()`,
`chainFrom()`, `isAvailable()`, `markAvailable()` and `markUnavailable()` all
take the scope.

```
quota             model                    reason      daily
ee4e0cc6cfe45acc  gemini-3.7-flash         overloaded  f      ← one clinician's key
instance          gemini-3.7-flash         quota       t      ← the shared key
instance          gemini-3.6-flash         quota       t
```

The fingerprint is one-way and 64 bits over a high-entropy key: not enumerable,
and it carries nothing about who pasted it. **It is the only part of the key that
ever reaches Postgres**, and it reaches it as a cooldown scope, never as a column
on an audit row.

`/api/models?quota=` takes the same fingerprint — computed in the browser, never
the key — so the selector greys out rungs *you* have spent rather than someone
else's exhausted afternoon. A `quota` that is not 16 hex characters falls back to
`instance` rather than minting a fresh namespace on demand.

### What the run reports

`meta.quotaSource` is `"own"` or `"instance"`, and the footer shows a **your
quota** chip for the former. That is deliberately the *only* thing recorded about
it: the audit row says which model wrote the note, not whose credential paid, and
the clinician already knows which key they pasted.

### With no instance key at all

`GEMINI_API_KEY` is now optional. A deployment started without one is a coherent
configuration — everyone brings their own — and the interface says so: the cloud
rungs grey out with "No Gemini key on this instance", the run button explains
itself, and the local model is unaffected. `/api/models` reports `instanceKey`
so the browser can tell that state apart from "your key is missing".

### A local run carries no credential

The client omits the key from the payload entirely when the destination is local,
and the route ignores it there too. A local run makes no outbound call, so a
credential in it would be a secret held in one more place for no reason.

## 9. Concurrency: one compute slot

`src/lib/concurrency.ts`.

The lock is a synchronous test-and-set on a module-global. Node's event loop is
single-threaded, so no `await` can interleave between the read and the write —
that *is* atomicity here, and the "atomic region" is marked in the source.

- **Stale reclaim** at 5 minutes: a wedged request must not brick the box forever.
- **Stale handles are ignored** on release, so a timed-out request cannot free the
  lock out from under whoever reclaimed it.
- **`setStage()` publishes what the slot is doing** so queued clients can display
  it. The `detail` field is non-identifying by contract — `"1,240 characters"`,
  never note content.

`/api/status` exposes `busy`, `lockHeldForMs` and `activity`. Verified live: the
status route flips to `busy: true` within one second of a run starting and
answers in 4–15 ms while a note is in flight.

The client-side queue lives in `page.tsx`: on a 429 it retries every two seconds
while showing the live activity, and polls `/api/status` at 1 s (rather than 5 s)
whenever this tab has work outstanding — queued **or** running. The badge also
treats "this tab is submitting" as busy directly, so it flips the instant the
button is pressed instead of waiting for a poll to confirm what the tab already
knows.

## 10. Workspaces, and the one rule

`src/lib/workspace.ts` is the whole model, and it is deliberately small enough
to hold in your head:

```
TWO WORKSPACES     note    a ward narrative becomes a chart entry
                   prompt  an instruction and a prompt become an answer

TWO DESTINATIONS   cloud   a rung of the Gemini ladder
                   local   the model already loaded in LM Studio

ONE RULE           de-identification happens if and only if the run is
                   bound for Google
```

The rule reads off **one variable**. The workspace does not enter into it, no
prompt is consulted, and there is no combination that is an exception — which is
what makes it a rule rather than a policy with a table attached.

|  | Note | Custom prompt |
| --- | --- | --- |
| Cloud | scrub → format → re-hydrate → audit | scrub → answer → re-hydrate → audit |
| Local | **raw: no scrub, no audit** | **raw: no scrub, no audit** |

Three one-line functions encode it, and the route, the progress list and the
acceptance suites all read them rather than re-deriving it:

```ts
deidentifies(localDestination)         // !local
audits(localDestination)               // the same answer, necessarily
stagesFor(local, patternScrub = true)  // 3 stages local, 6-7 cloud
patternScrubs(local, requested)        // Pass A only ever runs on a cloud run
```

### Why local writes nothing

The audit log holds de-identified text only — the hard PDPA boundary the whole
design is built around. A local run has no de-identified copy of itself to
store, so it stores nothing: the invariant holds by **never writing**, rather
than by writing something and hoping it is safe.

The consequence is a real trade and is stated on screen while it applies: notes
written locally do not appear in History and leave no audit trail. History is a
record of what crossed to the cloud, which is what it has always claimed to be.

The acceptance suite asserts this from both sides — it counts the rows before
and after a local run and requires the count to be unchanged.

### Two strings, one set of tokens

A custom-prompt run bound for the cloud has a system instruction *and* a prompt,
and both may carry identifiers. They must share one set of tokens — the same
name has to become the same placeholder in both — so:

1. the deterministic pass runs over each string with the same vault;
2. the local model reads the two **joined**, once, and populates the vault;
3. `TokenVault.deidentify()` applies what it found to each string separately.

Running the model twice would double the slowest stage in the pipeline. Joining
and splitting the *text* would be fragile, because the replacements change its
length. Applying the vault to each original is neither.

### The "Others" format

`NOTE_FORMATS.OTHER` carries no compiled-in skeleton. The other five each
impose a structure, which is what makes two notes labelled "SOAP" comparable; a
routine that describes its own headings was previously fighting a structure it
never asked for.

A run in this format therefore **requires a routine** — there is nothing else
left to say what the note should look like — and the route refuses it with
`ROUTINE_REQUIRED` rather than falling back to a shape nobody chose. Same rule
as everywhere else in this codebase: refuse rather than silently default.

`BUILT_IN_FORMATS` is derived by filtering on an empty skeleton, and **must be
declared below `FORMAT_INSTRUCTIONS`** — declaring it above threw a
`ReferenceError` out of the temporal dead zone the moment anything imported
`gemini.ts`, which presented as `isNoteFormat("OTHER")` quietly returning false
and the format falling back to SOAP.

### What replaced what

This collapsed four controls that could all express "I want to write the prompt
myself": a guided/custom toggle, a `CUSTOM` note format, and per-model sampling
parameters across two tabs. The free-text "extra instruction" box went too — a
saved routine does the same job, is screened for patient data on write, and is
named on every audit row, which a free-text box was not.

The de-identification prompt is no longer editable by anyone. It was editable in
custom mode, guarded by four properties that could not be switched off — a lot
of machinery to make a dangerous setting safe, for a setting nobody needed. It
is the de-identification step itself; making it configurable makes the safety
property configurable.

## 10b2. Sampling, and whose it is

Two sets of numbers, because two different models do two different jobs, and a
single unlabelled row left it ambiguous which was being tuned. Each row in the
interface names the model it drives.

| Row | Applies to | When |
| --- | --- | --- |
| **De-identification** | the LM Studio model, named | only on a cloud-bound run — a local run does not de-identify, and the row says so and is disabled |
| **Google Gemini** / **Local model** | whichever model answers, named | always |

One `Sampling` shape for both, translated at the edge:

| | Gemini | LM Studio |
| --- | --- | --- |
| `temperature` | `temperature` | `temperature` |
| `topP` | `topP` (sent when < 1) | `top_p` (sent when < 1) |
| `topK` | `topK` (sent when > 0) | `top_k` (sent when > 0) |
| `maxTokens` | `maxOutputTokens` | `max_tokens` |

Anything left at its off value is **not sent at all**, so the model's own
default applies rather than a number that only looks deliberate.

**The de-identification PROMPT is still not editable, and never will be** — it
is the de-identification step itself. Its *numbers* are, because the worst a
bad number can do is find fewer names, which the redaction list shows you,
rather than change what the step is. The defaults are temperature 0 (creativity
here shows up as invented spans, which the verbatim check discards, so it costs
recall and buys nothing) and 6144 tokens (a long shift note can carry 60+
entities and a truncated array fails the run closed).

Both sets are clamped server-side in `normaliseSampling` /
`normaliseDeidSampling`, on every request, for the usual reason: the payload is
assembled in the browser.

## 10c. Routines, in both workspaces

One table, `PromptTemplate`, with a `kind` discriminator:

| | `kind = "note"` | `kind = "prompt"` |
| --- | --- | --- |
| `instruction` | the charting instruction, appended to the built-in skeleton | the prompt itself |
| `systemInstruction` | unused | the model's standing instructions |
| `format` | the note shape it defaults to | unused |
| `temperature`/`topP`/`topK`/`maxTokens` | optional overrides | optional overrides |

Every added column is nullable or defaulted, so every row written before this
existed still means what it meant: a note routine with no saved sampling. The
migration is additive only.

**They behave differently on selection, and they have to.** A note routine is
*appended to the prompt at request time* and never touches what is on screen. A
prompt routine **is** the prompt, so selecting it loads the system instruction,
the prompt and any saved sampling into the editor — otherwise the clinician
would be looking at one thing and running another.

**Both bodies are PII-screened.** `assertNoPii` covers `systemInstruction` as
well as `instruction`: a saved prompt is no less permanent than a saved
charting instruction, and both live in Postgres forever.

**`isDefault` is per kind, and so is the preselection.** One preselected routine
for notes and one for prompts, rather than one across both — they are never
offered at the same time. The browser picks the default *of the open workspace*,
which it did not always do: picking the first default of either kind left a
prompt routine selected while the note workspace was open, invisible in a
selector that filters by kind, and still sent with the run. The route also
refuses a routine whose `kind` does not match the workspace, because the id
arrives over the wire and that is the check that actually holds.

**A prompt routine is named on the audit row** exactly as a note routine is,
so a cloud run can still be traced to the instructions that produced it. A
custom prompt with no routine attached records
`"Custom prompt — not stored"`.

## 11. Authentication

**Middleware** (`src/middleware.ts`) gates everything on the *presence* of a
session cookie. Public: `/signin`, `/api/auth/*`, `/api/health`, `/_next/*`,
`/favicon`. Everything else redirects (pages) or answers 401 (API).

**Presence is not proof, and this is the rule to remember when adding a route.**
Anyone can send `authjs.session-token=anything`; middleware never checks the
value, deliberately, to keep a database round-trip off every request. It is a
cheap filter for the unauthenticated, never an authorisation check. **Every
route that returns data therefore calls `auth()` itself.**

`/api/status` and `/api/models` once did not, and a forged cookie read the
loaded model name, whether a Gemini key was configured, and — the one that
mattered — that the developer password bypass was enabled and accepting remote
connections, which is the reconnaissance step for the bypass. Both check now,
and `e2e:system` asserts a forged cookie is refused on every data route.

The single deliberate exception is `/api/keys`, which serves an RSA **public**
key. It is meant to be readable, carries nothing about the instance or its
users, and the suite pins its response shape so it cannot quietly grow a field
that does.

**Auth.js** (`src/lib/auth.ts`) with the Prisma adapter, Google provider,
database sessions, 12-hour max age. The `session` callback returns only
`{ id, name, email, image }`: spreading the adapter's session row would publish
`sessionToken` in a JSON response readable by JavaScript, defeating the httpOnly
cookie it lives in.

**`AUTH_ALLOWED_EMAILS` is mandatory and fails closed.** An unset or empty
allowlist denies *everyone*. Accepts addresses and whole domains
(`@yourhospital.org.tw`).

**Developer bypass** (`/api/auth/dev-login`). Off unless `DEV_LOGIN_ENABLED=true`,
and refuses any request whose `Host` is not localhost unless
`DEV_LOGIN_ALLOW_REMOTE=true`. Password compared with `timingSafeEqual`. It mints
a **real** Session row rather than threading a special case through the app, so
ownership and tenant isolation behave exactly as for a Google account — a bypass
that takes a different code path is a bypass that hides bugs.

**Cookie naming.** Auth.js derives the `__Secure-` prefix from `AUTH_URL`, not
from the transport of the current request. Behind a tunnel those disagree (the
browser is on HTTPS, the container is spoken to over HTTP), so both `dev-login.ts`
and the test harness follow `AUTH_URL`. Get this wrong and every request is 401
with no other symptom.

## 12. Persistence

Schema and table-by-table notes: [docs/DATABASE.md](docs/DATABASE.md).

**`AuditLog` holds de-identified text only.** There is no column for the raw note
and none for the token map. `promptTemplateName` is stored as plain text so the
row survives the routine being renamed or deleted.

**Routines are configuration, not clinical data.** `assertNoPii()` runs every
saved routine through the deterministic scrubber and rejects it with **422** if
anything matches — a patient name pasted into a template would be persisted
forever and quietly defeat the pipeline.

**Ownership.** `PromptTemplate.userId = null` means a shared, instance-wide
routine. Scoping writes to `{ id, userId }` alone once made those visible to
everyone and editable by no one — an undeletable dead end. `writableBy()` now
allows the owner *or* anyone signed in for ownerless rows.

**A refused write leaves nothing behind.** `updateTemplate` does the ownership
check and the de-defaulting in **one transaction, ownership first**. Clearing
the caller's other defaults up front meant an edit aimed at somebody else's
routine still cleared the caller's own preselected one before failing — a
rejected request that changed their state anyway. `e2e:system` §7c pins it.

**Data lives on the Mac, not in a Docker volume.** Postgres and the keypair are
bind-mounted under `AIRLOCK_DATA_DIR` (default
`~/Library/Application Support/ProjectAirlock`). Named volumes live inside Docker
Desktop's VM disk image, and a Docker Desktop major upgrade can reset that image
— going 28.x → 29.x destroyed this database, the routines, the sessions and the
RSA keypair in one step. A bind mount survives Docker upgrades, factory resets,
and uninstalling Docker altogether. What still destroys data: deleting
`AIRLOCK_DATA_DIR` yourself.

**Backups.** `ops/backup-airlock.sh` dumps with the container's own `pg_dump`,
gzips into `~/Documents/airlock-backups/` (mode 600, directory 700) for Time
Machine, and prunes past 30 days. Installed as a launchd job firing **hourly at
:59** — daily was tried first, and a 24-hour window is precisely what lost a day
of history. Restore is a plain `psql` load:

```bash
gunzip -c ~/Documents/airlock-backups/airlock_YYYY-MM-DD_HHMM.sql.gz \
  | docker compose exec -T db psql -U airlock -d clinical_notes
```

**Prisma client** (`src/lib/db.ts`) is constructed lazily behind a `Proxy`.
Building the image has no database and no `DATABASE_URL`, and Next collects route
data at build time — an eager client would throw during `next build` rather than
at first query.

## 13. The browser client

**`pipeline-client.ts`** is isomorphic: the UI and every script drive it the same
way. It fetches `/api/keys`, seals, POSTs, and parses the SSE stream with a
minimal frame parser (`EventSource` cannot issue a POST). On
`code: DECRYPT_FAILED` it re-fetches the public key past any cache and retries
**once** — telling a clinician to reload mid-note is not a fix.

**`page.tsx`** is one client component plus drawers. Notable mechanics:

- **The raw note leaves the workspace the moment it is sealed** (`setInput("")`).
  A chart entry sitting on screen is itself an exposure.
- **Two copy buttons, named for what they contain**: *Copy note · with names* and
  *Copy de-identified*. The old single "Copy clean note" was ambiguous in the
  worst direction — in a de-identification tool "clean" reads as "de-identified",
  but it copied the re-hydrated note.
- **Stale tabs fix themselves.** Every build gets an id, exposed in `/api/status`
  and baked into the bundle. A tab whose id disagrees reloads once. This is what
  a removed banner surviving on screen until a manual reload actually was: old
  JS, not old code.
- **Theme** is a three-state control (light / dark / follow system) written to
  `<html data-theme>` and mirrored to `localStorage`, applied by an inline script
  before first paint so there is no white flash on a night shift. It is read
  through `useSyncExternalStore`, which avoids both a hydration mismatch and a
  render-time `localStorage` read. Tailwind v4's `dark:` variant is redefined to
  honour the attribute *and* the OS preference.
- **The Prompts drawer reads `/api/prompt-config` live** on every open, so the
  prompts it shows are the ones the running server would send, and the local
  model name is the one LM Studio actually has loaded.
- **Nothing you choose sits below what you write.** Every selector — workspace,
  model, settings, routine — is above the input, and the only control below it
  is the run button. The page then reads in the order it is used, and, because
  the input is the flexible element in a fixed-height panel, a selector
  appearing or disappearing cannot move anything: it is absorbed by the box you
  are typing into.

  This was measured. Before it, switching workspace moved the mode toggle 78px
  at 1024px and the model bar with it. After: **zero drift at 1024, 1280, 1440
  and 1920**, in both workspaces.

  Three things make it hold, and all three are easy to undo by accident:
  `lg:h-full` on `<body>` and the page root, so the height is *definite* and
  `flex-1` has something to distribute; `min-h-0` on the input container, so it
  can actually shrink; and a settings row that is present in both workspaces
  (note formats, or prompt parameters) rather than appearing in one.
- **A phone is not a small ward monitor.** Three things, all keyed on the
  device rather than guessed at: inputs are **16px below `lg`**, because Safari
  zooms in on anything smaller and never zooms back out — on iPad as well as
  iPhone; touch targets get a 2.5rem floor under `pointer: coarse`, which is a
  property of the device and not of its width, so a tablet at 1024px gets them
  and a mouse-driven desktop does not; and the four detail rows fold behind a
  **Run detail** disclosure below `lg`, because with every selector above the
  input they put the run button 1,120px down an iPhone SE. Mode and model stay
  visible — they are the two choices that change what a run does.

  Measured before and after on iPhone SE / 14 / 11 and iPad: 27 undersized tap
  targets and a guaranteed zoom-on-focus, down to **zero issues**, with the run
  button 1,120px → 965px and no horizontal overflow at any size. The desktop
  layout is bit-identical — the disclosure is `lg:block`, so from `lg` the rows
  are always open and the pinning still holds.
- **A focus ring on a full-bleed control reads as a stray rule.** The narrative
  box has no border of its own and fills a clipping scroll container, so the
  global `outline: 2px solid var(--accent); outline-offset: 2px` was sliced by
  the container and appeared as a teal line across the workspace whenever
  anyone clicked into it. Bordered boxes now ring *inside* themselves
  (`outline-offset: -2px`, so nothing can clip it); the flush one has
  `.field-flush` and no ring at all, with the caret as its focus indicator.
- **A notice that comes and goes moves everything around it.** The privacy
  notice under the toggle and the caption under the model bar are both always
  present and always exactly one line. Their text changes; their height does
  not.
- **Text in a shared row is budgeted, not just truncated.** `truncate` stops a
  row wrapping, but a flex item that shrinks to nothing produces a worse
  result than wrapping did: the mode blurb was cut to "You write…" — 11% of it
  — at 1920px, because a 252px parameter read-out beside it took the space
  first. The rule is to size the text to the narrowest supported width (~40
  characters in that row at 1024px), keep the whole sentence in `title`, and
  move anything that is a glance rather than a control onto the control it
  describes. `WORKSPACES[].summary` is what the row shows;
  `WORKSPACES[].blurb` is the tooltip. Verified across 32 surface/width
  combinations: zero clipped text.
- **A disabled primary action says why.** The run button carries
  `disabledReason` as its tooltip, naming whichever precondition is missing —
  no note, no server key, over the cap, or a prompt that needs fixing. A greyed
  control with no explanation is a dead end.
- **The workspace toggle sits directly above the model selector**, inside the
  input panel. The two together are the whole answer to "what will this run do"
  — which prompts, and which model. It is a segmented toggle rather than a pair
  of buttons because there are exactly two states and only one can hold.
- **Switching workspace must not move the page.** The workspace row is
  `flex-nowrap` with a truncating blurb, so it is the same height in both; the
  privacy notice beneath it is always present and always exactly one line, only
  its text changing; and the settings row below is occupied in both workspaces
  — format buttons in one, a caption in the other — so its height is fixed too.
  Nothing appears or disappears, so there is nothing to animate and no height
  nobody has measured.

  This was measured, not guessed. An earlier layout grew the block from **75px
  to 374px** on switching and moved the run button **329px** down the page,
  adding a scrollbar. Now the rows do not change at all.
- **Every drawer is a real dialog.** `useDrawer()` gives all seven the same
  four behaviours, which none of them had: Escape closes, focus moves inside on
  open and returns to the trigger on close, Tab is trapped, and the background
  is scroll-locked. Each `<aside>` carries `role="dialog"`, `aria-modal` and an
  accessible name. Measured before the fix at 1024×600: a wheel gesture over an
  open drawer moved the page behind it **342px**, and 30 controls stayed
  tabbable behind the overlay.
- **Drawers slide in** (`.drawer-panel` / `.drawer-scrim`, 180ms). A
  full-height panel materialising in one frame reads as the layout breaking
  rather than as a panel opening. Both animations are disabled under
  `prefers-reduced-motion`.

**Caching headers** (`next.config.ts`): HTML and every API response are
`no-store`, with `CDN-Cache-Control` and `Cloudflare-CDN-Cache-Control` set too —
Cloudflare was caching `/api/auth/csrf` and replaying it with `Set-Cookie`
stripped, so every sign-in failed with `MissingCSRF`. Hashed assets under
`/_next/static` are deliberately *not* covered: their names change per build.

The SSE response sets `X-Accel-Buffering: no` so Cloudflare does not sit on the
stream waiting for a full body. Verified live through the tunnel.

## 14. Configuration reference

| Variable | Purpose |
| --- | --- |
| `AIRLOCK_DATA_DIR` | Where Postgres and the keypair live on the Mac. Required by compose. |
| `DATABASE_URL` | Local Postgres for the audit log |
| `SHADOW_DATABASE_URL` | Scratch DB for `prisma migrate diff/dev`. No application data. |
| `GEMINI_API_KEY` | The instance's shared Gemini allowance. **Optional** — a clinician can bring their own instead; see [section 8d](#8d-bring-your-own-gemini-key). With neither, the cloud rungs grey out and the local model still works. |
| `GEMINI_MODEL` | Default starting rung of the ladder |
| `GEMINI_MODEL_LADDER` | Optional override of the whole ladder, best first, comma separated |
| `GEMINI_BASE_URL` | Optional endpoint override (egress proxy, regional endpoint, local stub). Unset normally. |
| `LMSTUDIO_BASE_URL` | Local NER endpoint. In Docker this is pinned to `DOCKER_LMSTUDIO_URL`. |
| `LMSTUDIO_MODEL` | **Fallback only.** The model is detected from LM Studio; this is used only when detection fails. Normally empty. |
| `LMSTUDIO_TIMEOUT_MS` | De-identification pass timeout, default 90000 |
| `LMSTUDIO_FORMAT_TIMEOUT_MS` | Local *formatting* timeout, default 240000. See [section 8b](#8b-the-local-destination). |
| `ALLOW_DEGRADED_SCRUB` | `false` (default) aborts when the local pass is unavailable. `true` permits regex-only. |
| `KEY_STORE_FILE` | Filename inside `./.keys/` for the RSA keypair |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth client |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL` | Canonical URL. **Determines the session cookie name.** |
| `AUTH_ALLOWED_EMAILS` | Mandatory allowlist. Empty denies everyone. |
| `DEV_LOGIN_ENABLED` / `DEV_LOGIN_PASSWORD` / `DEV_LOGIN_ALLOW_REMOTE` | Developer bypass. Off, and localhost-only, by default. |
| `TUNNEL_TOKEN` | Cloudflare Tunnel, used by the `tunnel` compose profile |
| `POSTGRES_PASSWORD` | Must match the credentials in `DATABASE_URL` |
| `BUILD_ID` | Optional explicit build id; otherwise a timestamp |

### Docker notes

- **Set Docker Desktop's VM to 2 GB** (Settings → Resources). The whole stack
  peaks around 215 MB; on a 16 GB Mac every gigabyte the VM reserves is a
  gigabyte the model cannot use. Measured: 2 GB VM leaves 6.2 GB free with a
  model loaded, against 2.7 GB at the 8 GB default.
- **Do not scale the `app` service.** The compute lock is process-local.
- **`docker compose` auto-loads `.env` for interpolation**, so a host-specific
  value there can override a compose default. `LMSTUDIO_BASE_URL` is the trap:
  the host's `127.0.0.1` means "this container" inside the container. It is
  pinned to `DOCKER_LMSTUDIO_URL` in the compose file for exactly this reason.
- The `migrate` service builds the **builder** stage, because the runtime image
  deliberately has no Prisma CLI.
- **`docker builder prune -af` reclaims build cache without touching data**, and
  it is not optional on a laptop. Measured after one session of repeated
  rebuilds: **19.5 GB** of build cache, and `Docker.raw` at 21 GB on disk. The
  prune took the image back to 3.6 GB. It leaves the images and
  `AIRLOCK_DATA_DIR` alone, so the database, the routines and the keypair
  survive it. See [ops/PUBLISH.md](ops/PUBLISH.md#keeping-the-ssd-alive).

## 15. Every script, and what it proves

All of them run under `tsx`. **Every route is behind sign-in**, so the scripts
that talk to a running server mint a real Auth.js Session row via
`scripts/test-session.ts` and present the cookie exactly as a browser would —
rather than adding a permanent bypass to a PHI-handling service. They need
`DATABASE_URL` for that, which `import "dotenv/config"` supplies from `.env`.

### `npm run verify` — `scripts/verify-pipeline.ts`

**Offline.** No database, no API key, no model: it stubs LM Studio on port
**11234**. Seven sections:

1. Crypto round-trip — envelope shape, ciphertext is not plaintext, server
   decrypts, response uses a fresh IV, client decrypts, GCM rejects a tampered IV.
2. Deterministic scrub — each identifier removed, doses and vitals preserved,
   indexed tokens issued, national-ID checksum accepts a valid ID and rejects a
   bad check digit.
3. Local NER against the stub — catches patient / relative / attending / English
   doctor / ward, rejects a hallucinated span, refuses a mislabelled clinical
   term, and `Troponin I` survives into the note.
4. Fail-closed — throws `LocalScrubUnavailableError` when LM Studio is down, and
   degrades only when `ALLOW_DEGRADED_SCRUB=true`.
5. Re-hydration — prints the de-identified text and asserts every token comes
   back.
6. Token collision — `[MRN_11]` vs `[MRN_1]`, longest-first replacement.
6b. Applying findings cannot corrupt findings already applied — a
   one-character span must not rewrite a placeholder a longer one produced.
6c. Bring-your-own-key: both of Google's key formats are accepted, six shapes of
   paste error are refused, the mask hides the middle, and the quota fingerprint
   is stable, whitespace-insensitive and reveals nothing of the key.
7. Compute lock — acquire, refuse, release, and a stale handle cannot free it.

**Run this first for any change to crypto, either scrubber, the vault, or the
lock.** It is the fastest signal in the repo.

### `npm run e2e` — `scripts/e2e-encrypted-post.ts`

Against a **running server with real dependencies**: fetch the key, seal a note,
stream it through, print the de-identified prompt, the re-hydrated note and the
metadata. Takes an optional base URL argument. Cleans up its own test user.

### `npm run e2e:full` — `scripts/e2e-full-stubbed.ts`

The whole pipeline with **both externals stubbed** — LM Studio on `:1234`, Gemini
on `:8899`. Start the server against the stub first:

```bash
GEMINI_API_KEY=stub GEMINI_BASE_URL=http://localhost:8899 npm run dev
npm run e2e:full
```

The Gemini stub records the prompt it was given, so the test can assert
positively that **the cloud never saw** each of ten identifiers — rather than
inferring it. Also checks clinical content survived, `CRP` was not mistaken for a
person, everything was restored, no placeholder is left, an audit row was
written, and inspector previews are masked.

### `npm run e2e:concurrency` — `scripts/e2e-concurrency.ts`

Stubs LM Studio on `:1234` with a deliberate 2-second latency so three requests
overlap, then asserts exactly one is admitted and two get 429, and that the lock
is released afterwards.

**Port collision.** This script and `e2e:full` both bind `:1234`, which is where
the real LM Studio lives. Stop LM Studio first, or point the server at a
different port. `e2e:prompt` and `e2e:system` use the real dependencies and do
not bind anything.

### `npm run e2e:routine` — `scripts/e2e-routine.ts`

Runs the same narrative twice, once bare and once through a saved routine, to
show the routine reached Gemini and shaped the output. Takes the routine name as
an argument. Note that routines are per-owner: a fresh harness user sees only
shared (ownerless) routines, and the script names what it *can* see if it cannot
find yours.

### `npm run e2e:prompt` — `scripts/e2e-prompt-mode.ts`

The privacy rule, asserted from both sides. Live server, real dependencies. It
runs the *same* prompt to Gemini and to the local model and checks that the
destination alone decided what happened to it: de-identified, re-hydrated and
audited on the way to Google; raw, unredacted and unlogged on the way to LM
Studio, with the note log confirmed not to have grown.

It also sends a system instruction that explicitly asks the model to ignore the
placeholder rules and repeat every name verbatim, and confirms that a
cloud-bound run is scrubbed anyway — because the rule is read from the
destination, and nothing in a prompt is consulted when deciding it.

Section 7 covers the **input budget**: two prompt fields, each legally under its
own 20,000-character cap, together exceed what the local model can scan, and the
server must refuse the run rather than under-scan it. It asserts the arithmetic
through `budgetedText()` and then asserts the live server agrees.

### `npm run e2e:key` — `scripts/e2e-own-key.ts`

Bring-your-own-key, asserted from the position of someone who does not trust the
claim. Live server, real Gemini. It runs a **recording proxy in Cloudflare's
seat** and requires that the key appears in no captured frame in either
direction; it then sweeps every table in the database for the key and for its
fingerprint; it checks the audit row records the run and not the credential; it
proves a rung spent on one quota is not spent on another; it confirms a local run
never carries the key at all; and it confirms `/api/gemini-key` refuses both an
unsealed key and an anonymous caller.

Uses `GEMINI_API_KEY` *as if* it were a clinician's own — which is the point: the
pipeline cannot tell the difference and must not try.

### `npm run e2e:system` — `scripts/e2e-full-system.ts`

**The acceptance suite.** Live server, real LM Studio, real Gemini, real
Postgres, no stubs. Waits for the compute slot rather than reporting a false
failure if something else is mid-run. Sections:

| | Covers |
| --- | --- |
| 0 | Auth gate — five routes refuse anonymous callers, `/` redirects, `/signin` is public, and **a forged session cookie is refused by every data route** (the middleware only proves a cookie is present). `/api/keys` stays open by design, and its response shape is pinned so it cannot grow a field that should not be public. |
| 0b | Developer bypass guards, including a **raw-socket** `Host` spoof (fetch silently drops a custom `Host`) |
| 1 | Preflight — LM Studio, database and Gemini key all real |
| 2 | Routine CRUD against Postgres, including the duplicate-name 409 |
| 3 | PHI guard — a routine carrying patient data is rejected 422 and names the categories |
| 4 | Input cap |
| 5 | A full ward note: every stage streams, stages arrive in order, no identifier reached the cloud, clinical content preserved, every emitted token restored, both scrub passes contributed |
| 5b | The local destination: written on this Mac, recorded as `local:…`, **not** de-identified, and leaving the note log exactly as long as it found it |
| 6 | The same note with a routine, and the routine's effect on the output |
| 6b | The EMR-export shapes that leaked in real use |
| 7 | Audit invariant — no row contains any identifier, scanned across the whole table |
| 7b | History: per-user recall, format recorded, search |
| 7b2 | Shared routines are manageable, not orphaned |
| 7c | Tenant isolation, both directions |
| 8 | Single-slot limit under concurrent load |
| 9 | Cleanup — the library returns to its original size and the test users are removed |

**It is deliberately non-destructive.** It creates its own users and removes only
what it created. Never add a `TRUNCATE`: the leak scan covers every row in the
table including yours, and emptying it first would make that check meaningless as
well as destroying real history.

### `npm run prove:e2ee` — `scripts/prove-e2ee.ts`

Runs a **wiretap proxy** on `:3999` between the "browser" and the app — exactly
where Cloudflare sits — records every byte in both directions, then tries to read
the note out of the capture. It reports the wrapped-key and ciphertext sizes,
shows the ciphertext decoded as text, and checks that no identifier appears
anywhere in the traffic, that the AES key cannot be unwrapped without the Mac
Mini's private key, and that GCM rejects tampered ciphertext rather than
returning garbage. Uses the developer bypass, so `DEV_LOGIN_ENABLED=true` is
required.

### `npm run db:smoke` — `scripts/db-smoke.ts`

Inserts one de-identified row, counts, deletes it. The fastest way to tell a
database problem from an application problem.

### `npm run db:inspect` — `scripts/inspect-audit-db.ts`

Prints every table with row counts, the full `AuditLog` column list, one real row
in both directions, and then scans the **whole table** for known identifiers.
Exits non-zero if anything leaked. This is the fastest way to satisfy yourself
that the audit table holds nothing identifying.

### `npm run audit:contrast` — `scripts/audit-contrast.mjs`

Drives real Chrome via `playwright-core` and walks **every text node on every
surface** — sign-in, the main page empty / typed / processing / with a result,
and all six drawers — in both themes. It composites through alpha layers and
`opacity` exactly as rendered, so nothing is judged by class name alone. Needs
`DEV_LOGIN_ENABLED=true` (it signs in with the dev password).

Widening it from "controls" to "all text", and from resting to in-flight states,
turned 0 known problems into 135 — which were three causes, not 135 bugs:
`opacity` used to dim text, Tailwind `-600`/`-500` shades on white, and
`animate-pulse` on a label. Current state: **2,658 text nodes, zero below AA,
both themes**, across sixteen surfaces including both mode states.

It waited on the wrong signal for a long time. "Copy note · with names" is
rendered from the start and merely *disabled* until a result exists, so
`waitForSelector('button:has-text("Copy note")')` returned instantly and the
"result" surface was audited mid-run — with the inspector button, which only
exists once there is a result, timing out immediately after. It now waits for
the redaction count, which is the honest signal that the run finished. The same
trap catches hand-written probes; check for a button that only exists on
success, not one that is merely enabled by it.

### `scripts/test-session.ts`

Not runnable — the helper the others import. `createTestSession(label)` upserts a
`<label>@airlock.test` user, writes a real Session row, and returns the cookie
header. `destroyTestUser()` cascades to sessions, audit rows and routines.

## 16. Debugging playbook

### Start here

```bash
curl -s localhost:3000/api/health                       # is the process answering?
curl -s localhost:1234/v1/models | head                 # is a model loaded?
docker compose ps                                       # are app and db healthy?
npm run db:smoke                                        # can Prisma reach Postgres?
npm run verify                                          # is the PHI path itself sound?
docker compose logs -f app                              # what did the server say?
```

`/api/status` (signed in) is the single richest read: compute slot, current
stage, LM Studio, database, whether the Gemini key is configured, active vault
count, degraded-scrub policy, build id, dev-login policy.

### Symptom table

| Symptom | Most likely cause | Check |
| --- | --- | --- |
| Every request 401, no other symptom | `AUTH_URL` scheme disagrees with the cookie name Auth.js reads | `sessionCookieName()` in `dev-login.ts`; compare `AUTH_URL` with how the browser reached you |
| Sign-in fails with `MissingCSRF` | An edge cached `/api/auth/csrf` and stripped `Set-Cookie` | The `no-store` headers in `next.config.ts` |
| Script dies on `Key endpoint returned 401` | The script is not presenting a session | It should use `createTestSession()` — see section 15 |
| `LOCAL_SCRUB_UNAVAILABLE` on every note | LM Studio down, wrong URL, or no model loaded | `curl $LMSTUDIO_BASE_URL/models`; inside Docker the URL must be `host.docker.internal` |
| Same, but only on long notes | The entity JSON was truncated | Split the note; the cap is compiled in at 6144 |
| Local pass returns nothing, model looks broken | A reasoning model put the answer in `reasoning_content` | Already handled by the empty-`content` retry; confirm the model actually answers `/chat/completions` |
| Status badge says "LM Studio down" during every note | Probing a server that serialises | Expected and handled — `/api/status` uses the cached health while locked |
| Prompts drawer names a model you did not load | Stale health cache, or LM Studio was unreachable when it was read | It refreshes on the next status poll; `curl $LMSTUDIO_BASE_URL/models` to confirm what is loaded |
| A run is far slower than usual on its local pass | LM Studio swapped models mid-request | Should no longer happen — every stage resolves the same detected model. If it recurs, check nothing is asking for a model other than the loaded one. |
| Badge stays "Mac Mini Online" during a run | Fixed — the badge now treats a submitting tab as busy and polls at 1 s | If it recurs, check `/api/status` returns `busy: true` directly |
| Every note 429 | A wedged request holds the lock | It self-reclaims after 5 minutes; `/api/status` shows `lockHeldForMs` |
| A model chip greys out unexpectedly | Google refused it and the cooldown persisted | `select * from "ModelCooldown"` |
| The **Local** chip is greyed out | LM Studio is unreachable, so there is no local model to write with | `curl $LMSTUDIO_BASE_URL/models`; the header badge says the same |
| `LOCAL_FORMAT_FAILED` after a long wait | The local model exceeded `LMSTUDIO_FORMAT_TIMEOUT_MS` | Shorten the note or raise it. It is deliberately not retried against Gemini. |
| A local run produced no History entry | By design — a local run writes no audit row | [Section 10](#10-workspaces-and-the-one-rule); send it to Gemini if you need the record |
| `ROUTINE_REQUIRED` | The "Others" format was chosen with no routine attached | Pick a routine, or one of the five built-in formats |
| Cloud rungs greyed out with "No Gemini key on this instance" | Neither `GEMINI_API_KEY` nor a key in this browser | Add one under **API key** in the header, or set `GEMINI_API_KEY`; see [section 8d](#8d-bring-your-own-gemini-key) |
| `GEMINI_KEY_INVALID` mid-run | The stored key stopped being well-formed, or was pasted with something attached | Re-paste it under **API key**; the drawer checks it against Google before saving |
| `GEMINI_AUTH` naming *your* key | Google revoked or restricted it after it started working | Re-check it in the drawer — the message says whose key was refused |
| A model is spent for you but not a colleague | Correct: availability is per Google allowance | `select quota, model from "ModelCooldown"` |
| `TOO_LONG` on a prompt that looks short enough | On a cloud run the budget covers the system instruction **and** the prompt, because the local model reads them joined | `budgetedText()` in `workspace.ts`; the browser counter shows the same number |
| The note arrives from a lighter model | The ladder walked down | The amber footer and `AuditLog.modelUsed` both say which |
| `DECRYPT_FAILED` | The keypair rotated under an open tab | The client retries once with a fresh key; if it persists, `.keys/` was not persisted |
| Placeholders left in the finished note | The cloud model renumbered or dropped them | `meta.unresolvedTokens`; confirm the placeholder kernel reached the system instruction |
| A clinical term was redacted | The local model mislabelled it and it escaped the stop-list | `meta.rejectedClinicalSpans`; add the pattern to `CLINICAL_STOPLIST` |
| An identifier was missed | The regex has no rule and the NER did not see it | Add a rule — and mind the ordering constraints in section 6 |
| Saved routine rejected 422 | It contains something the scrubber recognises | The response `detail` names the categories |
| A UI change does not appear | The tab is running an older build | It self-reloads on the build-id mismatch; otherwise hard-reload |
| `tsc --noEmit` reports duplicate `LayoutProps` / `unstable_cache` from `.next/types/…d 2.ts` | Stale generated types left behind by overlapping builds — the ` 2` suffix is the giveaway | `rm -rf .next && npm run build`. Nothing in `src/` is wrong. |
| A routine you did not choose shaped a note | A preselected routine from the *other* workspace was still attached | Fixed — `isDefault` is per workspace on both sides, and the route refuses a routine whose `kind` does not match. If it recurs, check `applyTemplates`. |
| History empty for a user who has notes | History is per-owner | Rows are scoped by `userId`; a fresh test user sees nothing |

### Reading the SSE stream by hand

```bash
COOKIE='authjs.session-token=<token from the Session table>'
curl -N -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{"encryptedData":"…","encryptedKey":"…","iv":"…"}' \
  localhost:3000/api/process-note
```

Every frame is `event: progress|stream|result|error` plus a JSON `data:` line.
Progress frames never contain note content, so they are safe to paste into a bug
report. `stream` and `result` frames are ciphertext — `stream` carries the local
model's live output, sealed with the same ephemeral key as the result.

### Logging rule

If you add logging to the pipeline route, log `deidentifiedInput`. **Never**
`plaintext`, **never** `noteText`, **never** `vault`. Everything already logged
in that route is either a stage name, a count, or the first line of an error
message.

## 17. Known quirks

- **`12-3床` is redacted as a date.** The month/day rule matches `12-3` before
  the bed reaches the NER, so a bed number can appear as `[DATE_n]床` in the
  de-identified text. It round-trips correctly and the identifier is removed
  either way — the label is simply wrong. Over-redaction is the safe failure.
- **The MRN rule is deliberately blunt.** `\b\d{7,8}\b` will sometimes swallow an
  accession number or a large plain integer.
- **Cooldowns for daily exhaustion are held until midnight US/Pacific**, computed
  by an offset trick that can be an hour out across a DST transition. The cost is
  one wasted request.
- **`isValidTaiwanId()` is not used for redaction.** It exists for callers that
  want to distinguish a real ID from a lookalike.
- **`AUTH_ALLOWED_EMAILS` is not consulted by the developer bypass.** The bypass
  is gated by its own two switches instead.
- **`vaultCount()` sweeps as a side effect**, so `/api/status` is what actually
  keeps the TTL store tidy in an idle process. Now that `/api/status` requires a
  real session, an instance nobody is signed in to relies on the 30-second
  sweeper alone — which is what the sweeper is for.
- **`/api/keys` is reachable with only a session cookie**, not a valid session.
  It serves an RSA public key, which is meant to be public; the acceptance suite
  pins its response shape so it cannot quietly grow a field that is not.
- **The health probe's 10-minute "busy" window** means a genuinely dead LM Studio
  can read as "busy" for up to ten minutes after its last success.
- **Cooldowns hydrate once per process.** A `ModelCooldown` row written directly
  into Postgres is invisible until the app restarts, because
  `ensureCooldownsLoaded` is memoised for the process lifetime. Only a concern
  when poking the table by hand.
- **A clinician's key is per browser.** It is in `localStorage`, so the same
  person on a second machine, or in a private window, is back on the instance's
  quota until they paste it again. That is the cost of never storing it
  server-side.

## 18. Changing this safely

Before you push anything that touches the PHI path:

1. `npm run verify` — offline, seconds, covers crypto, both scrubbers, the vault
   and the lock.
2. `npx tsc --noEmit && npm run lint`.
3. `npm run e2e:full` against a stubbed server if you touched the route or the
   client, `npm run e2e:prompt` if you touched the workspaces, the privacy rule
   or the input budget.
4. `npm run e2e:system` against the live stack before shipping.
5. `npm run db:inspect` if you touched anything that writes.

The invariants that must survive any change:

- The token map is never persisted anywhere.
- The regex pass runs before the local model, always.
- The local pass fails closed unless `ALLOW_DEGRADED_SCRUB` is explicitly set.
- Every span the local model returns is verified verbatim against the source.
- Placeholder shape stays `[A-Z_]+_\d+` — `assign`, `rehydrate` and the guards
  all depend on it.
- Only the `result` SSE event carries note content.
- `AuditLog` receives de-identified text only. A local run therefore writes **no
  row at all**: it has no de-identified copy of itself, and the invariant holds
  by never writing rather than by writing something and hoping.
- Every route that returns data calls `auth()` itself. The middleware proves a
  cookie is present, never that it is valid.
- The input budget is measured against what the local model is actually shown —
  `budgetedText()`, not the prompt alone.
- A clinician's API key is never persisted, never logged, and never written to
  an audit row. Only its one-way fingerprint reaches Postgres, and only as a
  cooldown scope. It crosses the tunnel sealed, on the check as well as the run.
- An observed cooldown is scoped to the quota that earned it.
- A run that chose the local destination never falls back to the cloud.
- The app runs as exactly one replica.

---

## Appendix A — setup details

### Running on the host, without Docker

```bash
npm install

brew install postgresql@17 && brew services start postgresql@17
# postgresql@17 is keg-only; add it to PATH for psql/createdb:
echo 'export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >> ~/.zshrc
createdb clinical_notes

# set DATABASE_URL in .env, then:
npm run db:migrate
npm run db:smoke

npm run dev            # http://localhost:3000
npm run build && npm start
```

LM Studio still runs separately: load an instruction-following model that handles
Traditional Chinese and start its server on port 1234.

### Creating the Google OAuth client

1. Google Cloud Console → APIs & Services → Credentials → **OAuth client ID**,
   type **Web application**.
2. Authorised redirect URIs — add both:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://<your-public-host>/api/auth/callback/google`
3. Put the client id and secret in `.env`, plus `AUTH_SECRET`
   (`openssl rand -base64 32`) and `AUTH_ALLOWED_EMAILS`.

Airlock stores only what OAuth returns: name, email, avatar. The Google provider
requests no offline access and no extra scopes.

Publishing over a tunnel: [ops/PUBLISH.md](ops/PUBLISH.md) — note that
`AUTH_URL` does double duty, since it also determines the session cookie name.

### Installing the hourly backup

```bash
cp ops/uk.galenchen.airlock.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/uk.galenchen.airlock.backup.plist
bash ops/backup-airlock.sh          # run once by hand to check
tail ~/Documents/airlock-backups/backup.log
```

If the Mac is asleep, launchd runs it at next wake. Each dump is a few KB, so 30
days of hourly retention costs single-digit megabytes.

## Appendix B — numbers worth knowing

### Input budget (`src/lib/limits.ts`)

| | |
| --- | --- |
| Comfortable | up to **6,000** characters — a full shift handover fits easily |
| Soft warning | past 6,000 the UI warns and asks you to check the redaction list |
| Hard refusal | past **20,000**, rejected client- and server-side |

Both limits are exported from one module and shared by the browser counter and
the route, so the two can never disagree. The live counter reports **words**
counted as Latin words plus CJK characters individually — Chinese is unspaced, so
a whitespace split alone would report a 400-character note as "1 word".

### Throughput with several clinicians

Sign-in, history and routines are fully per-user, but **the compute slot is
global**. Measured with three simultaneous users:

```
carol   done at  9.5s  (waited out 0 busy replies)
bob     done at 13.9s  (waited out 5 busy replies)
alice   done at 17.9s  (waited out 7 busy replies)
3/3 completed, each seeing only their own note
```

Genuinely multi-user; throughput is one note at a time. For a ward round where
several people submit at once, expect the last person to wait roughly *n* × the
time of one note.

### Interface constraints

Built for a **1024×768** ward monitor. No control ever loses its label — the
header wraps to a second row instead, and only the decorative strapline is
dropped. Verified at 1024, 1280, 1600 and 1920, with **Encrypt & structure** on
screen without scrolling.

Contrast is audited rather than assumed: `npm run audit:contrast` composites
through alpha and `opacity` exactly as rendered. Two rules learned the hard way —
never use `opacity` to dim text (it drags the colour toward its own background;
spent model chips once measured **1:1**, i.e. exactly invisible), and never
animate the opacity of a label (the busy pill dipped to 2.14:1 mid-cycle, right
when it mattered — the icon pulses now, not the text).

A third, for layout rather than colour: **a control above the primary action
must not change height when it changes state.** The mode toggle broke this and
pushed "Encrypt & structure" 329px down a 1024px screen. Measure the delta at
1024, 1280, 1440 and 1920 before shipping anything that appears or disappears
above the fold.
