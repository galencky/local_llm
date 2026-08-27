# Project Airlock

> *A local AI strips patient identity before the cloud.*

Airlock turns a messy Taiwanese ward narrative into a formal hospital note — SOAP,
discharge summary, hospital course, admission note, progress note — **without any
patient identifier leaving the Mac Mini it runs on**.

Created by **Kuan-Yuan Chen**. Built with **Claude Code**.
Source: <https://github.com/galencky/local_llm>

- **New here? Keep reading.** This page explains what it does and why that matters.
- **Working on it, or fixing it?** The full mechanism, every script, and the
  debugging playbook are in **[TECHNICAL.md](TECHNICAL.md)**.

---

## The problem

Cloud language models are very good at turning a shift's worth of scribbled
observations into a properly structured chart entry. They are also, legally and
ethically, the last place a Taiwanese clinician can put a patient's name.

Under Taiwan's Personal Data Protection Act, a medical record is special-category
personal data. Pasting a ward note into a chatbot sends the patient's name, ID,
medical record number, ward, bed, phone numbers and admission dates to a company
on another continent. The obvious workaround — "I'll take the names out myself" —
fails in practice for the same reason charting is hard in the first place: it is
tedious, it happens at 3 a.m., and one missed surname is a disclosure.

## The idea

An airlock joins two environments that must never meet directly.

A language model running **on your own Mac** reads the note first and takes out
every name, ID, date, ward and address — replacing each with a numbered
placeholder. Only then does the outer door open onto the cloud. The cloud model
sees `[PATIENT_1]` and `[MRN_1]`, never the patient's name and never their chart
number. It writes the structured note around those placeholders, and the real
identifiers are put back **on the Mac, after the door has shut again**.

```
browser ──AES-GCM sealed──▶ Cloudflare ──ciphertext──▶ Mac Mini (M4 / 16 GB)
                                                          │
                                       pattern scrub ─────┤  raw patient data
                                       local AI scrub ────┤  never leaves
                                                          ▼  this box
                                         [PATIENT_1] [MRN_1] … ──▶ Gemini
                                                          │
                                       put names back ────┤
browser ◀──AES-GCM sealed──  Cloudflare ◀──ciphertext─────┘
```

## What happens to one note

1. **You paste the narrative** and pick a note format.
2. **Your browser locks it.** The note is encrypted in the browser itself, with a
   fresh key made for this one note.
3. **It crosses the internet as ciphertext.** Cloudflare, which carries it, can
   only relay bytes it cannot read.
4. **The Mac Mini opens it** and runs two de-identification passes:
   - **Pattern rules** catch the things that always look the same — national IDs,
     medical record numbers, phone numbers, dates, staff codes, ward-bed cells.
     These are deterministic: what they catch, they always catch.
   - **A local AI model** catches what patterns cannot — a patient's name, a
     relative, an attending, an address, an employer, a hospital. This runs on
     your Mac, so the narrative with the names still in it never travels.
5. **Only placeholders go to the cloud.** Gemini formats the note it is given and
   is told, in the strongest terms, to copy every placeholder back exactly.
   (Or, if you pick the **Local** model, this step happens on the Mac too and
   nothing goes anywhere at all.)
6. **The Mac puts the identifiers back**, using a map that exists only in memory
   and is destroyed the moment the request ends.
7. **The finished note comes home sealed**, and you get two copies: one with the
   real names for the chart, one still de-identified for anywhere else.

The whole round trip takes roughly 15–70 seconds, most of it the two model calls.

## Why it matters

**The cloud never sees a patient.** Not "we told it not to look" — it is not sent.
You can check this yourself: after any run, **Wire view** shows the literal bytes
that crossed the internet, and the **redaction list** shows every identifier that
was taken out, masked.

**Nothing identifying is written down.** The audit database stores the
de-identified note only. There is no column for the raw text and none for the
name-to-placeholder map — that map lives in RAM for one request and is then
wiped. This is why History can never show you a real name: it is a record of what
went to the cloud, not a second copy of the chart.

**It fails closed.** If the local model is unreachable, the request is refused
rather than sent to the cloud with weaker scrubbing. Refusing to write a note is
an inconvenience; leaking a name is not.

**Only people you name can use it.** Sign-in is Google, gated by an email
allowlist that denies everyone when it is empty. An instance published to the
internet with no allowlist would otherwise accept any Google account on earth.

## What it does not promise

This is stated plainly because a de-identification tool that oversells itself is
worse than none.

- **The local AI pass is probabilistic.** It is very good and it is not perfect.
  That is exactly why the redaction list exists — read it before you file a note.
- **The pattern rules catch shapes they have been taught.** A format they have
  never met has no rule. The current list, and what once slipped through it, is
  in [TECHNICAL.md](TECHNICAL.md).
- **Over-redaction happens, and is the safe failure.** A seven-digit accession
  number can be mistaken for a medical record number. An odd-looking note is a
  cost worth paying for a name that never left.
- **The encryption defeats a passive eavesdropper, not an active one.** The
  server's public key is served over the same tunnel it protects, so someone who
  controlled that edge could substitute their own. Pinning the key closes this;
  see [TECHNICAL.md](TECHNICAL.md).
- **One note at a time.** 16 GB of unified memory runs one model pass, so several
  clinicians can use it at once but their notes queue rather than run in parallel.

## Running it

You need a Mac with [LM Studio](https://lmstudio.ai), Docker Desktop, and a
Google Gemini API key.

```bash
cp .env.example .env          # then fill it in — see the comments in the file

lms server start --port 1234  # LM Studio stays on the HOST, not in Docker
lms load google/gemma-4-12b   # any instruction model that reads Traditional Chinese

docker compose up -d --build  # app + Postgres + migrations
```

Then open <http://localhost:3000>.

LM Studio is deliberately **not** containerised: Docker Desktop on macOS has no
GPU passthrough, so a model inside a container would lose Metal acceleration
entirely. It runs on the host and the container reaches it at
`host.docker.internal:1234`.

Two settings that matter more than they look:

- `AUTH_ALLOWED_EMAILS` is **mandatory**. Empty means nobody, not everybody.
- `AIRLOCK_DATA_DIR` is where Postgres and the server's keypair actually live, on
  the Mac's own filesystem rather than inside Docker. A Docker Desktop upgrade
  destroyed this database once; a bind mount survives that.

To publish it to a hospital over a Cloudflare Tunnel, see
[ops/PUBLISH.md](ops/PUBLISH.md).

## Using it

There is one thing to decide before a run, and it is decided by two controls
sitting together: **what you are doing**, and **which model does it**.

|  | Note | Custom prompt |
| --- | --- | --- |
| You give it | a ward narrative | a system instruction and a prompt |
| You get back | a structured note | an answer |
| **Gemini** | de-identified, logged | de-identified, logged |
| **Local model** | de-identified, logged | **raw — nothing redacted, nothing logged** |

**The rule is the destination, not the prompt.** Anything bound for Google is
de-identified first, without exception, and the run is refused outright if the
local model is unavailable to do it. No prompt you can write changes that,
because nothing in a prompt is consulted when deciding it. The cloud options
grey out when LM Studio is not running, for the same reason.

The corollary is what makes the local model worth having: when nothing leaves
the box there is nothing to protect it from. **Custom prompt + Local** is the
one combination that runs raw — your text reaches the model exactly as written,
and no row is written to the note log, because that row would be the only
unredacted copy of it anywhere on disk. It is your machine talking to your
model. The interface says so, in those words, while it is selected.

**Formats.** In the Note workspace, five note shapes — SOAP, admission,
progress, hospital course, discharge summary. The format is recorded on the
audit row, so two notes labelled "SOAP" are comparable.

**Routines.** A saved instruction block per department — "always call out
dialysis access and dry weight under Objective". Written once, appended to every
note that uses it. Routines are screened for patient data when you save them and
refused if any is found.

**Checking the work.** Four drawers: the **redaction list** (what was taken
out), **Wire view** (what crossed the internet), **Prompts** (exactly what each
model is told, read live from the running server), and **History** (your past
notes, de-identified, searchable). Every drawer closes on **Escape** or a click
outside, keeps the keyboard inside it while open, and hands focus back to the
control you opened it from.

**Keyboard.** **Cmd/Ctrl + Enter** runs. When the run button is greyed out it
says why on hover — nothing typed yet, over the length cap, or a prompt that
needs fixing.

## Proving it rather than asserting it

```bash
npm run verify        # offline: encryption, both scrubbers, re-hydration, the lock
npm run prove:e2ee    # wiretap the traffic and try to read the note out of it
npm run db:inspect    # dump the audit schema and scan every row for identifiers
npm run e2e:system    # full acceptance run against the live stack
npm run e2e:prompt    # the custom-prompt workspace on both destinations
```

`prove:e2ee` puts a recording proxy exactly where Cloudflare sits, captures every
byte in both directions, and then tries to recover the note from the capture.
`db:inspect` prints what the database holds and scans the whole table for known
identifiers.

## Reading further

| | |
| --- | --- |
| [TECHNICAL.md](TECHNICAL.md) | How every part works, every script, and how to debug it |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, what each table holds, what is deliberately absent |
| [ops/PUBLISH.md](ops/PUBLISH.md) | Cloudflare Tunnel and the pre-flight checklist |

## The rule that matters

If you change the pipeline: the name-to-placeholder map must never be written to
Postgres, to a file, to a log line, or to telemetry. Log the de-identified text.
Never the note, never the map.
