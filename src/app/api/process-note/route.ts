import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  acquireLock,
  currentActivity,
  releaseLock,
  setStage,
  type LockHandle,
} from "@/lib/concurrency";
import { openRequest, sealResponse, type CryptoEnvelope } from "@/lib/crypto";
import { getServerKeys } from "@/lib/keystore";
import { scrubWithRegex } from "@/lib/scrubber-regex";
import { LocalScrubUnavailableError, scrubWithLlm } from "@/lib/scrubber-llm";
import {
  purgeVault,
  storeVault,
  TokenVault,
  type RedactionSummaryEntry,
} from "@/lib/memory-cache";
import {
  formatClinicalNote,
  GeminiUnavailableError,
  isNoteFormat,
  type NoteFormat,
} from "@/lib/gemini";
import { getTemplate } from "@/lib/prompts";
import {
  CustomConfigError,
  normaliseCustomConfig,
  type CustomConfig,
} from "@/lib/custom-mode";
import { HARD_CHAR_LIMIT, measure } from "@/lib/limits";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The pipeline, streamed:
 *   lock -> decrypt -> regex scrub -> local NER scrub -> Gemini
 *        -> re-hydrate -> audit (de-identified only) -> encrypt -> unlock
 *
 * Progress is emitted as Server-Sent Events so the clinician watches real
 * stages rather than a spinner. Only the final `result` event carries the
 * sealed payload; every progress event is deliberately free of note content.
 *
 * Raw PHI exists only inside this handler's scope and the volatile TokenVault.
 * Nothing on the PHI path is logged.
 */

interface ProcessRequestBody extends CryptoEnvelope {
  format?: string;
  instruction?: string;
}

interface DecryptedPayload {
  text: string;
  format?: string;
  instruction?: string;
  promptId?: string;
  /** Rung of the model ladder to start from. Falls back downward from here. */
  model?: string;
  /** Custom mode: the user's own prompts and parameters for both models. */
  custom?: unknown;
}

export interface ProcessNoteResult {
  note: string;
  deidentifiedInput: string;
  deidentifiedOutput: string;
  redactions: RedactionSummaryEntry[];
  meta: {
    auditLogId: string | null;
    model: string;
    format: NoteFormat;
    promptTemplateName: string | null;
    /** Which prompt set produced this note. */
    mode: "guided" | "custom";
    /** Models exhausted or unavailable before the one that served this note. */
    modelFallbacks: { model: string; reason: string }[];
    processingTimeMs: number;
    scrubMs: number;
    geminiMs: number;
    regexHits: Record<string, number>;
    llmEntityCount: number;
    hallucinatedSpans: number;
    rejectedClinicalSpans: number;
    unresolvedTokens: string[];
    degradedScrub: boolean;
  };
}

const encoder = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function fail(lock: LockHandle | null, message: string, status: number, code?: string) {
  releaseLock(lock);
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}

export async function POST(req: NextRequest) {
  // 0. Identity first: an unauthenticated caller must not even take the lock.
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json(
      { error: "Sign in required.", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  // 1. Single-slot compute lock. 16GB of unified memory holds one model run.
  const lock = acquireLock();
  if (!lock) {
    const activity = currentActivity();
    return NextResponse.json(
      {
        error: "Mac Mini compute busy. Single-user limit active.",
        code: "COMPUTE_BUSY",
        activity,
      },
      { status: 429, headers: { "Retry-After": "5" } },
    );
  }

  let body: ProcessRequestBody;
  try {
    body = (await req.json()) as ProcessRequestBody;
  } catch {
    return fail(lock, "Request body is not valid JSON.", 400);
  }

  if (!body?.encryptedData || !body?.encryptedKey || !body?.iv) {
    return fail(
      lock,
      "Encrypted envelope is incomplete. Expected encryptedData, encryptedKey and iv.",
      400,
    );
  }

  const startedAt = Date.now();
  const sessionId = randomUUID();
  const vault = new TokenVault();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => {
        try {
          controller.enqueue(sse(event, data));
        } catch {
          /* client disconnected; the finally block still cleans up */
        }
      };

      try {
        // 2. Unwrap the ephemeral AES key, then decrypt.
        setStage(lock, "decrypt");
        emit("progress", { stage: "decrypt", status: "running" });
        const t0 = Date.now();

        const { privateKey } = await getServerKeys();
        let plaintext: string;
        let aesKey: CryptoKey;
        try {
          ({ plaintext, aesKey } = await openRequest(privateKey, body));
        } catch {
          emit("error", {
            error:
              "Decryption failed. The server key may have rotated — reload the page to fetch the current public key.",
            code: "DECRYPT_FAILED",
          });
          return;
        }

        let noteText = plaintext;
        let format: string | undefined = body.format;
        let instruction: string | undefined = body.instruction;
        let promptId: string | undefined;
        let startModel: string | undefined;
        let rawCustom: unknown;
        if (plaintext.trimStart().startsWith("{")) {
          try {
            const payload = JSON.parse(plaintext) as DecryptedPayload;
            if (typeof payload.text === "string") {
              noteText = payload.text;
              format = payload.format ?? format;
              instruction = payload.instruction ?? instruction;
              promptId = payload.promptId ?? undefined;
              startModel = payload.model ?? undefined;
              rawCustom = payload.custom ?? undefined;
            }
          } catch {
            /* not a payload object; treat the whole thing as the narrative */
          }
        }

        // Re-clamp on this side of the wire. The editor's own bounds are a
        // courtesy to the person typing; these are the ones that hold, because
        // the payload is assembled in the browser.
        let custom: CustomConfig | null = null;
        if (rawCustom) {
          try {
            custom = normaliseCustomConfig(rawCustom);
          } catch (err) {
            if (err instanceof CustomConfigError) {
              emit("error", { error: err.message, code: "CUSTOM_CONFIG_INVALID" });
              return;
            }
            throw err;
          }
        }

        if (!noteText.trim()) {
          emit("error", { error: "The clinical narrative is empty.", code: "EMPTY" });
          return;
        }

        // The local model can only reliably scan what fits its attention. Past
        // the cap it starts missing names, so refusing is the safe answer.
        const size = measure(noteText);
        if (size.overHard) {
          emit("error", {
            error: `That narrative is ${size.chars.toLocaleString()} characters. The local de-identification model can only scan up to ${HARD_CHAR_LIMIT.toLocaleString()} reliably, and past that it starts missing names — split it into shorter sections.`,
            code: "TOO_LONG",
          });
          return;
        }

        emit("progress", {
          stage: "decrypt",
          status: "done",
          ms: Date.now() - t0,
          detail: `${size.chars.toLocaleString()} characters`,
        });

        // 3. Deterministic Taiwan PII scrub.
        setStage(lock, "regex", `${size.chars.toLocaleString()} characters`);
        emit("progress", { stage: "regex", status: "running" });
        const scrubStarted = Date.now();
        const regexResult = scrubWithRegex(noteText, vault);
        emit("progress", {
          stage: "regex",
          status: "done",
          ms: Date.now() - scrubStarted,
          detail: `${regexResult.totalReplacements} identifier${regexResult.totalReplacements === 1 ? "" : "s"}`,
        });

        // 4. Probabilistic local NER scrub. Fails closed by default.
        setStage(lock, "ner", `${size.chars.toLocaleString()} characters`);
        emit("progress", { stage: "ner", status: "running" });
        const llmResult = await scrubWithLlm(regexResult.text, vault, custom?.local ?? null);
        const scrubMs = Date.now() - scrubStarted;
        const deidentifiedInput = llmResult.text;
        emit("progress", {
          stage: "ner",
          status: "done",
          ms: llmResult.latencyMs,
          detail: `${llmResult.entities.length} name${llmResult.entities.length === 1 ? "" : "s"}/place${llmResult.entities.length === 1 ? "" : "s"}`,
        });

        // 5. Park the mapping in RAM with a 10-minute TTL.
        storeVault(sessionId, vault);

        // Resolve the saved specialty routine, if one was selected.
        let resolvedFormat: NoteFormat = isNoteFormat(format) ? format : "SOAP";
        let template: { name: string; instruction: string } | null = null;
        if (promptId) {
          try {
            const found = await getTemplate(userId, promptId);
            if (found) {
              template = { name: found.name, instruction: found.instruction };
              if (!isNoteFormat(format) && isNoteFormat(found.format)) {
                resolvedFormat = found.format;
              }
            }
          } catch (err) {
            console.error(
              "[process-note] prompt template lookup failed:",
              err instanceof Error ? err.message.split("\n")[0] : "unknown error",
            );
          }
        }

        // 6. Cloud formatting — placeholders only cross the wire.
        const cloudLabel = custom
          ? "custom instruction"
          : template
            ? `routine: ${template.name}`
            : resolvedFormat;
        setStage(lock, "cloud", cloudLabel);
        emit("progress", {
          stage: "cloud",
          status: "running",
          detail: custom || template ? cloudLabel : undefined,
        });
        const gemini = await formatClinicalNote(
          deidentifiedInput,
          resolvedFormat,
          { template, adHoc: instruction },
          // Surface the downgrade live rather than letting the note quietly
          // arrive from a lighter model than the clinician expects.
          (step, next) =>
            emit("progress", {
              stage: "cloud",
              status: "running",
              detail: `${step.model} ${step.reason} → ${next}`,
            }),
          startModel,
          custom?.cloud ?? null,
        );
        emit("progress", {
          stage: "cloud",
          status: "done",
          ms: gemini.latencyMs,
          detail: gemini.model,
        });

        // 7/8. Re-hydrate the structured note back into a usable chart entry.
        setStage(lock, "rehydrate");
        emit("progress", { stage: "rehydrate", status: "running" });
        const rehydrated = vault.rehydrate(gemini.text);
        const unresolvedTokens = vault.unresolvedTokens(rehydrated);
        emit("progress", {
          stage: "rehydrate",
          status: "done",
          detail: `${vault.size} token${vault.size === 1 ? "" : "s"} restored`,
        });

        // 9. Audit log — de-identified text ONLY. This is a hard PDPA boundary.
        setStage(lock, "audit");
        emit("progress", { stage: "audit", status: "running" });
        const processingTimeMs = Date.now() - startedAt;
        let auditLogId: string | null = null;
        try {
          const record = await prisma.auditLog.create({
            data: {
              deidentifiedInput,
              deidentifiedOutput: gemini.text,
              modelUsed: gemini.model,
              processingTimeMs,
              // Custom prompts are never persisted — they arrive sealed and
              // die with the request — so the row records that this note came
              // from prompts nobody can look up, rather than implying the
              // built-in ones produced it.
              promptTemplateName: custom
                ? "Custom mode — prompts not stored"
                : template?.name ?? null,
              noteFormat: resolvedFormat,
              userId,
            },
            select: { id: true },
          });
          auditLogId = record.id;
          emit("progress", { stage: "audit", status: "done", detail: auditLogId.slice(0, 8) });
        } catch (err) {
          // A dead audit DB must not destroy the clinician's note.
          console.error(
            "[process-note] audit log write failed:",
            err instanceof Error ? err.message.split("\n")[0] : "unknown error",
          );
          emit("progress", { stage: "audit", status: "failed", detail: "write failed" });
        }

        const result: ProcessNoteResult = {
          note: rehydrated,
          deidentifiedInput,
          deidentifiedOutput: gemini.text,
          redactions: vault.summary(),
          meta: {
            auditLogId,
            model: gemini.model,
            format: resolvedFormat,
            promptTemplateName: template?.name ?? null,
            mode: custom ? "custom" : "guided",
            modelFallbacks: gemini.fallbacks,
            processingTimeMs,
            scrubMs,
            geminiMs: gemini.latencyMs,
            regexHits: regexResult.hits,
            llmEntityCount: llmResult.entities.length,
            hallucinatedSpans: llmResult.hallucinated,
            rejectedClinicalSpans: llmResult.rejectedClinical,
            unresolvedTokens,
            degradedScrub: llmResult.degraded,
          },
        };

        // 10. Seal the reply with the same ephemeral AES key.
        setStage(lock, "seal");
        emit("progress", { stage: "seal", status: "running" });
        const envelope = await sealResponse(aesKey, JSON.stringify(result));
        emit("progress", { stage: "seal", status: "done" });
        emit("result", envelope);
      } catch (err) {
        if (err instanceof LocalScrubUnavailableError) {
          emit("error", { error: err.message, code: "LOCAL_SCRUB_UNAVAILABLE" });
        } else if (err instanceof GeminiUnavailableError) {
          emit("error", { error: err.message, code: `GEMINI_${err.kind.toUpperCase()}` });
        } else {
          const message = err instanceof Error ? err.message : "Unexpected pipeline failure.";
          console.error("[process-note] pipeline error:", message.split("\n")[0]);
          emit("error", { error: message, code: "PIPELINE_ERROR" });
        }
      } finally {
        // 11. Always: wipe the mapping and free the compute slot.
        purgeVault(sessionId);
        vault.clear();
        releaseLock(lock);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Cloudflare must not sit on the stream waiting for a full body.
      "X-Accel-Buffering": "no",
    },
  });
}
