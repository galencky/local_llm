import "server-only";
import { GoogleGenAI } from "@google/genai";
import { PLACEHOLDER_KERNEL, withPlaceholderKernel } from "./placeholders";
import {
  chainFrom,
  defaultModel,
  ensureCooldownsLoaded,
  isAvailable,
  markAvailable,
  markUnavailable,
  type UnavailableReason,
} from "./model-registry";

/**
 * Cloud formatting layer.
 *
 * By the time anything reaches this module it has been through both scrubbing
 * passes: every identifier is a `[CATEGORY_N]` placeholder. Gemini receives
 * clinical structure and nothing that can name a person.
 */

/**
 * The system instruction below is NOT editable and is not stored in the
 * database. The placeholder rules are what keep `[PATIENT_1]` intact
 * through the round trip, and the clinical rules are what stop the model
 * inventing findings. Making them a setting would make the safety properties a
 * setting. `systemInstruction()` exports the text so the UI can show it
 * verbatim.
 */

export const NOTE_FORMATS = {
  SOAP: "SOAP note",
  DISCHARGE_SUMMARY: "Discharge summary",
  HOSPITAL_COURSE: "Hospital course timeline",
  ADMISSION_NOTE: "Admission note",
  PROGRESS_NOTE: "Daily progress note",
  /**
   * The clinician writes the skeleton instead of picking one.
   *
   * This is the light door into customisation, and deliberately the safest
   * one: the format skeleton is the WEAKEST instruction in the assembled
   * prompt, so replacing it cannot touch the placeholder rules, the clinical
   * rules, or either de-identification pass. Custom *mode* is the heavy door —
   * it replaces both system prompts and the sampling parameters.
   */
  CUSTOM: "Custom prompt",
} as const;

/** Formats with a compiled-in skeleton — everything except the written one. */
export const BUILT_IN_FORMATS = (
  Object.keys(NOTE_FORMATS) as NoteFormat[]
).filter((f) => f !== "CUSTOM");

export type NoteFormat = keyof typeof NOTE_FORMATS;

export function isNoteFormat(value: unknown): value is NoteFormat {
  return typeof value === "string" && value in NOTE_FORMATS;
}

const FORMAT_INSTRUCTIONS: Record<NoteFormat, string> = {
  SOAP: `Produce a SOAP note with these headings exactly: **S (Subjective)**, **O (Objective)**, **A (Assessment)**, **P (Plan)**. Put symptoms and history under S; vitals, exam findings, labs and imaging under O; a numbered problem list with reasoning under A; and management steps per problem under P.`,
  DISCHARGE_SUMMARY: `Produce a discharge summary with these headings exactly: **Admission Diagnosis**, **Discharge Diagnosis**, **Hospital Course**, **Procedures**, **Discharge Medications**, **Follow-up Plan**, **Condition at Discharge**.`,
  HOSPITAL_COURSE: `Produce a chronological hospital course timeline. Each entry begins with its time marker (a date placeholder or a relative day such as "HD#3"), then a concise account of events, interventions, and the response to them. Keep strict chronological order.`,
  ADMISSION_NOTE: `Produce an admission note with these headings exactly: **Chief Complaint**, **History of Present Illness**, **Past Medical History**, **Medications**, **Allergies**, **Physical Examination**, **Investigations**, **Impression**, **Plan**.`,
  PROGRESS_NOTE: `Produce a concise daily progress note: an interval-history line, then objective data, then a numbered active problem list with today's assessment and plan for each.`,
  // Never sent: a CUSTOM run supplies its own skeleton, and the route refuses
  // the run rather than falling back to this if one did not arrive. It exists
  // so the type stays total and so a hand-rolled client cannot reach the cloud
  // with no formatting instruction at all.
  CUSTOM: `Produce a structured clinical note using the headings the source material implies. Keep every section grounded in the narrative.`,
};

const SYSTEM_INSTRUCTION = `You are a clinical documentation specialist producing formal hospital notes for physicians in Taiwan.

The narrative you receive has been de-identified. Bracketed placeholders such as [PATIENT_1], [DOCTOR_2], [MRN_1], [DATE_3], [WARD_1] stand in for real identifiers.

ABSOLUTE RULES ABOUT PLACEHOLDERS:
- Reproduce every placeholder character for character, including its number. [DATE_2] must never become [DATE_1], [Date_2], "DATE_2", or an invented date.
- Never invent a name, date, medical record number, or ward to fill a placeholder.
- Never introduce a new placeholder that was not in the source.
- Keep placeholders in the positions the clinical meaning requires; you may reorder content, but a placeholder travels with the fact it belongs to.

CLINICAL RULES:
- Use only information present in the source. Do not infer diagnoses, invent vitals, or add findings that were not stated.
- If a section has no source information, write "Not documented." rather than guessing.
- Preserve all numeric values, units, drug names, doses, routes, and frequencies exactly.
- Write in the register of a hospital chart: concise, impersonal, standard abbreviations acceptable.
- Keep source-language clinical terms where the physician used them; do not translate Traditional Chinese findings into English or vice versa unless asked.
- Output the note as Markdown. No preamble, no closing commentary, no explanation of what you did.`;

/** The compiled-in skeleton for a format, before any per-user override. */
export function builtInFormatInstruction(format: NoteFormat): string {
  return FORMAT_INSTRUCTIONS[format];
}

export function systemInstruction(): string {
  return SYSTEM_INSTRUCTION;
}

/**
 * Assemble exactly what Gemini will receive, for display or for sending.
 *
 * One function, used by both the real request and the read-only preview, so
 * what the UI shows cannot drift from what is actually sent. Everything a
 * clinician can change enters through `template` (a saved routine) or `adHoc`
 * — the skeleton and the system instruction are compiled in.
 */
export function assemblePrompt(opts: {
  format: NoteFormat;
  template?: { name: string; instruction: string } | null;
  adHoc?: string | null;
  narrative: string;
  /**
   * A replacement for the built-in format skeleton. When set, `format` is
   * only a label — it no longer chooses the note's shape.
   */
  skeleton?: string | null;
}): string {
  const adHoc = opts.adHoc?.trim();
  return [
    opts.skeleton?.trim() || FORMAT_INSTRUCTIONS[opts.format],
    opts.template?.instruction?.trim()
      ? `\n\nDepartmental charting routine ("${opts.template.name}") — follow this unless it conflicts with the placeholder rules:\n${opts.template.instruction.trim()}`
      : "",
    adHoc ? `\n\nAdditional instruction for this note only: ${adHoc}` : "",
    "\n\n--- DE-IDENTIFIED CLINICAL NARRATIVE ---\n",
    opts.narrative,
    "\n--- END NARRATIVE ---",
  ].join("");
}

/**
 * The system instruction a custom-prompt run actually gets on the cloud.
 *
 * The user's own text, plus the placeholder kernel — because the prompt was
 * de-identified on the way out and has to be re-hydratable on the way back.
 * That is not a style choice the user can decline; without it the answer comes
 * back with `[PATIENT_1]` renumbered and the round trip is broken.
 */
export function promptSystemInstruction(userInstruction: string): string {
  const own = userInstruction.trim();
  return own ? withPlaceholderKernel(own) : PLACEHOLDER_KERNEL;
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to .env on the Mac Mini.",
    );
  }
  // GEMINI_BASE_URL lets you point at an egress proxy, a regional endpoint, or
  // a local stub during verification. Unset in normal operation.
  const baseUrl = process.env.GEMINI_BASE_URL;
  client ??= new GoogleGenAI({
    apiKey,
    ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
  });
  return client;
}

export function geminiModel(): string {
  return defaultModel();
}

export function geminiModelChain(start?: string): string[] {
  return chainFrom(start);
}

/** Google returns operational failures as a JSON blob; make them readable. */
export class GeminiUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: UnavailableReason | "auth",
    /** Daily allowance gone, as opposed to a per-minute burst limit. */
    readonly daily = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}

function translateGeminiError(err: unknown, model: string): never {
  const raw = err instanceof Error ? err.message : String(err);

  if (/RESOURCE_EXHAUSTED|exceeded your current quota|quotaValue/i.test(raw)) {
    const retry = raw.match(/Please retry in ([\d.]+)s/)?.[1];
    const perDay = raw.match(/"quotaValue":\s*"(\d+)"/)?.[1];
    // A per-day quota is not solved by waiting 25 seconds, whatever the
    // retryDelay hint says — distinguish it so the cooldown is honest.
    const daily = /PerDay/i.test(raw);
    throw new GeminiUnavailableError(
      `${model} is out of quota${perDay && daily ? ` (${perDay} requests/day on the free tier)` : ""}.` +
        (daily ? " It resets at midnight US Pacific." : retry ? ` Retry in about ${Math.ceil(Number(retry))}s.` : ""),
      "quota",
      daily,
      retry ? Math.ceil(Number(retry) * 1000) : undefined,
    );
  }
  if (/UNAVAILABLE|high demand|overloaded/i.test(raw)) {
    throw new GeminiUnavailableError(
      `${model} is busy right now.`,
      "overloaded",
      false,
      30_000,
    );
  }
  if (/NOT_FOUND|no longer available|is not found/i.test(raw)) {
    const suggested = raw.match(/use models\/([\w.-]+)/)?.[1];
    throw new GeminiUnavailableError(
      `The model "${model}" is not available on this key${suggested ? ` — Google suggests "${suggested}"` : ""}.`,
      "model",
      true,
    );
  }
  if (/API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(raw)) {
    throw new GeminiUnavailableError(
      "Gemini rejected the API key. Check GEMINI_API_KEY in .env.",
      "auth",
    );
  }
  throw err instanceof Error ? err : new Error(raw);
}

export interface NoteInstructions {
  /** Saved specialty routine, applied before any ad-hoc steer. */
  template?: { name: string; instruction: string } | null;
  /** One-off steer typed by the clinician for this note only. */
  adHoc?: string | null;
  /**
   * The clinician's own note skeleton, from the CUSTOM format. Replaces the
   * compiled-in skeleton and nothing else — it sits at the same, weakest,
   * precedence the built-in one does.
   */
  skeleton?: string | null;
}

export interface FallbackStep {
  model: string;
  reason: "quota" | "overloaded" | "model";
}

export interface FormatNoteResult {
  text: string;
  /** The model that actually produced the note. */
  model: string;
  /** Models tried and rejected before this one, in order. Empty on first try. */
  fallbacks: FallbackStep[];
  latencyMs: number;
}

/**
 * Format a fully de-identified narrative into a structured note.
 *
 * Instruction precedence, weakest to strongest: the format skeleton (built-in,
 * or a replacement for it), then the saved specialty template,
 * then the clinician's ad-hoc steer. The placeholder rules in the system
 * instruction outrank all three — neither a template nor a custom instruction
 * can talk the model into inventing a name.
 *
 * @param deidentifiedText text containing placeholders only — never raw PHI
 * @param format target note structure
 * @param instructions saved template and/or one-off steer
 */
export async function runPromptOnCloud(opts: {
  /** Already de-identified: placeholders only. */
  systemInstruction: string;
  /** Already de-identified: placeholders only. */
  prompt: string;
  temperature: number;
  maxTokens: number;
  startModel?: string;
  onFallback?: (step: FallbackStep, next: string) => void;
}): Promise<FormatNoteResult> {
  return walkTheLadder({
    system: promptSystemInstruction(opts.systemInstruction),
    prompt: opts.prompt,
    generation: {
      temperature: opts.temperature,
      ...(opts.maxTokens > 0 ? { maxOutputTokens: opts.maxTokens } : {}),
    },
    startModel: opts.startModel,
    onFallback: opts.onFallback,
  });
}

export async function formatClinicalNote(
  deidentifiedText: string,
  format: NoteFormat,
  instructions: NoteInstructions = {},
  onFallback?: (step: FallbackStep, next: string) => void,
  startModel?: string,
): Promise<FormatNoteResult> {
  const prompt = assemblePrompt({
    format,
    template: instructions.template,
    adHoc: instructions.adHoc,
    narrative: deidentifiedText,
    skeleton: instructions.skeleton,
  });

  return walkTheLadder({
    system: SYSTEM_INSTRUCTION,
    prompt,
    generation: { temperature: 0.2 },
    startModel,
    onFallback,
  });
}

/**
 * Try each rung from `startModel` down, and report every refusal on the way.
 *
 * Shared by the note path and the custom-prompt path: the ladder, the cooldown
 * bookkeeping and the which-failures-are-worth-retrying rules are identical
 * whatever the prompt is made of.
 */
async function walkTheLadder(opts: {
  system: string;
  prompt: string;
  generation: Record<string, number>;
  startModel?: string;
  onFallback?: (step: FallbackStep, next: string) => void;
}): Promise<FormatNoteResult> {
  const { system, prompt, generation, startModel, onFallback } = opts;
  const started = Date.now();

  // Persisted cooldowns must be loaded before we decide which rung to try.
  await ensureCooldownsLoaded();

  const chain = geminiModelChain(startModel);
  const fallbacks: FallbackStep[] = [];
  let lastError: unknown = null;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const remaining = chain.slice(i + 1);

    // Skip a rung already known to be spent, unless it is the last hope.
    if (!isAvailable(model) && remaining.length > 0) {
      fallbacks.push({ model, reason: "quota" });
      onFallback?.({ model, reason: "quota" }, remaining[0]);
      continue;
    }

    try {
      const response = await getClient().models.generateContent({
        model,
        contents: prompt,
        config: { systemInstruction: system, ...generation },
      });

      const text = response.text?.trim();
      if (!text) {
        throw new Error(
          "Gemini returned an empty response (the request may have been blocked by a safety filter).",
        );
      }
      markAvailable(model);
      return { text, model, fallbacks, latencyMs: Date.now() - started };
    } catch (err) {
      let translated: unknown = err;
      try {
        translateGeminiError(err, model);
      } catch (e) {
        translated = e;
      }
      lastError = translated;

      const unavailable =
        translated instanceof GeminiUnavailableError && translated.kind !== "auth"
          ? translated
          : null;

      if (unavailable) {
        markUnavailable(model, unavailable.kind as UnavailableReason, {
          daily: unavailable.daily,
          retryAfterMs: unavailable.retryAfterMs,
        });
        if (unavailable.kind === "model") {
          console.warn(
            `[gemini] ${model} is retired for this key and has been dropped from the ladder.`,
          );
        }
      }

      // Quota, overload and retirement are solved by another model. An auth
      // failure or a safety block is not — fail immediately on those.
      if (unavailable && remaining.length > 0) {
        const step: FallbackStep = { model, reason: unavailable.kind as FallbackStep["reason"] };
        fallbacks.push(step);
        onFallback?.(step, remaining[0]);
        continue;
      }
      throw translated;
    }
  }

  if (lastError) throw lastError;

  // Unreachable while the chain is non-empty, but keeps the contract honest.
  throw new GeminiUnavailableError(
    "Every model in the ladder is out of quota. They reset at midnight US Pacific.",
    "quota",
    true,
  );
}
