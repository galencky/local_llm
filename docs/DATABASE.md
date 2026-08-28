# The database

Local PostgreSQL 17, in the `db` container, with its data **bind-mounted to the
Mac's filesystem** at `$AIRLOCK_DATA_DIR/postgres` — not a Docker named volume,
because a Docker Desktop major upgrade can reset the VM image those live in and
did destroy this database once. Bound to `127.0.0.1:5432` only, never to your
network.

## Where to find it

| | |
| --- | --- |
| Schema, as source of truth | [`prisma/schema.prisma`](../prisma/schema.prisma) |
| Applied migrations | [`prisma/migrations/`](../prisma/migrations) |
| Inspect it, with a leak scan | `npm run db:inspect` |
| Browse it visually | `npm run db:studio` |
| Raw SQL | `docker compose exec db psql -U airlock -d clinical_notes` |
| Data on disk | `$AIRLOCK_DATA_DIR/postgres` (default `~/Library/Application Support/ProjectAirlock`) |
| Hourly dumps | `~/Documents/airlock-backups/` (:59 each hour, keeps 30 days) |

## Shape

```
┌──────────────────────────────┐
│ User                         │  identity from Google (or the dev bypass)
│──────────────────────────────│
│ id            cuid      PK   │
│ email         text      UQ   │
│ name          text?          │
│ image         text?          │
│ emailVerified timestamp?     │
│ createdAt     timestamp      │
└──────────────────────────────┘
   │ 1            │ 1              │ 1
   │              │                │
   │ n            │ n              │ n
┌──────────────┐ ┌──────────────┐ ┌────────────────────────────────────┐
│ Account      │ │ Session      │ │ AuditLog          ← the clinical    │
│──────────────│ │──────────────│ │────────────────────  record        │
│ provider  PK │ │ sessionToken │ │ id                 uuid    PK      │
│ providerAcct │ │           UQ │ │ createdAt          timestamp       │
│           PK │ │ userId    FK │ │ userId             text?   FK      │
│ userId    FK │ │ expires      │ │ deidentifiedInput  text            │
│ access_token │ └──────────────┘ │ deidentifiedOutput text            │
│ id_token     │                  │ modelUsed          text            │
│ …            │                  │ processingTimeMs   int             │
└──────────────┘                  │ noteFormat         text?           │
  OAuth tokens                    │ promptTemplateName text?           │
  from Google                     │ patternScrub       boolean         │
                                  └────────────────────────────────────┘
                                    ▲ ON DELETE CASCADE from User

┌──────────────────────────────────────┐ ┌──────────────────────────────┐
│ PromptTemplate      ← saved routines │ │ ModelCooldown                │
│──────────────────────────────────────│ │──────────────────────────────│
│ id                uuid   PK          │ │ quota   text  PK  "instance" │
│ userId            text?  FK  (null = │ │                   or a key's │
│                          shared)     │ │                   fingerprint│
│ name              text  UQ(user,name)│ │ model   text  PK             │
│ specialty         text?              │ │ until      timestamp         │
│ kind              text   note|prompt │ │ reason     text              │
│ instruction       text               │ │ daily      boolean           │
│ systemInstruction text?  prompt only │ │ updatedAt  timestamp         │
│ format            text?  note only   │ └──────────────────────────────┘
│ temperature/topP/topK/maxTokens      │   which Gemini models are spent,
│                   nullable numbers   │   for WHICH allowance — learned
│ isDefault         boolean  (per kind)│   only by being refused
│ createdAt / updatedAt                │
└──────────────────────────────────────┘
```

`ModelCooldown.quota` is which Google allowance a refusal was observed against:
the literal `instance` for this deployment's own `GEMINI_API_KEY`, or a truncated
one-way SHA-256 of a clinician's own key. It is part of the primary key because a
refusal is a fact about one allowance and not about the model — a global table
let one clinician exhausting the flagship grey it out for everybody, and the row
survived a restart to keep doing so.

**The fingerprint is the only trace of a clinician's API key anywhere in this
database**, it is not reversible, and it says nothing about who pasted it. The
key itself is never stored — see
[TECHNICAL.md § 8d](../TECHNICAL.md#8d-bring-your-own-gemini-key).

`kind` splits the two workspaces: a **note** routine is a charting instruction
appended beneath the format skeleton; a **prompt** routine *is* the prompt, and
carries its own system instruction and sampling so selecting it restores the
whole run. `isDefault` is per kind — one preselected routine for notes and one
for prompts, because they are never offered at the same time.

The four sampling columns are nullable, and null means "leave whatever the
browser already has" — which is what every row written before routines carried
sampling means.

`patternScrub` records whether the deterministic pass ran for that note. It can
be switched off for a cloud run, which leaves the local model alone responsible
for every identifier, and a note whose de-identification worked differently has
to be traceable as such. It defaults to true, so every row written before the
switch existed says what was true of it.

Prompts are **not** in the database. Both system prompts and the five format
skeletons are compiled into the image and read-only — see the Prompts drawer.
The only prompt text that is stored is a `PromptTemplate`, which is a saved
routine appended beneath the fixed rules.

`VerificationToken` also exists — required by the Auth.js adapter, unused here
because Google is the only provider.

## What is in `AuditLog`, exactly

Two columns of text, both already de-identified:

- **`deidentifiedInput`** — precisely what was sent to Gemini. Every identifier
  is a `[CATEGORY_N]` placeholder.
- **`deidentifiedOutput`** — precisely what Gemini returned, placeholders still
  intact, *before* re-hydration.

A real row:

```
deidentifiedInput │ 病歷號 [MRN_1]，患者[PATIENT_1]，身分證 [TAIWAN_ID_1]，男性 81 歲…
```

## What is not written at all

**A local run writes no row.** The rule in `src/lib/workspace.ts` is that
de-identification happens if and only if a run is bound for the cloud — so a
local run has no de-identified copy of itself, and the invariant below holds by
never writing rather than by writing something and hoping it is safe.

The clinical consequence is worth stating: notes written on the local model do
not appear in History and leave no audit trail. History is a record of what
crossed to the cloud, which is what it has always claimed to be.

## What is deliberately absent

**There is no column for a clinician's Gemini API key.** It lives in their
browser, crosses the tunnel sealed inside the same envelope as the note, is used
for one request and dropped. `npm run e2e:key` sweeps every table for it after a
real run.

**There is no column for the raw note, and none for the token map.**

That mapping — `[PATIENT_1] → 黃文昌` — exists only in `TokenVault`, a JavaScript
`Map` held in the request's own scope. It is purged in the route's `finally`
block and expires after ten minutes regardless. Nothing writes it anywhere.

This is structural, not policy. There is nowhere to put it.

The consequence, which matters clinically: **history can never show a real
name.** Past notes are a record of what crossed to the cloud, not a second copy
of the chart.

## The invariant, checked

`npm run db:inspect` scans every row for known identifiers:

```
Scanned all 12 rows for 15 known identifiers: none present.
```

The acceptance suite asserts the same thing after every pipeline run, and
`PromptTemplate` writes are rejected outright (HTTP 422) if a saved routine
contains anything the scrubber recognises — a template lives in Postgres
forever, so a name pasted into one would quietly defeat the pipeline.

## Ownership and isolation

`AuditLog.userId` and `PromptTemplate.userId` scope every read and write. A
clinician cannot list, reuse or delete another's notes or routines; the suite
asserts this in both directions. A null `PromptTemplate.userId` means a shared
routine anyone on the instance may manage.

Deleting a `User` cascades to their sessions, notes and routines.
