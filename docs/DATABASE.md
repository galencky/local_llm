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
  from Google                     └────────────────────────────────────┘
                                    ▲ ON DELETE CASCADE from User

┌────────────────────────────────────┐   ┌──────────────────────────────┐
│ PromptTemplate    ← saved routines │   │ ModelCooldown                │
│────────────────────────────────────│   │──────────────────────────────│
│ id          uuid   PK              │   │ model      text     PK       │
│ userId      text?  FK  (null =     │   │ until      timestamp         │
│                    shared)         │   │ reason     text              │
│ name        text   UQ(userId,name) │   │ daily      boolean           │
│ specialty   text?                  │   │ updatedAt  timestamp         │
│ instruction text                   │   └──────────────────────────────┘
│ format      text?                  │     which Gemini models are spent
│ isDefault   boolean                │     — learned only by being refused
│ createdAt / updatedAt              │
└────────────────────────────────────┘
```

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

## What is deliberately absent

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
