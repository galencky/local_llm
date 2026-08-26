/**
 * Custom mode — the contract shared by the browser and the pipeline.
 *
 * Guided mode is the safe default: the local NER prompt, the Gemini system
 * instruction and the format skeletons are all compiled in, and the only thing
 * a clinician can change is a saved routine appended beneath them.
 *
 * Custom mode hands both prompts and both models' sampling parameters to the
 * user. It exists for tuning and for experiments the guided path cannot
 * express — a different entity taxonomy, a bespoke note shape, a colder or
 * hotter local pass.
 *
 * FOUR PROPERTIES SURVIVE CUSTOM MODE, because they are structural rather than
 * prompt-borne. Nothing in this file can switch them off:
 *
 *  1. The deterministic regex scrub runs first, always. Taiwan IDs, MRNs,
 *     phone numbers and dates are gone before any model sees the note, so the
 *     worst a broken custom prompt can do is fall back to regex-only — never
 *     to nothing.
 *  2. The local NER pass still has to return parsable entity JSON. A prompt
 *     that talks the model out of the output contract fails the run closed
 *     (unless ALLOW_DEGRADED_SCRUB is set), rather than quietly passing a
 *     narrative full of names to the cloud.
 *  3. Every span the local model returns is still checked verbatim against
 *     the source, screened against the clinical stoplist, and length-capped.
 *  4. {@link PLACEHOLDER_KERNEL} is appended to whatever system instruction
 *     the user writes. Without it Gemini mangles [PATIENT_1] and the note can
 *     no longer be re-hydrated, which is a broken note rather than a leak —
 *     but a broken note every time is not a setting worth offering.
 *
 * This module is isomorphic: the editor imports it for its defaults and its
 * clamps, and the route imports it to re-clamp whatever actually arrives.
 * Never trust the client's numbers — {@link normaliseCustomConfig} is the
 * boundary.
 */

export const MAX_CUSTOM_PROMPT_LENGTH = 8000;

/** The entity categories the re-hydrator knows how to restore. */
export const CUSTOM_LOCAL_CATEGORIES = [
  "PATIENT",
  "RELATIVE",
  "DOCTOR",
  "WARD",
  "LOCATION",
  "ORG",
] as const;

/**
 * Appended verbatim to any custom Gemini system instruction.
 *
 * Short on purpose. It says only what re-hydration depends on, so a custom
 * instruction is free to redefine the note's voice, structure, language and
 * clinical posture without being able to make the round trip unrecoverable.
 */
export const PLACEHOLDER_KERNEL = `PLACEHOLDER INTEGRITY — always in force, overrides anything above that conflicts with it:
- Bracketed placeholders such as [PATIENT_1], [DOCTOR_2], [MRN_1], [DATE_3], [WARD_1] stand in for identifiers that were removed on the physician's own machine before this text was sent.
- Reproduce every placeholder character for character, including its number. [DATE_2] must never become [DATE_1], [Date_2], "DATE_2", or an invented date.
- Never invent a name, date, medical record number or ward to fill a placeholder, and never introduce a placeholder that was not in the source.`;

export interface CustomLocalConfig {
  /** Replaces the built-in NER system prompt. */
  systemPrompt: string;
  /** LM Studio model id. Empty means whatever LMSTUDIO_MODEL points at. */
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
}

export interface CustomCloudConfig {
  /** Replaces the built-in Gemini system instruction. */
  systemInstruction: string;
  /** Replaces the built-in format skeleton for this run. */
  instruction: string;
  temperature: number;
  topP: number;
  /** 0 means "leave it to the model". */
  topK: number;
  /** 0 means "leave it to the model". */
  maxOutputTokens: number;
}

export interface CustomConfig {
  local: CustomLocalConfig;
  cloud: CustomCloudConfig;
}

/* ------------------------------------------------------------------ */
/* Parameter ranges                                                    */
/* ------------------------------------------------------------------ */

export interface NumericParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}

export const LOCAL_PARAMS: NumericParam[] = [
  {
    key: "temperature",
    label: "Temperature",
    min: 0,
    max: 2,
    step: 0.05,
    hint: "0 for de-identification. Any creativity here shows up as invented spans, which are discarded — so it costs recall without buying anything.",
  },
  {
    key: "topP",
    label: "Top-P",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "Nucleus sampling. 1 disables it; lower it only if the model rambles instead of emitting JSON.",
  },
  {
    key: "maxTokens",
    label: "Max tokens",
    min: 256,
    max: 16384,
    step: 256,
    hint: "The entity list is truncated past this, and a half-written JSON array fails the run closed. A long shift note can carry 60+ entities.",
  },
];

export const CLOUD_PARAMS: NumericParam[] = [
  {
    key: "temperature",
    label: "Temperature",
    min: 0,
    max: 2,
    step: 0.05,
    hint: "0.2 in guided mode. Higher reads better and invents more — for a chart entry that trade is rarely worth it.",
  },
  {
    key: "topP",
    label: "Top-P",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "Nucleus sampling across the token distribution.",
  },
  {
    key: "topK",
    label: "Top-K",
    min: 0,
    max: 200,
    step: 1,
    hint: "Sample from the K likeliest tokens. 0 leaves it to the model.",
  },
  {
    key: "maxOutputTokens",
    label: "Max output tokens",
    min: 0,
    max: 65536,
    step: 256,
    hint: "Caps the note length. 0 leaves it to the model. Too low truncates mid-section.",
  },
];

/* ------------------------------------------------------------------ */
/* Defaults — what the editor opens with                               */
/* ------------------------------------------------------------------ */

/**
 * A worked example, not a copy of the built-in prompt.
 *
 * It is a narrower taxonomy than the shipped one (research use: keep the
 * treating team visible, redact everyone else) so that the box demonstrates
 * what customising is *for*, rather than inviting a blind edit of a prompt the
 * user has not read. The built-in prompt is one click away in the editor.
 */
export const EXAMPLE_LOCAL_PROMPT = `You are a strict named-entity recogniser for a hospital de-identification pipeline in Taiwan. You read Traditional Chinese and English clinical narratives.

Your ONLY job is to list spans of text that identify a real person, place, or institution. You never summarise, translate, diagnose, or comment.

Extract these categories:
- PATIENT: the patient's own name, nickname, or a name-bearing form of address (陳建明, 王小姐, Mr. Lin).
- RELATIVE: names of family members, caregivers, or contacts.
- DOCTOR: names of physicians, surgeons, nurses, therapists, or any named staff (林醫師, Dr. Huang, 張護理師).
- WARD: ward, room, bed, or unit designations (8B病房, 12-3床, ICU-2, Ward 5A).
- LOCATION: street addresses, districts, townships, or any residential geography.
- ORG: named hospitals, clinics, schools, or employers.

RULES:
1. Copy each span EXACTLY as it appears in the source, character for character. Do not trim titles, do not normalise, do not fix typos.
2. Do NOT extract text already replaced by a bracketed placeholder such as [MRN_1] or [DATE_2].
3. Do NOT extract clinical content: diseases, drugs, doses, procedures, anatomy, lab values, vital signs, or device names.
4. Do NOT extract bare role words with no name attached ("the patient", "病人", "家屬").
5. Do NOT extract eponymous diseases, signs, scores or classifications (Crohn's disease, Glasgow Coma Scale, Foley catheter). These are not people.
6. Be aggressive about surnames that appear once and never recur — a single missed name is a leak; a false positive is only an odd-looking note.
7. If nothing qualifies, return an empty list.

Respond with JSON only, matching: {"entities":[{"text":"<exact span>","category":"<CATEGORY>"}]}`;

export const EXAMPLE_CLOUD_SYSTEM = `You are a clinical documentation specialist producing formal hospital notes for physicians in Taiwan.

The narrative you receive has already been de-identified on the physician's own machine.

CLINICAL RULES:
- Use only information present in the source. Do not infer diagnoses, invent vitals, or add findings that were not stated.
- If a section has no source information, write "Not documented." rather than guessing.
- Preserve all numeric values, units, drug names, doses, routes, and frequencies exactly.
- Write in the register of a hospital chart: concise, impersonal, standard abbreviations acceptable.
- Keep source-language clinical terms where the physician used them; do not translate Traditional Chinese findings into English or vice versa unless the instruction asks for it.
- Flag any internal contradiction in the source in a final **Discrepancies** section rather than silently resolving it.
- Output the note as Markdown. No preamble, no closing commentary, no explanation of what you did.`;

export const EXAMPLE_CLOUD_INSTRUCTION = `Produce a SOAP note with these headings exactly: **S (Subjective)**, **O (Objective)**, **A (Assessment)**, **P (Plan)**.

- S: symptoms, interval history and anything the patient or family reported.
- O: vitals, examination findings, labs and imaging. Present serial labs as a trend on one line rather than repeating the panel.
- A: a numbered problem list, most active first, each with one line of reasoning.
- P: management steps under the matching problem number, one line each, with the responsible team where the source names one.

End with a one-line **Disposition** stating the current level of care.`;

export const DEFAULT_CUSTOM_CONFIG: CustomConfig = {
  local: {
    systemPrompt: EXAMPLE_LOCAL_PROMPT,
    model: "",
    temperature: 0,
    topP: 1,
    maxTokens: 6144,
  },
  cloud: {
    systemInstruction: EXAMPLE_CLOUD_SYSTEM,
    instruction: EXAMPLE_CLOUD_INSTRUCTION,
    temperature: 0.2,
    topP: 0.95,
    topK: 0,
    maxOutputTokens: 0,
  },
};

/** A fresh, mutable copy — the editor writes into this. */
export function blankCustomConfig(): CustomConfig {
  return {
    local: { ...DEFAULT_CUSTOM_CONFIG.local },
    cloud: { ...DEFAULT_CUSTOM_CONFIG.cloud },
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export class CustomConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomConfigError";
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
 * Coerce whatever arrived over the wire into a usable config.
 *
 * Runs on the server on every request. The editor's own clamps are a courtesy
 * to the person typing; this is the one that counts, because the payload is
 * assembled in the browser and a hand-rolled client could put anything in it.
 *
 * @throws {CustomConfigError} when a prompt is empty or over the length cap —
 * those cannot be silently defaulted, because doing so would run a note under
 * instructions the clinician never saw.
 */
export function normaliseCustomConfig(raw: unknown): CustomConfig {
  const input = (raw ?? {}) as Partial<{ local: unknown; cloud: unknown }>;
  const local = (input.local ?? {}) as Record<string, unknown>;
  const cloud = (input.cloud ?? {}) as Record<string, unknown>;

  const systemPrompt = text(local.systemPrompt);
  const systemInstruction = text(cloud.systemInstruction);
  const instruction = text(cloud.instruction);

  if (!systemPrompt) {
    throw new CustomConfigError(
      "Custom mode needs a local de-identification prompt. An empty one would send the note to the cloud with regex scrubbing alone.",
    );
  }
  if (!systemInstruction) {
    throw new CustomConfigError("Custom mode needs a Gemini system instruction.");
  }
  if (!instruction) {
    throw new CustomConfigError(
      "Custom mode needs a formatting instruction — it replaces the built-in note skeleton, so there is nothing to fall back to.",
    );
  }
  for (const [name, body] of [
    ["local prompt", systemPrompt],
    ["Gemini system instruction", systemInstruction],
    ["formatting instruction", instruction],
  ] as const) {
    if (body.length > MAX_CUSTOM_PROMPT_LENGTH) {
      throw new CustomConfigError(
        `The ${name} is ${body.length.toLocaleString()} characters. The cap is ${MAX_CUSTOM_PROMPT_LENGTH.toLocaleString()} — a prompt longer than the note crowds out the narrative itself.`,
      );
    }
  }

  const d = DEFAULT_CUSTOM_CONFIG;
  return {
    local: {
      systemPrompt,
      // A model id is a free-text field; keep it to something that could
      // plausibly be one rather than passing an essay to LM Studio.
      model: text(local.model).slice(0, 200),
      temperature: clamp(local.temperature, d.local.temperature, 0, 2),
      topP: clamp(local.topP, d.local.topP, 0, 1),
      maxTokens: Math.round(clamp(local.maxTokens, d.local.maxTokens, 256, 16384)),
    },
    cloud: {
      systemInstruction,
      instruction,
      temperature: clamp(cloud.temperature, d.cloud.temperature, 0, 2),
      topP: clamp(cloud.topP, d.cloud.topP, 0, 1),
      topK: Math.round(clamp(cloud.topK, d.cloud.topK, 0, 200)),
      maxOutputTokens: Math.round(clamp(cloud.maxOutputTokens, d.cloud.maxOutputTokens, 0, 65536)),
    },
  };
}

/** The system instruction Gemini actually receives in custom mode. */
export function withPlaceholderKernel(systemInstruction: string): string {
  return `${systemInstruction.trim()}\n\n${PLACEHOLDER_KERNEL}`;
}
