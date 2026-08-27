import "server-only";
import { assemblePrompt, systemInstruction, type NoteFormat, type NoteInstructions, type FormatNoteResult } from "./gemini";
import { withPlaceholderKernel, type CustomCloudConfig } from "./custom-mode";
import { lmStudioBaseUrl, lmStudioFormatTimeoutMs } from "./lmstudio";
import { resolveLocalModel } from "./scrubber-llm";

/**
 * The local formatting destination — the same note, written on this Mac.
 *
 * Guided and custom mode decide *what* the models are told. This decides *who*
 * writes the note: the Gemini ladder, or the model already loaded in LM Studio.
 * Picking local means the request makes no outbound call at all — no Google, no
 * quota, and nothing to explain to a hospital about a third-party processor.
 *
 * WHAT DOES NOT CHANGE, and this is the point:
 *
 *  - Both de-identification passes still run, in the same order. It would be
 *    tempting to skip them when nothing leaves the box, but the audit log's
 *    de-identification invariant is not a property of the cloud boundary — it
 *    is what makes History safe to open in front of somebody. A local run that
 *    wrote raw names into Postgres would quietly undo that.
 *  - The note is still assembled by `assemblePrompt`, so the format skeleton,
 *    the saved routine and the one-off steer compose exactly as they do for the
 *    cloud, in the same precedence.
 *  - The placeholder rules still travel with the request, so re-hydration works
 *    identically and the same `unresolvedTokens` check applies.
 *
 * WHAT IT COSTS. The formatting model is whatever is loaded locally, so the
 * draft is generally weaker than a flagship Flash model, and the run holds the
 * single compute slot for two local inferences instead of one. That is a
 * legitimate trade for a ward with no egress, an exhausted quota, or a note
 * somebody would simply rather not send.
 *
 * It NEVER falls back to the cloud. Choosing local is a statement about where
 * the work happens; quietly escalating to Google on a local failure would break
 * exactly the promise the option exists to make.
 */

/** Thrown when the local model cannot produce a note. Never falls back. */
export class LocalFormatError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LocalFormatError";
  }
}

/**
 * Prefixed so an audit row can never be misread.
 *
 * Every cloud rung is `gemini-…`; a bare `google/gemma-4-12b` in `modelUsed`
 * would leave a reader guessing where the note was written. `local:` is the
 * answer, in the column itself.
 */
export function localModelLabel(model: string): string {
  return `local:${model}`;
}

/**
 * Format a fully de-identified narrative using the local model.
 *
 * Signature-compatible with `formatClinicalNote` so the route branches on the
 * destination and nothing downstream has to care which one answered.
 *
 * @param deidentifiedText text containing placeholders only — never raw PHI
 * @param format target note structure
 * @param instructions saved routine and/or one-off steer
 * @param custom custom mode's prompts and parameters for the formatting stage
 */
export async function formatWithLocalModel(
  deidentifiedText: string,
  format: NoteFormat,
  instructions: NoteInstructions = {},
  custom: CustomCloudConfig | null = null,
): Promise<FormatNoteResult> {
  const started = Date.now();
  const model = await resolveLocalModel();

  const prompt = assemblePrompt({
    format,
    template: instructions.template,
    adHoc: instructions.adHoc,
    narrative: deidentifiedText,
    skeleton: custom?.instruction ?? instructions.skeleton,
  });

  // Custom mode owns the system instruction here too, except for the
  // placeholder kernel — a local model is, if anything, more likely to
  // renumber [DATE_2] than a flagship is.
  const system = custom
    ? withPlaceholderKernel(custom.systemInstruction)
    : systemInstruction();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), lmStudioFormatTimeoutMs());

  try {
    const res = await fetch(`${lmStudioBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        // Custom mode's "cloud" block is really the formatting block, so it
        // applies whichever model is doing the formatting. topK and
        // maxOutputTokens carry over to their OpenAI-compatible names.
        temperature: custom ? custom.temperature : 0.2,
        ...(custom && custom.topP < 1 ? { top_p: custom.topP } : {}),
        ...(custom && custom.topK > 0 ? { top_k: custom.topK } : {}),
        // A discharge summary is long. Too low a cap truncates it mid-section,
        // which reads as the model having given up rather than as a setting.
        max_tokens:
          custom && custom.maxOutputTokens > 0 ? custom.maxOutputTokens : 8192,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`LM Studio responded ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error("LM Studio returned an empty choice.");
    }

    return {
      text,
      model: localModelLabel(model),
      // Nothing to fall back to, and deliberately so.
      fallbacks: [],
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new LocalFormatError(
      aborted
        ? `The local model did not finish writing the note within ${Math.round(
            lmStudioFormatTimeoutMs() / 1000,
          )}s. A long narrative on a large local model can exceed this — shorten the note, or raise LMSTUDIO_FORMAT_TIMEOUT_MS.`
        : `The local model could not write the note: ${
            err instanceof Error ? err.message.split("\n")[0] : "unknown error"
          }. The note was NOT sent to the cloud — choosing the local model means it never is.`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}
