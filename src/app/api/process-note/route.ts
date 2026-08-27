import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  acquireLock,
  currentActivity,
  releaseLock,
  setStage,
  type LockHandle,
  type PipelineStage,
} from "@/lib/concurrency";
import { openRequest, sealResponse, type CryptoEnvelope } from "@/lib/crypto";
import { getServerKeys } from "@/lib/keystore";
import { scrubWithRegex } from "@/lib/scrubber-regex";
import { LocalScrubUnavailableError, scrubWithLlm } from "@/lib/scrubber-llm";
import { purgeVault, storeVault, TokenVault, type RedactionSummaryEntry } from "@/lib/memory-cache";
import {
  formatClinicalNote,
  GeminiUnavailableError,
  isNoteFormat,
  runPromptOnCloud,
  type NoteFormat,
} from "@/lib/gemini";
import { formatWithLocalModel, LocalFormatError, runPromptLocally } from "@/lib/local-format";
import { isLocalDestination } from "@/lib/pipeline-client";
import { getTemplate } from "@/lib/prompts";
import { HARD_CHAR_LIMIT, measure } from "@/lib/limits";
import {
  audits,
  deidentifies,
  isWorkspace,
  normalisePromptRun,
  normaliseDeidSampling,
  normaliseSampling,
  patternScrubs,
  PromptRunError,
  type PromptRun,
  type Sampling,
  type Workspace,
} from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The pipeline, streamed:
 *   lock -> decrypt -> regex scrub -> local NER scrub -> format
 *        -> re-hydrate -> audit (de-identified only) -> encrypt -> unlock
 *
 * The format stage goes to Gemini, or to the model already loaded in LM Studio
 * when the clinician picks the local destination. Everything either side of it
 * is identical — in particular both scrub passes still run, because the audit
 * log's de-identification invariant is not a property of the cloud boundary.
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
}

interface DecryptedPayload {
  text: string;
  format?: string;
  promptId?: string;
  /** Rung of the model ladder to start from. Falls back downward from here. */
  model?: string;
  /** "note" (default) or "prompt" — which workspace produced this request. */
  workspace?: unknown;
  /** The custom-prompt workspace's system instruction and prompt. */
  promptRun?: unknown;
  /** Sampling for whichever model answers. Applies to both workspaces. */
  sampling?: unknown;
  /** Sampling for the de-identification pass. Only used on a cloud run. */
  deidSampling?: unknown;
  /** Whether the deterministic pattern pass should run. Cloud runs only. */
  patternScrub?: unknown;
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
    /** Where the note was written. "local" means nothing left the Mac at all. */
    destination: "cloud" | "local";
    /** Which workspace produced it. */
    workspace: "note" | "prompt";
    /** False on a local run — the one destination that is not scrubbed. */
    deidentified: boolean;
    /** Whether the deterministic pattern pass ran. */
    patternScrub: boolean;
    /** Models exhausted or unavailable before the one that served this note. */
    modelFallbacks: { model: string; reason: string }[];
    processingTimeMs: number;
    scrubMs: number;
    /** Time in the formatting stage, wherever it ran. Named before local
     *  formatting existed; kept, because it is on the wire and in History. */
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

      /**
       * Live output from the local model, SEALED like everything else.
       *
       * Progress events are plaintext by design — they carry stage names and
       * counts, never content. A token stream is content, and the entity list
       * the de-identifier writes is content of the worst kind, so each flush is
       * encrypted with the same ephemeral AES key as the final result. The
       * browser already holds that key; Cloudflare still sees only ciphertext.
       *
       * Buffered rather than emitted per token: a GCM seal and a base64 encode
       * per token would cost more than the inference.
       */
      let streamKey: CryptoKey | null = null;
      let pending = "";
      let pendingStage: PipelineStage | null = null;
      let lastFlush = 0;
      const flushStream = async (force = false) => {
        if (!streamKey || !pending || !pendingStage) return;
        if (!force && Date.now() - lastFlush < 120) return;
        const chunk = pending;
        const stage = pendingStage;
        pending = "";
        lastFlush = Date.now();
        emit("stream", { stage, sealed: await sealResponse(streamKey, chunk) });
      };
      const onToken = (stage: PipelineStage) => (chunk: string) => {
        pendingStage = stage;
        pending += chunk;
        void flushStream();
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

        streamKey = aesKey;
        let noteText = plaintext;
        let format: string | undefined = body.format;
        let promptId: string | undefined;
        let startModel: string | undefined;
        let workspace: Workspace = "note";
        let rawPromptRun: unknown;
        let rawSampling: unknown;
        let rawDeidSampling: unknown;
        // Default ON. A client that says nothing gets the safer behaviour.
        let wantsPatternScrub = true;
        if (plaintext.trimStart().startsWith("{")) {
          try {
            const payload = JSON.parse(plaintext) as DecryptedPayload;
            if (typeof payload.text === "string") {
              noteText = payload.text;
              format = payload.format ?? format;
              promptId = payload.promptId ?? undefined;
              startModel = payload.model ?? undefined;
              if (isWorkspace(payload.workspace)) workspace = payload.workspace;
              rawPromptRun = payload.promptRun ?? undefined;
              rawSampling = payload.sampling ?? undefined;
              rawDeidSampling = payload.deidSampling ?? undefined;
              if (payload.patternScrub === false) wantsPatternScrub = false;
            }
          } catch {
            /* not a payload object; treat the whole thing as the narrative */
          }
        }

        const localDestination = isLocalDestination(startModel);
        // The destination decides privacy, and nothing else does — not the
        // workspace, not the prompt. Bound for Google means de-identified;
        // staying on this Mac means there is nothing to protect it from.
        const scrubbing = deidentifies(localDestination);
        const usePatterns = patternScrubs(localDestination, wantsPatternScrub);

        // Clamped on this side of the wire, always: the editor's own bounds
        // are a courtesy to the person typing.
        const sampling: Sampling = normaliseSampling(rawSampling);
        const deidSampling: Sampling = normaliseDeidSampling(rawDeidSampling);
        // The routine a prompt run selected, recorded on the audit row by name
        // the same way a note routine is.
        let promptRoutineName: string | null = null;

        let promptRun: PromptRun | null = null;
        if (workspace === "prompt") {
          try {
            promptRun = normalisePromptRun(rawPromptRun);
          } catch (err) {
            if (err instanceof PromptRunError) {
              emit("error", { error: err.message, code: "PROMPT_INVALID" });
              return;
            }
            throw err;
          }
          if (promptId) {
            try {
              const found = await getTemplate(userId, promptId);
              if (found?.kind === "prompt") promptRoutineName = found.name;
            } catch (err) {
              console.error(
                "[process-note] prompt routine lookup failed:",
                err instanceof Error ? err.message.split("\n")[0] : "unknown error",
              );
            }
          }
          // The prompt IS the input, so it is what the budget applies to.
          noteText = promptRun.prompt;
        }

        if (!noteText.trim()) {
          emit("error", {
            error:
              workspace === "prompt"
                ? "There is no prompt to run."
                : "The clinical narrative is empty.",
            code: "EMPTY",
          });
          return;
        }

        // The local model can only reliably scan what fits its attention. Past
        // the cap it starts missing names, so refusing is the safe answer.
        const size = measure(noteText);
        if (size.overHard) {
          emit("error", {
            error: scrubbing
              ? `That input is ${size.chars.toLocaleString()} characters. The local de-identification model can only scan up to ${HARD_CHAR_LIMIT.toLocaleString()} reliably, and past that it starts missing names — split it into shorter sections.`
              : `That prompt is ${size.chars.toLocaleString()} characters. The cap is ${HARD_CHAR_LIMIT.toLocaleString()}.`,
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

        // 3-5. Both scrub passes, unless this is the one run that skips them.
        let scrubMs = 0;
        let regexHits: Record<string, number> = {};
        let llmEntityCount = 0;
        let hallucinatedSpans = 0;
        let rejectedClinicalSpans = 0;
        let degradedScrub = false;
        // What the model will actually be given.
        let deidentifiedInput = noteText;
        let promptSystem = promptRun?.systemInstruction ?? "";

        if (scrubbing) {
          const scrubStarted = Date.now();

          // The deterministic pass, unless it was switched off. When it is,
          // the local model alone is responsible for every identifier —
          // including the structured ones the rules would have caught for
          // certain.
          if (usePatterns) {
            setStage(lock, "regex", `${size.chars.toLocaleString()} characters`);
            emit("progress", { stage: "regex", status: "running" });
            // A custom-prompt run has two strings to clean and they must share
            // one set of tokens, so both go through the deterministic pass with
            // the same vault.
            // Populates the vault; the text itself is rewritten later, once,
            // by `vault.deidentify`. The NER pass must see the original.
            const regexResult = scrubWithRegex(noteText, vault);
            if (promptRun) scrubWithRegex(promptSystem, vault);
            regexHits = regexResult.hits;
            emit("progress", {
              stage: "regex",
              status: "done",
              ms: Date.now() - scrubStarted,
              detail: `${regexResult.totalReplacements} identifier${regexResult.totalReplacements === 1 ? "" : "s"}`,
            });
          }

          setStage(lock, "ner", `${size.chars.toLocaleString()} characters`);
          emit("progress", { stage: "ner", status: "running" });
          // The local model reads the two joined once — running it twice would
          // double the slowest stage in the pipeline — and the vault then
          // applies what it found to each string separately.
          // The original, joined for a prompt run so one pass covers both
          // strings. See `scrubWithLlm` on why this is not the scrubbed text.
          const nerInput = promptRun ? `${promptSystem}\n\n${noteText}` : noteText;
          const llmResult = await scrubWithLlm(nerInput, vault, onToken("ner"), deidSampling);
          await flushStream(true);
          scrubMs = Date.now() - scrubStarted;

          // One application of everything both passes found, in one place.
          deidentifiedInput = vault.deidentify(noteText);
          if (promptRun) promptSystem = vault.deidentify(promptSystem);

          llmEntityCount = llmResult.entities.length;
          hallucinatedSpans = llmResult.hallucinated;
          rejectedClinicalSpans = llmResult.rejectedClinical;
          degradedScrub = llmResult.degraded;
          emit("progress", {
            stage: "ner",
            status: "done",
            ms: llmResult.latencyMs,
            detail: `${llmEntityCount} name${llmEntityCount === 1 ? "" : "s"}/place${llmEntityCount === 1 ? "" : "s"}`,
          });

          // Park the mapping in RAM with a 10-minute TTL.
          storeVault(sessionId, vault);
        }

        // Resolve the saved specialty routine, if one was selected. Routines
        // and formats belong to the note workspace; a custom prompt is the
        // whole instruction by itself.
        let resolvedFormat: NoteFormat = isNoteFormat(format) ? format : "SOAP";
        let template: { name: string; instruction: string } | null = null;
        if (promptId && workspace === "note") {
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

        // "Others" carries no compiled-in skeleton, so the saved routine is
        // the only thing that says what the note should look like. Refuse
        // rather than send a narrative with no shape attached at all.
        if (!promptRun && resolvedFormat === "OTHER" && !template) {
          emit("error", {
            error:
              'The "Others" format has no built-in note shape — it runs on a saved routine alone. Pick a routine, or choose one of the five built-in formats.',
            code: "ROUTINE_REQUIRED",
          });
          return;
        }

        // 6. Formatting. For the cloud destination, placeholders only cross
        //    the wire; for the local one, nothing crosses it at all.
        const promptLabel = promptRun
          ? "custom prompt"
          : template
            ? `routine: ${template.name}`
            : resolvedFormat;
        const cloudLabel = localDestination ? `local · ${promptLabel}` : promptLabel;
        setStage(lock, "cloud", cloudLabel);
        emit("progress", {
          stage: "cloud",
          status: "running",
          detail: localDestination || promptRun || template ? cloudLabel : undefined,
        });
        const onFallback = (step: { model: string; reason: string }, next: string) =>
          // Surface the downgrade live rather than letting the answer quietly
          // arrive from a lighter model than the clinician expects.
          emit("progress", {
            stage: "cloud",
            status: "running",
            detail: `${step.model} ${step.reason} → ${next}`,
          });

        const formatted = promptRun
          ? localDestination
            ? await runPromptLocally({
                systemInstruction: promptSystem,
                prompt: deidentifiedInput,
                sampling,
                onToken: onToken("cloud"),
              })
            : await runPromptOnCloud({
                systemInstruction: promptSystem,
                prompt: deidentifiedInput,
                sampling,
                startModel,
                onFallback,
              })
          : localDestination
            ? await formatWithLocalModel(
                deidentifiedInput,
                resolvedFormat,
                { template },
                sampling,
                onToken("cloud"),
              )
            : await formatClinicalNote(
                deidentifiedInput,
                resolvedFormat,
                { template },
                sampling,
                onFallback,
                startModel,
              );
        await flushStream(true);
        emit("progress", {
          stage: "cloud",
          status: "done",
          ms: formatted.latencyMs,
          detail: formatted.model,
        });

        // 7/8. Put the identifiers back. Nothing to put back on a raw run.
        let rehydrated = formatted.text;
        let unresolvedTokens: string[] = [];
        if (scrubbing) {
          setStage(lock, "rehydrate");
          emit("progress", { stage: "rehydrate", status: "running" });
          rehydrated = vault.rehydrate(formatted.text);
          unresolvedTokens = vault.unresolvedTokens(rehydrated);
          emit("progress", {
            stage: "rehydrate",
            status: "done",
            detail: `${vault.size} token${vault.size === 1 ? "" : "s"} restored`,
          });
        }

        // 9. Audit log — de-identified text ONLY. This is a hard PDPA boundary,
        //    and it is why a raw local run writes no row at all: there is no
        //    de-identified copy of it to write, and storing the raw text would
        //    put the only unredacted copy of it on disk.
        const processingTimeMs = Date.now() - startedAt;
        let auditLogId: string | null = null;
        if (audits(localDestination)) {
          setStage(lock, "audit");
          emit("progress", { stage: "audit", status: "running" });
          try {
            const record = await prisma.auditLog.create({
              data: {
                deidentifiedInput,
                deidentifiedOutput: formatted.text,
                modelUsed: formatted.model,
                processingTimeMs,
                patternScrub: usePatterns,
                // Custom prompts are never persisted — they arrive sealed and
                // die with the request — so the row records that this note came
                // from prompts nobody can look up, rather than implying the
                // built-in ones produced it.
                // A custom prompt is never persisted — it arrives sealed and
                // dies with the request — so the row says the run came from a
                // prompt nobody can look up, rather than naming a routine.
                promptTemplateName: promptRun
                  ? (promptRoutineName ?? "Custom prompt — not stored")
                  : (template?.name ?? null),
                noteFormat: resolvedFormat,
                userId,
              },
              select: { id: true },
            });
            auditLogId = record.id;
            emit("progress", {
              stage: "audit",
              status: "done",
              detail: auditLogId.slice(0, 8),
            });
          } catch (err) {
            // A dead audit DB must not destroy the clinician's note.
            console.error(
              "[process-note] audit log write failed:",
              err instanceof Error ? err.message.split("\n")[0] : "unknown error",
            );
            emit("progress", {
              stage: "audit",
              status: "failed",
              detail: "write failed",
            });
          }
        }

        const result: ProcessNoteResult = {
          note: rehydrated,
          deidentifiedInput,
          deidentifiedOutput: formatted.text,
          redactions: vault.summary(),
          meta: {
            auditLogId,
            model: formatted.model,
            format: resolvedFormat,
            promptTemplateName: template?.name ?? promptRoutineName,
            destination: localDestination ? "local" : "cloud",
            workspace,
            deidentified: scrubbing,
            patternScrub: usePatterns,
            modelFallbacks: formatted.fallbacks,
            processingTimeMs,
            scrubMs,
            geminiMs: formatted.latencyMs,
            regexHits,
            llmEntityCount,
            hallucinatedSpans,
            rejectedClinicalSpans,
            unresolvedTokens,
            degradedScrub,
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
          emit("error", {
            error: err.message,
            code: "LOCAL_SCRUB_UNAVAILABLE",
          });
        } else if (err instanceof LocalFormatError) {
          // Deliberately not retried against Gemini: the clinician chose the
          // local destination, and silently escalating to the cloud would
          // break the one promise that choice makes.
          emit("error", { error: err.message, code: "LOCAL_FORMAT_FAILED" });
        } else if (err instanceof PromptRunError) {
          emit("error", { error: err.message, code: "PROMPT_INVALID" });
        } else if (err instanceof GeminiUnavailableError) {
          emit("error", {
            error: err.message,
            code: `GEMINI_${err.kind.toUpperCase()}`,
          });
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
