import type { BusyInfo } from "./pipeline-client";

/**
 * The shapes that cross the wire, declared once.
 *
 * ============================ WHY THIS EXISTS ============================
 * Every one of these used to be written twice — once where the route builds
 * it, once where the browser reads it — and the two drifted. `quotaSource` was
 * added to the route's `meta` and had to be remembered separately in the
 * page's copy of the same interface; nothing would have complained if it had
 * not been, because a JSON response is `any` until somebody asserts otherwise.
 *
 * So the contract lives here and both ends import it. This file must stay free
 * of Node-only imports and of anything with a runtime cost: it is types only,
 * so it is erased at compile time and costs the browser bundle nothing.
 * ========================================================================
 */

/* ------------------------------------------------------------------ */
/* POST /api/process-note                                              */
/* ------------------------------------------------------------------ */

export interface RedactionEntry {
  token: string;
  category: string;
  /** Masked sample — never the full identifier. */
  preview: string;
  /** Which pass caught it. */
  source: "regex" | "llm";
}

export interface ProcessNoteMeta {
  auditLogId: string | null;
  /** The model that actually produced the note, `local:` prefixed if local. */
  model: string;
  format: string;
  promptTemplateName: string | null;
  /** Where the note was written. "local" means nothing left the Mac at all. */
  destination: "cloud" | "local";
  workspace: "note" | "prompt";
  /** False on a local run — the one destination that is not scrubbed. */
  deidentified: boolean;
  /** Whether the deterministic pattern pass ran. */
  patternScrub: boolean;
  /** Whose Google allowance paid for this run. */
  quotaSource: "own" | "instance";
  /** Models exhausted or unavailable before the one that served this note. */
  modelFallbacks: { model: string; reason: string }[];
  processingTimeMs: number;
  scrubMs: number;
  /**
   * Time in the formatting stage, wherever it ran. Named before local
   * formatting existed; kept, because it is on the wire and in History.
   */
  geminiMs: number;
  regexHits: Record<string, number>;
  llmEntityCount: number;
  hallucinatedSpans: number;
  rejectedClinicalSpans: number;
  /** Placeholders the model failed to reproduce — a drift signal. */
  unresolvedTokens: string[];
  degradedScrub: boolean;
}

export interface ProcessNoteResult {
  note: string;
  deidentifiedInput: string;
  deidentifiedOutput: string;
  redactions: RedactionEntry[];
  meta: ProcessNoteMeta;
}

/* ------------------------------------------------------------------ */
/* GET /api/status                                                     */
/* ------------------------------------------------------------------ */

export interface StatusPayload {
  state: "online" | "busy";
  busy: boolean;
  lockHeldForMs?: number | null;
  activity: BusyInfo | null;
  lmStudio: {
    online: boolean;
    /** What LM Studio has loaded. */
    models: string[];
    /** What a request will actually ask for. */
    requestModel?: string;
    busy?: boolean;
    error?: string;
  };
  database: { online: boolean; error?: string };
  gemini: { configured: boolean; model: string };
  vaults: { active: number; ttlMs: number };
  degradedScrubAllowed: boolean;
  devLogin: { enabled: boolean; allowsRemote: boolean };
  /** Lets an open tab notice its own JS is from a previous build. */
  buildId: string;
}

/* ------------------------------------------------------------------ */
/* GET /api/models                                                     */
/* ------------------------------------------------------------------ */

export interface ModelAvailability {
  id: string;
  label: string;
  tier: "flagship" | "lite";
  /** Documented free-tier requests/day, shown as a hint in the selector. */
  dailyLimit: number;
  available: boolean;
  reason: "quota" | "overloaded" | "model" | null;
  /** Milliseconds until it can be tried again; null when available. */
  retryInMs: number | null;
  daily: boolean;
}

export interface ModelsPayload {
  models: ModelAvailability[];
  default: string;
  /** The quota scope these answers are about. */
  quota: string;
  /** False when this deployment has no Gemini key of its own. */
  instanceKey: boolean;
}

/* ------------------------------------------------------------------ */
/* GET /api/history                                                    */
/* ------------------------------------------------------------------ */

export interface HistoryNote {
  id: string;
  createdAt: string;
  deidentifiedInput: string;
  deidentifiedOutput: string;
  modelUsed: string;
  noteFormat: string | null;
  promptTemplateName: string | null;
  processingTimeMs: number;
}

/* ------------------------------------------------------------------ */
/* GET /api/prompts                                                    */
/* ------------------------------------------------------------------ */

export interface PromptTemplate {
  id: string;
  name: string;
  specialty: string | null;
  /** "note" or "prompt" — which workspace this routine belongs to. */
  kind?: string | null;
  instruction: string;
  /** Prompt routines only. */
  systemInstruction?: string | null;
  format: string | null;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  maxTokens?: number | null;
  isDefault: boolean;
  /** Null owner = a shared routine anyone on this instance can manage. */
  userId: string | null;
}

/* ------------------------------------------------------------------ */
/* GET /api/prompt-config                                              */
/* ------------------------------------------------------------------ */

export interface PromptConfig {
  local: {
    /** The model answering right now. */
    model: string;
    /** What LM Studio has loaded, or null when it is unreachable. */
    loadedModel: string | null;
    /** The LMSTUDIO_MODEL fallback, used only if detection fails. */
    configuredModel: string | null;
    prompt: string;
  };
  cloud: {
    model: string;
    systemInstruction: string;
    formats: { format: string; label: string; instruction: string }[];
  };
  custom: { placeholderKernel: string };
  customisation: { where: string; why: string };
}

/* ------------------------------------------------------------------ */
/* GET /api/auth/session                                               */
/* ------------------------------------------------------------------ */

export interface SessionUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}
