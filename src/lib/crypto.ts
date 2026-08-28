/**
 * Isomorphic WebCrypto helpers (Node 18+ and browser).
 *
 * Threat model: Cloudflare terminates TLS at its edge, so anything travelling
 * the tunnel in the clear is readable by a third party — unacceptable for PHI
 * under Taiwan's PDPA. Every clinical payload is therefore sealed in the
 * browser with an ephemeral AES-256-GCM key, and that key is wrapped with the
 * Mac Mini's RSA-OAEP-2048 public key. Cloudflare only ever relays ciphertext.
 *
 * The same ephemeral AES key seals the response, so the re-hydrated note (which
 * DOES contain real PHI) is also opaque in transit.
 *
 * NOTE: this file must stay free of Node-only imports — it is bundled into the
 * browser. Server-side keypair persistence lives in `keystore.ts`.
 */

export const RSA_ALGORITHM = {
  name: "RSA-OAEP",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

export const AES_KEY_BITS = 256;
export const AES_IV_BYTES = 12;

/** Sealed request/response envelope exchanged over the tunnel. */
export interface CryptoEnvelope {
  /** base64 AES-GCM ciphertext (includes the GCM auth tag). */
  encryptedData: string;
  /** base64 RSA-OAEP-wrapped AES key. Absent on server->client responses. */
  encryptedKey?: string;
  /** base64 96-bit GCM nonce. */
  iv: string;
}

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      "WebCrypto unavailable. A secure context (https:// or localhost) is required.",
    );
  }
  return c.subtle;
};

/* ------------------------------------------------------------------ */
/* base64 <-> bytes                                                    */
/* ------------------------------------------------------------------ */

export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 0x8000; // avoid blowing the argument limit on large notes
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** SHA-256 of a UTF-8 string, as lower-case hex. Same answer on both ends. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", buf(encoder.encode(input)));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** WebCrypto wants a plain ArrayBuffer; narrow away SharedArrayBuffer. */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/* ------------------------------------------------------------------ */
/* RSA-OAEP                                                            */
/* ------------------------------------------------------------------ */

export async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey(RSA_ALGORITHM, true, ["encrypt", "decrypt"]);
}

export async function exportSpkiBase64(key: CryptoKey): Promise<string> {
  return bytesToBase64(await subtle().exportKey("spki", key));
}

export async function exportPkcs8Base64(key: CryptoKey): Promise<string> {
  return bytesToBase64(await subtle().exportKey("pkcs8", key));
}

export async function importRsaPublicKey(spkiB64: string): Promise<CryptoKey> {
  return subtle().importKey(
    "spki",
    buf(base64ToBytes(spkiB64)),
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"],
  );
}

export async function importRsaPrivateKey(
  pkcs8B64: string,
): Promise<CryptoKey> {
  return subtle().importKey(
    "pkcs8",
    buf(base64ToBytes(pkcs8B64)),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
}

/* ------------------------------------------------------------------ */
/* AES-GCM                                                             */
/* ------------------------------------------------------------------ */

export async function generateAesKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: AES_KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function importAesKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey(
    "raw",
    buf(raw),
    { name: "AES-GCM", length: AES_KEY_BITS },
    true,
    ["encrypt", "decrypt"],
  );
}

async function aesEncrypt(
  key: CryptoKey,
  plaintext: string,
): Promise<{ encryptedData: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_BYTES));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: buf(iv) },
    key,
    buf(encoder.encode(plaintext)),
  );
  return { encryptedData: bytesToBase64(ct), iv: bytesToBase64(iv) };
}

async function aesDecrypt(
  key: CryptoKey,
  encryptedData: string,
  ivB64: string,
): Promise<string> {
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: buf(base64ToBytes(ivB64)) },
    key,
    buf(base64ToBytes(encryptedData)),
  );
  return decoder.decode(plain);
}

/* ------------------------------------------------------------------ */
/* Browser side: seal a request / open a response                      */
/* ------------------------------------------------------------------ */

export interface SealedRequest {
  envelope: CryptoEnvelope;
  /** Kept in browser memory only, to open the reply. Never transmitted. */
  aesKey: CryptoKey;
}

/**
 * Encrypt a clinical note in the browser. Produces a fresh AES key per call —
 * a single compromised note can never unlock another.
 */
export async function sealRequest(
  publicKeySpkiB64: string,
  plaintext: string,
): Promise<SealedRequest> {
  const publicKey = await importRsaPublicKey(publicKeySpkiB64);
  const aesKey = await generateAesKey();
  const rawAes = await subtle().exportKey("raw", aesKey);
  const wrapped = await subtle().encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawAes,
  );
  const { encryptedData, iv } = await aesEncrypt(aesKey, plaintext);
  return {
    envelope: { encryptedData, encryptedKey: bytesToBase64(wrapped), iv },
    aesKey,
  };
}

/** Decrypt the server's reply with the AES key retained from `sealRequest`. */
export async function openResponse(
  aesKey: CryptoKey,
  envelope: CryptoEnvelope,
): Promise<string> {
  return aesDecrypt(aesKey, envelope.encryptedData, envelope.iv);
}

/* ------------------------------------------------------------------ */
/* Server side: open a request / seal a response                       */
/* ------------------------------------------------------------------ */

export interface OpenedRequest {
  plaintext: string;
  /** Ephemeral key, reused to seal the reply. Discarded when the request ends. */
  aesKey: CryptoKey;
}

export async function openRequest(
  privateKey: CryptoKey,
  envelope: CryptoEnvelope,
): Promise<OpenedRequest> {
  if (!envelope.encryptedKey) {
    throw new Error("Envelope is missing the wrapped AES key.");
  }
  const rawAes = await subtle().decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    buf(base64ToBytes(envelope.encryptedKey)),
  );
  const aesKey = await importAesKeyRaw(new Uint8Array(rawAes));
  const plaintext = await aesDecrypt(
    aesKey,
    envelope.encryptedData,
    envelope.iv,
  );
  return { plaintext, aesKey };
}

/** Seal the re-hydrated note (real PHI) for the trip back through Cloudflare. */
export async function sealResponse(
  aesKey: CryptoKey,
  plaintext: string,
): Promise<CryptoEnvelope> {
  return aesEncrypt(aesKey, plaintext);
}
