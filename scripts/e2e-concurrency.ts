/**
 * Verifies the single-slot limit against a running server, using a stub LM
 * Studio on port 1234 that deliberately takes 2s so requests overlap.
 *
 *   npx tsx scripts/e2e-concurrency.ts
 *
 * Every route is behind sign-in, so the harness mints a real Auth.js session
 * row and presents the cookie exactly as a browser would.
 */
import "dotenv/config";
import { createServer } from "node:http";
import { ComputeBusyError, runPipeline } from "../src/lib/pipeline-client";
import { createTestSession, destroyTestUser, type TestSession } from "./test-session";

const base = "http://localhost:3000";
let who: TestSession;

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "stub-ner-7b" }] }));
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  entities: [
                    { text: "王小明", category: "PATIENT" },
                    { text: "陳大文", category: "DOCTOR" },
                    { text: "8A病房", category: "WARD" },
                  ],
                }),
              },
            },
          ],
        }),
      );
    }, 2000);
  });
});

const NOTE = `病歷號 87654321，患者王小明，身分證 B234567890，
2024/05/02 因發燒入院，主治醫師陳大文，8A病房。CRP 12.4 mg/dL。`;

async function fire(n: number) {
  try {
    await runPipeline({ baseUrl: base, text: NOTE, format: "SOAP", headers: who.cookie });
    return { n, status: 200, code: "OK", error: undefined as string | undefined };
  } catch (e) {
    if (e instanceof ComputeBusyError) {
      return { n, status: 429, code: "COMPUTE_BUSY", error: e.message };
    }
    return { n, status: 500, code: "ERROR", error: (e as Error).message };
  }
}

async function main() {
  who = await createTestSession("concurrency");
  await new Promise<void>((r) => stub.listen(1234, r));
  console.log("stub LM Studio listening on :1234 (2s latency)\n");

  const results = await Promise.all([fire(1), fire(2), fire(3)]);
  for (const r of results) {
    console.log(`req ${r.n}: ${r.status} ${r.code ?? ""} ${r.error ? "— " + r.error.slice(0, 90) : ""}`);
  }

  const busy = results.filter((r) => r.status === 429).length;
  const admitted = results.filter((r) => r.status !== 429).length;
  console.log(`\nadmitted=${admitted} rejected429=${busy}`);
  console.log(admitted === 1 && busy === 2 ? "PASS: single-slot limit enforced" : "FAIL");

  // Lock must be free again once the in-flight request finished.
  const after = (await (
    await fetch(`${base}/api/status`, { headers: who.cookie })
  ).json()) as { busy: boolean };
  console.log(after.busy === false ? "PASS: lock released" : "FAIL: lock still held");

  await destroyTestUser(who.userId);
  await new Promise<void>((r) => stub.close(() => r()));
  process.exit(0);
}

void main();
