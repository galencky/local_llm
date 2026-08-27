import { NextResponse } from "next/server";
import { availability, defaultModel } from "@/lib/model-registry";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The model ladder and what is currently spendable, for the selector bar.
 * Availability is observed, not predicted: a model is marked unavailable only
 * after Google has actually refused it.
 *
 * Authenticated for real. The middleware only proves a session cookie is
 * PRESENT, so without this any caller could read which models this instance
 * has and how much of the day's quota is already spent.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Sign in required.", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  return NextResponse.json(
    { models: await availability(), default: defaultModel() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
