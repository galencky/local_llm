import "server-only";
import { assemblePrompt, systemInstruction, type NoteFormat, type NoteInstructions, type FormatNoteResult } from "./gemini";

import { lmStudioBaseUrl, lmStudioFormatTimeoutMs, readChatDeltas } from "./lmstudio";
import { resolveLocalModel } from "./scrubber-llm";
import type { Sampling } from "./workspace";

/**
 * The local formatting destination — the same note, written on this Mac.
 *
 * The workspace decides *what* the model is asked. This decides *who* answers:
 * the Gemini ladder, or the model already loaded in LM Studio. Picking local
 * means the request makes no outbound call at all — no Google, no quota, and
 * nothing to explain to a hospital about a third-party processor.
 *
 * WHAT DOES NOT CHANGE:
 *
 *  - The note is still assembled by `assemblePrompt`, so the format skeleton
 *    and the saved routine compose exactly as they do for the cloud, in the
 *    same precedence.
 *  - The system instruction is the same one Gemini gets, so the clinical rules
 *    that stop a model inventing findings apply here too.
 *
 * WHAT DOES CHANGE, and it is the whole point: NOTHING IS DE-IDENTIFIED and
 * nothing is written down. `workspace.ts` holds the rule — de-identification
 * happens if and only if a run is bound for Google — and it reads off the
 * destination alone. A local run has no cloud boundary to protect and no
 * de-identified copy of itself to store, so the passes do not run and no audit
 * row is written. The consequence is worth saying out loud: local runs do not
 * appear in History.
 *
 * WHAT IT COSTS. The formatting model is whatever is loaded locally, so the
 * draft is generally weaker than a flagship Flash model. That is a legitimate
 * trade for a ward with no egress, an exhausted quota, or a note somebody would
 * simply rather not send.
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
 * Run a bare system instruction and prompt against the local model.
 *
 * No note assembly, no format skeleton, no placeholder kernel — this is the
 * raw console. Only a local run reaches here, and a local run is never
 * de-identified, so the text is whatever the clinician typed. That is the point
 * of the local destination, and the placeholder kernel would be describing a
 * substitution that never happened.
 */
export async function runPromptLocally(opts: {
  systemInstruction: string;
  prompt: string;
  sampling: Sampling;
  onToken?: (chunk: string) => void;
}): Promise<FormatNoteResult> {
  return callLocalChat({
    system: opts.systemInstruction.trim() || undefined,
    user: opts.prompt,
    ...localSampling(opts.sampling),
    onToken: opts.onToken,
  });
}

/**
 * Sampling in LM Studio's names. Anything at its "off" value is omitted rather
 * than sent, so the model's own default applies instead of a value that only
 * looks deliberate.
 */
function localSampling(s: Sampling) {
  return {
    temperature: s.temperature,
    topP: s.topP < 1 ? s.topP : undefined,
    topK: s.topK > 0 ? s.topK : undefined,
    maxTokens: s.maxTokens,
  };
}

/**
 * Format a fully de-identified narrative using the local model.
 *
 * Signature-compatible with `formatClinicalNote` so the route branches on the
 * destination and nothing downstream has to care which one answered.
 *
 * @param deidentifiedText the narrative as the model will see it. Named for the
 * cloud twin whose signature this matches; on this path it is the RAW note,
 * because a local run is not de-identified — nothing left the box to protect it
 * from.
 * @param format target note structure
 * @param instructions the saved routine, if one was selected
 */
export async function formatWithLocalModel(
  deidentifiedText: string,
  format: NoteFormat,
  instructions: NoteInstructions = {},
  sampling: Sampling,
  onToken?: (chunk: string) => void,
): Promise<FormatNoteResult> {
  const prompt = assemblePrompt({
    format,
    template: instructions.template,
    narrative: deidentifiedText,
    skeleton: instructions.skeleton,
  });

  return callLocalChat({
    system: systemInstruction(),
    user: prompt,
    ...localSampling(sampling),
    onToken,
  });
}

/** The one place either local path actually talks to LM Studio. */
async function callLocalChat(opts: {
  system?: string;
  user: string;
  temperature: number;
  topP?: number;
  topK?: number;
  maxTokens: number;
  /**
   * Called with each chunk as the model produces it.
   *
   * When present the request is made with `stream: true`, so the clinician
   * watches the answer being written instead of a spinner — which on a local
   * model, where a long note can take a minute, is the difference between
   * "working" and "hung".
   */
  onToken?: (chunk: string) => void;
}): Promise<FormatNoteResult> {
  const started = Date.now();
  const model = await resolveLocalModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), lmStudioFormatTimeoutMs());
  const streaming = Boolean(opts.onToken);

  try {
    const res = await fetch(`${lmStudioBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: opts.temperature,
        ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
        ...(opts.topK !== undefined ? { top_k: opts.topK } : {}),
        max_tokens: opts.maxTokens,
        ...(streaming ? { stream: true } : {}),
        messages: [
          ...(opts.system ? [{ role: "system", content: opts.system }] : []),
          { role: "user", content: opts.user },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`LM Studio responded ${res.status}: ${await res.text()}`);
    }

    let text: string;
    if (streaming && res.body) {
      text = await readChatDeltas(res.body, opts.onToken);
    } else {
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      text = body.choices?.[0]?.message?.content ?? "";
    }
    text = text.trim();
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
        ? `The local model did not answer within ${Math.round(
            lmStudioFormatTimeoutMs() / 1000,
          )}s. A long input on a large local model can exceed this — shorten it, or raise LMSTUDIO_FORMAT_TIMEOUT_MS.`
        : `The local model could not answer: ${
            err instanceof Error ? err.message.split("\n")[0] : "unknown error"
          }. Nothing was sent to the cloud — choosing the local model means it never is.`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}
