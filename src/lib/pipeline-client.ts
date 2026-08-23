import { openResponse, sealRequest, type CryptoEnvelope } from "./crypto";

/**
 * Client half of the streaming pipeline: seals the note, POSTs it, and reports
 * each server stage as it happens. Isomorphic — the browser UI and the
 * verification scripts drive it the same way.
 */

export type PipelineStage =
  | "decrypt"
  | "regex"
  | "ner"
  | "cloud"
  | "rehydrate"
  | "audit"
  | "seal";

export const STAGE_ORDER: PipelineStage[] = [
  "decrypt",
  "regex",
  "ner",
  "cloud",
  "rehydrate",
  "audit",
  "seal",
];

export const STAGE_TITLES: Record<PipelineStage, string> = {
  decrypt: "Open the sealed note",
  regex: "Strip IDs, MRNs, dates, phones",
  ner: "Local model finds names & places",
  cloud: "Gemini formats the note",
  rehydrate: "Put the real identifiers back",
  audit: "Log the de-identified copy",
  seal: "Seal the reply",
};

/** Where each stage runs — the UI colours by trust boundary. */
export const STAGE_LOCUS: Record<PipelineStage, "browser" | "mac" | "cloud"> = {
  decrypt: "mac",
  regex: "mac",
  ner: "mac",
  cloud: "cloud",
  rehydrate: "mac",
  audit: "mac",
  seal: "mac",
};

export interface ProgressEvent {
  stage: PipelineStage;
  status: "running" | "done" | "failed";
  ms?: number;
  detail?: string;
}

export interface BusyInfo {
  stage: PipelineStage | null;
  label: string;
  detail: string | null;
  stageElapsedMs: number;
  totalElapsedMs: number;
}

export class ComputeBusyError extends Error {
  constructor(readonly activity: BusyInfo | null) {
    super("Mac Mini compute busy. Single-user limit active.");
    this.name = "ComputeBusyError";
  }
}

export class PipelineError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "PipelineError";
  }
}

export interface RunOptions {
  text: string;
  format: string;
  instruction?: string;
  promptId?: string;
  /** Starting rung of the model ladder; the server falls back downward. */
  model?: string;
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Called with the exact bytes that are about to go on the wire, plus the
   * plaintext they replace. Lets the UI show what an intermediary sees.
   */
  onSealed?: (sealed: { envelope: CryptoEnvelope; plaintext: string }) => void;
  signal?: AbortSignal;
  baseUrl?: string;
  /** Extra request headers — used by the test harness to carry a session cookie. */
  headers?: Record<string, string>;
}

/**
 * Seal, send, and stream back the structured note.
 *
 * @throws {ComputeBusyError} when the single compute slot is taken.
 * @throws {PipelineError} for any server-reported pipeline failure.
 */
export async function runPipeline<T>(opts: RunOptions): Promise<T> {
  return attempt<T>(opts, false);
}

/**
 * @param bustKeyCache re-fetch the public key past any cache. Used for the one
 * automatic retry after the server reports it could not decrypt, which means
 * the key we sealed with was stale rather than anything being broken.
 */
async function attempt<T>(opts: RunOptions, bustKeyCache: boolean): Promise<T> {
  const base = opts.baseUrl ?? "";
  const extra = opts.headers ?? {};

  const keyUrl = bustKeyCache ? `${base}/api/keys?fresh=${Date.now()}` : `${base}/api/keys`;
  const keyRes = await fetch(keyUrl, { signal: opts.signal, headers: extra, cache: "no-store" });
  if (!keyRes.ok) throw new PipelineError(`Key endpoint returned ${keyRes.status}.`);
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  const plaintext = JSON.stringify({
    text: opts.text,
    format: opts.format,
    instruction: opts.instruction || undefined,
    promptId: opts.promptId || undefined,
    model: opts.model || undefined,
  });
  const { envelope, aesKey } = await sealRequest(publicKey, plaintext);
  opts.onSealed?.({ envelope, plaintext });

  const res = await fetch(`${base}/api/process-note`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify(envelope),
    signal: opts.signal,
  });

  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { activity?: BusyInfo };
    throw new ComputeBusyError(body.activity ?? null);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new PipelineError(body.error ?? `Request failed with status ${res.status}.`, body.code);
  }
  if (!res.body) throw new PipelineError("Server returned no stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sealed: CryptoEnvelope | null = null;
  let failure: PipelineError | null = null;

  // Minimal SSE frame parser — EventSource cannot issue a POST.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      const parsed = JSON.parse(data);
      if (event === "progress") opts.onProgress?.(parsed as ProgressEvent);
      else if (event === "result") sealed = parsed as CryptoEnvelope;
      else if (event === "error") {
        failure = new PipelineError(
          (parsed as { error: string }).error,
          (parsed as { code?: string }).code,
        );
      }
    }
  }

  if (failure) {
    // A stale public key is recoverable: fetch the current one and try again,
    // once. Telling a clinician to reload mid-note is not a fix.
    if (failure.code === "DECRYPT_FAILED" && !bustKeyCache) {
      return attempt<T>(opts, true);
    }
    throw failure;
  }
  if (!sealed) throw new PipelineError("The stream ended before the note was returned.");

  return JSON.parse(await openResponse(aesKey, sealed)) as T;
}
