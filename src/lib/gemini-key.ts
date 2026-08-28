import { sha256Hex } from "./crypto";

/**
 * Bring-your-own Gemini key: shape, masking, and quota identity.
 *
 * ======================== WHERE THE KEY LIVES ========================
 * In the clinician's browser, and nowhere else.
 *
 * It is held in that browser's `localStorage`, travels to the Mac Mini INSIDE
 * the same AES-GCM envelope as the note, is used for the life of one request,
 * and is dropped when the handler returns. It is never written to Postgres,
 * never written to disk, never logged, and never held between requests — the
 * same discipline the TokenVault is under, for the same reason.
 *
 * The alternative was a per-user encrypted column in Postgres. That would put
 * a decryptable third-party credential on the disk of a machine reachable from
 * the internet, and require a key-encryption key to protect it — a standing
 * secret to protect a standing secret. Sending it sealed per request costs a
 * few hundred bytes and means a stolen database contains nobody's API key.
 *
 * The honest trade: `localStorage` is readable by any script running on this
 * origin. Airlock loads no third-party scripts and ships no production source
 * maps, but if an attacker can execute script in the page they can read the
 * key — and at that point they can also read the note. The key is no softer a
 * target than the clinical text already on screen.
 * ====================================================================
 *
 * This module is isomorphic: the editor masks with the same function the route
 * fingerprints with, so the two can never disagree about which key is which.
 */

/**
 * Deliberately loose, and that is the lesson rather than the compromise.
 *
 * The first version of this required `AIza` plus 35 URL-safe characters, which
 * is the AI Studio format every tutorial shows. It rejected the very first real
 * key it was pointed at: Google also issues 53-character keys beginning `AQ.A`,
 * and a validator that knows one vendor format is a validator that will refuse
 * a working credential the day the vendor adds another. Nobody debugging that
 * would suspect the client.
 *
 * So this checks only what is genuinely diagnostic of a PASTE ERROR — empty,
 * whitespace inside it, absurdly short or long, characters no key of any format
 * contains — and leaves "is this a real key" to the only party that can answer
 * it. That answer is one sealed round trip away, and the editor asks for it
 * before saving.
 */
const KEY_SHAPE = /^[A-Za-z0-9._-]{20,200}$/;

export const GEMINI_KEY_HINT =
  "Paste exactly what AI Studio gave you — no spaces, no quotes, no `export`. " +
  "Google issues more than one key format, so the length varies.";

export class GeminiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiKeyError";
  }
}

/** Trim and validate. @throws {GeminiKeyError} with something actionable. */
export function normaliseGeminiKey(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) throw new GeminiKeyError("Paste a Gemini API key first.");
  if (/\s/.test(key)) {
    throw new GeminiKeyError(
      "That contains whitespace, so it is probably a whole command rather than " +
        `just the key. ${GEMINI_KEY_HINT}`,
    );
  }
  if (key.length < 20) {
    throw new GeminiKeyError(
      `That is only ${key.length} characters, which is too short to be an API key. ${GEMINI_KEY_HINT}`,
    );
  }
  if (key.length > 200) {
    throw new GeminiKeyError(
      "That is longer than any API key, so it is probably a whole file or a " +
        "URL rather than the key itself.",
    );
  }
  if (!KEY_SHAPE.test(key)) {
    throw new GeminiKeyError(
      "That contains characters no API key does — letters, digits, dots, " +
        `hyphens and underscores only. ${GEMINI_KEY_HINT}`,
    );
  }
  return key;
}

/** True without throwing — for a live editor that should not shout while typing. */
export function looksLikeGeminiKey(raw: unknown): boolean {
  try {
    normaliseGeminiKey(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * `AIzaSyAB…7Xq2` — enough to recognise which key this is, never enough to use
 * it. Google's prefixes are constant within a format, so it is the tail that
 * actually identifies the key; four characters is plenty for a human and
 * nowhere near enough for anyone else.
 */
export function maskGeminiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

/**
 * The scope a model's observed availability belongs to.
 *
 * Cooldowns are learned by being refused, and a refusal is a fact about ONE
 * Google quota — not about the model. Before this existed the table was global,
 * so one clinician exhausting the flagship greyed it out for everybody, and the
 * row survived a restart to keep doing so. Keying on the quota means an
 * observation only ever constrains the key that earned it.
 */
export const INSTANCE_QUOTA = "instance";

/**
 * A stable, non-reversible name for a quota.
 *
 * The same key always yields the same scope — which is the point, because two
 * clinicians sharing a key really do share a quota and should share its
 * cooldowns. 64 bits of SHA-256 over a high-entropy random key: not enumerable,
 * and it carries nothing about who pasted it.
 */
export async function quotaFingerprint(apiKey?: string | null): Promise<string> {
  const key = apiKey?.trim();
  if (!key) return INSTANCE_QUOTA;
  return (await sha256Hex(key)).slice(0, 16);
}
