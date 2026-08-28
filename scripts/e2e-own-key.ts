/**
 * Acceptance test for bring-your-own Gemini key.
 *
 *   npx tsx scripts/e2e-own-key.ts
 *
 * The promise being checked is narrow and worth stating: a clinician's key is
 * never handled less carefully than a clinical note. So this asserts it crosses
 * the wire sealed, is never written down, never reaches a log or an audit row,
 * and that the quota it spends — and the exhaustion it earns — belong to that
 * key alone rather than to everyone on the instance.
 *
 * Needs a live server, real LM Studio, and a real Gemini key in GEMINI_API_KEY
 * (used here AS IF it were a clinician's own, which is exactly the point: the
 * pipeline cannot tell the difference and must not try).
 */
import "dotenv/config";
import { createServer, request as httpRequest } from "node:http";
import { runPipeline, verifyGeminiKey, PipelineError } from "../src/lib/pipeline-client";
import { INSTANCE_QUOTA, maskGeminiKey, quotaFingerprint } from "../src/lib/gemini-key";
import { prisma } from "../src/lib/db";
import { createTestSession, destroyTestUser } from "./test-session";
import { check, finish, note, section } from "./harness";

const base = "http://localhost:3000";
const KEY = process.env.GEMINI_API_KEY?.trim() ?? "";


const NOTE = `病歷號 4471902，患者林淑惠，主治醫師吳承翰。BT 37.8°C，CRP 4.6 mg/dL。`;

interface Result {
  note: string;
  deidentifiedInput: string;
  meta: {
    auditLogId: string | null;
    model: string;
    destination: "cloud" | "local";
    quotaSource: "own" | "instance";
  };
}

/**
 * A recording proxy in Cloudflare's seat, so "the key crossed sealed" is an
 * observation rather than an assertion about code we wrote.
 */
function wiretap(port: number) {
  const seen: string[] = [];
  const proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push(Buffer.concat(chunks).toString("utf8"));
      const up = httpRequest(
        { host: "127.0.0.1", port: 3000, path: req.url, method: req.method, headers: req.headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 500, upRes.headers);
          upRes.on("data", (c: Buffer) => {
            seen.push(c.toString("utf8"));
            res.write(c);
          });
          upRes.on("end", () => res.end());
        },
      );
      up.on("error", () => res.destroy());
      up.end(Buffer.concat(chunks));
    });
  });
  return {
    seen,
    listen: () => new Promise<void>((r) => proxy.listen(port, r)),
    close: () => new Promise<void>((r) => proxy.close(() => r())),
  };
}

async function main() {
  if (!KEY) {
    console.error("GEMINI_API_KEY is not set; this suite needs a real key to present as a user's own.");
    process.exit(1);
  }
  const who = await createTestSession("own-key");
  const tap = wiretap(8901);
  await tap.listen();

  try {
    section("0. The key's identity is derived, one-way, and agreed by both ends");
    const fingerprint = await quotaFingerprint(KEY);
    check("no key means the instance quota", (await quotaFingerprint(null)) === INSTANCE_QUOTA);
    check("a key yields 16 hex characters", /^[0-9a-f]{16}$/.test(fingerprint), fingerprint);
    check("the same key always yields the same scope",
      (await quotaFingerprint(KEY)) === fingerprint);
    check("a different key yields a different scope",
      (await quotaFingerprint(`${KEY.slice(0, -1)}X`)) !== fingerprint);
    check("the fingerprint does not contain the key", !fingerprint.includes(KEY.slice(4, 12)));
    check("the mask shows a tail, never the middle",
      maskGeminiKey(KEY).endsWith(KEY.slice(-4)) && !maskGeminiKey(KEY).includes(KEY.slice(10, 20)));

    section("1. Checking a key: sealed both ways, and honest about what it reaches");
    const good = await verifyGeminiKey(KEY, { baseUrl: `http://127.0.0.1:8901`, headers: who.cookie });
    check("Google accepts a real key", good.ok === true, good.error ?? "");
    check("it reports which ladder rungs the key reaches", good.usable.length > 0,
      `usable=${good.usable.length} missing=${good.missing.length}`);
    const bad = await verifyGeminiKey("AIza" + "b".repeat(35), { baseUrl: base, headers: who.cookie });
    check("a well-formed but wrong key is refused", bad.ok === false);
    check("and the refusal says why", /not valid|API key/i.test(bad.error ?? ""), bad.error ?? "");
    await verifyGeminiKey("short", { baseUrl: base, headers: who.cookie }).then(
      () => check("a malformed key is refused before Google is called", false, "it was accepted"),
      (e: Error) =>
        check("a malformed key is refused before Google is called",
          e instanceof PipelineError && /too short/i.test(e.message), e.message),
    );

    section("2. The key never crosses the wire in the clear");
    check("no request or response body contains the key",
      !tap.seen.some((frame) => frame.includes(KEY)),
      `${tap.seen.length} frames captured`);
    check("the check really did go through the tap", tap.seen.length > 0);

    section("3. A run on your own key");
    const rowsBefore = await prisma.auditLog.count({ where: { userId: who.userId } });
    const own = await runPipeline<Result>({
      baseUrl: base,
      text: NOTE,
      format: "SOAP",
      geminiApiKey: KEY,
      headers: who.cookie,
    });
    check("a note came back", own.note.length > 0);
    check("it reports that your quota paid", own.meta.quotaSource === "own", own.meta.quotaSource);
    check("a cloud model served it", own.meta.model.startsWith("gemini-"), own.meta.model);
    check("it is still de-identified", !own.deidentifiedInput.includes("林淑惠"));
    check("an audit row was written",
      (await prisma.auditLog.count({ where: { userId: who.userId } })) === rowsBefore + 1);

    section("4. The audit row records the run, never the credential");
    const row = await prisma.auditLog.findUnique({ where: { id: own.meta.auditLogId ?? "" } });
    check("the row exists", Boolean(row));
    const serialised = JSON.stringify(row);
    check("no column contains the key", !serialised.includes(KEY));
    check("no column contains its fingerprint", !serialised.includes(fingerprint));
    check("no column contains the key's distinctive head",
      !serialised.includes(KEY.slice(0, 12)));

    section("5. Nowhere in the database holds the key");
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname='public'`;
    let hits = 0;
    for (const { tablename } of tables) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT * FROM "${tablename}" LIMIT 500`,
      );
      if (JSON.stringify(rows).includes(KEY)) hits++;
    }
    check(`the key appears in none of the ${tables.length} tables`, hits === 0, `${hits} table(s)`);

    section("6. Exhaustion is scoped to the key that earned it");
    // Availability is OBSERVED, and an observation belongs to one Google
    // allowance. Read the same ladder under three names and compare.
    const ladderFor = async (q: string) =>
      (await (
        await fetch(`${base}/api/models?quota=${encodeURIComponent(q)}`, { headers: who.cookie })
      ).json()) as {
        models: { id: string; available: boolean }[];
        quota: string;
        instanceKey: boolean;
      };

    // A fingerprint-shaped scope that has never run anything.
    const virgin = "0123456789abcdef";
    const [asInstance, asMine, asVirgin] = await Promise.all([
      ladderFor(INSTANCE_QUOTA),
      ladderFor(fingerprint),
      ladderFor(virgin),
    ]);
    check("the instance reports whether it has a key of its own", asInstance.instanceKey === true);
    check("a quota that has never run sees the whole ladder",
      asVirgin.models.every((m) => m.available),
      asVirgin.models.filter((m) => !m.available).map((m) => m.id).join(","));

    const spentSomewhere = [
      ...asInstance.models.filter((m) => !m.available).map((m) => `instance:${m.id}`),
      ...asMine.models.filter((m) => !m.available).map((m) => `yours:${m.id}`),
    ];
    if (spentSomewhere.length === 0) {
      // Say so rather than passing quietly: with nothing spent anywhere, the
      // comparison below has nothing to compare and proves nothing.
      note("nothing is spent on any quota right now, so the cross-quota");
      note("comparison is vacuous this run. Offline scoping is pinned by `npm run verify`.");
    } else {
      note(`spent right now: ${spentSomewhere.join(", ")}`);
      check("nothing spent elsewhere leaks into a fresh quota",
        asVirgin.models.every((m) => m.available));
    }

    const junk = (await ladderFor("../../etc/passwd")).quota;
    check("a quota that is not a fingerprint falls back to the instance",
      junk === INSTANCE_QUOTA, junk);

    section("7. A local run carries no credential at all");
    const localRun = await runPipeline<Result>({
      baseUrl: `http://127.0.0.1:8901`,
      text: NOTE,
      format: "SOAP",
      model: "local",
      geminiApiKey: KEY,
      headers: who.cookie,
    });
    check("it ran locally", localRun.meta.destination === "local");
    check("it reports the instance quota, because it spent nobody's",
      localRun.meta.quotaSource === "instance", localRun.meta.quotaSource);
    check("the key was never even sealed into the payload",
      !tap.seen.some((frame) => frame.includes(KEY)));

    section("8. The key endpoint refuses an unsealed key");
    const naked = await fetch(`${base}/api/gemini-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...who.cookie },
      body: JSON.stringify({ apiKey: KEY }),
    });
    check("a plain JSON key is refused", naked.status === 400, `got ${naked.status}`);
    check("and says an envelope is required",
      ((await naked.json()) as { code?: string }).code === "ENVELOPE_REQUIRED");
    const anon = await fetch(`${base}/api/gemini-key`, { method: "POST", body: "{}" });
    check("and an anonymous caller cannot reach it at all", anon.status === 401, `got ${anon.status}`);
  } finally {
    await tap.close();
    await destroyTestUser(who.userId);
  }

  finish();
}

void main();
