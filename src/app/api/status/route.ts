import { NextResponse } from "next/server";
import { isLocked, lockHeldForMs } from "@/lib/concurrency";
import { checkLmStudioHealth } from "@/lib/scrubber-llm";
import { vaultCount, VAULT_TTL_MS } from "@/lib/memory-cache";
import { geminiModel } from "@/lib/gemini";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Health probe for the status badge: compute slot, local model, DB, cloud key. */
export async function GET() {
  const [lmStudio, database] = await Promise.all([
    checkLmStudioHealth(),
    prisma
      .$queryRaw`SELECT 1`
      .then(() => ({ online: true as const }))
      .catch((err: unknown) => ({
        online: false as const,
        error: err instanceof Error ? err.message.split("\n")[0] : "unreachable",
      })),
  ]);

  const busy = isLocked();

  return NextResponse.json(
    {
      state: busy ? "busy" : "online",
      busy,
      lockHeldForMs: lockHeldForMs(),
      lmStudio,
      database,
      gemini: {
        configured: Boolean(process.env.GEMINI_API_KEY),
        model: geminiModel(),
      },
      vaults: { active: vaultCount(), ttlMs: VAULT_TTL_MS },
      degradedScrubAllowed: process.env.ALLOW_DEGRADED_SCRUB === "true",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
