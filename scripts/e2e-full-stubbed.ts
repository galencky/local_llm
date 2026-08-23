/**
 * Exercises the complete pipeline against a running server with both external
 * dependencies stubbed: LM Studio on :1234 and the Gemini endpoint on :8899.
 * Proves decrypt -> scrub -> cloud call -> re-hydrate -> audit write -> encrypt.
 *
 * Requires the server to be started with:
 *   GEMINI_API_KEY=stub GEMINI_BASE_URL=http://localhost:8899 npm run dev
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { sealRequest, openResponse, type CryptoEnvelope } from "../src/lib/crypto";

const base = "http://localhost:3000";

const NOTE = `病歷號 87654321，患者王小明，身分證 B234567890，聯絡電話 0912-345-678。
2024/05/02 因發燒入院，收治 8A病房，主治醫師陳大文。CRP 12.4 mg/dL，BT 38.9°C。
113/05/05 症狀改善出院，aspirin 100mg PO QD。家屬王美華 02-27123456。`;

function collect(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const lmStudio = createServer(async (req, res) => {
  if (req.url?.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "stub-ner" }] }));
    return;
  }
  await collect(req);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              entities: [
                { text: "王小明", category: "PATIENT" },
                { text: "王美華", category: "RELATIVE" },
                { text: "陳大文", category: "DOCTOR" },
                { text: "8A病房", category: "WARD" },
              ],
            }),
          },
        },
      ],
    }),
  );
});

/** Echoes the de-identified prompt back inside a SOAP skeleton. */
let promptSeenByCloud = "";
const geminiStub = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const body = await collect(req);
  promptSeenByCloud = body;
  const parsed = JSON.parse(body) as {
    contents?: { parts?: { text?: string }[] }[];
  };
  const userText = parsed.contents?.[0]?.parts?.[0]?.text ?? "";
  const narrative = userText.split("--- DE-IDENTIFIED CLINICAL NARRATIVE ---")[1] ?? userText;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: `**S (Subjective)**\n${narrative.trim()}\n\n**A (Assessment)**\nFebrile illness in [PATIENT_1], MRN [MRN_1], under [DOCTOR_1] on [WARD_1].` }],
          },
          finishReason: "STOP",
        },
      ],
    }),
  );
});

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
  if (!ok) failures++;
}

async function main() {
  await new Promise<void>((r) => lmStudio.listen(1234, r));
  await new Promise<void>((r) => geminiStub.listen(8899, r));
  console.log("stubs up: LM Studio :1234, Gemini :8899\n");

  const { publicKey } = (await (await fetch(`${base}/api/keys`)).json()) as { publicKey: string };
  const { envelope, aesKey } = await sealRequest(publicKey, JSON.stringify({ text: NOTE, format: "SOAP" }));

  const res = await fetch(`${base}/api/process-note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    console.log("request failed:", res.status, JSON.stringify(await res.json()));
    process.exit(1);
  }

  const decoded = JSON.parse(await openResponse(aesKey, (await res.json()) as CryptoEnvelope));

  console.log("--- what the cloud actually received ---");
  console.log(decoded.deidentifiedInput.split("\n").map((l: string) => "   " + l).join("\n"));
  console.log("\n--- re-hydrated note returned to the browser ---");
  console.log(decoded.note.split("\n").map((l: string) => "   " + l).join("\n"));
  console.log();

  for (const pii of ["王小明", "王美華", "陳大文", "8A病房", "87654321", "B234567890", "0912-345-678", "02-27123456", "2024/05/02", "113/05/05"]) {
    check(`cloud never saw ${pii}`, !promptSeenByCloud.includes(pii));
  }
  check("clinical data preserved for the cloud", decoded.deidentifiedInput.includes("12.4") && decoded.deidentifiedInput.includes("100mg"));
  check("CRP not mistaken for a person", decoded.deidentifiedInput.includes("CRP"));
  check("patient name restored", decoded.note.includes("王小明"));
  check("MRN restored", decoded.note.includes("87654321"));
  check("attending restored", decoded.note.includes("陳大文"));
  check("ROC date restored", decoded.note.includes("113/05/05"));
  check("no placeholders left in the note", decoded.meta.unresolvedTokens.length === 0, JSON.stringify(decoded.meta.unresolvedTokens));
  check("audit row written", Boolean(decoded.meta.auditLogId), "audit write failed");
  check("scrub was not degraded", decoded.meta.degradedScrub === false);
  check("inspector has redactions", decoded.redactions.length >= 8, `${decoded.redactions.length}`);
  check("inspector previews are masked", decoded.redactions.every((r: { preview: string }) => r.preview.includes("*")));

  await new Promise<void>((r) => lmStudio.close(() => r()));
  await new Promise<void>((r) => geminiStub.close(() => r()));
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
