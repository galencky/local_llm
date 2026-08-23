import type { PiiCategory, TokenVault } from "./memory-cache";

/**
 * Pass 3B — probabilistic NER via LM Studio on localhost.
 *
 * Catches the identifiers regex cannot: patient and relative names, attending
 * physicians, ward/bed designations, employers, and place names. Runs entirely
 * on the Mac Mini — the raw narrative never leaves the box for this step.
 */

const LLM_CATEGORIES = [
  "PATIENT",
  "RELATIVE",
  "DOCTOR",
  "WARD",
  "LOCATION",
  "ORG",
] as const satisfies readonly PiiCategory[];

type LlmCategory = (typeof LLM_CATEGORIES)[number];

const CATEGORY_SET = new Set<string>(LLM_CATEGORIES);

/** Thrown when the local NER pass cannot run. Fail-closed by default. */
export class LocalScrubUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LocalScrubUnavailableError";
  }
}

export const NER_SYSTEM_PROMPT = `You are a strict named-entity recogniser for a hospital de-identification pipeline in Taiwan. You operate on Traditional Chinese and English clinical narratives.

Your ONLY job is to list spans of text that identify a real person, place, or institution. You never summarise, translate, diagnose, or comment.

Extract these categories:
- PATIENT: the patient's own name, nickname, or a name-bearing form of address (e.g. 陳建明, 王小姐, Mr. Lin).
- RELATIVE: names of family members, caregivers, or contacts.
- DOCTOR: names of physicians, surgeons, nurses, therapists, or any named staff (e.g. 林醫師, Dr. Huang, 張護理師).
- WARD: ward, room, bed, or unit designations (e.g. 8B病房, 12-3床, ICU-2, Ward 5A).
- LOCATION: street addresses, districts, townships, or any residential geography.
- ORG: named hospitals, clinics, schools, or employers.

CRITICAL RULES:
1. Copy each span EXACTLY as it appears in the source, character for character. Do not trim titles, do not normalise, do not fix typos.
2. Do NOT extract text already replaced by a bracketed placeholder such as [MRN_1] or [DATE_2].
3. Do NOT extract clinical content: diseases, drugs, doses, procedures, anatomy, lab values, vital signs, or device names.
4. Do NOT extract generic role words used without a name (e.g. bare "the patient", "病人", "家屬", "主治醫師" with no surname attached).
5. Do NOT extract named medical entities such as eponymous diseases, syndromes, signs, scores, or classifications (Crohn's disease, Glasgow Coma Scale, Foley catheter). These are not people.
6. If nothing qualifies, return an empty list.

Respond with JSON only, matching: {"entities":[{"text":"<exact span>","category":"<CATEGORY>"}]}`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          category: { type: "string", enum: [...LLM_CATEGORIES] },
        },
        required: ["text", "category"],
      },
    },
  },
  required: ["entities"],
} as const;

/**
 * Defence in depth against a weak local model mislabelling clinical content as
 * a person. A 7B GGUF will occasionally return "Troponin I" as a PATIENT or
 * "Foley" as a DOCTOR; redacting those silently corrupts the note.
 *
 * Best-effort only — the system prompt is the primary control. Anything listed
 * here is refused as an entity, never redacted.
 */
const CLINICAL_STOPLIST = [
  // Lab analytes and panels
  /^(?:troponin|creatinine|bilirubin|albumin|h(?:a)?emoglobin|platelet|lactate|procalcitonin|ferritin|glucose|potassium|sodium|calcium|magnesium|phosphate|urea|ammonia)\b/i,
  /^(?:hb|hct|wbc|rbc|plt|bun|cr|alt|ast|alp|ggt|ldh|crp|esr|inr|aptt|pt|bnp|hba1c|tsh|ck-?mb|egfr|pco2|po2|hco3)\b/i,
  // Eponymous diseases, signs, scales, devices, organisms
  /^(?:crohn|parkinson|alzheimer|graves?|hashimoto|cushing|addison|wilson|bell|murphy|glasgow|apgar|braden|ramsay|richmond|foley|swan-?ganz|hickman|port-?a-?cath|kaposi|hodgkin|wegener|beh[cç]et|kawasaki|guillain|barr[ée]|charcot|raynaud|sj[oö]gren|paget|barrett|mallory|weiss|klebsiella|escherichia|staphylococcus|streptococcus|pseudomonas|candida|clostridi)/i,
  // Anything self-describing as a score, scale, or nosological entity
  /\b(?:scale|score|index|criteria|classification|grade|stage|syndrome|disease|sign|test|man(?:o|oeu|eu)vre|maneuver)\b/i,
] as const;

function isClinicalTerm(span: string): boolean {
  return CLINICAL_STOPLIST.some((re) => re.test(span.trim()));
}

interface RawEntity {
  text: string;
  category: string;
}

export interface LlmScrubResult {
  text: string;
  entities: { text: string; category: LlmCategory }[];
  /** Spans the model returned that were not found verbatim in the source. */
  hallucinated: number;
  /** Spans refused because they name clinical content, not a person or place. */
  rejectedClinical: number;
  /** True when LM Studio was unreachable and degraded mode was permitted. */
  degraded: boolean;
  latencyMs: number;
}

function baseUrl(): string {
  return (
    process.env.LMSTUDIO_BASE_URL?.replace(/\/+$/, "") ||
    "http://localhost:1234/v1"
  );
}

function timeoutMs(): number {
  const parsed = Number(process.env.LMSTUDIO_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
}

/** Strip ```json fences and any prose the model wrapped around the object. */
function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? content).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("LM Studio returned no parsable JSON object.");
  }
}

async function callLmStudio(
  prompt: string,
  signal: AbortSignal,
  useSchema: boolean,
): Promise<Response> {
  return fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: process.env.LMSTUDIO_MODEL || "local-model",
      temperature: 0,
      // A long shift note can carry 60+ entities. Too low a cap truncates the
      // JSON mid-array, which fails closed and looks to the user like an
      // unexplained 503 — so the cap is generous but still bounded, to stop a
      // looping model pinning the single compute slot for minutes.
      max_tokens: 6144,
      messages: [
        { role: "system", content: NER_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      ...(useSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "phi_entities",
                strict: true,
                schema: RESPONSE_SCHEMA,
              },
            },
          }
        : {}),
    }),
  });
}

export interface LmStudioHealth {
  online: boolean;
  models: string[];
  /** True when the answer came from cache because the model was mid-inference. */
  busy?: boolean;
  error?: string;
}

/**
 * Last successful probe. LM Studio serialises requests, so `/v1/models` blocks
 * while the model is generating — without this, the status badge would read
 * "LM Studio down" for the duration of every note.
 */
const globalForHealth = globalThis as unknown as {
  __lmStudioLastHealthy: { models: string[]; at: number } | undefined;
};

/** What we last knew, for callers that must not probe a busy server. */
export function lastKnownLmStudioHealth(): LmStudioHealth {
  const cached = globalForHealth.__lmStudioLastHealthy;
  if (!cached) return { online: false, models: [], error: "not probed yet" };
  return { online: true, models: cached.models, busy: true };
}

/** Is the local inference server up and holding a model? */
export async function checkLmStudioHealth(): Promise<LmStudioHealth> {
  try {
    const res = await fetch(`${baseUrl()}/models`, {
      // Generous: the probe crosses Docker Desktop's network proxy when the app
      // is containerised, and may queue behind a warm-up.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { online: false, models: [], error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id));
    if (models.length > 0) {
      globalForHealth.__lmStudioLastHealthy = { models, at: Date.now() };
    }
    return { online: models.length > 0, models };
  } catch (err) {
    // A probe that fails while we are mid-inference means "busy", not "down".
    const cached = globalForHealth.__lmStudioLastHealthy;
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
      return { online: true, models: cached.models, busy: true };
    }
    return {
      online: false,
      models: [],
      error: err instanceof Error ? err.message : "unreachable",
    };
  }
}

/**
 * Run the local NER pass over regex-scrubbed text and replace what it finds.
 *
 * @param input text that has already been through {@link scrubWithRegex}
 * @param vault volatile token store, mutated in place
 * @throws {LocalScrubUnavailableError} when LM Studio is unreachable and
 *         `ALLOW_DEGRADED_SCRUB` is not explicitly enabled.
 */
export async function scrubWithLlm(
  input: string,
  vault: TokenVault,
): Promise<LlmScrubResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());

  let content: string;
  try {
    let res = await callLmStudio(input, controller.signal, true);
    if (res.status === 400) {
      // Older LM Studio builds / GGUFs without grammar support.
      res = await callLmStudio(input, controller.signal, false);
    }
    if (!res.ok) {
      throw new Error(`LM Studio responded ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    content = body.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) throw new Error("LM Studio returned an empty choice.");
  } catch (err) {
    const allowDegraded = process.env.ALLOW_DEGRADED_SCRUB === "true";
    if (!allowDegraded) {
      throw new LocalScrubUnavailableError(
        "Local NER de-identification is unavailable, so the note cannot be " +
          "cleared for cloud processing. Start LM Studio on " +
          `${baseUrl()} and load a model, or set ALLOW_DEGRADED_SCRUB=true ` +
          "to accept regex-only scrubbing.",
        err,
      );
    }
    return {
      text: input,
      entities: [],
      hallucinated: 0,
      rejectedClinical: 0,
      degraded: true,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch (err) {
    if (process.env.ALLOW_DEGRADED_SCRUB !== "true") {
      throw new LocalScrubUnavailableError(
        "The local model did not return usable NER output, so the note cannot " +
          "be cleared for cloud processing. This usually means the narrative " +
          "is long enough that the entity list was cut off — try splitting it " +
          "into shorter sections.",
        err,
      );
    }
    return {
      text: input,
      entities: [],
      hallucinated: 0,
      rejectedClinical: 0,
      degraded: true,
      latencyMs: Date.now() - started,
    };
  }

  const raw = Array.isArray((parsed as { entities?: unknown }).entities)
    ? ((parsed as { entities: unknown[] }).entities as RawEntity[])
    : [];

  const accepted: { text: string; category: LlmCategory }[] = [];
  const seen = new Set<string>();
  let hallucinated = 0;
  let rejectedClinical = 0;

  for (const entity of raw) {
    const span = typeof entity?.text === "string" ? entity.text.trim() : "";
    const category =
      typeof entity?.category === "string"
        ? entity.category.trim().toUpperCase()
        : "";

    if (!span || !CATEGORY_SET.has(category)) continue;
    // Reject anything that is not a verbatim substring: a hallucinated span
    // would otherwise create a token that never matches and never rehydrates.
    if (!input.includes(span)) {
      hallucinated += 1;
      continue;
    }
    // Never re-redact a placeholder emitted by the regex pass.
    if (/^\[[A-Z_]+_\d+\]$/.test(span)) continue;
    // Guard against a model that returns the whole paragraph as one "name".
    if (span.length > 60) continue;
    // Never let a mislabelled lab analyte or eponym be redacted out of the note.
    if (isClinicalTerm(span)) {
      rejectedClinical += 1;
      continue;
    }

    const key = `${category}::${span}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({ text: span, category: category as LlmCategory });
  }

  // Longest span first: replacing "林" before "林建明" would shred the latter.
  accepted.sort((a, b) => b.text.length - a.text.length);

  let text = input;
  for (const entity of accepted) {
    const token = vault.assign(entity.category, entity.text, "llm");
    text = text.split(entity.text).join(token);
  }

  return {
    text,
    entities: accepted,
    hallucinated,
    rejectedClinical,
    degraded: false,
    latencyMs: Date.now() - started,
  };
}
