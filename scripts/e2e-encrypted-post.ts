/**
 * End-to-end check against a running server: fetch the public key, seal a note
 * in "browser" mode, POST it, and report what came back.
 *
 *   npx tsx scripts/e2e-encrypted-post.ts [baseUrl]
 */
import { sealRequest, openResponse, type CryptoEnvelope } from "../src/lib/crypto";

const base = process.argv[2] ?? "http://localhost:3000";

const NOTE = `病歷號 87654321，患者王小明，身分證 B234567890，
2024/05/02 因發燒入院，主治醫師陳大文，8A病房。CRP 12.4 mg/dL。`;

async function main() {
  const keyRes = await fetch(`${base}/api/keys`);
  const { publicKey, keyId } = (await keyRes.json()) as {
    publicKey: string;
    keyId: string;
  };
  console.log(`public key ${keyId} (${publicKey.length} b64 chars)`);

  const { envelope, aesKey } = await sealRequest(
    publicKey,
    JSON.stringify({ text: NOTE, format: "SOAP" }),
  );
  console.log(`sealed ${NOTE.length} chars -> ${envelope.encryptedData.length} b64 ciphertext`);

  const res = await fetch(`${base}/api/process-note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  console.log(`POST /api/process-note -> ${res.status}`);

  const body = await res.json();
  if (!res.ok) {
    console.log("error:", JSON.stringify(body, null, 2));
    return;
  }
  const decoded = JSON.parse(await openResponse(aesKey, body as CryptoEnvelope));
  console.log("\n--- de-identified prompt ---\n" + decoded.deidentifiedInput);
  console.log("\n--- re-hydrated note ---\n" + decoded.note);
  console.log("\nmeta:", JSON.stringify(decoded.meta, null, 2));
}

void main();
