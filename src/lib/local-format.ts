import "server-only";
import { assemblePrompt, systemInstruction, type NoteFormat, type NoteInstructions, type FormatNoteResult } from "./gemini";

import { lmStudioBaseUrl, lmStudioFormatTimeoutMs } from "./lmstudio";
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
 * WHAT DOES NOT CHANGE, and this is the point:
 *
 *  - Both de-identification passes still run, in the same order. It would be
 *    tempting to skip them when nothing leaves the box, but the audit log's
 *    de-identification invariant is not a property of the cloud boundary — it
 *    is what makes History safe to open in front of somebody. A local run that
 *    wrote raw names into Postgres would quietly undo that.
 *  - The note is still assembled by `assemblePrompt`, so the format skeleton
 *    and the saved routine compose exactly as they do for the cloud, in the
 *    same precedence.
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
 * Run a bare system instruction and prompt against the local model.
 *
 * No note assembly, no format skeleton, no placeholder kernel — this is the
 * raw console. When the caller de-identified first (a cloud-bound prompt never
 * reaches here, but a note-mode local run does) the placeholders are already
 * in the text; when it did not, the text is whatever the user typed, and that
 * is the point of the local destination.
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
 * @param deidentifiedText text containing placeholders only — never raw PHI
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

/**
 * Read an OpenAI-style `stream: true` response, handing each delta to the
 * caller and returning the whole thing at the end.
 *
 * A chunk can be split across TCP reads, so the tail of the buffer is kept
 * until a blank line completes the frame — the same reason the browser's own
 * SSE parser in `pipeline-client.ts` buffers rather than parsing per read.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onToken: (chunk: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = (JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        }).choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onToken(delta);
        }
      } catch {
        // A malformed frame is not worth failing a whole note over; the
        // non-streaming path would not have seen it either.
      }
    }
  }
  return text;
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
      text = await readStream(res.body, opts.onToken!);
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
