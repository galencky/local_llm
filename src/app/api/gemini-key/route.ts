import { NextRequest, NextResponse } from "next/server";
import { openRequest, sealResponse, type CryptoEnvelope } from "@/lib/crypto";
import { getServerKeys } from "@/lib/keystore";
import { verifyGeminiKey } from "@/lib/gemini";
import { GeminiKeyError, normaliseGeminiKey } from "@/lib/gemini-key";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check a clinician's own Gemini key against Google, and report what it reaches.
 *
 * ===================== WHY THIS IS A SEALED ROUTE =====================
 * The obvious implementation is `POST { apiKey }` as plain JSON. That would
 * hand the key to Cloudflare in the clear, because Cloudflare terminates TLS at
 * its edge — the exact threat this whole application is built to defeat for
 * clinical text. A credential deserves the same envelope the note gets, so this
 * takes the identical `CryptoEnvelope` the pipeline does, opens it with the
 * server's private key, and seals its answer with the same ephemeral AES key.
 * =====================================================================
 *
 * The key exists inside this handler's scope and nowhere else. It is not
 * stored, not logged, not written to the audit row, and not cached — a second
 * check re-sends it. `models.list` spends no generation quota, so checking is
 * free in every sense that matters.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Sign in required.", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  let envelope: CryptoEnvelope;
  try {
    envelope = (await req.json()) as CryptoEnvelope;
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }
  if (!envelope?.encryptedData || !envelope?.encryptedKey || !envelope?.iv) {
    return NextResponse.json(
      {
        error:
          "Send the key sealed, as an envelope. An API key must not cross the " +
          "tunnel in the clear any more than a note may.",
        code: "ENVELOPE_REQUIRED",
      },
      { status: 400 },
    );
  }

  let apiKey: string;
  let aesKey: CryptoKey;
  try {
    const { privateKey } = await getServerKeys();
    const opened = await openRequest(privateKey, envelope);
    aesKey = opened.aesKey;
    apiKey = normaliseGeminiKey(
      (JSON.parse(opened.plaintext) as { apiKey?: unknown }).apiKey,
    );
  } catch (err) {
    if (err instanceof GeminiKeyError) {
      return NextResponse.json({ error: err.message, code: "GEMINI_KEY_INVALID" }, { status: 422 });
    }
    // Deliberately not `err.message`: a decryption or parse failure here is
    // being told about a payload that contains a credential.
    return NextResponse.json(
      {
        error:
          "Could not open the sealed key. The server key may have rotated — " +
          "reload the page and try again.",
        code: "DECRYPT_FAILED",
      },
      { status: 400 },
    );
  }

  const result = await verifyGeminiKey(apiKey);

  // Sealed on the way back too. The reply names which ladder rungs this key can
  // reach, which is a fact about the clinician's Google project, not about the
  // note — but it is still theirs and not Cloudflare's.
  return NextResponse.json(await sealResponse(aesKey, JSON.stringify(result)), {
    headers: { "Cache-Control": "no-store" },
  });
}
