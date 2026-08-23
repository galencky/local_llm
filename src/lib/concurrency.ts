/**
 * Atomic single-slot compute lock.
 *
 * The M4 / 16GB box runs one LM Studio inference at a time. Node's event loop
 * is single-threaded, so a synchronous test-and-set on a plain boolean IS
 * atomic: no `await` can interleave between the read and the write below.
 */

export interface LockHandle {
  readonly token: string;
  readonly acquiredAt: number;
}

/** A wedged request must not brick the box forever. */
const STALE_LOCK_MS = 5 * 60 * 1000;

interface LockState {
  held: LockHandle | null;
}

const globalForLock = globalThis as unknown as {
  __clinicalComputeLock: LockState | undefined;
};

const state: LockState = (globalForLock.__clinicalComputeLock ??= {
  held: null,
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
  // --- end atomic region ---
  return handle;
}

/**
 * Release the slot. Ignores stale handles so a timed-out request cannot free
 * the lock out from under whoever reclaimed it.
 */
export function releaseLock(handle: LockHandle | null): void {
  if (!handle) return;
  if (state.held?.token === handle.token) state.held = null;
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
