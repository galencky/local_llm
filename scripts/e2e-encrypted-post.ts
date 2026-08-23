/**
 * End-to-end check against a running server: fetch the public key, seal a note
 * in "browser" mode, stream it through the pipeline, and print what came back.
 *
 *   npx tsx scripts/e2e-encrypted-post.ts [baseUrl]
 */
import { runPipeline } from "../src/lib/pipeline-client";

const base = process.argv[2] ?? "http://localhost:3000";

const NOTE = `病歷號 87654321，患者王小明，身分證 B234567890，
2024/05/02 因發燒入院，主治醫師陳大文，8A病房。CRP 12.4 mg/dL。`;

async function main() {
  const out = await runPipeline<{ note: string; deidentifiedInput: string; meta: Record<string, unknown> }>({
    baseUrl: base,
    text: NOTE,
    format: "SOAP",
    onProgress: (e) =>
      console.log(`  ${e.stage.padEnd(10)} ${e.status.padEnd(8)} ${e.ms ?? ""}${e.ms ? "ms" : ""} ${e.detail ?? ""}`),
  });
  console.log("\n--- de-identified prompt ---\n" + out.deidentifiedInput);
  console.log("\n--- re-hydrated note ---\n" + out.note);
  console.log("\nmeta:", JSON.stringify(out.meta, null, 2));
  process.exit(0);
}

void main();
