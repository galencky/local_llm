import { NextResponse } from "next/server";
import { currentActivity, isLocked, lockHeldForMs } from "@/lib/concurrency";
import { checkLmStudioHealth, lastKnownLmStudioHealth } from "@/lib/scrubber-llm";
import { resolveLocalFormatModel } from "@/lib/local-format";
import { vaultCount, VAULT_TTL_MS } from "@/lib/memory-cache";
import { geminiModel } from "@/lib/gemini";
import { devLoginAllowsRemote, devLoginEnabled } from "@/lib/dev-login";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Health probe for the status badge: compute slot, local model, DB, cloud key. */
export async function GET() {
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

  const busy = busyNow;

  // What a request will actually ask LM Studio for. `lmStudio.models` is what
  // is loaded; these differ whenever LMSTUDIO_MODEL pins something else, and
  // the selector must label its Local option with the one that will answer.
  const requestModel = await resolveLocalFormatModel();

  return NextResponse.json(
    {
      state: busy ? "busy" : "online",
      busy,
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
