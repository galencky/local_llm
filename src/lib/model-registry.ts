import "server-only";
import { prisma } from "./db";

/**
 * The Gemini ladder, best first.
 *
 * Ordering is by note quality, and the tail is deliberately the lite models:
 * on the free tier they carry 500 requests/day against the flagships' 20, so
 * they are the difference between "the tool stopped working at lunchtime" and
 * "the tool kept working, in a lighter voice".
 *
 * Pro models are absent on purpose — the free tier grants them zero quota, so
 * offering them would just be a button that always fails.
 */

export interface ModelSpec {
  id: string;
  label: string;
  tier: "flagship" | "lite";
  /** Documented free-tier requests/day, shown as a hint in the selector. */
  dailyLimit: number;
}

const DEFAULT_LADDER: ModelSpec[] = [
  { id: "gemini-3.7-flash", label: "3.7 Flash", tier: "flagship", dailyLimit: 20 },
  { id: "gemini-3.6-flash", label: "3.6 Flash", tier: "flagship", dailyLimit: 20 },
  { id: "gemini-3.5-flash", label: "3.5 Flash", tier: "flagship", dailyLimit: 20 },
  { id: "gemini-3-flash-preview", label: "3 Flash", tier: "flagship", dailyLimit: 20 },
  { id: "gemini-3.5-flash-lite", label: "3.5 Flash Lite", tier: "lite", dailyLimit: 500 },
  { id: "gemini-3.1-flash-lite", label: "3.1 Flash Lite", tier: "lite", dailyLimit: 500 },
];

// The 2.5-era models are absent on purpose. Google returns NOT_FOUND for them
// on keys issued after their retirement ("no longer available to new users"),
// so listing them only spends a request rediscovering that each day.

/** `GEMINI_MODEL_LADDER` overrides the list entirely, best-first, comma separated. */
export function modelLadder(): ModelSpec[] {
  const override = process.env.GEMINI_MODEL_LADDER?.trim();
  if (!override) return DEFAULT_LADDER;
  return override
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map(
      (id) =>
        DEFAULT_LADDER.find((m) => m.id === id) ?? {
          id,
          label: id.replace(/^gemini-/, ""),
          tier: /lite/.test(id) ? ("lite" as const) : ("flagship" as const),
          dailyLimit: 0,
        },
    );
}

/** Default starting rung: the best model, unless pinned by env. */
export function defaultModel(): string {
  const pinned = process.env.GEMINI_MODEL?.trim();
  const ladder = modelLadder();
  if (pinned && ladder.some((m) => m.id === pinned)) return pinned;
  return ladder[0].id;
}

/* ------------------------------------------------------------------ */
/* Volatile exhaustion state                                           */
/* ------------------------------------------------------------------ */

export type UnavailableReason = "quota" | "overloaded" | "model";

interface Cooldown {
  until: number;
  reason: UnavailableReason;
  /** True when the daily allowance is gone, not just a per-minute burst. */
  daily: boolean;
}

const globalForModels = globalThis as unknown as {
  __modelCooldowns: Map<string, Cooldown> | undefined;
  __modelCooldownsHydrated: Promise<void> | undefined;
};

/**
 * In-memory cache over the ModelCooldown table.
 *
 * Availability is *observed*, never predicted: Airlock has no view of your
 * Google AI Studio quota, so a model is only known to be spent once Google has
 * refused it. Persisting that lets the knowledge survive a restart instead of
 * costing a wasted request to relearn.
 */
const cooldowns: Map<string, Cooldown> = (globalForModels.__modelCooldowns ??= new Map());

async function hydrate(): Promise<void> {
  const rows = await prisma.modelCooldown.findMany({ where: { until: { gt: new Date() } } });
  for (const row of rows) {
    cooldowns.set(row.model, {
      until: row.until.getTime(),
      reason: row.reason as UnavailableReason,
      daily: row.daily,
    });
  }
}

/** Load persisted cooldowns once per process. A dead DB must not block a note. */
export function ensureCooldownsLoaded(): Promise<void> {
  return (globalForModels.__modelCooldownsHydrated ??= hydrate().catch((err) => {
    console.error(
      "[models] could not load cooldowns:",
      err instanceof Error ? err.message.split("\n")[0] : "unknown error",
    );
  }));
}

/** Google's free-tier day rolls over at midnight US/Pacific. */
function nextPacificMidnight(): number {
  const now = new Date();
  const pacificNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offset = now.getTime() - pacificNow.getTime();
  const midnight = new Date(pacificNow);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() + offset;
}

export function markUnavailable(
  model: string,
  reason: UnavailableReason,
  opts: { daily?: boolean; retryAfterMs?: number } = {},
): void {
  const daily = Boolean(opts.daily);
  const until = daily ? nextPacificMidnight() : Date.now() + (opts.retryAfterMs ?? 60_000);
  cooldowns.set(model, { until, reason, daily });

  // Write through, but never let the audit DB stall the clinical path.
  void prisma.modelCooldown
    .upsert({
      where: { model },
      update: { until: new Date(until), reason, daily },
      create: { model, until: new Date(until), reason, daily },
    })
    .catch(() => {});
}

/** A model that just answered is demonstrably fine. */
export function markAvailable(model: string): void {
  if (!cooldowns.delete(model)) return;
  void prisma.modelCooldown.deleteMany({ where: { model } }).catch(() => {});
}

export function cooldownFor(model: string): Cooldown | null {
  const c = cooldowns.get(model);
  if (!c) return null;
  if (c.until <= Date.now()) {
    cooldowns.delete(model);
    return null;
  }
  return c;
}

export function isAvailable(model: string): boolean {
  return cooldownFor(model) === null;
}

export interface ModelAvailability extends ModelSpec {
  available: boolean;
  reason: UnavailableReason | null;
  /** Milliseconds until it can be tried again; null when available. */
  retryInMs: number | null;
  daily: boolean;
}

export async function availability(): Promise<ModelAvailability[]> {
  await ensureCooldownsLoaded();
  return modelLadder().map((spec) => {
    const c = cooldownFor(spec.id);
    return {
      ...spec,
      available: c === null,
      reason: c?.reason ?? null,
      retryInMs: c ? Math.max(0, c.until - Date.now()) : null,
      daily: c?.daily ?? false,
    };
  });
}

/**
 * The models to try, starting at `start` and walking down the ladder.
 * Exhausted rungs stay in the chain — they are skipped at call time, so a
 * cooldown that expires mid-request is still usable.
 */
export function chainFrom(start?: string): string[] {
  const ladder = modelLadder().map((m) => m.id);
  const from = start && ladder.includes(start) ? ladder.indexOf(start) : ladder.indexOf(defaultModel());
  return ladder.slice(Math.max(0, from));
}
