/**
 * End-to-end check against a running server: fetch the public key, seal a note
 * in "browser" mode, stream it through the pipeline, and print what came back.
 *
 *   npx tsx scripts/e2e-encrypted-post.ts [baseUrl]
 *
 * Every route is behind sign-in, so the harness mints a real Auth.js session
 * row and presents the cookie exactly as a browser would — the same mechanism
 * the full acceptance suite uses. Without it the run dies on the first fetch
 * with "Key endpoint returned 401".
 */
import "dotenv/config";
import { runPipeline } from "../src/lib/pipeline-client";
import { createTestSession, destroyTestUser } from "./test-session";

const base = process.argv[2] ?? "http://localhost:3000";

const NOTE = `病歷號 87654321，患者王小明，身分證 B234567890，
2024/05/02 因發燒入院，主治醫師陳大文，8A病房。CRP 12.4 mg/dL。`;

async function main() {
  const who = await createTestSession("encrypted-post");
  try {
    const out = await runPipeline<{ note: string; deidentifiedInput: string; meta: Record<string, unknown> }>({
      baseUrl: base,
      text: NOTE,
      format: "SOAP",
      headers: who.cookie,
      onProgress: (e) =>
        console.log(`  ${e.stage.padEnd(10)} ${e.status.padEnd(8)} ${e.ms ?? ""}${e.ms ? "ms" : ""} ${e.detail ?? ""}`),
    });
    console.log("\n--- de-identified prompt ---\n" + out.deidentifiedInput);
    console.log("\n--- re-hydrated note ---\n" + out.note);
    console.log("\nmeta:", JSON.stringify(out.meta, null, 2));
  } finally {
    // Cascades to the session and the audit row this run wrote.
    await destroyTestUser(who.userId);
  }
  process.exit(0);
}

void main();
