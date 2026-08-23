import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { acquireLock, releaseLock } from "@/lib/concurrency";
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
import { formatClinicalNote, isNoteFormat, type NoteFormat } from "@/lib/gemini";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The pipeline:
 *   lock -> decrypt -> regex scrub -> local NER scrub -> Gemini
 *        -> re-hydrate -> audit (de-identified only) -> encrypt -> unlock
 *
 * Raw PHI exists only inside this function's local scope and the volatile
 * TokenVault. Nothing on the PHI path is logged.
 */

interface ProcessRequestBody extends CryptoEnvelope {
  format?: string;
  instruction?: string;
}

interface DecryptedPayload {
  text: string;
  format?: string;
  instruction?: string;
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

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(req: NextRequest) {
  // 1. Single-slot compute lock. 16GB of unified memory holds one model run.
  const lock = acquireLock();
  if (!lock) {
    return NextResponse.json(
      { error: "Mac Mini compute busy. Single-user limit active." },
      { status: 429, headers: { "Retry-After": "15" } },
    );
  }

  const startedAt = Date.now();
  const sessionId = randomUUID();
  const vault = new TokenVault();

  try {
    let body: ProcessRequestBody;
    try {
      body = (await req.json()) as ProcessRequestBody;
    } catch {
      return badRequest("Request body is not valid JSON.");
    }

    if (!body?.encryptedData || !body?.encryptedKey || !body?.iv) {
      return badRequest(
        "Encrypted envelope is incomplete. Expected encryptedData, encryptedKey and iv.",
      );
    }

    // 2. Unwrap the ephemeral AES key with the local private key, then decrypt.
    const { privateKey } = await getServerKeys();
    let plaintext: string;
    let aesKey: CryptoKey;
    try {
      ({ plaintext, aesKey } = await openRequest(privateKey, body));
    } catch {
      // A stale public key in a long-lived tab is the usual cause.
      return NextResponse.json(
        {
          error:
            "Decryption failed. The server key may have rotated — reload the page to fetch the current public key.",
          code: "DECRYPT_FAILED",
        },
        { status: 400 },
      );
    }

    // The plaintext may itself be a JSON payload (text + options), or bare text.
    let noteText = plaintext;
    let format: string | undefined = body.format;
    let instruction: string | undefined = body.instruction;
    if (plaintext.trimStart().startsWith("{")) {
      try {
        const payload = JSON.parse(plaintext) as DecryptedPayload;
        if (typeof payload.text === "string") {
          noteText = payload.text;
          format = payload.format ?? format;
          instruction = payload.instruction ?? instruction;
        }
      } catch {
        // Not a payload object; treat the whole thing as the narrative.
      }
    }

    if (!noteText.trim()) {
      return badRequest("The clinical narrative is empty.");
    }
    const resolvedFormat: NoteFormat = isNoteFormat(format) ? format : "SOAP";

    // 3. Deterministic Taiwan PII scrub.
    const scrubStarted = Date.now();
    const regexResult = scrubWithRegex(noteText, vault);

    // 4. Probabilistic local NER scrub. Fails closed by default.
    const llmResult = await scrubWithLlm(regexResult.text, vault);
    const scrubMs = Date.now() - scrubStarted;
    const deidentifiedInput = llmResult.text;

    // 5. Park the mapping in RAM with a 10-minute TTL.
    storeVault(sessionId, vault);

    // 6. Cloud formatting — placeholders only cross the wire.
    const gemini = await formatClinicalNote(
      deidentifiedInput,
      resolvedFormat,
      instruction,
    );

    // 7/8. Re-hydrate the structured note back into a usable chart entry.
    const rehydrated = vault.rehydrate(gemini.text);
    const unresolvedTokens = vault.unresolvedTokens(rehydrated);

    // 9. Audit log — de-identified text ONLY. This is a hard PDPA boundary.
    const processingTimeMs = Date.now() - startedAt;
    let auditLogId: string | null = null;
    try {
      const record = await prisma.auditLog.create({
        data: {
          deidentifiedInput,
          deidentifiedOutput: gemini.text,
          modelUsed: gemini.model,
          processingTimeMs,
        },
        select: { id: true },
      });
      auditLogId = record.id;
    } catch (err) {
      // A dead audit DB must not destroy the clinician's note. Surface it in
      // the response metadata instead, with no PHI in the log line.
      console.error(
        "[process-note] audit log write failed:",
        err instanceof Error ? err.message.split("\n")[0] : "unknown error",
      );
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
    const envelope = await sealResponse(aesKey, JSON.stringify(result));
    return NextResponse.json(envelope, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof LocalScrubUnavailableError) {
      return NextResponse.json(
        { error: err.message, code: "LOCAL_SCRUB_UNAVAILABLE" },
        { status: 503 },
      );
    }
    const message =
      err instanceof Error ? err.message : "Unexpected pipeline failure.";
    console.error("[process-note] pipeline error:", message.split("\n")[0]);
    return NextResponse.json(
      { error: message, code: "PIPELINE_ERROR" },
      { status: 500 },
    );
  } finally {
    // 11. Always: wipe the mapping and free the compute slot.
    purgeVault(sessionId);
    vault.clear();
    releaseLock(lock);
  }
}
