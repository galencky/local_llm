/**
 * Verifies the single-slot limit against a running server, using a stub LM
 * Studio on port 1234 that deliberately takes 2s so requests overlap.
 *
 *   npx tsx scripts/e2e-concurrency.ts
 */
import { createServer } from "node:http";
import { sealRequest } from "../src/lib/crypto";

const base = "http://localhost:3000";

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
  const { publicKey } = (await (await fetch(`${base}/api/keys`)).json()) as {
    publicKey: string;
  };
  const { envelope } = await sealRequest(
    publicKey,
    JSON.stringify({ text: NOTE, format: "SOAP" }),
  );
  const res = await fetch(`${base}/api/process-note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const body = (await res.json()) as { error?: string; code?: string };
  return { n, status: res.status, error: body.error, code: body.code };
}

async function main() {
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
  const after = (await (await fetch(`${base}/api/status`)).json()) as { busy: boolean };
  console.log(after.busy === false ? "PASS: lock released" : "FAIL: lock still held");

  await new Promise<void>((r) => stub.close(() => r()));
  process.exit(0);
}

void main();
