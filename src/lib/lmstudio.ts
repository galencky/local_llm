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
