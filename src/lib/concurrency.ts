import type { PipelineStage } from "./pipeline-client";

/**
 * Atomic single-slot compute lock, plus a live read-out of what the slot is
 * doing so other tabs can see why they are queued.
 *
 * The M4 / 16GB box runs one inference at a time. Node's event loop is
 * single-threaded, so a synchronous test-and-set on a plain boolean IS atomic:
 * no `await` can interleave between the read and the write below.
 */

/**
 * Re-exported rather than redeclared. The stage ids are the wire contract
 * between this route and every client, so there is one list, in the module both
 * halves already import. `import type` is erased at compile time, so nothing
 * server-side is pulled into the browser bundle by this.
 */
export type { PipelineStage } from "./pipeline-client";

export const STAGE_LABELS: Record<PipelineStage, string> = {
  decrypt: "Decrypting the sealed note",
  regex: "Scrubbing Taiwan identifiers",
  ner: "Local model scanning for names",
  // Destination-neutral: the detail field names who is actually writing it,
  // because this label is read by clients queued behind a run they did not
  // start and cannot see the settings of.
  cloud: "Formatting the note",
  rehydrate: "Restoring identifiers",
  audit: "Writing the audit row",
  seal: "Encrypting the reply",
};

export interface LockHandle {
  readonly token: string;
  readonly acquiredAt: number;
}

/** A wedged request must not brick the box forever. */
const STALE_LOCK_MS = 5 * 60 * 1000;

interface LockState {
  held: LockHandle | null;
  stage: PipelineStage | null;
  stageStartedAt: number;
  /** Non-identifying description, e.g. "1,240 characters". Never note content. */
  detail: string | null;
}

const globalForLock = globalThis as unknown as {
  __clinicalComputeLock: LockState | undefined;
};

const state: LockState = (globalForLock.__clinicalComputeLock ??= {
  held: null,
  stage: null,
  stageStartedAt: 0,
  detail: null,
});

let counter = 0;

/**
 * Try to take the compute slot.
 * @returns a handle, or `null` when the box is already busy.
 */
export function acquireLock(): LockHandle | null {
  // --- begin atomic region (no await, no yield) ---
  const current = state.held;
  if (current !== null) {
    if (Date.now() - current.acquiredAt < STALE_LOCK_MS) return null;
    // Previous holder died without releasing; reclaim it.
  }
  const handle: LockHandle = {
    token: `lock_${Date.now().toString(36)}_${(counter++).toString(36)}`,
    acquiredAt: Date.now(),
  };
  state.held = handle;
  state.stage = null;
  state.stageStartedAt = Date.now();
  state.detail = null;
  // --- end atomic region ---
  return handle;
}

/**
 * Publish which stage the held slot is working on.
 *
 * @param detail short, non-identifying context for the UI. NEVER note content.
 */
export function setStage(
  handle: LockHandle | null,
  stage: PipelineStage,
  detail?: string,
): void {
  if (!handle || state.held?.token !== handle.token) return;
  state.stage = stage;
  state.stageStartedAt = Date.now();
  state.detail = detail ?? null;
}

/**
 * Release the slot. Ignores stale handles so a timed-out request cannot free
 * the lock out from under whoever reclaimed it.
 */
export function releaseLock(handle: LockHandle | null): void {
  if (!handle) return;
  if (state.held?.token === handle.token) {
    state.held = null;
    state.stage = null;
    state.detail = null;
  }
}

export function isLocked(): boolean {
  const current = state.held;
  if (!current) return false;
  return Date.now() - current.acquiredAt < STALE_LOCK_MS;
}

export function lockHeldForMs(): number | null {
  const current = state.held;
  return current ? Date.now() - current.acquiredAt : null;
}

export interface Activity {
  stage: PipelineStage | null;
  label: string;
  detail: string | null;
  /** Time in the current stage. */
  stageElapsedMs: number;
  /** Time since the slot was taken. */
  totalElapsedMs: number;
}

/** What the compute slot is doing right now, for queued clients to display. */
export function currentActivity(): Activity | null {
  const current = state.held;
  if (!current || !isLocked()) return null;
  return {
    stage: state.stage,
    label: state.stage ? STAGE_LABELS[state.stage] : "Starting",
    detail: state.detail,
    stageElapsedMs: Date.now() - state.stageStartedAt,
    totalElapsedMs: Date.now() - current.acquiredAt,
  };
}
