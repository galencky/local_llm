import type { PipelineStage } from "./concurrency";

/**
 * The two things you can be doing, and the one rule that governs both.
 *
 * ============================ THE WHOLE MODEL ============================
 *
 * TWO WORKSPACES
 *   note    a ward narrative becomes a structured chart entry
 *   prompt  a system instruction and a prompt become an answer
 *
 * TWO DESTINATIONS
 *   cloud   a rung of the Gemini ladder
 *   local   the model already loaded in LM Studio
 *
 * ONE RULE
 *   De-identification happens if and only if the run is bound for Google.
 *   It reads off the destination alone: the workspace does not enter into it,
 *   no prompt is consulted, and there is no combination that is an exception.
 *
 * Cloud runs are de-identified without exception and fail closed if the local
 * model is not there to do it. Local runs are not de-identified at all —
 * because nothing leaves the box, and there is nothing to protect it from.
 * They also write no audit row: there is no de-identified copy of a local run
 * to store, and storing the raw text would put the only unredacted copy of it
 * on disk. It is your machine talking to your model.
 *
 * This replaced four overlapping controls — a guided/custom toggle, a CUSTOM
 * note format, a saved routine and a free-text steer — that between them could
 * express the same intent in three different ways and had started to need a
 * table to explain.
 * ========================================================================
 */

export type Workspace = "note" | "prompt";

export function isWorkspace(value: unknown): value is Workspace {
  return value === "note" || value === "prompt";
}

/** Longer than any sane system instruction, shorter than a note. */
export const MAX_PROMPT_LENGTH = 20000;

/**
 * Sampling, for whichever model this run uses.
 *
 * One set of numbers, not one per model and not one per workspace. Both
 * destinations accept all four under different names, and a clinician tuning
 * "how loose should this be" is asking one question — so they set it once and
 * the route translates. Where a destination cannot honour one, it is simply
 * not sent.
 */
export interface Sampling {
  temperature: number;
  /** Nucleus sampling. 1 disables it, and it is then not sent at all. */
  topP: number;
  /** Sample from the K likeliest tokens. 0 leaves it to the model. */
  topK: number;
  maxTokens: number;
}

export const SAMPLING_DEFAULTS: Sampling = {
  // 0.2 is the guided default this project has always used for a chart entry:
  // low enough to be repeatable, not so low that the prose goes stilted.
  temperature: 0.2,
  topP: 1,
  topK: 0,
  maxTokens: 8192,
};

export const SAMPLING_PARAMS = [
  {
    key: "temperature" as const,
    label: "Temp",
    min: 0,
    max: 2,
    step: 0.05,
    hint: "0 is repeatable, 2 is loose. 0.2 for anything going in a chart.",
  },
  {
    key: "topP" as const,
    label: "Top-P",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "Nucleus sampling: consider only the likeliest tokens summing to P. 1 disables it.",
  },
  {
    key: "topK" as const,
    label: "Top-K",
    min: 0,
    max: 200,
    step: 1,
    hint: "Consider only the K likeliest tokens. 0 leaves it to the model.",
  },
  {
    key: "maxTokens" as const,
    label: "Max",
    min: 256,
    max: 32768,
    step: 256,
    hint: "Caps the answer. Too low truncates it mid-sentence.",
  },
];

/**
 * Sampling for the de-identification pass, which is a different job.
 *
 * Temperature 0 because any creativity here shows up as invented spans, which
 * are discarded by the verbatim check — so it costs recall without buying
 * anything. The token cap is generous because a long shift note can carry 60+
 * entities and a truncated JSON array fails the run closed.
 *
 * The PROMPT is not editable and never will be: it is the de-identification
 * step itself. The numbers are, because the worst a bad number can do is find
 * fewer names — which the redaction list shows you — rather than change what
 * the step is.
 */
export const DEID_SAMPLING_DEFAULTS: Sampling = {
  temperature: 0,
  topP: 1,
  topK: 0,
  maxTokens: 6144,
};

export function normaliseDeidSampling(raw: unknown): Sampling {
  const s = normaliseSampling({ ...DEID_SAMPLING_DEFAULTS, ...(raw ?? {}) });
  // The entity list is the only output, so it needs a smaller ceiling than a
  // whole note does.
  return { ...s, maxTokens: Math.min(16384, s.maxTokens) };
}

export function normaliseSampling(raw: unknown): Sampling {
  const input = (raw ?? {}) as Record<string, unknown>;
  return {
    temperature: clamp(input.temperature, SAMPLING_DEFAULTS.temperature, 0, 2),
    topP: clamp(input.topP, SAMPLING_DEFAULTS.topP, 0, 1),
    topK: Math.round(clamp(input.topK, SAMPLING_DEFAULTS.topK, 0, 200)),
    maxTokens: Math.round(clamp(input.maxTokens, SAMPLING_DEFAULTS.maxTokens, 256, 32768)),
  };
}

/** What a custom-prompt run carries, beyond the sampling every run carries. */
export interface PromptRun {
  /** The model's standing instructions. May be empty — not every model needs one. */
  systemInstruction: string;
  /** The actual question. Required: there is nothing to run without it. */
  prompt: string;
}

export const PROMPT_DEFAULTS: PromptRun = {
  systemInstruction:
    "You are a careful clinical assistant. Answer only from what you are given, say when something is not stated, and keep to the register of a hospital chart.",
  prompt: "",
};

export class PromptRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptRunError";
  }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Coerce whatever arrived over the wire into a runnable prompt.
 *
 * Runs on the server on every custom-prompt request. The editor's own limits
 * are a courtesy to the person typing; this is the one that counts, because
 * the payload is assembled in the browser and a hand-rolled client could put
 * anything in it.
 *
 * @throws {PromptRunError} when there is no prompt, or either field is over
 * the cap — refused rather than truncated, because a silently shortened prompt
 * is a different question than the one that was asked.
 */
export function normalisePromptRun(raw: unknown): PromptRun {
  const input = (raw ?? {}) as Record<string, unknown>;
  const systemInstruction = text(input.systemInstruction);
  const prompt = text(input.prompt);

  if (!prompt) {
    throw new PromptRunError("There is no prompt to run. Write one first.");
  }
  for (const [name, body] of [
    ["system instruction", systemInstruction],
    ["prompt", prompt],
  ] as const) {
    if (body.length > MAX_PROMPT_LENGTH) {
      throw new PromptRunError(
        `The ${name} is ${body.length.toLocaleString()} characters. The cap is ${MAX_PROMPT_LENGTH.toLocaleString()}.`,
      );
    }
  }

  return { systemInstruction, prompt };
}

/* ------------------------------------------------------------------ */
/* What a given run actually does                                      */
/* ------------------------------------------------------------------ */

/**
 * Does this run de-identify? Exactly when it is bound for Google.
 *
 * The rule reads off one variable, and that is the whole of it. The workspace
 * does not enter into it, no prompt is consulted, and there is no combination
 * that is an exception — which is what makes it a rule rather than a policy
 * with a table attached.
 *
 * Cloud: always, without exception, failing closed if the local model is not
 * there to do it. Local: never, because nothing leaves the box and there is
 * nothing to protect it from. The clinician's own machine running the
 * clinician's own model on the clinician's own patient's notes needs no
 * intermediary, and pretending otherwise would be theatre.
 */
export function deidentifies(localDestination: boolean): boolean {
  return !localDestination;
}

/**
 * Does this run leave a row in the audit log? The same answer, necessarily.
 *
 * The audit log holds de-identified text only — that is the hard PDPA boundary
 * the whole design is built around. A local run has no de-identified copy of
 * itself to store, so it stores nothing: the invariant holds by never writing,
 * rather than by writing something and hoping it is safe.
 *
 * The consequence is worth stating plainly, because it is a real trade: notes
 * written locally do not appear in History, and leave no audit trail. History
 * is a record of what crossed to the cloud, which is exactly what it has always
 * claimed to be.
 */
export function audits(localDestination: boolean): boolean {
  return deidentifies(localDestination);
}

/**
 * The stages this run will actually emit, in order.
 *
 * The progress list is built from this rather than from a fixed array, so a
 * local run shows the three steps it performs instead of four greyed-out ones
 * it will never reach.
 */
export function stagesFor(
  localDestination: boolean,
  patternScrub = true,
): PipelineStage[] {
  if (localDestination) return ["decrypt", "cloud", "seal"];
  return [
    "decrypt",
    ...(patternScrub ? (["regex"] as const) : []),
    "ner",
    "cloud",
    "rehydrate",
    "audit",
    "seal",
  ];
}

/**
 * Does the deterministic pass run?
 *
 * Only ever a question for a cloud run — a local run de-identifies nothing at
 * all, so there is no pattern pass to switch off.
 *
 * Switching it off is a real weakening and is presented as one. The pattern
 * rules are deterministic where the model is not: what they catch, they always
 * catch. What they buy in exchange for that is over-eagerness — a bed number
 * like `08-2` reads as a month/day, a seven-digit accession reads as an MRN —
 * and for some notes that costs more than it saves. The measured argument for
 * allowing it at all is that the current NER prompt scores 17/17 alone on the
 * synthetic set; the argument against is that "alone" is a probabilistic
 * 17/17, not a guaranteed one.
 */
export function patternScrubs(localDestination: boolean, requested: boolean): boolean {
  return deidentifies(localDestination) && requested;
}
