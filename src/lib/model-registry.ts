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
/* Observed exhaustion state, per quota                                */
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
 * Availability is *observed*, never predicted: Airlock has no view of anyone's
 * Google AI Studio quota, so a model is only known to be spent once Google has
 * refused it. Persisting that lets the knowledge survive a restart instead of
 * costing a wasted request to relearn.
 *
 * EVERY ENTRY IS SCOPED TO A QUOTA. A refusal is a fact about one Google
 * allowance, not about the model — so it is keyed `<quota>::<model>`, where
 * `quota` is `instance` for this deployment's own key and a one-way fingerprint
 * for a clinician's own. Without the scope, one exhausted key greyed the
 * flagship out for everybody on the box, and the persisted row kept doing so
 * across restarts.
 */
const cooldowns: Map<string, Cooldown> = (globalForModels.__modelCooldowns ??= new Map());

function slot(quota: string, model: string): string {
  return `${quota}::${model}`;
}

async function hydrate(): Promise<void> {
  const rows = await prisma.modelCooldown.findMany({ where: { until: { gt: new Date() } } });
  for (const row of rows) {
    cooldowns.set(slot(row.quota, row.model), {
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
  quota: string,
  model: string,
  reason: UnavailableReason,
  opts: { daily?: boolean; retryAfterMs?: number } = {},
): void {
  const daily = Boolean(opts.daily);
  const until = daily ? nextPacificMidnight() : Date.now() + (opts.retryAfterMs ?? 60_000);
  cooldowns.set(slot(quota, model), { until, reason, daily });

  writeThrough(() =>
    prisma.modelCooldown.upsert({
      where: { quota_model: { quota, model } },
      update: { until: new Date(until), reason, daily },
      create: { quota, model, until: new Date(until), reason, daily },
    }),
  );
}

/** A model that just answered is demonstrably fine — for THIS quota. */
export function markAvailable(quota: string, model: string): void {
  if (!cooldowns.delete(slot(quota, model))) return;
  writeThrough(() => prisma.modelCooldown.deleteMany({ where: { quota, model } }));
}

/**
 * Persist an observation, and never let failing to persist it cost a note.
 *
 * The in-memory map above is the one that matters within a process; the table
 * only exists so a restart does not have to relearn by spending requests. So
 * this is fire-and-forget by design.
 *
 * The `try` is load-bearing and was missing. `prisma` is a lazy Proxy that
 * constructs its client on first property access, so an UNSET `DATABASE_URL`
 * throws SYNCHRONOUSLY from `prisma.modelCooldown` — before there is a promise
 * for `.catch()` to attach to, which is the failure mode `.catch()` alone never
 * covers. A Postgres that is merely *down* rejects asynchronously and was
 * always handled.
 *
 * Not reachable in a deployed configuration, because an instance with no
 * DATABASE_URL cannot authenticate anyone and so never reaches this line. It is
 * fixed because the function's contract is "never let the audit DB stall the
 * clinical path" and it did not hold that contract — and the next caller will
 * not know to check.
 */
function writeThrough(write: () => Promise<unknown>): void {
  try {
    void write().catch(() => {});
  } catch {
    /* no database reachable; the in-memory cooldown still stands */
  }
}

export function cooldownFor(quota: string, model: string): Cooldown | null {
  const key = slot(quota, model);
  const c = cooldowns.get(key);
  if (!c) return null;
  if (c.until <= Date.now()) {
    cooldowns.delete(key);
    return null;
  }
  return c;
}

export function isAvailable(quota: string, model: string): boolean {
  return cooldownFor(quota, model) === null;
}

export interface ModelAvailability extends ModelSpec {
  available: boolean;
  reason: UnavailableReason | null;
  /** Milliseconds until it can be tried again; null when available. */
  retryInMs: number | null;
  daily: boolean;
}

/**
 * A model Google says does not exist for this key is retired, not merely busy.
 * Waiting will not bring it back, so it is dropped from the ladder and from
 * the selector rather than sitting there greyed out forever.
 *
 * Retirement is per quota too, and that is not pedantry: `NOT_FOUND` is exactly
 * what Google returns for a model an *individual key* has no access to, so one
 * key's retirement must not remove a rung another key can still use.
 */
function isRetired(quota: string, model: string): boolean {
  return cooldownFor(quota, model)?.reason === "model";
}

export async function availability(quota: string): Promise<ModelAvailability[]> {
  await ensureCooldownsLoaded();
  return modelLadder()
    .filter((spec) => !isRetired(quota, spec.id))
    .map((spec) => {
      const c = cooldownFor(quota, spec.id);
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
export function chainFrom(quota: string, start?: string): string[] {
  const ladder = modelLadder()
    .map((m) => m.id)
    .filter((id) => !isRetired(quota, id));
  const from = start && ladder.includes(start) ? ladder.indexOf(start) : ladder.indexOf(defaultModel());
  return ladder.slice(Math.max(0, from));
}
