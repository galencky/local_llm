/**
 * Runs the same narrative twice — once bare, once through a saved specialty
 * routine — to confirm the routine reaches Gemini and shapes the output.
 *
 *   npx tsx scripts/e2e-routine.ts "<routine name>"
 *
 * Every route is behind sign-in, so the harness mints a real Auth.js session
 * row. Note that a routine is per-owner: a brand-new test user sees only
 * shared (ownerless) routines, so pass the name of one of those, or run this
 * against a routine you created as a shared one.
 */
import "dotenv/config";
import { runPipeline } from "../src/lib/pipeline-client";
import { createTestSession, destroyTestUser, type TestSession } from "./test-session";

const base = "http://localhost:3000";
let who: TestSession;
const wanted = process.argv[2] ?? "Nephrology ward round";

const NOTE = `病歷號 4471902，患者林淑惠，身分證 H284549486，女性 74 歲，8B病房 15-2床。
主治醫師吳承翰。ESRD on HD 每週三次，AV fistula 於左前臂，dry weight 52.5 kg。
2024/04/18 入院。今日 pre-HD BP 158/88 mmHg，post-HD 132/76 mmHg，UF 2.4 L。
Cr 8.9 mg/dL，eGFR 5，K 5.8 mmol/L，Hb 9.4 g/dL，iPTH 412 pg/mL。
予 calcium polystyrene sulfonate 5g PO TID。家屬林佳玲 0937-882-146。`;

async function run(promptId?: string) {
  return runPipeline<{ note: string; meta: Record<string, unknown> }>({
    baseUrl: base,
    text: NOTE,
    format: "PROGRESS_NOTE",
    promptId,
    headers: who.cookie,
  });
}

async function main() {
  who = await createTestSession("routine");
  // One `finally`, so a run that dies mid-pipeline leaves no harness user
  // behind either. The unhappy path used to clean up only where it was
  // remembered, which is exactly where it will eventually not be.
  try {
    const { templates } = (await (
      await fetch(`${base}/api/prompts`, { headers: who.cookie })
    ).json()) as {
      templates: { id: string; name: string }[];
    };
    const routine = templates.find((t) => t.name === wanted);
    if (!routine) {
      throw new Error(
        `No routine named "${wanted}" is visible to a fresh user. ` +
          `Visible: ${templates.map((t) => t.name).join(", ") || "(none)"}. ` +
          `Routines are per-owner, so a fresh harness user sees only shared ` +
          `(ownerless) ones — pass the name of a shared routine, or create one.`,
      );
    }

    console.log("=== WITHOUT routine ===");
    const plain = await run();
    console.log(plain.note);

    console.log(`\n=== WITH routine "${routine.name}" ===`);
    const styled = await run(routine.id);
    console.log(styled.note);

    console.log("\nroutine recorded in meta:", styled.meta.promptTemplateName);
    console.log("routine recorded in audit row:", styled.meta.auditLogId);
  } finally {
    // Cascades to the session and to any audit row this run wrote.
    await destroyTestUser(who.userId);
  }
  process.exit(0);
}

void main();
