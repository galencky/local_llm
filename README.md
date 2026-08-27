# Project Airlock

> *A local AI strips patient identity before the cloud.*

Airlock turns a messy ward narrative into a formal hospital note — SOAP,
discharge summary, hospital course, admission note, progress note — **without
any patient identifier leaving the machine it runs on**.

It is a small, self-hosted Next.js app. One person built it for one Mac Mini in
Taiwan, but nothing about it is specific to that hospital, and the parts that
*are* specific to Taiwan are in one file you can rewrite.

Created by **Kuan-Yuan Chen**. Built with **Claude Code**.
Source: <https://github.com/galencky/local_llm>

| If you are… | Read |
| --- | --- |
| deciding whether this is for you | [Is this for you?](#is-this-for-you) and [What it does not promise](#what-it-does-not-promise) |
| setting it up | [Install](#install), then [Prove it works](#prove-it-works) |
| adapting it to your own hospital | [Making it yours](#making-it-yours) |
| changing the code | **[TECHNICAL.md](TECHNICAL.md)** — every module's inputs and outputs, the flow charts, and the debugging playbook |

---

## The problem

Cloud language models are very good at turning a shift's worth of scribbled
observations into a structured chart entry. They are also, legally and
ethically, the last place a clinician can put a patient's name.

Under Taiwan's Personal Data Protection Act — and the GDPR, and HIPAA, and most
other regimes — a medical record is special-category personal data. Pasting a
ward note into a chatbot sends the patient's name, national ID, chart number,
ward, bed, phone numbers and admission dates to a company on another continent.

The obvious workaround, "I'll take the names out myself", fails for the same
reason charting is hard in the first place: it is tedious, it happens at 3 a.m.,
and one missed surname is a disclosure.

## The idea

An airlock joins two environments that must never meet directly.

A language model running **on your own machine** reads the note first and takes
out every name, ID, date, ward and address, replacing each with a numbered
placeholder. Only then does the outer door open onto the cloud. The cloud model
sees `[PATIENT_1]` and `[MRN_1]`, never a name and never a chart number. It
writes the structured note around those placeholders, and the real identifiers
are put back **on your machine, after the door has shut again**.

```
browser ──AES-GCM sealed──▶ Cloudflare ──ciphertext──▶ your Mac (M4 / 16 GB)
                                                          │
                                       pattern scrub ─────┤  raw patient data
                                       local AI scrub ────┤  never leaves
                                                          ▼  this box
                                         [PATIENT_1] [MRN_1] … ──▶ Gemini
                                                          │
                                       put names back ────┤
browser ◀──AES-GCM sealed──  Cloudflare ◀──ciphertext─────┘
```

## Is this for you?

**It fits if** you are a clinician or a small department, you already have a Mac
with enough memory to hold a mid-size model, and you want cloud-quality note
structuring without cloud-side identifiers. One machine serves several people —
they queue rather than run in parallel.

**It does not fit if** you need many concurrent users, a hospital-wide rollout,
or a vendor with an audited compliance certificate. This is one person's tool,
published because the mechanism is worth copying, not because it is a product.

**What you are committing to:** running a local model, keeping a Postgres
container alive, and reading the redaction list before you file a note. The last
one is not optional — see [what it does not promise](#what-it-does-not-promise).

## What happens to one note

1. **You choose** which workspace you are in and which model writes the answer.
   Everything below follows from those two choices.
2. **Your browser locks the note** — encrypted in the page itself, with a fresh
   key made for this one note.
3. **It crosses the internet as ciphertext.** Cloudflare, which carries it, can
   only relay bytes it cannot read. (This matters because Cloudflare terminates
   ordinary HTTPS at its edge.)
4. **Your Mac opens it.** If the note is bound for Google, two de-identification
   passes run first:
   - **Pattern rules** catch things that always look the same — national IDs,
     chart numbers, phone numbers, dates, staff codes, ward-bed cells.
     Deterministic: what they catch, they always catch.
   - **A local AI model** catches what patterns cannot — a patient's name, a
     relative, an attending, an address, an employer, a hospital. This runs on
     your machine, so the narrative with the names in it never travels.
5. **Only placeholders go to the cloud.**
6. **Your Mac puts the identifiers back**, using a map that exists only in
   memory and is destroyed the moment the request ends.
7. **The finished note comes home sealed.**

If you send it to the **local model** instead, steps 4 to 6 do not happen at
all — there is nothing to protect the note from, because it never leaves the
machine. See [the one rule](#the-one-rule).

## The one rule

**De-identification happens if and only if the run is bound for the cloud.**

It reads off one thing — the destination — and there is no combination that is
an exception. No prompt is consulted when deciding it, because nothing you can
type is part of the decision.

|  | Note | Custom prompt |
| --- | --- | --- |
| You give it | a ward narrative | a system instruction and a prompt |
| You get back | a structured note | an answer |
| **Gemini** | de-identified, logged | de-identified, logged |
| **Local model** | **raw — nothing redacted, nothing logged** | **raw — nothing redacted, nothing logged** |

**Cloud runs are de-identified without exception**, and are refused outright if
the local model is not available to do it. The cloud options grey out when LM
Studio is not running, for exactly that reason.

**Local runs are not de-identified at all**, and write no row to the note log.
That is not an oversight. There is no de-identified copy of a local run to
store, and storing the raw text would put the only unredacted copy of it on
disk — the exact thing the rest of the design exists to prevent. The trade is
worth stating plainly: **notes written locally do not appear in History.** The
interface says so, in those words, while a local model is selected.

## Why it matters

**The cloud never sees a patient.** Not "we told it not to look" — it is not
sent. You can check this yourself: after any run, **Wire view** shows the
literal bytes that crossed the internet, and the **redaction list** shows every
identifier that was taken out, masked.

**Nothing identifying is written down.** The audit database stores
de-identified text only. There is no column for the raw note and none for the
name-to-placeholder map — that map lives in RAM for one request and is then
wiped. This is why History can never show you a real name.

**It fails closed.** If the local model is unreachable, a cloud run is refused
rather than sent with weaker scrubbing. Refusing to write a note is an
inconvenience; leaking a name is not.

**Only people you name can use it.** Sign-in is Google, gated by an email
allowlist that denies everyone when it is empty.

## What it does not promise

Stated plainly, because a de-identification tool that oversells itself is worse
than none.

- **The local AI pass is probabilistic.** It is very good and it is not perfect.
  That is exactly why the redaction list exists — read it before you file a note.
- **The pattern rules catch shapes they have been taught.** A format they have
  never met has no rule. The current list, and what once slipped through it, is
  in [TECHNICAL.md](TECHNICAL.md).
- **Over-redaction happens, and is the safe failure.** A seven-digit accession
  number can be mistaken for a chart number; a bed number can read as a date. An
  odd-looking note is a cost worth paying for a name that never left.
- **The encryption defeats a passive eavesdropper, not an active one.** The
  server's public key is served over the same tunnel it protects, so someone who
  controlled that edge could substitute their own. Pinning the key closes this;
  see [TECHNICAL.md](TECHNICAL.md).
- **One note at a time.** 16 GB of unified memory runs one model pass, so
  several clinicians can use it at once but their notes queue rather than run in
  parallel.
- **A local run keeps no record.** Nothing is redacted and nothing is logged, so
  it never appears in History and leaves no audit trail.
- **This is not a certified medical device**, and the formatted note is written
  by a model. Read it as a draft, not a record.

---

## Install

### What you need

| | |
| --- | --- |
| **A Mac with ≥16 GB unified memory** | Apple Silicon. The local model has to fit alongside everything else. |
| **[LM Studio](https://lmstudio.ai)** | Runs the local model. Stays on the host — see below. |
| **A local model** | Any instruction-tuned model that reads your clinical language. `google/gemma-4-12b` is what this was tuned against; a 4B model works and misses more. |
| **[Docker Desktop](https://docker.com)** | Runs the app and Postgres. |
| **A Google Gemini API key** | Free tier is enough. <https://aistudio.google.com/apikey> |
| **A Google OAuth client** | For sign-in. Ten minutes in the Cloud Console — steps in [TECHNICAL.md](TECHNICAL.md) Appendix A. |

Linux and Windows are not tested. Nothing in the code is macOS-specific except
`host.docker.internal` and the launchd backup job, but nobody has tried it.

### Steps

```bash
git clone https://github.com/galencky/local_llm.git
cd local_llm
cp .env.example .env
```

Now open `.env` and fill it in. Every variable is commented in the file; three
of them decide whether this works at all:

| Variable | Why it matters |
| --- | --- |
| `AUTH_ALLOWED_EMAILS` | **Mandatory.** Empty means *nobody*, not everybody. Accepts addresses and whole domains (`@yourhospital.org.tw`). |
| `AIRLOCK_DATA_DIR` | Where Postgres and the server's keypair actually live, on your own filesystem rather than inside Docker. A Docker Desktop upgrade destroyed this database once; a bind mount survives that. |
| `AUTH_SECRET` | `openssl rand -base64 32` |

Start the local model **on the host, not in Docker**:

```bash
lms server start --port 1234
lms load google/gemma-4-12b
```

Docker Desktop on macOS runs a Linux VM with no GPU passthrough, so a
containerised model loses Metal acceleration entirely. It stays outside, and the
container reaches it at `host.docker.internal:1234`.

Then bring up the app, Postgres and the migrations:

```bash
docker compose up -d --build
```

Open <http://localhost:3000> and sign in.

### Set Docker Desktop's memory to 2 GB

Settings → Resources. The whole stack peaks around 215 MB, and on a 16 GB Mac
every gigabyte the VM reserves is a gigabyte the model cannot use. Measured: a
2 GB VM leaves 6.2 GB free with `gemma-4-12b` loaded; the 8 GB default leaves
2.7 GB.

### Working on the code

Docker is for running it. For editing it, run the app on the host against the
same Postgres container:

```bash
npm install
npm run dev
```

Set `DEV_LOGIN_ENABLED=true` in `.env` to sign in with a password instead of
Google while you work. It is localhost-only unless you deliberately say
otherwise, and it mints a *real* session rather than threading a special case
through the app — so ownership and history behave exactly as they do for a
Google account. Turn it off before the instance sees a patient.

### Publishing it to a hospital

`docker compose --profile tunnel up -d` brings up a Cloudflare Tunnel alongside
the app. The full checklist — DNS, the OAuth redirect URI, and what to verify
before letting anyone else near it — is in [ops/PUBLISH.md](ops/PUBLISH.md).

## Prove it works

Don't take the claims on trust. Each of these checks one of them, and they run
against your own installation.

```bash
npm run verify        # offline: encryption, both scrubbers, re-hydration, the lock
npm run prove:e2ee    # wiretap the traffic and try to read the note out of it
npm run db:inspect    # dump the audit schema and scan every row for identifiers
npm run e2e:system    # full acceptance run against the live stack
npm run e2e:prompt    # the one rule, asserted from both destinations
```

`verify` needs nothing but Node — no model, no key, no database. The rest need
the stack up.

`prove:e2ee` puts a recording proxy exactly where Cloudflare sits, captures every
byte in both directions, and then tries to recover the note from the capture.
`db:inspect` prints what the database holds and scans the whole table for known
identifiers. `e2e:system` runs a realistic ward note end to end and asserts, from
the Gemini side, that no identifier reached it.

All of them are non-destructive: they create their own users and remove only
what they created.

## Using it

The page reads in the order you use it: **choose, then write, then press one
button.** Every selector is above the input; the only thing below it is the run
button, and nothing moves when you change your mind.

**Mode.** *Note* takes a ward narrative and gives back a structured chart entry.
*Custom prompt* takes a system instruction and a prompt and gives back an
answer — the left panel becomes two boxes and the right panel becomes Output.

**Model.** *Local* is whatever LM Studio has loaded, detected automatically and
named on the chip. The rest are the Gemini ladder, best first; a rung greys out
only once Google has actually refused it, and the run walks down from there
rather than failing. The cloud rungs are unavailable when LM Studio is down,
because Gemini cannot be reached without it.

**Shape.** In Note: SOAP, admission, progress, course, discharge — plus
**Others**, which has no built-in shape at all and runs on a saved routine
alone, so a routine that describes its own headings is not fighting a structure
it never asked for. In Custom prompt your prompt is the shape.

**Pattern rules.** A switch on the de-identification row, for cloud runs only.
On by default. They are deliberately over-eager — a bed number can read as a
date — so you can turn them off and let the local model alone find everything.
Doing that is marked on screen while it is off and recorded on the audit row,
because it is a real weakening: the rules are certain where the model is
probabilistic.

**Sampling.** Two labelled rows, so it is never ambiguous which model you are
tuning. The first is the **de-identification pass**, named for the LM Studio
model doing it — it applies only to a cloud-bound run, and greys out otherwise.
The second is whichever model answers. Anything left at its off value is not
sent at all, so the model's own default applies.

The de-identification *prompt* is not editable and never will be — it is the
de-identification step itself. Its numbers are, because the worst a bad number
can do is find fewer names, which the redaction list shows you.

**Routines.** Saved, named and owned, in both modes. A *note* routine is a
charting instruction appended to every note that uses it ("always call out
dialysis access and dry weight under Objective"). A *prompt* routine saves the
system instruction, the prompt and the sampling together, so selecting it
restores the whole run. Routines are screened for patient data when you save
them and refused if any is found, because they live in Postgres forever.

**Watching it work.** When the local model is writing — finding identifiers or
answering a prompt — you see the text appear as it is produced. Those chunks are
encrypted exactly like the finished answer, so watching costs nothing in
confidentiality.

**Checking the work.** Four drawers: the **redaction list** (what was taken
out), **Wire view** (what crossed the internet), **Prompts** (exactly what each
model is told, read live from the running server), and **History** (past notes,
de-identified, searchable).

**Copying.** A cloud run gives you two buttons: the note with the real names for
the chart, and the de-identified version for anywhere else. A local run gives
you one — nothing was replaced, so there is only one version of it.

**Keyboard.** **Cmd/Ctrl + Enter** runs. When the run button is greyed out it
says why on hover.

## Making it yours

The parts most people will want to change, and where they are:

| To change… | Edit | Notes |
| --- | --- | --- |
| **which identifiers the rules catch** | `src/lib/scrubber-regex.ts` | The Taiwan-specific half of the project. Rule **order is load-bearing** — the comments say why. Add a case to `scripts/verify-pipeline.ts` for anything you add. |
| **what the local model looks for** | `NER_SYSTEM_PROMPT` in `src/lib/scrubber-llm.ts` | Naming the structured categories explicitly is what moved recall from 9/17 to 17/17 on the test note. The category list is a *suggestion*, not a whitelist: the model may invent tags, and the code guarantees the round trip. |
| **the note formats** | `NOTE_FORMATS` and `FORMAT_INSTRUCTIONS` in `src/lib/gemini.ts` | Add a key to both. `BUILT_IN_FORMATS` must stay declared *below* `FORMAT_INSTRUCTIONS`. |
| **which cloud models are tried** | `GEMINI_MODEL_LADDER` in `.env`, or `DEFAULT_LADDER` in `src/lib/model-registry.ts` | Best first. Availability is observed, never predicted. |
| **the cloud provider** | `src/lib/gemini.ts` | It is one module with one job. Whatever replaces it must keep the placeholder rules in its system instruction, or re-hydration breaks. |
| **the input budget** | `src/lib/limits.ts` | `HARD_CHAR_LIMIT` is a **safety** limit, not a performance one: past it your local model starts missing names. Raise it only if you raise the model. |
| **who may sign in** | `AUTH_ALLOWED_EMAILS` | Or replace the Google provider in `src/lib/auth.ts`. Keep the fail-closed allowlist. |

Adapting it to another country is mostly the first two rows. Everything else —
the envelope, the vault, the lock, the audit invariant — has no idea which
country it is in.

### Rules that must survive any change

1. The name-to-placeholder map is never written to Postgres, to a file, to a log
   line, or to telemetry. Log the de-identified text. Never the note, never the
   map.
2. The local pass fails closed. If it cannot run, a cloud run is refused.
3. Every span the local model returns is verified verbatim against the source
   before it becomes a placeholder.
4. Every route that returns data calls `auth()` itself. The middleware only
   proves a session *cookie* is present, never that it is valid.
5. The app runs as exactly one replica. The compute lock lives in that process's
   memory.

The full list, and how to test against it, is in
[TECHNICAL.md § 18](TECHNICAL.md#18-changing-this-safely).

## When something breaks

| Symptom | Usually |
| --- | --- |
| Every cloud model is greyed out | LM Studio is not running, or has no model loaded. Gemini needs it for the de-identification pass. |
| "Local NER de-identification is unavailable" | The same, mid-run. This is the fail-closed path working. |
| Every request is 401 | `AUTH_URL` disagrees with how the browser reaches you, so Auth.js is looking for a differently-named cookie. |
| Sign-in bounces with `AccessDenied` | The account is not in `AUTH_ALLOWED_EMAILS`. |
| Sign-in fails with `MissingCSRF` behind a tunnel | An edge cache is holding `/api/auth/csrf`. The app sets `no-store` on every API response for this reason. |
| The page shows something that is no longer in the code | A tab running an old bundle. It reloads itself within one status poll. |

The full symptom table, the SSE stream format, and how to read the logs are in
[TECHNICAL.md § 16](TECHNICAL.md#16-debugging-playbook).

## Reading further

| | |
| --- | --- |
| [TECHNICAL.md](TECHNICAL.md) | Flow charts, every module's inputs and outputs, every script, and the debugging playbook |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, what each table holds, what is deliberately absent |
| [ops/PUBLISH.md](ops/PUBLISH.md) | Cloudflare Tunnel and the pre-flight checklist |

## Licence

UNLICENSED — all rights reserved. Read it, learn from it, and ask before you
ship it.
