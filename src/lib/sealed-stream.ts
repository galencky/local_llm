import "server-only";
import { sealResponse } from "./crypto";
import type { PipelineStage } from "./concurrency";

/**
 * Live model output, sealed on its way to the browser.
 *
 * ===================== WHY THIS IS NOT A PROGRESS EVENT =====================
 * Progress events are plaintext by design: they carry stage names, counts and
 * durations, and never content. A token stream IS content — and the entity
 * list the de-identifier writes is content of the worst kind, because it is
 * literally the identifiers it just found. So every flush is encrypted with
 * the same ephemeral AES key as the final result. The browser already holds
 * that key; Cloudflare still relays ciphertext either way.
 * ===========================================================================
 *
 * Two properties, both of which cost something to get wrong:
 *
 * **Buffered, not per token.** A GCM seal and a base64 encode per token would
 * cost more than the inference producing it. Flushes are throttled to one every
 * 120ms, with a forced flush at the end of each stage.
 *
 * **Chained, not raced.** Sealing is async, so two flushes in flight can resolve
 * in either order — which prints the second half of a sentence first. The
 * browser awaits each decryption, but that only preserves the order frames
 * ARRIVE in, so the ordering has to be established here. Awaiting the tail also
 * means a forced flush waits for everything queued behind it.
 *
 * Lifted out of the route because it is machinery with one job, and it was 50
 * lines of closure state in the middle of a clinical pipeline that had nothing
 * to do with the pipeline.
 */
export interface SealedStream {
  /**
   * Arm it with the request's ephemeral key. Until this is called every flush
   * is a no-op, which is the safe direction: nothing is emitted in the clear
   * because there was no key to seal it with.
   */
  arm(key: CryptoKey): void;
  /** A token callback bound to one stage, for handing to a model client. */
  onToken(stage: PipelineStage): (chunk: string) => void;
  /** Flush now and wait for everything queued. Call at the end of a stage. */
  flush(): Promise<void>;
}

const FLUSH_INTERVAL_MS = 120;

export function createSealedStream(
  emit: (event: string, data: unknown) => void,
): SealedStream {
  let key: CryptoKey | null = null;
  let pending = "";
  let stage: PipelineStage | null = null;
  let lastFlush = 0;
  let chain: Promise<void> = Promise.resolve();

  const send = (force: boolean): Promise<void> => {
    if (!key || !pending || !stage) return chain;
    if (!force && Date.now() - lastFlush < FLUSH_INTERVAL_MS) return chain;
    const sealWith = key;
    const chunk = pending;
    const forStage = stage;
    pending = "";
    lastFlush = Date.now();
    chain = chain.then(async () => {
      emit("stream", { stage: forStage, sealed: await sealResponse(sealWith, chunk) });
    });
    return chain;
  };

  return {
    arm(k) {
      key = k;
    },
    onToken(forStage) {
      return (chunk) => {
        stage = forStage;
        pending += chunk;
        void send(false);
      };
    },
    flush() {
      return send(true);
    },
  };
}
