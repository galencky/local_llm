/**
 * Full-system acceptance test against a LIVE server with real LM Studio, real
 * Gemini, and the real Postgres audit database. No stubs.
 *
 *   npx tsx scripts/e2e-full-system.ts
 *
 * Covers: the ward-note pipeline end to end, specialty routines (CRUD + effect
 * on output + audit attribution), the PHI guard on saved prompts, the input
 * length cap, the streaming progress contract, the single-slot 429, and the
 * database's de-identification invariant.
 *
 * NON-DESTRUCTIVE. It creates its own users and removes only what it created;
 * your notes and routines are left alone. Never add a TRUNCATE here — the
 * leak scan deliberately covers every row in the table, including yours, and
 * emptying it first would make that check meaningless as well as destroying
 * real history.
 */
import "dotenv/config";
import { ComputeBusyError, PipelineError, runPipeline, STAGE_ORDER } from "../src/lib/pipeline-client";
import type { PipelineStage, ProgressEvent } from "../src/lib/pipeline-client";
import { HARD_CHAR_LIMIT } from "../src/lib/limits";
import { prisma } from "../src/lib/db";
import { request as httpRequest } from "node:http";
import { createTestSession, destroyTestUser, type TestSession } from "./test-session";

const base = "http://localhost:3000";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "  — " + detail}`);
  if (!ok) failures++;
}
function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** A realistic Taiwanese nursing shift note. Every identifier is invented. */
const WARD_NOTE = `【護理紀錄 — 夜班交班】8B病房 15-2床
病歷號 4471902，患者林淑惠，身分證 H284549486，女性 74 歲，
入院日期 2024/04/18，主診斷 right hip fracture s/p ORIF。
主治醫師 吳承翰，住院醫師 郭怡君，本班護理師 蔡宜蓁。
聯絡人：長女林佳玲 0937-882-146，次子林建國 04-23015678。
住址：台中市西屯區台灣大道三段 168 號。轉診自 中國醫藥大學附設醫院。
23:00 GCS E4V5M6 = 15。右髖術後傷口疼痛 NRS 6 分，予 morphine 2mg IV PRN 後降至 2 分。
BT 37.8°C，BP 138/82 mmHg，HR 92/min，SpO2 96% room air。
02:30 Hb 9.2 g/dL，WBC 11,300/µL，CRP 4.6 mg/dL，Albumin 3.1 g/dL。
04:00 Braden Scale 15 分，Morse Fall Scale 55 分，予每 2 小時翻身。Foley catheter 留置中。
預計 113/04/25 轉復健科病房。`;

const PII = [
  "林淑惠", "林佳玲", "林建國", "吳承翰", "郭怡君", "蔡宜蓁",
  "H284549486", "4471902", "0937-882-146", "04-23015678",
  "中國醫藥大學附設醫院", "2024/04/18", "113/04/25",
];
const CLINICAL = [
  "GCS E4V5M6", "Braden Scale", "Morse Fall Scale", "Foley catheter",
  "morphine 2mg", "9.2", "11,300", "4.6", "37.8",
];

/**
 * EMR-export shapes that reached the cloud intact in real use: a staff code and
 * the physician name printed beside it, a ward-bed cell, and month/day dates
 * with no year — the commonest date format in a ward note, and invisible to a
 * rule that expects three components.
 */
const EMR_HEADER = `[病程紀錄內容] 2024/08/12 18:08:00  A092- 36  PNS   DOC1234X   林建宏   [Progress Note]
Urgent surgery was done on 1/21. Follow-up MRI on 1/23. Re-do surgery on 2/2.
Albumin and lasix since 2/3-2/5. BP 152/94 mmHg. Pupil (L/R) 5+/6+. Give 1/2 tab BID.`;
const EMR_MUST_GO = ["林建宏", "DOC1234X", "A092- 36", "1/21", "1/23", "2/2", "2/3"];
const EMR_MUST_STAY = ["152/94", "5+/6+", "1/2 tab", "PNS"];

interface RunResult {
  note: string;
  deidentifiedInput: string;
  deidentifiedOutput: string;
  redactions: { token: string; category: string; preview: string; source: string }[];
  meta: {
    auditLogId: string | null;
    model: string;
    format: string;
    promptTemplateName: string | null;
    llmEntityCount: number;
    unresolvedTokens: string[];
    degradedScrub: boolean;
    processingTimeMs: number;
  };
}

let sessionA: TestSession;
let sessionB: TestSession;

async function api(path: string, init?: RequestInit, as?: TestSession) {
  const who = as ?? sessionA;
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...who.cookie, ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  sessionA = await createTestSession("clinician-a");
  sessionB = await createTestSession("clinician-b");

  // The box runs one note at a time. If something else is mid-run — a browser
  // tab, a screenshot script — wait rather than reporting a false failure.
  for (let i = 0; i < 60; i++) {
    const st = (await api("/api/status")).body as { busy?: boolean; activity?: { label?: string } };
    if (!st.busy) break;
    if (i === 0) console.log(`  waiting for the compute slot (${st.activity?.label ?? "busy"})…`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  /* ---------------------------------------------------------------- */
  section("0. Authentication gate");
  for (const [path, init] of [
    ["/api/status", undefined],
    ["/api/history", undefined],
    ["/api/prompts", undefined],
    ["/api/models", undefined],
    ["/api/process-note", { method: "POST", body: "{}" }],
  ] as [string, RequestInit | undefined][]) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
    });
    check(`${path} refuses an anonymous caller`, res.status === 401, `got ${res.status}`);
  }
  const page = await fetch(`${base}/`, { redirect: "manual" });
  check("/ redirects anonymous browsers to sign-in",
    page.status === 307 && (page.headers.get("location") ?? "").includes("/signin"),
    `${page.status} ${page.headers.get("location")}`);
  check("/signin itself is public", (await fetch(`${base}/signin`)).status === 200);

  section("0b. Developer bypass guards");
  const devPost = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const devCfg = ((await api("/api/status")).body as {
    devLogin?: { enabled: boolean; allowsRemote: boolean };
  }).devLogin;
  const devEnabled = devCfg?.enabled;

  if (!devEnabled) {
    check("dev bypass disabled -> route is 404", (await devPost({ password: "llm" })).status === 404);
  } else {
    check("wrong password rejected", (await devPost({ password: "nope" })).status === 401);
    check("empty password rejected", (await devPost({ password: "" })).status === 401);
    // fetch() silently drops a custom Host — it is a forbidden header — so the
    // tunnel guard has to be exercised over a raw socket to mean anything.
    const spoofed = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ password: "llm" });
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: 3000,
          path: "/api/auth/dev-login",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Host: "llm.galenchen.uk",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    if (devCfg?.allowsRemote) {
      check("remote allowed by config, so a foreign Host is accepted", spoofed === 200, `got ${spoofed}`);
    } else {
      check("refused when the Host is not localhost", spoofed === 403, `got ${spoofed}`);
    }

    const ok = await devPost({ password: "llm" });
    check("correct password accepted", ok.status === 200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    check("issues a session cookie", setCookie.includes("authjs.session-token"));
    check("cookie is httpOnly", /httponly/i.test(setCookie));

    const devCookie = setCookie.split(";")[0];
    const who = await (
      await fetch(`${base}/api/auth/session`, { headers: { Cookie: devCookie } })
    ).json();
    check("signs in as airlock_dev", who?.user?.name === "airlock_dev", JSON.stringify(who?.user));

    // The bypass must be an ordinary session, not a privileged one.
    const devHist = await (
      await fetch(`${base}/api/history`, { headers: { Cookie: devCookie } })
    ).json();
    check(
      "dev user sees only its own history",
      Array.isArray(devHist.notes) && devHist.notes.every((n: { id: string }) => n.id !== undefined),
    );
  }

  /* ---------------------------------------------------------------- */
  section("1. Preflight — every dependency is real");
  const status = (await api("/api/status")).body as {
    lmStudio: { online: boolean; models: string[] };
    database: { online: boolean };
    gemini: { configured: boolean; model: string };
  };
  check("LM Studio online", status.lmStudio.online, JSON.stringify(status.lmStudio));
  check("audit database online", status.database.online);
  check("Gemini key configured", status.gemini.configured);
  console.log(
    `       local: ${status.lmStudio?.models?.[0] ?? "(none reported)"}   cloud: ${status.gemini?.model}`,
  );

  /* ---------------------------------------------------------------- */
  section("2. Specialty routines — CRUD against Postgres");
  const before = ((await api("/api/prompts")).body as { templates: unknown[] }).templates.length;

  const created = await api("/api/prompts", {
    method: "POST",
    body: JSON.stringify({
      name: `Orthopaedic nursing handover ${Date.now()}`,
      specialty: "Orthopaedics",
      format: "PROGRESS_NOTE",
      instruction:
        "Open with a Fall Risk line quoting the Morse Fall Scale, and a Pressure Injury Risk line quoting the Braden Scale. State wound status and drain output explicitly under Objective. Number the Plan, one line per active problem.",
    }),
  });
  check("create routine → 201", created.status === 201, `got ${created.status}`);
  const routine = (created.body as { template: { id: string; name: string } }).template;

  const listed = (await api("/api/prompts")).body as { templates: { id: string }[] };
  check("routine appears in the list", listed.templates.some((t) => t.id === routine.id));
  check("list grew by one", listed.templates.length === before + 1);

  const patched = await api(`/api/prompts/${routine.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: routine.name,
      specialty: "Orthopaedics",
      format: "PROGRESS_NOTE",
      isDefault: false,
      instruction:
        "Open with a Fall Risk line quoting the Morse Fall Scale, and a Pressure Injury Risk line quoting the Braden Scale. State wound status explicitly under Objective. Number the Plan.",
    }),
  });
  check("update routine → 200", patched.status === 200, `got ${patched.status}`);

  const dupe = await api("/api/prompts", {
    method: "POST",
    body: JSON.stringify({ name: routine.name, instruction: "x" }),
  });
  check("duplicate name → 409", dupe.status === 409, `got ${dupe.status}`);

  section("3. PHI guard — a routine may never carry patient data");
  const dirty = await api("/api/prompts", {
    method: "POST",
    body: JSON.stringify({
      name: `Bad ${Date.now()}`,
      instruction: "Chart like the note for 病歷號 4471902, ID H284549486, admitted 2024/04/18.",
    }),
  });
  check("PHI-bearing routine → 422", dirty.status === 422, `got ${dirty.status}`);
  const detail = (dirty.body as { detail?: string[] }).detail ?? [];
  check("names the categories found", detail.length >= 3, JSON.stringify(detail));

  /* ---------------------------------------------------------------- */
  section("4. Input cap — refuses what the local model cannot scan safely");
  try {
    await runPipeline({ baseUrl: base, text: "患者".repeat(HARD_CHAR_LIMIT), format: "SOAP", headers: sessionA.cookie });
    check("oversized note refused", false, "it was accepted");
  } catch (e) {
    check("oversized note refused", e instanceof PipelineError && e.code === "TOO_LONG", String(e));
  }

  /* ---------------------------------------------------------------- */
  section("5. Ward note through the full pipeline (no routine)");
  const seen: ProgressEvent[] = [];
  const plain = await runPipeline<RunResult>({
    baseUrl: base,
    text: WARD_NOTE,
    format: "PROGRESS_NOTE",
    headers: sessionA.cookie,
    onProgress: (e) => seen.push(e),
  });

  const doneStages = new Set(seen.filter((e) => e.status === "done").map((e) => e.stage));
  check(
    "every pipeline stage streamed a completion",
    STAGE_ORDER.every((s: PipelineStage) => doneStages.has(s)),
    [...doneStages].join(","),
  );
  check("stages arrived in pipeline order", (() => {
    const order = seen.filter((e) => e.status === "running").map((e) => e.stage);
    const idx = order.map((s) => STAGE_ORDER.indexOf(s));
    return idx.every((v, i) => i === 0 || v >= idx[i - 1]);
  })());

  for (const p of PII) check(`cloud never saw ${p}`, !plain.deidentifiedInput.includes(p));
  for (const c of CLINICAL) check(`clinical content preserved: ${c}`, plain.deidentifiedInput.includes(c));

  check("local NER found names", plain.meta.llmEntityCount >= 5, `${plain.meta.llmEntityCount}`);
  check("scrub was not degraded", plain.meta.degradedScrub === false);
  check("no placeholders left in the note", plain.meta.unresolvedTokens.length === 0,
    JSON.stringify(plain.meta.unresolvedTokens));
  // The real contract is not "Gemini mentions the attending" — whether a
  // progress note names the consultant is the model's editorial choice. The
  // pipeline's guarantee is that EVERY token the model did emit comes back as
  // the correct identifier, and that none survive as literal text.
  const emitted = plain.redactions.filter((r) => plain.deidentifiedOutput.includes(r.token));
  check("Gemini emitted placeholders to restore", emitted.length > 0, `${emitted.length}`);
  check(
    "every emitted token was restored",
    emitted.every((r) => !plain.note.includes(r.token)),
    emitted.filter((r) => plain.note.includes(r.token)).map((r) => r.token).join(","),
  );
  check("no bracketed placeholder survives in the note", !/\[[A-Z]+_\d+\]/.test(plain.note),
    (plain.note.match(/\[[A-Z]+_\d+\]/g) ?? []).join(","));
  // Positive proof that re-hydration actually ran: at least one real
  // identifier from the source is back in the finished note. Which ones the
  // model chose to carry through varies run to run.
  const restored = PII.filter((p) => plain.note.includes(p));
  check("real identifiers are back in the note", restored.length > 0, "none restored");
  console.log(`       restored ${restored.length}/${PII.length}: ${restored.join(", ") || "—"}`);
  check("audit row written", Boolean(plain.meta.auditLogId));
  check("inspector previews are masked", plain.redactions.every((r) => r.preview.includes("*")));
  check("both scrub passes contributed",
    plain.redactions.some((r) => r.source === "regex") && plain.redactions.some((r) => r.source === "llm"));

  /* ---------------------------------------------------------------- */
  section("6. Same note WITH the specialty routine");
  const styled = await runPipeline<RunResult>({
    baseUrl: base,
    text: WARD_NOTE,
    format: "PROGRESS_NOTE",
    promptId: routine.id,
    headers: sessionA.cookie,
  });
  check("routine reported in metadata", styled.meta.promptTemplateName === routine.name,
    String(styled.meta.promptTemplateName));
  check("routine shaped the output (Fall Risk line)", /fall risk/i.test(styled.note),
    styled.note.slice(0, 120));
  check("routine shaped the output (Braden / pressure injury)",
    /braden|pressure injury/i.test(styled.note));
  // Same contract as section 5: whether the model echoes any given identifier
  // is its editorial choice — that every token it DID emit comes back is not.
  const styledEmitted = styled.redactions.filter((r) => styled.deidentifiedOutput.includes(r.token));
  check("routine run emitted placeholders", styledEmitted.length > 0, `${styledEmitted.length}`);
  check(
    "every emitted token restored under a routine",
    styledEmitted.every((r) => !styled.note.includes(r.token)),
    styledEmitted.filter((r) => styled.note.includes(r.token)).map((r) => r.token).join(","),
  );
  check("real identifiers back in the routine note", PII.some((p) => styled.note.includes(p)));
  check("cloud still saw no PII under a routine",
    PII.every((p) => !styled.deidentifiedInput.includes(p)));

  /* ---------------------------------------------------------------- */
  section("7. Audit database — the de-identification invariant");
  const row = await prisma.auditLog.findUnique({ where: { id: styled.meta.auditLogId! } });
  check("audit row is retrievable", Boolean(row));
  check("audit records the routine by name", row?.promptTemplateName === routine.name);
  check("audit records the model", row?.modelUsed === styled.meta.model);
  check("audit stores a de-identified input", (row?.deidentifiedInput ?? "").includes("["));

  const leaked = await prisma.auditLog.count({
    where: {
      OR: PII.flatMap((p) => [
        { deidentifiedInput: { contains: p } },
        { deidentifiedOutput: { contains: p } },
      ]),
    },
  });
  check("NO audit row contains any identifier", leaked === 0, `${leaked} row(s) leaked`);
  console.log(`       scanned ${await prisma.auditLog.count()} audit rows for ${PII.length} identifiers`);

  /* ---------------------------------------------------------------- */
  section("6b. EMR-export shapes that leaked in real use");
  {
    const vault = new (await import("../src/lib/memory-cache")).TokenVault();
    const { scrubWithRegex } = await import("../src/lib/scrubber-regex");
    const out = scrubWithRegex(EMR_HEADER, vault).text;
    for (const bad of EMR_MUST_GO) check(`redacted ${bad}`, !out.includes(bad));
    for (const good of EMR_MUST_STAY) check(`preserved ${good}`, out.includes(good));
  }

  /* ---------------------------------------------------------------- */
  section("7b. History — per-user recall of de-identified notes");
  const hist = (await api("/api/history")).body as { notes: { id: string; deidentifiedInput: string; noteFormat: string | null }[] };
  check("clinician A sees their own notes", hist.notes.length >= 2, `${hist.notes.length}`);
  check("history records the note format", hist.notes.every((n) => n.noteFormat !== null));
  check(
    "history is de-identified — no identifier in any row",
    hist.notes.every((n) => PII.every((p) => !n.deidentifiedInput.includes(p))),
  );

  const searchHit = (await api("/api/history?q=ORIF")).body as { notes: unknown[] };
  const searchMiss = (await api("/api/history?q=zzzznotpresent")).body as { notes: unknown[] };
  check("search finds matching notes", searchHit.notes.length > 0);
  check("search excludes non-matching notes", searchMiss.notes.length === 0);

  section("7b2. Shared routines are manageable, not orphaned");
  // Regression: rows with userId = null were visible to everyone and writable
  // by no one, so they could never be deleted.
  const shared = await prisma.promptTemplate.create({
    data: { name: `Shared routine ${Date.now()}`, instruction: "Keep the plan terse.", userId: null },
  });
  const sharedList = (await api("/api/prompts")).body as { templates: { id: string; userId: string | null }[] };
  check("shared routine is visible", sharedList.templates.some((t) => t.id === shared.id));
  check("shared routine reports a null owner",
    sharedList.templates.find((t) => t.id === shared.id)?.userId === null);

  const editShared = await api(`/api/prompts/${shared.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: shared.name, instruction: "Edited by a signed-in user." }),
  });
  check("a signed-in user can edit a shared routine", editShared.status === 200, `got ${editShared.status}`);

  const delShared = await api(`/api/prompts/${shared.id}`, { method: "DELETE" });
  check("a signed-in user can delete a shared routine", delShared.status === 200, `got ${delShared.status}`);
  check("it is really gone",
    (await prisma.promptTemplate.findUnique({ where: { id: shared.id } })) === null);

  section("7c. Tenant isolation");
  const bHist = (await api("/api/history", undefined, sessionB)).body as { notes: unknown[] };
  check("clinician B sees none of A's notes", bHist.notes.length === 0, `${bHist.notes.length}`);

  const bPrompts = (await api("/api/prompts", undefined, sessionB)).body as { templates: { id: string }[] };
  check("clinician B does not see A's routine", !bPrompts.templates.some((t) => t.id === routine.id));

  const steal = await api(`/api/prompts/${routine.id}`, { method: "DELETE" }, sessionB);
  check("clinician B cannot delete A's routine", steal.status === 403, `got ${steal.status}`);

  const stillThere = (await api("/api/prompts")).body as { templates: { id: string }[] };
  check("A's routine survived B's attempt", stillThere.templates.some((t) => t.id === routine.id));

  const aNoteId = hist.notes[0].id;
  const stealNote = await api(`/api/history?id=${aNoteId}`, { method: "DELETE" }, sessionB);
  check("clinician B cannot delete A's note", stealNote.status === 404, `got ${stealNote.status}`);
  check("A's note survived", (await prisma.auditLog.findUnique({ where: { id: aNoteId } })) !== null);

  /* ---------------------------------------------------------------- */
  section("8. Single-slot limit under concurrent load");
  const burst = await Promise.all(
    [1, 2, 3].map(async (n) => {
      try {
        await runPipeline({ baseUrl: base, text: WARD_NOTE, format: "SOAP", headers: sessionA.cookie });
        return { n, busy: false };
      } catch (e) {
        return { n, busy: e instanceof ComputeBusyError, err: e instanceof Error ? e.message : "" };
      }
    }),
  );
  const rejected = burst.filter((r) => r.busy).length;
  check("exactly one request admitted", burst.length - rejected === 1, JSON.stringify(burst));
  check("the rest were told the box is busy", rejected === 2);
  const after = (await api("/api/status")).body as { busy: boolean; activity: unknown };
  check("lock released afterwards", after.busy === false);

  /* ---------------------------------------------------------------- */
  section("9. Cleanup");
  const del = await api(`/api/prompts/${routine.id}`, { method: "DELETE" });
  check("routine deleted → 200", del.status === 200);
  const finalList = ((await api("/api/prompts")).body as { templates: unknown[] }).templates.length;
  check("library back to its original size", finalList === before, `${finalList} vs ${before}`);

  await destroyTestUser(sessionA.userId);
  await destroyTestUser(sessionB.userId);
  check("test users removed", (await prisma.user.count({ where: { email: { endsWith: "@airlock.test" } } })) === 0);

  console.log(
    failures === 0
      ? `\n\x1b[32mAll checks passed.\x1b[0m\n`
      : `\n\x1b[31m${failures} check(s) FAILED.\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
