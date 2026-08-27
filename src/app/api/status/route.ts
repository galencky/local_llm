import { NextResponse } from "next/server";
import { currentActivity, isLocked, lockHeldForMs } from "@/lib/concurrency";
import {
  checkLmStudioHealth,
  lastKnownLmStudioHealth,
  resolveLocalModel,
} from "@/lib/scrubber-llm";

import { vaultCount, VAULT_TTL_MS } from "@/lib/memory-cache";
import { geminiModel } from "@/lib/gemini";
import { devLoginAllowsRemote, devLoginEnabled } from "@/lib/dev-login";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Health probe for the status badge: compute slot, local model, DB, cloud key.
 *
 * Authenticated for real, not merely gated by the middleware. Middleware checks
 * that a session COOKIE exists, never that it is valid — deliberately, to keep
 * a database round-trip off every request — so any caller who sent
 * `authjs.session-token=anything` used to read this. On a tunnelled instance
 * that handed out the loaded model name, whether a Gemini key is configured,
 * and — the one that matters — that `devLogin` is enabled and accepts remote
 * connections, which is the reconnaissance step for the password bypass.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Sign in required.", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  // Do not poke LM Studio while we are the ones keeping it busy: it serialises
  // requests, so the probe would block and read as "down" during every note.
  const busyNow = isLocked();

  const [lmStudio, database] = await Promise.all([
    busyNow ? Promise.resolve(lastKnownLmStudioHealth()) : checkLmStudioHealth(),
    prisma
      .$queryRaw`SELECT 1`
      .then(() => ({ online: true as const }))
      .catch((err: unknown) => ({
        online: false as const,
        error: err instanceof Error ? err.message.split("\n")[0] : "unreachable",
      })),
  ]);

  // What a request will actually ask LM Studio for. Normally this IS the loaded
  // model — it falls back to LMSTUDIO_MODEL only when detection fails — but the
  // selector should label its Local option from one resolved value rather than
  // guessing from the model list.
  //
  // While the slot is held this must come from the cached read above and NOT
  // from `resolveLocalModel`, which re-probes once its cache passes 60s. This
  // route is polled once a second during a run, so resolving here undid the
  // whole point of `busyNow`: every poll queued another `/v1/models` behind the
  // inference the clinician is waiting for.
  const requestModel = busyNow
    ? (lmStudio.models[0] ?? process.env.LMSTUDIO_MODEL?.trim() ?? "local-model")
    : await resolveLocalModel();

  return NextResponse.json(
    {
      state: busyNow ? "busy" : "online",
      busy: busyNow,
      lockHeldForMs: lockHeldForMs(),
      /** What the compute slot is doing, so queued clients can show it live. */
      activity: currentActivity(),
      lmStudio: { ...lmStudio, requestModel },
      database,
      gemini: {
        configured: Boolean(process.env.GEMINI_API_KEY),
        model: geminiModel(),
      },
      vaults: { active: vaultCount(), ttlMs: VAULT_TTL_MS },
      degradedScrubAllowed: process.env.ALLOW_DEGRADED_SCRUB === "true",
      /** Lets an open tab notice its own JS is from a previous build. */
      buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? "dev",
      devLogin: { enabled: devLoginEnabled(), allowsRemote: devLoginAllowsRemote() },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
