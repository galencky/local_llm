import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import path from "node:path";
import {
  exportPkcs8Base64,
  exportSpkiBase64,
  generateRsaKeyPair,
  importRsaPrivateKey,
} from "./crypto";

/**
 * Server-side RSA-OAEP-2048 identity for the Mac Mini.
 *
 * The keypair is persisted to disk so it survives dev hot-reloads and restarts;
 * a rotating key would silently invalidate every public key already held by an
 * open browser tab. The file contains no PHI — only the server's own key.
 */

export interface ServerKeys {
  privateKey: CryptoKey;
  publicKeySpki: string;
  /** SHA-256 prefix of the SPKI. Lets the client detect a rotated key. */
  keyId: string;
}

interface StoredKeys {
  privateKeyPkcs8: string;
  publicKeySpki: string;
}

const globalForKeys = globalThis as unknown as {
  __serverKeys: Promise<ServerKeys> | undefined;
};

/**
 * Statically scoped to `<cwd>/.keys/` so Next's build tracer does not pull the
 * whole project into the server bundle. Only the filename is configurable.
 */
function keyStoreDir(): string {
  return path.join(process.cwd(), ".keys");
}

function keyStorePath(): string {
  const name = path.basename(process.env.KEY_STORE_FILE || "server-rsa.json");
  return path.join(keyStoreDir(), name);
}

function fingerprint(spkiB64: string): string {
  return createHash("sha256").update(spkiB64).digest("hex").slice(0, 16);
}

async function loadFromDisk(): Promise<StoredKeys | null> {
  try {
    const raw = await readFile(keyStorePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredKeys>;
    if (!parsed.privateKeyPkcs8 || !parsed.publicKeySpki) return null;
    return parsed as StoredKeys;
  } catch {
    return null;
  }
}

async function persist(keys: StoredKeys): Promise<void> {
  const file = keyStorePath();
  await mkdir(keyStoreDir(), { recursive: true });
  await writeFile(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
}

async function initialise(): Promise<ServerKeys> {
  // Node's WebCrypto is the same SubtleCrypto surface the browser helpers use.
  if (!globalThis.crypto) {
    (globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;
  }

  let stored = await loadFromDisk();
  if (!stored) {
    const pair = await generateRsaKeyPair();
    stored = {
      privateKeyPkcs8: await exportPkcs8Base64(pair.privateKey),
      publicKeySpki: await exportSpkiBase64(pair.publicKey),
    };
    await persist(stored);
  }

  return {
    privateKey: await importRsaPrivateKey(stored.privateKeyPkcs8),
    publicKeySpki: stored.publicKeySpki,
    keyId: fingerprint(stored.publicKeySpki),
  };
}

/** Idempotent, memoised across hot-reloads. */
export function getServerKeys(): Promise<ServerKeys> {
  return (globalForKeys.__serverKeys ??= initialise());
}
