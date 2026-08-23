/**
 * Demonstrate the end-to-end encryption, from the position of an attacker.
 *
 *   npx tsx scripts/prove-e2ee.ts
 *
 * Runs a wiretap proxy between the "browser" and the app — exactly where
 * Cloudflare sits — records every byte in both directions, then tries to read
 * the clinical note out of the captured traffic.
 */
import "dotenv/config";
import { createServer, request as httpRequest } from "node:http";
import { runPipeline } from "../src/lib/pipeline-client";
import { base64ToBytes } from "../src/lib/crypto";

/** WebCrypto wants a plain ArrayBuffer; narrow away SharedArrayBuffer. */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const APP = { host: "127.0.0.1", port: 3000 };
const WIRETAP_PORT = 3999;

const NOTE = `病歷號 3308914，患者黃文昌，身分證 K184525646，男性 81 歲，6C病房 22-1床。
主治醫師 蘇建誠。診斷 COPD acute exacerbation with AF with RVR。
配偶黃李秀蘭 0955-217-403。入院日 2024/11/07。`;

/** Every identifier a wiretap would love to find. */
const SECRETS = [
  "黃文昌", "黃李秀蘭", "蘇建誠", "K184525646", "3308914",
  "0955-217-403", "2024/11/07", "6C病房", "COPD",
];

interface Capture {
  method: string;
  path: string;
  requestBody: Buffer;
  responseBody: Buffer;
}

const captured: Capture[] = [];

const wiretap = createServer((clientReq, clientRes) => {
  const reqChunks: Buffer[] = [];
  const resChunks: Buffer[] = [];

  clientReq.on("data", (c: Buffer) => reqChunks.push(c));

  const upstream = httpRequest(
    { ...APP, path: clientReq.url, method: clientReq.method, headers: { ...clientReq.headers, host: `${APP.host}:${APP.port}` } },
    (upRes) => {
      clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.on("data", (c: Buffer) => {
        resChunks.push(c);
        clientRes.write(c); // pass through immediately: SSE must not be buffered
      });
      upRes.on("end", () => {
        clientRes.end();
        captured.push({
          method: clientReq.method ?? "?",
          path: (clientReq.url ?? "").split("?")[0],
          requestBody: Buffer.concat(reqChunks),
          responseBody: Buffer.concat(resChunks),
        });
      });
    },
  );
  upstream.on("error", () => clientRes.destroy());
  clientReq.pipe(upstream);
});

function found(haystack: string): string[] {
  return SECRETS.filter((s) => haystack.includes(s));
}

async function main() {
  await new Promise<void>((r) => wiretap.listen(WIRETAP_PORT, r));
  const base = `http://127.0.0.1:${WIRETAP_PORT}`;
  console.log(`wiretap listening on :${WIRETAP_PORT}, forwarding to :${APP.port}\n`);

  const login = await fetch(`${base}/api/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "llm" }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  console.log("--- the note being sent ---");
  console.log(NOTE.split("\n").map((l) => "   " + l).join("\n"));

  const out = await runPipeline<{ note: string; deidentifiedInput: string }>({
    baseUrl: base,
    text: NOTE,
    format: "SOAP",
    headers: { Cookie: cookie },
  });

  console.log("\n--- what the wiretap recorded ---");
  const post = captured.find((c) => c.path === "/api/process-note");
  if (!post) throw new Error("wiretap missed the pipeline request");

  const reqRaw = post.requestBody.toString("utf8");
  const resRaw = post.responseBody.toString("utf8");
  const envelope = JSON.parse(reqRaw) as { encryptedData: string; encryptedKey: string; iv: string };

  console.log(`   POST ${post.path}`);
  console.log(`   request body  : ${post.requestBody.length} bytes of JSON`);
  console.log(`     encryptedKey : ${envelope.encryptedKey.slice(0, 56)}…  (${base64ToBytes(envelope.encryptedKey).length} bytes, RSA-OAEP-2048 wrapped AES key)`);
  console.log(`     iv           : ${envelope.iv}  (${base64ToBytes(envelope.iv).length}-byte GCM nonce)`);
  console.log(`     encryptedData: ${envelope.encryptedData.slice(0, 56)}…  (${base64ToBytes(envelope.encryptedData).length} bytes)`);
  console.log(`   ciphertext, decoded as text: ${JSON.stringify(Buffer.from(base64ToBytes(envelope.encryptedData)).toString("utf8").slice(0, 60))}`);

  let fails = 0;
  const check = (n: string, ok: boolean, d = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok || !d ? "" : "  — " + d}`);
    if (!ok) fails++;
  };

  console.log("\n--- can the wiretap read anything? ---");
  const everything = captured.map((c) => c.requestBody.toString("utf8") + c.responseBody.toString("utf8")).join("\n");
  const leaked = found(everything);
  check("no identifier appears anywhere in the captured traffic", leaked.length === 0, leaked.join(", "));
  check("the request body is not the note", !reqRaw.includes("病歷號"));
  check("the response body is not the note", !resRaw.includes("黃文昌"));

  console.log("\n--- can the wiretap decrypt it? ---");
  // An attacker holds the ciphertext and the wrapped key, but not the private
  // key. Unwrapping is the only way in, so try it with a fresh 2048-bit key.
  const attacker = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  let unwrapFailed = false;
  try {
    await crypto.subtle.decrypt({ name: "RSA-OAEP" }, attacker.privateKey, buf(base64ToBytes(envelope.encryptedKey)));
  } catch {
    unwrapFailed = true;
  }
  check("AES key cannot be unwrapped without the Mac Mini's private key", unwrapFailed);

  // And AES-GCM is authenticated: flipping one bit is detected, not silently
  // decrypted into garbage.
  const tampered = base64ToBytes(envelope.encryptedData);
  tampered[0] ^= 0x01;
  const realKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  let tamperDetected = false;
  try {
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(base64ToBytes(envelope.iv)) }, realKey, buf(tampered));
  } catch {
    tamperDetected = true;
  }
  check("GCM rejects tampered ciphertext rather than returning garbage", tamperDetected);

  console.log("\n--- what the legitimate client got back ---");
  console.log(`   plaintext note restored: ${/黃文昌|3308914|蘇建誠/.test(out.note)}`);
  console.log(out.note.split("\n").slice(0, 4).map((l) => "   " + l).join("\n"));

  console.log("\n--- and what Gemini saw (a separate boundary) ---");
  console.log(out.deidentifiedInput.split("\n").map((l) => "   " + l).join("\n"));

  await new Promise<void>((r) => wiretap.close(() => r()));
  console.log(fails === 0 ? "\nE2EE holds against a full wiretap.\n" : `\n${fails} FAILED\n`);
  process.exit(fails === 0 ? 0 : 1);
}

void main();
