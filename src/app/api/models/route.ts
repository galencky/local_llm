import { NextResponse } from "next/server";
import { availability, defaultModel } from "@/lib/model-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The model ladder and what is currently spendable, for the selector bar.
 * Availability is observed, not predicted: a model is marked unavailable only
 * after Google has actually refused it.
 */
export async function GET() {
  return NextResponse.json(
    { models: availability(), default: defaultModel() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
