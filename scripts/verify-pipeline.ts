/**
 * Offline verification of the PHI path: encryption round-trip, deterministic
 * scrubbing, local-NER handling, and token re-hydration.
 *
 *   npx tsx scripts/verify-pipeline.ts
 *
 * Uses a stub LM Studio server on port 11234, so it needs neither a real model
 * nor a Gemini key nor Postgres.
 */
import { createServer } from "node:http";
import {
  INSTANCE_QUOTA,
  looksLikeGeminiKey,
  maskGeminiKey,
  quotaFingerprint,
} from "../src/lib/gemini-key";
import {
  generateRsaKeyPair,
  exportSpkiBase64,
  exportPkcs8Base64,
  importRsaPrivateKey,
  sealRequest,
  openRequest,
  sealResponse,
  openResponse,
} from "../src/lib/crypto";
import { TokenVault } from "../src/lib/memory-cache";
import { scrubWithRegex, isValidTaiwanId } from "../src/lib/scrubber-regex";
import { scrubWithLlm, LocalScrubUnavailableError } from "../src/lib/scrubber-llm";
import { acquireLock, releaseLock } from "../src/lib/concurrency";
import { check, finish } from "./harness";

const SAMPLE = `病歷號 12345678，患者陳建明（身分證 A123456789），男性 68 歲，
聯絡電話 0912-345-678，家屬陳美玲 0928765432，住台北市大安區信義路四段 100 號。
2024/03/15 因胸痛至急診，收治於 8B病房 12-3床，主治醫師林志豪。
113/03/18 行冠狀動脈支架置放術。Troponin I 3.45 ng/mL，BP 152/94 mmHg，HR 88。
Discharged 2024-03-22 on aspirin 100mg PO QD. Follow-up with Dr. Huang at 台大醫院.`;

async function main() {
  console.log("\n[1] Crypto round-trip (RSA-OAEP-2048 + AES-256-GCM)");
  const pair = await generateRsaKeyPair();
  const spki = await exportSpkiBase64(pair.publicKey);
  const pkcs8 = await exportPkcs8Base64(pair.privateKey);
  const privateKey = await importRsaPrivateKey(pkcs8);

  const payload = JSON.stringify({ text: SAMPLE, format: "SOAP" });
  const { envelope, aesKey } = await sealRequest(spki, payload);
  check("envelope carries wrapped key + iv", Boolean(envelope.encryptedKey && envelope.iv));
  check(
    "ciphertext is not the plaintext",
    !Buffer.from(envelope.encryptedData, "base64").toString("utf8").includes("陳建明"),
  );

  const opened = await openRequest(privateKey, envelope);
  check("server decrypts request", opened.plaintext === payload);

  const reply = await sealResponse(opened.aesKey, "REHYDRATED NOTE 陳建明");
  check("response uses a fresh IV", reply.iv !== envelope.iv);
  check("client decrypts response", (await openResponse(aesKey, reply)) === "REHYDRATED NOTE 陳建明");

  let tampered = false;
  try {
    await openResponse(aesKey, { ...reply, iv: Buffer.alloc(12).toString("base64") });
  } catch {
    tampered = true;
  }
  check("GCM rejects a tampered IV", tampered);

  console.log("\n[2] Deterministic Taiwan PII scrub");
  const vault = new TokenVault();
  const regex = scrubWithRegex(SAMPLE, vault);
  console.log("     hits:", JSON.stringify(regex.hits));
  for (const literal of ["A123456789", "12345678", "0912-345-678", "0928765432", "2024/03/15", "113/03/18", "2024-03-22"]) {
    check(`removed ${literal}`, !regex.text.includes(literal));
  }
  check("preserved dose 100mg", regex.text.includes("100mg"));
  check("preserved troponin 3.45", regex.text.includes("3.45"));
  check("preserved BP 152/94", regex.text.includes("152/94"));
  check("issued indexed tokens", /\[MRN_1\]/.test(regex.text) && /\[TAIWAN_ID_1\]/.test(regex.text));
  // This was `isValidTaiwanId(x) === false || true`, which is a tautology and
  // could never fail. Assert both directions instead: the checksum accepts a
  // well-formed ID and rejects one that only looks like it.
  check("checksum accepts a well-formed ID", isValidTaiwanId("A123456789"));
  check("checksum rejects a bad check digit", !isValidTaiwanId("A123456780"));

  console.log("\n[3] Local NER pass against a stub LM Studio");
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const entities = [
        { text: "陳建明", category: "PATIENT" },
        { text: "陳美玲", category: "RELATIVE" },
        { text: "林志豪", category: "DOCTOR" },
        { text: "Dr. Huang", category: "DOCTOR" },
        { text: "8B病房", category: "WARD" },
        { text: "台大醫院", category: "ORG" },
        { text: "王大明", category: "PATIENT" }, // hallucination: not in source
        { text: "Troponin I", category: "PATIENT" }, // wrong-category clinical term, still in source
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ entities }) } }] }));
    });
  });
  await new Promise<void>((r) => stub.listen(11234, r));
  process.env.LMSTUDIO_BASE_URL = "http://localhost:11234/v1";

  const llm = await scrubWithLlm(regex.text, vault);
  check("caught patient name", !llm.text.includes("陳建明"));
  check("caught relative name", !llm.text.includes("陳美玲"));
  check("caught attending", !llm.text.includes("林志豪"));
  check("caught english doctor", !llm.text.includes("Dr. Huang"));
  check("caught ward", !llm.text.includes("8B病房"));
  check("rejected hallucinated span", llm.hallucinated === 1, `got ${llm.hallucinated}`);
  check("refused mislabelled clinical term", llm.rejectedClinical === 1, `got ${llm.rejectedClinical}`);
  check("Troponin I survives into the note", llm.text.includes("Troponin I"));
  check("no degraded flag", llm.degraded === false);
  await new Promise<void>((r) => stub.close(() => r()));

  console.log("\n[4] Fail-closed when LM Studio is down");
  process.env.LMSTUDIO_BASE_URL = "http://localhost:59999/v1";
  process.env.ALLOW_DEGRADED_SCRUB = "false";
  let failedClosed = false;
  try {
    await scrubWithLlm("test", new TokenVault());
  } catch (e) {
    failedClosed = e instanceof LocalScrubUnavailableError;
  }
  check("throws LocalScrubUnavailableError", failedClosed);
  process.env.ALLOW_DEGRADED_SCRUB = "true";
  check("degrades only when opted in", (await scrubWithLlm("test", new TokenVault())).degraded);
  process.env.ALLOW_DEGRADED_SCRUB = "false";

  console.log("\n[5] Re-hydration");
  console.log("--- de-identified text sent to Gemini ---");
  console.log(llm.text.split("\n").map((l) => "     " + l).join("\n"));
  const geminiish = `**S:** ${llm.text}\n**A:** [PATIENT_1] admitted [DATE_1], MRN [MRN_1], under [DOCTOR_1].`;
  const back = vault.rehydrate(geminiish);
  check("restores patient", back.includes("陳建明"));
  check("restores MRN", back.includes("12345678"));
  check("restores attending", back.includes("林志豪"));
  check("no tokens survive", vault.unresolvedTokens(back).length === 0);

  console.log("\n[6] Token collision safety (MRN_1 vs MRN_11)");
  const v2 = new TokenVault();
  for (let i = 1; i <= 12; i++) v2.assign("MRN", `mrn-value-${i}`, "regex");
  const collide = v2.rehydrate("[MRN_11] and [MRN_1]");
  check("longest-first replacement", collide === "mrn-value-11 and mrn-value-1", collide);

  console.log("\n[6b] Applying findings cannot corrupt findings already applied");
  // `deidentify` used to walk the vault with split/join, which re-reads text it
  // has already written. A short identifier processed last therefore landed
  // INSIDE a placeholder an earlier, longer one had produced — and a mangled
  // placeholder never rehydrates, so the note came back with a broken token in
  // it. One pass over a longest-first alternation cannot see its own output.
  const v3 = new TokenVault();
  v3.assign("MRN", "12345678", "regex");
  v3.assign("OTHER_ID", "1", "llm");
  const applied = v3.deidentify("MRN 12345678, bed 1");
  check("long identifier tokenised", applied.includes("[MRN_1]"), applied);
  check("short identifier did not rewrite it", !applied.includes("[MRN_[") , applied);
  check("both round-trip", v3.rehydrate(applied) === "MRN 12345678, bed 1", v3.rehydrate(applied));

  console.log("\n[6c] Bring-your-own key: shape, mask, and quota identity");
  // The first version of the shape check demanded `AIza` + 35 characters and
  // rejected the very first real key it saw — Google also issues 53-character
  // keys beginning `AQ.A`. A validator that knows one vendor format refuses a
  // working credential the day the vendor adds another, so both formats are
  // pinned here alongside the paste errors it is actually for.
  const AIZA = `AIza${"b".repeat(35)}`;
  const AQ = `AQ.Ab8${"c".repeat(46)}`;
  check("accepts the classic AIza format", looksLikeGeminiKey(AIZA));
  check("accepts the newer AQ.A format", looksLikeGeminiKey(AQ), `${AQ.length} chars`);
  for (const [label, bad] of [
    ["empty", ""],
    ["whitespace only", "   "],
    ["too short", "AIzaShort"],
    ["a whole shell command", `export GEMINI_API_KEY=${AIZA}`],
    ["a trailing newline pasted in", `${AIZA}\nnext line`],
    ["a whole URL", `https://example.com/?key=${AIZA}`],
  ] as const) {
    check(`refuses ${label}`, !looksLikeGeminiKey(bad));
  }
  check("refuses something absurdly long", !looksLikeGeminiKey("a".repeat(300)));

  check("the mask hides the middle", !maskGeminiKey(AIZA).includes(AIZA.slice(12, 30)));
  check("the mask keeps a recognisable tail", maskGeminiKey(AIZA).endsWith(AIZA.slice(-4)));

  check("no key means the instance quota", (await quotaFingerprint(null)) === INSTANCE_QUOTA);
  const fp = await quotaFingerprint(AIZA);
  check("a key yields 16 hex characters", /^[0-9a-f]{16}$/.test(fp), fp);
  check("the same key always yields the same scope", (await quotaFingerprint(AIZA)) === fp);
  check("one character's difference yields a different scope",
    (await quotaFingerprint(`${AIZA.slice(0, -1)}c`)) !== fp);
  check("surrounding whitespace does not change the scope",
    (await quotaFingerprint(`  ${AIZA}  `)) === fp);
  check("the fingerprint reveals nothing of the key", !AIZA.includes(fp));

  console.log("\n[7] Compute lock");
  const a = acquireLock();
  check("first acquire succeeds", a !== null);
  check("second acquire is refused", acquireLock() === null);
  releaseLock(a);
  const b = acquireLock();
  check("acquire succeeds after release", b !== null);
  releaseLock(a); // stale handle must be a no-op
  check("stale handle cannot free the slot", acquireLock() === null);
  releaseLock(b);

  finish();
}

void main();
