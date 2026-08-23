import { NextResponse } from "next/server";
import { currentActivity, isLocked, lockHeldForMs } from "@/lib/concurrency";
import { checkLmStudioHealth, lastKnownLmStudioHealth } from "@/lib/scrubber-llm";
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

  return NextResponse.json(
    {
      state: busy ? "busy" : "online",
      busy,
      lockHeldForMs: lockHeldForMs(),
      /** What the compute slot is doing, so queued clients can show it live. */
      activity: currentActivity(),
      lmStudio,
      database,
      gemini: {
        configured: Boolean(process.env.GEMINI_API_KEY),
        model: geminiModel(),
      },
      vaults: { active: vaultCount(), ttlMs: VAULT_TTL_MS },
      degradedScrubAllowed: process.env.ALLOW_DEGRADED_SCRUB === "true",
      devLogin: { enabled: devLoginEnabled(), allowsRemote: devLoginAllowsRemote() },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
