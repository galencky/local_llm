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
 *   Anything bound for Google is de-identified first, without exception and
 *   failing closed if the local model is unavailable. Nothing else about a run
 *   can switch that off, because it is decided by the destination rather than
 *   by any prompt.
 *
 * The corollary is what makes the local destination worth having: when nothing
 * leaves the box there is nothing to protect it from. `prompt` + `local` is
 * therefore the one combination that runs raw — no scrubbing, and no audit
 * row, because an audit row would be the only copy of unredacted text anywhere
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

/** What a custom-prompt run carries. */
export interface PromptRun {
  /** The model's standing instructions. May be empty — not every model needs one. */
  systemInstruction: string;
  /** The actual question. Required: there is nothing to run without it. */
  prompt: string;
  temperature: number;
  maxTokens: number;
}

export const PROMPT_DEFAULTS: PromptRun = {
  systemInstruction:
    "You are a careful clinical assistant. Answer only from what you are given, say when something is not stated, and keep to the register of a hospital chart.",
  prompt: "",
  temperature: 0.2,
  maxTokens: 4096,
};

export const PROMPT_PARAMS = [
  {
    key: "temperature" as const,
    label: "Temperature",
    min: 0,
    max: 2,
    step: 0.05,
    hint: "0 is repeatable, 2 is loose. 0.2 for anything going in a chart.",
  },
  {
    key: "maxTokens" as const,
    label: "Max tokens",
    min: 256,
    max: 32768,
    step: 256,
    hint: "Caps the answer. Too low truncates it mid-sentence.",
  },
];

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

  return {
    systemInstruction,
    prompt,
    temperature: clamp(input.temperature, PROMPT_DEFAULTS.temperature, 0, 2),
    maxTokens: Math.round(clamp(input.maxTokens, PROMPT_DEFAULTS.maxTokens, 256, 32768)),
  };
}

/* ------------------------------------------------------------------ */
/* What a given run actually does                                      */
/* ------------------------------------------------------------------ */

/**
 * Does this run de-identify?
 *
 * Everything except a custom prompt run locally. Note runs always do, on both
 * destinations, because they produce a chart entry and an audit trail and the
 * audit log's de-identification invariant is not a property of the cloud
 * boundary.
 */
export function deidentifies(workspace: Workspace, localDestination: boolean): boolean {
  return !(workspace === "prompt" && localDestination);
}

/**
 * Does this run leave a row in the audit log?
 *
 * Only if it was de-identified. A raw local run has nothing safe to store, and
 * storing it anyway would put the only unredacted copy of the text on disk —
 * which is the exact thing the whole design exists to avoid.
 */
export function audits(workspace: Workspace, localDestination: boolean): boolean {
  return deidentifies(workspace, localDestination);
}

/**
 * The stages this run will actually emit, in order.
 *
 * The progress list is built from this rather than from a fixed array, so a
 * raw local run shows the three steps it performs instead of four greyed-out
 * ones it will never reach.
 */
export function stagesFor(workspace: Workspace, localDestination: boolean): PipelineStage[] {
  if (!deidentifies(workspace, localDestination)) {
    return ["decrypt", "cloud", "seal"];
  }
  return ["decrypt", "regex", "ner", "cloud", "rehydrate", "audit", "seal"];
}
