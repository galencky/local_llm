/**
 * Acceptance test for custom mode.
 *
 * Both dependencies are stubbed, and both stubs record exactly what they were
 * asked, so the run can assert on the thing that matters: that the user's own
 * prompts and parameters reached the models, and that the properties custom
 * mode is NOT allowed to switch off held anyway.
 *
 * Requires the server started against the stubs, e.g.
 *   GEMINI_API_KEY=stub GEMINI_BASE_URL=http://localhost:8899 \
 *   LMSTUDIO_BASE_URL=http://localhost:1299/v1 npm run dev -- -p 3100
 *
 *   AIRLOCK_BASE=http://localhost:3100 LMSTUDIO_STUB_PORT=1299 \
 *   npx tsx scripts/e2e-custom-mode.ts
 *
 * The stub ports are configurable because a developer box usually has the real
 * LM Studio sitting on :1234 already.
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runPipeline } from "../src/lib/pipeline-client";
import {
  blankCustomConfig,
  PLACEHOLDER_KERNEL,
  type CustomConfig,
} from "../src/lib/custom-mode";
import { createTestSession, destroyTestUser } from "./test-session";

const base = process.env.AIRLOCK_BASE ?? "http://localhost:3000";
const lmStudioPort = Number(process.env.LMSTUDIO_STUB_PORT ?? 1234);
const geminiPort = Number(process.env.GEMINI_STUB_PORT ?? 8899);

const NOTE = `病歷號 87654321，患者王小明，身分證 B234567890，聯絡電話 0912-345-678。
2024/05/02 因發燒入院，收治 8A病房，主治醫師陳大文。CRP 12.4 mg/dL，BT 38.9°C。
113/05/05 症狀改善出院，aspirin 100mg PO QD。家屬王美華 02-27123456。`;

/** Distinctive enough that finding it in the stub's request proves the path. */
const MARKER_LOCAL = "MARKER-LOCAL-PROMPT-REACHED-LM-STUDIO";
const MARKER_SYSTEM = "MARKER-CLOUD-SYSTEM-REACHED-GEMINI";
const MARKER_SKELETON = "MARKER-CLOUD-SKELETON-REPLACED-THE-BUILT-IN";

function collect(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

let lmStudioRequest = "";
const lmStudio = createServer(async (req, res) => {
  if (req.url?.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "stub-ner" }] }));
    return;
  }
  lmStudioRequest = await collect(req);
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
                // Never in the source: must be counted and discarded, not
                // redacted, however the custom prompt was written.
                { text: "李承恩", category: "PATIENT" },
                // A lab analyte mislabelled as a person. It IS in the source,
                // so it clears the verbatim check and reaches the clinical
                // stoplist — which must still refuse it in custom mode.
                { text: "CRP", category: "DOCTOR" },
              ],
            }),
          },
        },
      ],
    }),
  );
});

let geminiRequest = "";
const geminiStub = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  geminiRequest = await collect(req);
  const parsed = JSON.parse(geminiRequest) as {
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
            parts: [
              {
                text: `**Custom section**\n${narrative.trim()}\n\n**Assessment**\nFebrile illness in [PATIENT_1], MRN [MRN_1], under [DOCTOR_1] on [WARD_1].`,
              },
            ],
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

function customConfig(): CustomConfig {
  const c = blankCustomConfig();
  c.local.systemPrompt = `${MARKER_LOCAL}\n${c.local.systemPrompt}`;
  c.local.temperature = 0.35;
  c.local.topP = 0.8;
  c.local.maxTokens = 2048;
  c.cloud.systemInstruction = `${MARKER_SYSTEM}\n${c.cloud.systemInstruction}`;
  c.cloud.instruction = `${MARKER_SKELETON}\nProduce a note with the single heading **Custom section**.`;
  c.cloud.temperature = 0.7;
  c.cloud.topP = 0.5;
  c.cloud.topK = 40;
  c.cloud.maxOutputTokens = 4096;
  return c;
}

interface Result {
  note: string;
  deidentifiedInput: string;
  redactions: { preview: string }[];
  meta: {
    mode: string;
    unresolvedTokens: string[];
    auditLogId: string | null;
    degradedScrub: boolean;
    hallucinatedSpans: number;
    rejectedClinicalSpans: number;
    llmEntityCount: number;
  };
}

async function main() {
  const who = await createTestSession("custom-mode");
  await new Promise<void>((r) => lmStudio.listen(lmStudioPort, r));
  await new Promise<void>((r) => geminiStub.listen(geminiPort, r));
  console.log(`stubs up: LM Studio :${lmStudioPort}, Gemini :${geminiPort}\n`);

  try {
    const custom = customConfig();
    const out = await runPipeline<Result>({
      baseUrl: base,
      text: NOTE,
      format: "SOAP",
      custom,
      headers: who.cookie,
    });

    const lm = JSON.parse(lmStudioRequest) as {
      messages: { role: string; content: string }[];
      temperature: number;
      top_p?: number;
      max_tokens: number;
    };
    const gem = JSON.parse(geminiRequest) as {
      contents?: { parts?: { text?: string }[] }[];
      systemInstruction?: { parts?: { text?: string }[] } | string;
      generationConfig?: Record<string, number>;
    };
    const gemSystem =
      typeof gem.systemInstruction === "string"
        ? gem.systemInstruction
        : (gem.systemInstruction?.parts?.[0]?.text ?? "");
    const gemUser = gem.contents?.[0]?.parts?.[0]?.text ?? "";
    const cfg = gem.generationConfig ?? {};

    console.log("--- custom prompts reached the models ---");
    check("local system prompt is the user's", lm.messages[0].content.startsWith(MARKER_LOCAL));
    check("local temperature honoured", lm.temperature === 0.35, String(lm.temperature));
    check("local top_p honoured", lm.top_p === 0.8, String(lm.top_p));
    check("local max_tokens honoured", lm.max_tokens === 2048, String(lm.max_tokens));
    check("cloud system instruction is the user's", gemSystem.startsWith(MARKER_SYSTEM));
    check("cloud skeleton replaced", gemUser.startsWith(MARKER_SKELETON));
    check(
      "built-in SOAP skeleton is gone",
      !gemUser.includes("Produce a SOAP note with these headings exactly"),
    );
    check("cloud temperature honoured", cfg.temperature === 0.7, String(cfg.temperature));
    check("cloud topP honoured", cfg.topP === 0.5, String(cfg.topP));
    check("cloud topK honoured", cfg.topK === 40, String(cfg.topK));
    check("cloud maxOutputTokens honoured", cfg.maxOutputTokens === 4096, String(cfg.maxOutputTokens));

    console.log("\n--- what custom mode may not switch off ---");
    check("placeholder kernel appended", gemSystem.includes(PLACEHOLDER_KERNEL));
    for (const pii of [
      "王小明", "王美華", "陳大文", "8A病房",
      "87654321", "B234567890", "0912-345-678", "02-27123456",
      "2024/05/02", "113/05/05",
    ]) {
      check(`cloud never saw ${pii}`, !geminiRequest.includes(pii));
    }
    check("regex scrub still ran", out.deidentifiedInput.includes("[MRN_1]"));
    check("hallucinated span discarded", out.meta.hallucinatedSpans === 1, String(out.meta.hallucinatedSpans));
    check("clinical span refused", out.meta.rejectedClinicalSpans === 1, String(out.meta.rejectedClinicalSpans));
    check("only the four real entities kept", out.meta.llmEntityCount === 4, String(out.meta.llmEntityCount));
    check("scrub was not degraded", out.meta.degradedScrub === false);
    check("clinical data preserved", out.deidentifiedInput.includes("12.4") && out.deidentifiedInput.includes("100mg"));

    console.log("\n--- the note comes back whole ---");
    check("patient name restored", out.note.includes("王小明"));
    check("MRN restored", out.note.includes("87654321"));
    check("attending restored", out.note.includes("陳大文"));
    check("ROC date restored", out.note.includes("113/05/05"));
    check("no placeholders left", out.meta.unresolvedTokens.length === 0, JSON.stringify(out.meta.unresolvedTokens));
    check("meta reports custom mode", out.meta.mode === "custom", out.meta.mode);
    check("audit row written", Boolean(out.meta.auditLogId));

    console.log("\n--- a broken config is refused, not silently defaulted ---");
    const empty = blankCustomConfig();
    empty.local.systemPrompt = "   ";
    await runPipeline<Result>({
      baseUrl: base, text: NOTE, format: "SOAP", custom: empty, headers: who.cookie,
    }).then(
      () => check("empty local prompt refused", false, "the run was accepted"),
      (e: Error) => check("empty local prompt refused", /de-identification prompt/i.test(e.message), e.message),
    );

    const huge = blankCustomConfig();
    huge.cloud.instruction = "x".repeat(9000);
    await runPipeline<Result>({
      baseUrl: base, text: NOTE, format: "SOAP", custom: huge, headers: who.cookie,
    }).then(
      () => check("over-long instruction refused", false, "the run was accepted"),
      (e: Error) => check("over-long instruction refused", /cap is/i.test(e.message), e.message),
    );

    console.log("\n--- guided mode is untouched ---");
    const guided = await runPipeline<Result>({
      baseUrl: base, text: NOTE, format: "SOAP", headers: who.cookie,
    });
    const guidedUser = (JSON.parse(geminiRequest) as { contents?: { parts?: { text?: string }[] }[] })
      .contents?.[0]?.parts?.[0]?.text ?? "";
    check("built-in skeleton back in force", guidedUser.includes("Produce a SOAP note with these headings exactly"));
    check("meta reports guided mode", guided.meta.mode === "guided", guided.meta.mode);
  } finally {
    await destroyTestUser(who.userId);
    await new Promise<void>((r) => lmStudio.close(() => r()));
    await new Promise<void>((r) => geminiStub.close(() => r()));
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
