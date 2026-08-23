import "server-only";
import { GoogleGenAI } from "@google/genai";

/**
 * Cloud formatting layer.
 *
 * By the time anything reaches this module it has been through both scrubbing
 * passes: every identifier is a `[CATEGORY_N]` placeholder. Gemini receives
 * clinical structure and nothing that can name a person.
 */

export const NOTE_FORMATS = {
  SOAP: "SOAP note",
  DISCHARGE_SUMMARY: "Discharge summary",
  HOSPITAL_COURSE: "Hospital course timeline",
  ADMISSION_NOTE: "Admission note",
  PROGRESS_NOTE: "Daily progress note",
} as const;

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
  return process.env.GEMINI_MODEL || "gemini-3.6-flash";
}

export interface FormatNoteResult {
  text: string;
  model: string;
  latencyMs: number;
}

/**
 * Format a fully de-identified narrative into a structured note.
 *
 * @param deidentifiedText text containing placeholders only — never raw PHI
 * @param format target note structure
 * @param extraInstruction optional free-text steer from the clinician
 */
export async function formatClinicalNote(
  deidentifiedText: string,
  format: NoteFormat,
  extraInstruction?: string,
): Promise<FormatNoteResult> {
  const started = Date.now();
  const model = geminiModel();

  const prompt = [
    FORMAT_INSTRUCTIONS[format],
    extraInstruction?.trim()
      ? `\nAdditional instruction from the clinician: ${extraInstruction.trim()}`
      : "",
    "\n--- DE-IDENTIFIED CLINICAL NARRATIVE ---\n",
    deidentifiedText,
    "\n--- END NARRATIVE ---",
  ].join("");

  const response = await getClient().models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.2,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error(
      "Gemini returned an empty response (the request may have been blocked by a safety filter).",
    );
  }

  return { text, model, latencyMs: Date.now() - started };
}
