# Project Airlock

> *A local AI strips patient identity before the cloud.*

Structures Taiwanese hospital narratives into formal notes (SOAP, discharge
summary, hospital course, …) without any identifier leaving the Mac Mini.

An airlock joins two environments that must never meet. A language model running
on your own Mac reads each note and removes every name, ID, date and ward before
the outer door opens onto the cloud — and puts them back only after it shuts.

Created by **Kuan-Yuan Chen**. Built with **Claude Code**.
Source: <https://github.com/galencky/local_llm>

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

**5. Publish it** — easiest via a dashboard token, which needs no browser login
on the Mac:

```bash
# Zero Trust > Networks > Tunnels > Create a tunnel > Cloudflared
# Copy the token into .env as TUNNEL_TOKEN, then in the tunnel's
# "Public Hostname" tab route llm.galenchen.uk -> HTTP -> app:3000
docker compose --profile tunnel up -d
```

Or via the CLI (`cloudflared tunnel login` then `bash ops/setup-tunnel.sh`).

Then set `AUTH_URL="https://llm.galenchen.uk"` in `.env` and add the matching
redirect URI to the Google OAuth client. Details and the pre-flight checklist:
[ops/PUBLISH.md](ops/PUBLISH.md).

Verified end to end through a live Cloudflare tunnel: the auth gate, the
`__Secure-` session cookie, the full de-identification pipeline, and — the one
that could have failed silently — **Cloudflare does not buffer the progress
stream**, so the stage list stays live over the tunnel.

## Seeing it for yourself

After any run, **Wire view** in the output panel shows the literal request body
that crossed the internet, beside the plaintext it replaced: the RSA-wrapped AES
key, the GCM nonce, the ciphertext decoded as text (gibberish, by design), the
first 96 bytes as hex, and the whole POST body. Nothing extra is fetched to
render it — those bytes are already in the browser.

## Proving it, rather than asserting it

```bash
npm run prove:e2ee     # wiretap the traffic and try to read the note
npm run db:inspect     # dump the audit schema and scan every row for identifiers
```

`prove:e2ee` runs a proxy between the browser and the app — exactly where
Cloudflare sits — records every byte in both directions, then tries to recover
the note from the capture. It reports the wrapped-key and ciphertext sizes,
shows the ciphertext decoded as text, and checks that no identifier appears
anywhere in the traffic, that the AES key cannot be unwrapped without the Mac
Mini's private key, and that GCM rejects tampered ciphertext.

`db:inspect` prints every table and row count, the full `AuditLog` column list,
one real row in both directions, and then scans the whole table for known
identifiers.

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
| `src/lib/auth.ts` | Google sign-in, with the mandatory email allowlist |
| `src/lib/model-registry.ts` | The Gemini ladder and observed availability |
| `src/lib/prompts.ts` | Specialty routine CRUD + the guard that keeps PHI out of saved prompts |

## Nightly backups

`ops/backup-airlock.sh` dumps the database with the container's own `pg_dump`
(always the right version), gzips it into `~/Documents/airlock-backups/` so Time
Machine picks it up, and prunes dumps older than 30 days. Files are `chmod 600`,
the directory `700`.

Installed as a launchd job that fires **hourly at :59** — daily was tried first
and a 24-hour window is precisely what lost a day of history. Each dump is a few
KB, so 30 days of hourly retention costs single-digit megabytes. If the Mac is
asleep, launchd runs it at next wake.

```bash
cp ops/uk.galenchen.airlock.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/uk.galenchen.airlock.backup.plist
bash ops/backup-airlock.sh          # run once by hand to check
tail ~/Documents/airlock-backups/backup.log
```

Restoring is a plain `psql` load — verified end to end, all seven tables and
their rows:

```bash
gunzip -c ~/Documents/airlock-backups/airlock_YYYY-MM-DD_HHMM.sql.gz \
  | docker compose exec -T db psql -U airlock -d clinical_notes
```

This is the answer to "a Docker reset would nuke my data" — the volume is
already durable across restarts and `compose down`, and the dump covers the one
case that is not: `compose down -v` or a Docker factory reset.

## Sign-in

Google sign-in via Auth.js, gating **everything** — `/` redirects anonymous
browsers to `/signin`, and every API route returns 401. Before this, anything
that could reach the tunnel could submit clinical text.

```bash
# 1. Google Cloud Console → APIs & Services → Credentials → OAuth client ID
#    Type: Web application. Authorised redirect URIs:
#      http://localhost:3000/api/auth/callback/google
#      https://llm.galenchen.uk/api/auth/callback/google
# 2. Put the client id/secret in .env, plus:
openssl rand -base64 32        # -> AUTH_SECRET
```

**`AUTH_ALLOWED_EMAILS` is mandatory and fails closed.** An unset or empty
allowlist denies *everyone* rather than allowing everyone — without it, any
Google account on earth could sign in to a tunnelled instance. Accepts
addresses and whole domains:

```
AUTH_ALLOWED_EMAILS="you@example.com,@yourhospital.org.tw"
```

Airlock stores only what OAuth returns: name, email, avatar.

### Developer bypass

For working on the UI without Google, `DEV_LOGIN_ENABLED=true` adds a password
form to `/signin` that signs you in as `airlock_dev`.

It mints a **real** session row rather than threading a special case through the
app, so ownership, history scoping and tenant isolation behave exactly as they
do for a Google account — a bypass that takes a different code path is a bypass
that hides bugs.

Two guards, because `llm` on a public hostname is not authentication: it is off
unless explicitly enabled, and it refuses any request whose `Host` is not
localhost unless `DEV_LOGIN_ALLOW_REMOTE=true`. While enabled, a standing amber
banner says so at the top of every page.

## Past notes

Each run is filed against the clinician who made it, and the **History** drawer
recalls them — searchable, expandable, copyable, deletable.

Everything in history is de-identified and permanently so. The token→PII map is
destroyed when the request that created it ends, so history *cannot* show a
real name; it is a record of what crossed to the cloud, not a second copy of
the chart. One clinician can never see, reuse or delete another's notes or
routines — the acceptance suite asserts this both ways.

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

The selector bar on the page picks where a run **starts**.

**Availability is observed, never predicted.** Airlock cannot see your Google AI
Studio dashboard — no API reports remaining quota — so a rung greys out only
after Google has actually refused it. That observation is written to the
`ModelCooldown` table, so a container restart does not forget which models are
spent and burn a request per rung rediscovering it.

The cooldown is honest about which kind of refusal it was: a per-day exhaustion
is held until midnight US Pacific, not retried in 25 seconds because a
`retryDelay` hint said so.

The 2.5-era models are deliberately absent — Google returns NOT_FOUND for them
on keys issued after their retirement, so listing them would only spend a
request rediscovering that daily.

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

## Documentation

| | |
| --- | --- |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema diagram, what each table holds, and what is deliberately absent |
| [ops/PUBLISH.md](ops/PUBLISH.md) | Cloudflare Tunnel, both routes, and the pre-flight checklist |

## Configuration files

| | |
| --- | --- |
| `.env` | **Never committed.** Holds the Gemini key, Google OAuth secret, `AUTH_SECRET` and the tunnel token. |
| `.env.example` | The tracked template. Copy to `.env` and fill in. |
| `docker-compose.yml` | app + Postgres + migrate, and an opt-in `tunnel` profile |
| `Dockerfile` | Multi-stage build to a standalone Next server |

## Known limits of the regex pass

Rules added after real notes leaked through them, kept here because the list is
the honest statement of what this layer does and does not catch:

| Shape | Example | Why it was missed |
| --- | --- | --- |
| Staff code | `DOC4674E` | Neither 7-8 digits nor a word |
| Name beside a staff code | `DOC4674E   劉展瑋` | In a tabular header there is no sentence for the NER to recognise a name by |
| Ward-bed cell | `A092- 36` | Not the `8B病房` form the NER was shown |
| Month/day, no year | `1/21`, `2/3-2/5` | The date rule needs three components |

Month/day is deliberately bounded to real months and days and refuses anything
that reads as a dose (`1/2 tab`, `1/2 vial`), because mangling a paediatric dose
is a patient-safety problem rather than a formatting one. `152/94 mmHg` and
`(L/R) 5+/6+` are unaffected.

**This layer is still not a guarantee.** It catches shapes it has been taught.
Read the redaction list before filing a note — that is what it is for.

## The rule that matters

`TokenVault` contents must never be written to Postgres, a file, a log line, or
telemetry. If you add logging to the pipeline route, log `deidentifiedInput` —
never `plaintext`, never `noteText`, never `vault`.

## Where the data lives, and why not in a Docker volume

Postgres and the RSA keypair are **bind-mounted to the Mac's own filesystem**,
under `AIRLOCK_DATA_DIR` (default
`~/Library/Application Support/ProjectAirlock`). They are deliberately *not*
Docker named volumes.

This is not a preference. Named volumes live inside Docker Desktop's VM disk
image, and **a Docker Desktop major upgrade can reset that image** — going from
28.x to 29.x destroyed this database, the routines, the sessions and the RSA
keypair in one step, with no warning and nothing in `docker volume ls`
afterwards. A bind mount survives Docker upgrades, factory resets, and
uninstalling Docker altogether.

Verified end to end: write a note and a routine through the site, quit Docker
Desktop entirely, relaunch, and read both back — along with the same session
and the *same* RSA `keyId`.

What still destroys data: deleting `AIRLOCK_DATA_DIR` yourself. `docker compose
down`, `down -v`, rebuilds and Docker upgrades no longer touch it.

The other way to lose it is a `TRUNCATE` run by hand. The acceptance suite is
deliberately non-destructive: it creates its own users and removes only what it
created.

## On a 1024×768 ward screen

Built for the monitor you actually have. **No control ever loses its label** —
the header wraps to a second row instead, and only the decorative strapline is
dropped. Measured at 1024×768: all eight chips readable, no horizontal
overflow, and **Encrypt & structure** on screen without scrolling (it used to
be below the fold). Verified at 1024, 1280, 1600 and 1920.

## Light and dark

A three-state control in the header: **Light**, **Dark**, **Follow system**.
"System" is a real state rather than the absence of a choice — a ward monitor
that dims at dusk should keep doing so unless someone says otherwise. The choice
is written to `<html data-theme>` and mirrored to `localStorage`, and an inline
script applies it before first paint so there is no white flash on a night
shift.

Two details that matter more than they look:

- Tailwind v4 ties `dark:` to `prefers-color-scheme`. With ~70 `dark:`
  utilities in the UI, an explicit toggle would have left them fighting the CSS
  variables — so the variant is redefined to honour the attribute *and* the OS
  preference.
- The theme lives in the DOM, not React state, and the toggle reads it through
  `useSyncExternalStore`. That avoids both a hydration mismatch and a
  render-time `localStorage` read.

Two light-mode bugs the toggle exposed, both worth naming:

- Spent model chips were `text-[var(--muted)]/60` on `bg-[var(--border)]/40`
  with a strikethrough. In light mode those two converge — the labels measured
  **1:1**, i.e. the text was exactly the colour of its own background and
  simply vanished. Spent now reads as "off", not "erased", and clears AA in
  both themes (7.04:1 light, 7.08:1 dark). Translucent fills over a white
  surface are also gone: solid tokens only, since an alpha wash is what made
  this hard to see coming.
- **"Copy clean note" was dangerously ambiguous.** In a de-identification tool
  "clean" reads as "de-identified" — but it copied the *re-hydrated* note, full
  of real names. It is now two buttons that say what they contain:
  **Copy note · with names** (accent-coloured, for the chart) and
  **Copy de-identified** (for anywhere else). Verified: the first contains real
  identifiers and no placeholders, the second the reverse.

`npm run audit:contrast` walks **every text node on every surface** — sign-in,
the main page empty / typed / processing / with a result, and all six drawers —
in both themes. It composites through alpha layers and `opacity` exactly as
rendered, so nothing is judged by the class name alone.

Widening it from "controls" to "all text", and from resting states to
in-flight ones, turned 0 known problems into **135**. They were three causes,
not 135 bugs:

| Cause | Effect |
| --- | --- |
| `opacity` used to dim things | Pending pipeline steps 2.59:1, model chips 2.21:1 while a note ran. Dimming drags text toward whatever it sits on — the same mistake that once made spent chips **1:1**, i.e. literally invisible. |
| Tailwind `-600`/`-500` shades on white | Status pills 3.62:1, redaction tags 3.2:1. Fine in dark at `-400`; the light half needed `-700`. |
| `animate-pulse` on the busy pill | The "Mac Mini Busy" label dipped to **2.14:1** mid-cycle — unreadable exactly when it matters. The icon pulses now, not the text. |

Result: **1,763 text nodes checked, zero below AA, in both themes.**

Solid buttons stay white-on-green in both themes. The fix for the dark-mode
contrast failure was to darken the *fill* (`--accent-solid`), not to flip the
label to dark text — a green button with dark text stops reading as the primary
action. `--accent` remains the lighter tint used for accent *text* and borders.

Long prompts and payloads no longer look truncated. Where a box must stay
capped it uses `.scroll-visible`, which forces a visible scrollbar: macOS
overlay scrollbars hide until you gesture, so a clipped box reads as missing
content rather than scrollable content. In the Prompts drawer the cap was
removed altogether — one scroll region beats a scroller nested in a scroller.

Light mode was rebalanced rather than inverted: `--muted` darkened so secondary
text clears 4.5:1 on white, panels given a faint elevation because a border
alone is too weak on an off-white monitor, and a visible focus ring added.
Measured in light mode — body 17.1:1, headings 7.0:1, submit button 6.4:1,
footer 6.5:1; all AA.

## Multiple clinicians

Yes, with one caveat worth understanding.

Sign-in, history and routines are fully per-user: three clinicians can work at
once and each sees only their own notes. But **the compute slot is global, not
per user** — 16 GB of unified memory runs one model pass at a time, so notes
queue rather than run in parallel. A waiting client shows what the box is busy
with and starts automatically when the slot frees.

Measured with three simultaneous users:

```
carol   done at  9.5s  (waited out 0 busy replies)
bob     done at 13.9s  (waited out 5 busy replies)
alice   done at 17.9s  (waited out 7 busy replies)
3/3 completed, each seeing only their own note
```

So it is genuinely multi-user, but throughput is one note at a time. For a ward
round where several people submit at once, expect the last person to wait
roughly *n* × the time of one note.

## What each model is told

The **Prompts** drawer shows both system prompts verbatim — the local NER
prompt and the Gemini system instruction — plus every format skeleton, with a
copy button.

All of it is **read-only, deliberately**:

- The local prompt *is* the de-identification step. Weakening it would silently
  widen what reaches the cloud.
- The Gemini system instruction carries the placeholder rules that let a note be
  re-hydrated at all, and the rules that stop the model inventing findings.
- The format skeletons are what `AuditLog.noteFormat` refers to. If they drifted
  per user, two rows both labelled "SOAP" would not be comparable.

Customisation goes in a **saved routine**, or the one-off box for a single note.
Both are appended *beneath* the fixed rules, so a routine can shape the note
without overriding what protects the patient. Routines are owned, PII-screened
on save, and recorded by name on every audit row — so a note can always be
traced back to the instructions that produced it.

## Stale tabs fix themselves

Every build gets an id, exposed in `/api/status` and baked into the browser
bundle. A tab left open across a deploy notices the mismatch on its next poll
and reloads once. This is what a removed banner surviving on screen until a
manual reload actually was — old JS, not old code.

The pipeline is similarly forgiving about the RSA key: if the server reports it
could not decrypt, the client re-fetches the public key past any cache and
retries once, rather than telling a clinician to reload mid-note.

## Housekeeping notes

- `npm run db:inspect` is the fastest way to satisfy yourself that the audit
  table holds nothing identifying.
- The container healthcheck hits `/api/health`, which is public and returns
  `{"ok":true}` and nothing else. Every other route is behind sign-in, so a
  probe against `/api/status` would fail forever with a 401.
- Docker build cache grows quickly across rebuilds. `docker builder prune -af`
  reclaims it without touching the `airlock-db` or `airlock-keys` volumes.
