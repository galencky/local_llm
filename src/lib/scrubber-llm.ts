import type { PiiCategory, TokenVault } from "./memory-cache";
import { lmStudioBaseUrl, lmStudioTimeoutMs } from "./lmstudio";

/**
 * Pass 3B — probabilistic NER via LM Studio on localhost.
 *
 * Catches the identifiers regex cannot: patient and relative names, attending
 * physicians, ward/bed designations, employers, and place names. It is also
 * asked for the structured categories the regex pass already covers, so that
 * a format the rules do not know still has a second chance to be caught.
 * Runs entirely on the Mac Mini — the raw narrative never leaves the box.
 */

/**
 * Coerce whatever the model called a category into a token-safe label.
 *
 * The categories this pass asks for live in NER_SYSTEM_PROMPT below, which is
 * their single source of truth — and that list is a suggestion, not a
 * whitelist. A model that meets a passport number and reports `PASSPORT` is
 * doing the right thing, and the old behaviour — silently dropping any
 * category outside a fixed enum — turned that correct detection into a leak.
 *
 * Naming the structured categories in the prompt is what moved the numbers.
 * Measured on gemma-4-12b over a 17-identifier synthetic note, temperature 0:
 * LLM-only recall went 9/17 -> 17/17, and the full regex+NER pipeline
 * 15/17 -> 17/17, with no clinical term wrongly redacted in either arm.
 *
 * What is NOT negotiable is the shape. `TokenVault.assign` builds
 * `[${category}_${n}]`, `rehydrate` matches those literally, and the
 * placeholder guard below tests `/^\[[A-Z_]+_\d+\]$/`. So anything outside
 * `[A-Z_]` is folded away here, and the result is length-capped, before a
 * label can reach the vault. This is the deterministic half of the pipeline:
 * the model chooses the name, the code guarantees the round-trip.
 */
function normaliseCategory(raw: string): PiiCategory {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned ? cleaned.slice(0, 24) : "OTHER_ID";
}

/** Thrown when the local NER pass cannot run. Fail-closed by default. */
export class LocalScrubUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LocalScrubUnavailableError";
  }
}

export const NER_SYSTEM_PROMPT = `You are a strict named-entity recogniser for a hospital de-identification pipeline in Taiwan. You operate on Traditional Chinese and English clinical narratives.

Your ONLY job is to list spans of text that identify a real person, place, institution, or record. You never summarise, translate, diagnose, or comment.

Extract these categories:
- PATIENT: the patient's own name, nickname, or name-bearing form of address.
- RELATIVE: names of family members, caregivers, or contacts.
- DOCTOR: names of physicians, surgeons, nurses, therapists, or any named staff.
- WARD: ward, room, bed, or unit designations (e.g. 8B病房, 12-3床, A092- 36, Ward 5A).
- LOCATION: street addresses, districts, townships, or any residential geography — however long.
- ORG: named hospitals, clinics, schools, or employers.
- TAIWAN_ID: national ID or ARC numbers (one letter + 9 digits, e.g. A123456789).
- MRN: hospital medical record / chart numbers (bare 7-8 digit runs).
- PHONE: any telephone number, mobile or landline, any format.
- DATE: any calendar date in any format — Gregorian, ROC/民國, CJK 年月日, or bare month/day.
- EMAIL: any email address.
- STAFF_CODE: alphanumeric staff or physician codes as printed in EMR exports (e.g. DOC1234X).
- OTHER_ID: any other number or code that could identify a person or record.

If a span identifies someone or something but none of the categories above fit, invent your own short descriptive tag in UPPERCASE_WITH_UNDERSCORES (e.g. PASSPORT, INSURANCE_ID, VEHICLE_PLATE, BANK_ACCOUNT). Never discard an identifier just because it has no listed category.

CRITICAL RULES:
1. Copy each span EXACTLY as it appears in the source, character for character. Do not trim titles, do not normalise, do not fix typos.
2. Do NOT extract text already replaced by a bracketed placeholder such as [MRN_1] or [DATE_2]. A placeholder means some OTHER identifier was already removed; it NEVER means the text has been dealt with. Names, wards, places and codes sitting beside a placeholder must still be listed.
3. Do NOT extract clinical content: diseases, drugs, doses, procedures, anatomy, lab values, vital signs, or device names.
4. Do NOT extract generic role words used without a name.
5. Do NOT extract named medical entities such as eponymous diseases, syndromes, signs, scores, or classifications (Crohn's disease, Glasgow Coma Scale, Foley catheter). These are not people.
6. Do NOT extract clinical unit abbreviations used as a destination of care (CCU, ICU, ER, OR, NICU) — these are not ward identifiers.
7. Numbers attached to a lab value, dose, or vital sign are clinical, not identifiers. A bare 7-8 digit run with no unit IS an MRN.
8. If nothing qualifies, return an empty list.

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
          // Deliberately un-enumerated: see `normaliseCategory`.
          category: { type: "string" },
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
  entities: { text: string; category: PiiCategory }[];
  /** Spans the model returned that were not found verbatim in the source. */
  hallucinated: number;
  /** Spans refused because they name clinical content, not a person or place. */
  rejectedClinical: number;
  /** True when LM Studio was unreachable and degraded mode was permitted. */
  degraded: boolean;
  latencyMs: number;
}

const baseUrl = lmStudioBaseUrl;
const timeoutMs = lmStudioTimeoutMs;

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
  /** Resolved once per run — see `resolveLocalModel`. */
  model: string,
): Promise<Response> {
  return fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: model,
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

/**
 * The model LM Studio actually has loaded right now, or null if we cannot tell.
 */
export async function loadedLmStudioModel(): Promise<string | null> {
  const cached = globalForHealth.__lmStudioLastHealthy;
  // Fresh enough for a UI read, and free. Never probe a server that is
  // mid-inference: LM Studio serialises, so the probe would block a note.
  if (cached && Date.now() - cached.at < 60_000) return cached.models[0] ?? null;
  return (await checkLmStudioHealth()).models[0] ?? null;
}

/**
 * The local model every stage should use — detected, not configured.
 *
 * LM Studio serves one loaded model on a 16GB box, so "whatever is loaded" is
 * both the true answer and the only one that cannot go stale. `LMSTUDIO_MODEL`
 * is therefore a FALLBACK for when detection fails, not an override: a pin that
 * outranked reality meant asking for a model that was not there, and LM Studio
 * answers that by swapping models mid-request. Measured, with the pin naming a
 * model other than the loaded one: the de-identification pass went from 4.5s to
 * 20s while the box loaded the pinned model, and the interface named one model
 * while another wrote the note.
 *
 * Every caller shares this so the status badge, the model selector, the
 * de-identification pass, the formatting pass and the audit row cannot disagree
 * about which model is doing the work.
 */
export async function resolveLocalModel(): Promise<string> {
  return (
    (await loadedLmStudioModel()) ??
    process.env.LMSTUDIO_MODEL?.trim() ??
    "local-model"
  );
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
 * There is one prompt and one set of parameters, compiled in. Nothing a user
 * can type reaches this: it is the de-identification step itself, and making
 * it configurable would make the safety property configurable.
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

  // Resolve once, so the retries below cannot land on a different model than
  // the first attempt did.
  const model = await resolveLocalModel();

  let content: string;
  /** Set when the answer we ended up parsing came from a schema-constrained call. */
  let usedSchema = true;
  try {
    type ChatBody = { choices?: { message?: { content?: string } }[] };
    const read = async (r: Response): Promise<string> => {
      if (!r.ok) {
        throw new Error(`LM Studio responded ${r.status}: ${await r.text()}`);
      }
      return ((await r.json()) as ChatBody).choices?.[0]?.message?.content ?? "";
    };

    let res = await callLmStudio(input, controller.signal, true, model);
    if (res.status === 400) {
      // Older LM Studio builds / GGUFs without grammar support.
      res = await callLmStudio(input, controller.signal, false, model);
      usedSchema = false;
      content = await read(res);
    } else {
      content = await read(res);
      if (!content.trim()) {
        // A reasoning model with a json_schema attached answers HTTP 200 with
        // the entire object in `reasoning_content` and `content` empty. The
        // 400 branch above never fires, so without this the pipeline fails
        // closed on every note and the model looks broken. Retry once with no
        // schema, which puts the answer back in `content`.
        res = await callLmStudio(input, controller.signal, false, model);
        usedSchema = false;
        content = await read(res);
      }
    }
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

  let raw = Array.isArray((parsed as { entities?: unknown }).entities)
    ? ((parsed as { entities: unknown[] }).entities as RawEntity[])
    : [];

  /**
   * "Nothing here" is the one answer worth asking twice.
   *
   * Grammar-constrained decoding makes the shape certain and the content less
   * so: measured on gemma-4-12b, a short input already dense with placeholders
   * came back `{"entities": []}` under `json_schema` while the identical call
   * without it found both names. Every other answer fails safe — a wrong span
   * is discarded by the verbatim check, a wrong category is normalised — but an
   * empty list fails OPEN, and quietly.
   *
   * So an empty result from a constrained call is retried once unconstrained,
   * and whatever that finds wins. It costs a second inference only when the
   * first pass claims there is nothing to redact, which for a real ward note is
   * the rare case and the one worth paying for.
   */
  if (raw.length === 0 && usedSchema) {
    // Its own deadline: the first call's timer was cleared in the `finally`
    // above, so reusing that signal would leave this retry able to hang.
    const retryController = new AbortController();
    const retryTimer = setTimeout(() => retryController.abort(), timeoutMs());
    try {
      const retry = await callLmStudio(input, retryController.signal, false, model);
      if (retry.ok) {
        const body = (await retry.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const retried = body.choices?.[0]?.message?.content ?? "";
        if (retried.trim()) {
          const reparsed = extractJson(retried) as { entities?: unknown };
          if (Array.isArray(reparsed.entities)) raw = reparsed.entities as RawEntity[];
        }
      }
    } catch {
      // The constrained answer stands. An empty list is still a valid one, and
      // the caller has already been told nothing came back.
    } finally {
      clearTimeout(retryTimer);
    }
  }

  const accepted: { text: string; category: PiiCategory }[] = [];
  const seen = new Set<string>();
  let hallucinated = 0;
  let rejectedClinical = 0;

  for (const entity of raw) {
    const span = typeof entity?.text === "string" ? entity.text.trim() : "";
    const category =
      typeof entity?.category === "string"
        ? normaliseCategory(entity.category)
        : "OTHER_ID";

    if (!span) continue;
    // Reject anything that is not a verbatim substring: a hallucinated span
    // would otherwise create a token that never matches and never rehydrates.
    if (!input.includes(span)) {
      hallucinated += 1;
      continue;
    }
    // Never re-redact a placeholder emitted by the regex pass.
    if (/^\[[A-Z_]+_\d+\]$/.test(span)) continue;
    // Guard against a model that returns the whole paragraph as one "name".
    // A newline is the real signal for that; a bare length cap is not. At 60
    // this silently discarded correctly-identified long addresses — the model
    // did its job and the guard threw the answer away, with no counter to show
    // it had happened. 200 clears the longest realistic single-line address.
    if (span.includes("\n") || span.length > 200) continue;
    // Never let a mislabelled lab analyte or eponym be redacted out of the note.
    if (isClinicalTerm(span)) {
      rejectedClinical += 1;
      continue;
    }

    const key = `${category}::${span}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({ text: span, category });
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
