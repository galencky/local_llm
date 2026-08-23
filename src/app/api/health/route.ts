import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness probe for the container. Deliberately public and deliberately
 * empty: every other route is behind sign-in, so /api/status returning 401
 * made the Docker healthcheck fail forever once auth was added.
 *
 * It reveals nothing — no config, no versions, no dependency state. "Is the
 * process answering?" is the whole question.
 */
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
