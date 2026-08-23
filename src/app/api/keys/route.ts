import { NextResponse } from "next/server";
import { getServerKeys } from "@/lib/keystore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves the Mac Mini's RSA-OAEP-2048 public key so the browser can wrap its
 * ephemeral AES key. Public material only — safe to hand out.
 */
export async function GET() {
  try {
    const { publicKeySpki, keyId } = await getServerKeys();
    return NextResponse.json(
      {
        publicKey: publicKeySpki,
        keyId,
        algorithm: "RSA-OAEP",
        hash: "SHA-256",
        modulusLength: 2048,
        format: "spki-base64",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[keys] failed to load server keypair:", err);
    return NextResponse.json(
      { error: "Server key material unavailable." },
      { status: 500 },
    );
  }
}
