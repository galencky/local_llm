/**
 * Volatile, RAM-only re-identification store.
 *
 * ============================ PDPA CONSTRAINT ============================
 * The contents of a TokenVault are the ONLY place raw PHI exists on the
 * server. It must never be written to Postgres, to a file, to a log line, or
 * to any telemetry sink. Entries self-destruct after TTL_MS.
 * ========================================================================
 */

/**
 * The categories the pipeline names for itself. The local model is free to
 * invent others — a token is only a label plus a number, and re-hydration is a
 * literal lookup, so an unfamiliar label costs nothing. What must hold is the
 * SHAPE of the label, which `normaliseCategory` in `scrubber-llm.ts` enforces
 * before it ever reaches {@link TokenVault.assign}.
 */
export type KnownPiiCategory =
  | "TAIWAN_ID"
  | "MRN"
  | "PHONE"
  | "DATE"
  | "PATIENT"
  | "RELATIVE"
  | "DOCTOR"
  | "WARD"
  | "LOCATION"
  | "ORG"
  | "EMAIL"
  | "STAFF_CODE"
  | "OTHER_ID";

/** A known category, or any other `[A-Z_]` label the local model invented. */
export type PiiCategory = KnownPiiCategory | (string & {});

export interface RedactionSummaryEntry {
  token: string;
  category: PiiCategory;
  /** Masked sample for the UI inspector — never the full identifier. */
  preview: string;
  /** Which pass caught it. */
  source: "regex" | "llm";
}

/** Mask all but the first and last character: 陳建明 -> 陳*明, A123456789 -> A********9 */
function mask(value: string): string {
  const chars = [...value];
  if (chars.length <= 2) return "*".repeat(chars.length);
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bidirectional PII <-> token map for a single note.
 *
 * The same identifier always maps to the same token, so "陳先生" appearing five
 * times stays one referent for the cloud model instead of five strangers.
 */
export class TokenVault {
  private readonly tokenToPii = new Map<string, string>();
  private readonly piiToToken = new Map<string, string>();
  private readonly meta = new Map<
    string,
    { category: PiiCategory; source: "regex" | "llm" }
  >();
  private readonly counters = new Map<PiiCategory, number>();

  /**
   * Reserve a token for `original`, or return the existing one.
   * @returns the placeholder, e.g. `[PATIENT_1]`
   */
  assign(
    category: PiiCategory,
    original: string,
    source: "regex" | "llm",
  ): string {
    const key = `${category}::${original}`;
    const existing = this.piiToToken.get(key);
    if (existing) return existing;

    const next = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, next);
    const token = `[${category}_${next}]`;

    this.piiToToken.set(key, token);
    this.tokenToPii.set(token, original);
    this.meta.set(token, { category, source });
    return token;
  }

  get size(): number {
    return this.tokenToPii.size;
  }

  /** Every token currently issued, longest first (see `rehydrate`). */
  tokens(): string[] {
    return [...this.tokenToPii.keys()].sort((a, b) => b.length - a.length);
  }

  /**
   * Swap placeholders back to the real identifiers.
   *
   * Longest-token-first ordering matters: replacing `[MRN_1]` before
   * `[MRN_11]` would corrupt the latter into `<mrn-one>1]`.
   */
  rehydrate(text: string): string {
    const tokens = this.tokens();
    if (tokens.length === 0) return text;
    const pattern = new RegExp(tokens.map(escapeRegex).join("|"), "g");
    return text.replace(pattern, (match) => this.tokenToPii.get(match) ?? match);
  }

  /** Tokens the cloud model left unresolved — a signal the prompt drifted. */
  unresolvedTokens(text: string): string[] {
    return this.tokens().filter((t) => text.includes(t));
  }

  /** Safe-to-display audit trail for the UI inspector drawer. */
  summary(): RedactionSummaryEntry[] {
    return [...this.tokenToPii.entries()].map(([token, pii]) => {
      const m = this.meta.get(token)!;
      return {
        token,
        category: m.category,
        preview: mask(pii),
        source: m.source,
      };
    });
  }

  /** Best-effort wipe. */
  clear(): void {
    this.tokenToPii.clear();
    this.piiToToken.clear();
    this.meta.clear();
    this.counters.clear();
  }
}

/* ------------------------------------------------------------------ */
/* TTL store                                                           */
/* ------------------------------------------------------------------ */

const TTL_MS = 10 * 60 * 1000; // 10 minutes, per spec
const SWEEP_MS = 30 * 1000;

interface CacheEntry {
  vault: TokenVault;
  expiresAt: number;
}

interface CacheState {
  entries: Map<string, CacheEntry>;
  sweeper: ReturnType<typeof setInterval> | null;
}

const globalForCache = globalThis as unknown as {
  __tokenVaultCache: CacheState | undefined;
};

const cache: CacheState = (globalForCache.__tokenVaultCache ??= {
  entries: new Map(),
  sweeper: null,
});

function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of cache.entries) {
    if (entry.expiresAt <= now) {
      entry.vault.clear();
      cache.entries.delete(id);
    }
  }
}

if (!cache.sweeper) {
  cache.sweeper = setInterval(sweep, SWEEP_MS);
  // Do not hold the process open for a purge timer.
  cache.sweeper.unref?.();
}

export function storeVault(sessionId: string, vault: TokenVault): void {
  cache.entries.set(sessionId, { vault, expiresAt: Date.now() + TTL_MS });
}

export function getVault(sessionId: string): TokenVault | null {
  const entry = cache.entries.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    entry.vault.clear();
    cache.entries.delete(sessionId);
    return null;
  }
  return entry.vault;
}

/** Explicit purge — called as soon as a note is re-hydrated and returned. */
export function purgeVault(sessionId: string): void {
  const entry = cache.entries.get(sessionId);
  if (!entry) return;
  entry.vault.clear();
  cache.entries.delete(sessionId);
}

export function vaultCount(): number {
  sweep();
  return cache.entries.size;
}

export const VAULT_TTL_MS = TTL_MS;
