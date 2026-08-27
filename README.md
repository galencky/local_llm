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

1. **You choose** what you are doing and which model does it. Everything below
   follows from those two choices.
2. **Your browser locks the note.** It is encrypted in the browser itself, with
   a fresh key made for this one note.
3. **It crosses the internet as ciphertext.** Cloudflare, which carries it, can
   only relay bytes it cannot read.
4. **The Mac Mini opens it.** If the note is bound for Google, two
   de-identification passes run first:
   - **Pattern rules** catch the things that always look the same — national
     IDs, medical record numbers, phone numbers, dates, staff codes, ward-bed
     cells. Deterministic: what they catch, they always catch.
   - **A local AI model** catches what patterns cannot — a patient's name, a
     relative, an attending, an address, an employer, a hospital. This runs on
     your Mac, so the narrative with the names still in it never travels.
5. **Only placeholders go to the cloud.** Gemini is told, in the strongest
   terms, to copy every placeholder back exactly.
6. **The Mac puts the identifiers back**, using a map that exists only in
   memory and is destroyed the moment the request ends.
7. **The finished note comes home sealed.**

If instead you send it to the **local model**, steps 4 to 6 do not happen at
all — there is nothing to protect the note from, because it never leaves the
machine. See [the one rule](#the-one-rule).

## The one rule

**De-identification happens if and only if the run is bound for Google.**

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
Studio is not running, for exactly that reason: Gemini cannot be reached
without it.

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
  number can be mistaken for a medical record number. An odd-looking note is a
  cost worth paying for a name that never left.
- **The encryption defeats a passive eavesdropper, not an active one.** The
  server's public key is served over the same tunnel it protects, so someone who
  controlled that edge could substitute their own. Pinning the key closes this;
  see [TECHNICAL.md](TECHNICAL.md).
- **One note at a time.** 16 GB of unified memory runs one model pass, so
  several clinicians can use it at once but their notes queue rather than run in
  parallel.
- **A local run keeps no record.** Nothing is redacted and nothing is logged, so
  it never appears in History and leaves no audit trail. That is the deal the
  local model offers, and it is stated on screen while it is selected.

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
it never asked for. In Custom prompt your prompt is the shape, so there is
nothing to pick.

**Pattern rules.** A switch on the de-identification row, for cloud runs only.
On by default: national IDs, MRNs, phone numbers and dates are removed
deterministically before the model looks. They are deliberately over-eager
though — a bed number can read as a date — so you can turn them off and let the
local model alone find everything. Doing that is marked on screen while it is
off and recorded on the audit row, because it is a real weakening: the rules are
certain where the model is probabilistic.

**Sampling.** Two labelled rows, so it is never ambiguous which model you are
tuning. The first is the **de-identification pass**, named for the LM Studio
model doing it — it applies only to a cloud-bound run, and says so and greys out
otherwise. The second is whichever model answers: **Google Gemini** or your
**local model**, named. Temperature, top-p, top-k and max tokens on both, in
both modes. Anything left at its off value is not sent at all, so the model's
own default applies.

The de-identification *prompt* is not editable and never will be — it is the
de-identification step itself. Its numbers are, because the worst a bad number
can do is find fewer names, which the redaction list shows you.

**Routines.** Saved, named, and owned — in both modes. A *note* routine is a
charting instruction appended to every note that uses it ("always call out
dialysis access and dry weight under Objective"). A *prompt* routine saves the
system instruction, the prompt and the sampling together, so selecting it
restores the whole run rather than just the words. Routines are screened for
patient data when you save them and refused if any is found, because they live
in Postgres forever.

**Reading the result.** The output pane renders what models actually emit —
headings, nested lists, tables of labs, fenced blocks, quotes, inline code —
rather than showing asterisks and pipes in the middle of a chart entry.

**Watching it work.** When the local model is writing — whether it is finding
identifiers or answering a prompt — you see the text appear as it is produced,
rather than a spinner. Those chunks are encrypted exactly like the finished
answer, so watching costs nothing in confidentiality.

**Checking the work.** Four drawers: the **redaction list** (what was taken
out), **Wire view** (what crossed the internet), **Prompts** (exactly what each
model is told, read live from the running server), and **History** (past notes,
de-identified, searchable). Every drawer closes on **Escape** or a click
outside, keeps the keyboard inside it while open, and hands focus back to the
control you opened it from.

**Copying.** A cloud run gives you two buttons: the note with the real names for
the chart, and the de-identified version for anywhere else. A local run gives
you one — nothing was replaced, so there is only one version of it.

**On a phone.** It works on one. Inputs are sized so iOS does not zoom the page
when you tap them, touch targets are thumb-sized on any touch device, and the
detail rows fold behind **Run detail** so the input and the run button are not
buried under settings. Mode and model stay visible, because those are the two
choices that change what a run does.

**Keyboard.** **Cmd/Ctrl + Enter** runs. When the run button is greyed out it
says why on hover.

## Proving it rather than asserting it

```bash
npm run verify        # offline: encryption, both scrubbers, re-hydration, the lock
npm run prove:e2ee    # wiretap the traffic and try to read the note out of it
npm run db:inspect    # dump the audit schema and scan every row for identifiers
npm run e2e:system    # full acceptance run against the live stack
npm run e2e:prompt    # the one rule, asserted from both destinations
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
