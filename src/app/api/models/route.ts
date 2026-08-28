import { NextRequest, NextResponse } from "next/server";
import { availability, defaultModel } from "@/lib/model-registry";
import { instanceKeyConfigured } from "@/lib/gemini";
import { INSTANCE_QUOTA } from "@/lib/gemini-key";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The model ladder and what is currently spendable, for the selector bar.
 *
 * Availability is observed, not predicted: a model is marked unavailable only
 * after Google has actually refused it — and a refusal belongs to ONE Google
 * allowance. `?quota=` is the one-way fingerprint of the caller's own key
 * (computed in the browser, never the key itself), so a clinician on their own
 * key sees their own quota rather than someone else's exhausted afternoon.
 *
 * Authenticated for real. The middleware only proves a session cookie is
 * PRESENT, so without this any caller could read which models this instance
 * has and how much of the day's quota is already spent.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Sign in required.", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  // A fingerprint is 16 hex characters or the literal "instance". Anything else
  // is refused rather than accepted as a new scope, so a hand-rolled client
  // cannot mint itself an unlimited supply of blank cooldown namespaces.
  const asked = req.nextUrl.searchParams.get("quota")?.trim() ?? "";
  const quota = /^[0-9a-f]{16}$/.test(asked) ? asked : INSTANCE_QUOTA;

  return NextResponse.json(
    {
      models: await availability(quota),
      default: defaultModel(),
      quota,
      /**
       * False means this deployment has no Gemini key of its own, so the cloud
       * ladder is reachable only by a clinician who brings one. The selector
       * says so rather than letting every rung fail with an auth error.
       */
      instanceKey: instanceKeyConfigured(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
