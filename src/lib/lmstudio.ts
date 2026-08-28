/**
 * Shared configuration for the local inference server.
 *
 * Two different stages talk to LM Studio now — the de-identification pass in
 * `scrubber-llm.ts` and, when the clinician picks the local destination, the
 * formatting pass in `local-format.ts`. They must agree on where it lives, so
 * the address resolves in exactly one place.
 */

/** LM Studio's OpenAI-compatible base, without a trailing slash. */
export function lmStudioBaseUrl(): string {
  return (
    process.env.LMSTUDIO_BASE_URL?.replace(/\/+$/, "") ||
    "http://localhost:1234/v1"
  );
}

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Timeout for the de-identification pass, which returns a short entity list. */
export function lmStudioTimeoutMs(): number {
  return positiveEnv("LMSTUDIO_TIMEOUT_MS", 90_000);
}

/**
 * Timeout for the formatting pass, which is a different shape of work.
 *
 * The NER pass writes a JSON array; formatting writes a whole chart entry, so
 * on a 12B model it can take several times as long. Sharing the NER timeout
 * would abort perfectly healthy runs. Kept under the route's 300 s
 * `maxDuration` so the request fails with a readable message rather than the
 * platform cutting the stream.
 */
export function lmStudioFormatTimeoutMs(): number {
  return positiveEnv("LMSTUDIO_FORMAT_TIMEOUT_MS", 240_000);
}

/**
 * Read an OpenAI-style `stream: true` body, handing each delta to the caller
 * and returning the whole thing at the end.
 *
 * Both local stages stream — the de-identification pass so the clinician can
 * watch it find names, the formatting pass so a minute of inference is not
 * indistinguishable from a hang — and both had their own byte-identical copy
 * of this loop. One reader, in the module that already owns where LM Studio
 * lives.
 *
 * A frame can be split across TCP reads, so the tail of the buffer is kept
 * until a newline completes the line — the same reason the browser's own SSE
 * parser in `pipeline-client.ts` buffers rather than parsing per read. A
 * malformed frame is skipped rather than thrown: the non-streaming path would
 * not have seen it either, and it is not worth failing a note over.
 */
export async function readChatDeltas(
  body: ReadableStream<Uint8Array>,
  onToken?: (chunk: string) => void,
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
        const delta = (
          JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }
        ).choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onToken?.(delta);
        }
      } catch {
        /* a malformed frame is not worth failing the note over */
      }
    }
  }
  return text;
}
