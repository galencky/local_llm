/**
 * Everything this browser remembers between runs.
 *
 * Two independent stores, both owned by `localStorage` with React subscribing
 * rather than owning — the same shape as the theme toggle, and for the same
 * three reasons: it survives a reload, it cannot hydrate-mismatch, and a second
 * tab changing a setting is seen here rather than silently overwritten.
 *
 * They are deliberately NOT in Postgres. A saved routine is PII-screened on
 * write and named on every audit row; free-form prompts and a third-party API
 * key would be neither. These travel to the Mac Mini inside the sealed
 * envelope, are used once, and are gone when the request ends.
 *
 * Lifted out of `page.tsx` because none of it is UI: it is storage semantics,
 * it is where a mistake would be silent, and it is the part worth reading on
 * its own.
 */
import type { PromptRun, Sampling, Workspace } from "./workspace";
import {
  DEID_SAMPLING_DEFAULTS,
  PROMPT_DEFAULTS,
  SAMPLING_DEFAULTS,
} from "./workspace";

/* ------------------------------------------------------------------ */
/* What a run is set to do                                             */
/* ------------------------------------------------------------------ */

const WORKSPACE_KEY = "airlock.workspace.v1";
const PROMPT_RUN_KEY = "airlock.prompt-run.v1";
const SAMPLING_KEY = "airlock.sampling.v1";
const DEID_SAMPLING_KEY = "airlock.deid-sampling.v1";
const PATTERN_SCRUB_KEY = "airlock.pattern-scrub.v1";

export interface RunSettings {
  workspace: Workspace;
  prompt: PromptRun;
  /** Applies to whichever model answers, in either workspace. */
  sampling: Sampling;
  /** Applies to the de-identification pass. Only reached on a cloud run. */
  deidSampling: Sampling;
  /** Run the deterministic pattern pass? Cloud runs only. */
  patternScrub: boolean;
}

const runListeners = new Set<() => void>();

/**
 * `useSyncExternalStore` compares snapshots by identity, so this has to be a
 * cached object rather than a fresh parse per call — otherwise every render
 * looks like a change and the component never settles.
 */
let runCache: RunSettings | null = null;

export function readRunSettings(): RunSettings {
  try {
    const raw = window.localStorage.getItem(PROMPT_RUN_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<PromptRun>) : {};
    return {
      workspace: window.localStorage.getItem(WORKSPACE_KEY) === "prompt" ? "prompt" : "note",
      // Merged field by field: a config written by an older build is missing
      // whatever was added since, and a half-applied one is worse than none.
      prompt: { ...PROMPT_DEFAULTS, ...saved },
      sampling: {
        ...SAMPLING_DEFAULTS,
        ...(JSON.parse(window.localStorage.getItem(SAMPLING_KEY) ?? "{}") as Partial<Sampling>),
      },
      deidSampling: {
        ...DEID_SAMPLING_DEFAULTS,
        ...(JSON.parse(window.localStorage.getItem(DEID_SAMPLING_KEY) ?? "{}") as Partial<Sampling>),
      },
      // Only an explicit "off" turns it off. A missing or corrupt value means
      // on, because on is the safer of the two.
      patternScrub: window.localStorage.getItem(PATTERN_SCRUB_KEY) !== "off",
    };
  } catch {
    // Private window, disabled storage, or a corrupt entry. The note
    // workspace is the right thing to fall back to — never a half-read prompt.
    return {
      workspace: "note",
      prompt: { ...PROMPT_DEFAULTS },
      sampling: { ...SAMPLING_DEFAULTS },
      deidSampling: { ...DEID_SAMPLING_DEFAULTS },
      patternScrub: true,
    };
  }
}

export function subscribeRunSettings(fn: () => void) {
  runListeners.add(fn);
  // Another tab writing the prompt fires `storage` here, never in the tab that
  // wrote it — hence the explicit notify in `writeRunSettings` too.
  const onStorage = (e: StorageEvent) => {
    if (
      e.key === PROMPT_RUN_KEY ||
      e.key === WORKSPACE_KEY ||
      e.key === SAMPLING_KEY ||
      e.key === DEID_SAMPLING_KEY ||
      e.key === PATTERN_SCRUB_KEY
    ) {
      runCache = null;
      runListeners.forEach((l) => l());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    runListeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function getRunSettings(): RunSettings {
  return (runCache ??= readRunSettings());
}

/** The server cannot know what this browser saved; Note is the honest default. */
const SERVER_RUN_SETTINGS: RunSettings = {
  workspace: "note",
  prompt: { ...PROMPT_DEFAULTS },
  sampling: { ...SAMPLING_DEFAULTS },
  deidSampling: { ...DEID_SAMPLING_DEFAULTS },
  patternScrub: true,
};

export function getServerRunSettings(): RunSettings {
  return SERVER_RUN_SETTINGS;
}

export function writeRunSettings(next: RunSettings): void {
  runCache = next;
  try {
    window.localStorage.setItem(PROMPT_RUN_KEY, JSON.stringify(next.prompt));
    window.localStorage.setItem(WORKSPACE_KEY, next.workspace);
    window.localStorage.setItem(SAMPLING_KEY, JSON.stringify(next.sampling));
    window.localStorage.setItem(DEID_SAMPLING_KEY, JSON.stringify(next.deidSampling));
    window.localStorage.setItem(PATTERN_SCRUB_KEY, next.patternScrub ? "on" : "off");
  } catch {
    // The setting still applies to this session; it just will not survive.
  }
  runListeners.forEach((fn) => fn());
}

/* ------------------------------------------------------------------ */
/* The clinician's own Gemini key                                      */
/* ------------------------------------------------------------------ */

/**
 * DELIBERATELY NOT PART OF `RunSettings`.
 *
 * Everything in that object is spread into payloads, copied into drafts and
 * passed to child components. A credential in there would eventually be spread
 * somewhere it should not go, and the failure would be silent. Its own store,
 * its own storage key, its own snapshot — so there is exactly one place it can
 * enter a request, and `grep geminiApiKey` finds all of them.
 *
 * It lives in this browser and is sent, sealed, with each cloud run. The server
 * never holds it between requests. See `src/lib/gemini-key.ts` for why that is
 * the shape rather than an encrypted column in Postgres.
 */
const GEMINI_KEY_STORAGE = "airlock.gemini-key.v1";

const keyListeners = new Set<() => void>();
let keyCache: string | null = null;

export function readGeminiKey(): string {
  try {
    return window.localStorage.getItem(GEMINI_KEY_STORAGE) ?? "";
  } catch {
    // Private window or storage disabled: no key, which is a working state.
    return "";
  }
}

export function subscribeGeminiKey(fn: () => void) {
  keyListeners.add(fn);
  // Another tab adding or clearing the key fires `storage` here but never in
  // the tab that wrote it — hence the explicit notify in `writeGeminiKey`.
  const onStorage = (e: StorageEvent) => {
    if (e.key === GEMINI_KEY_STORAGE) {
      keyCache = null;
      keyListeners.forEach((l) => l());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    keyListeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function getGeminiKey(): string {
  return (keyCache ??= readGeminiKey());
}

/** The server cannot know what this browser saved, and must not guess. */
export function getServerGeminiKey(): string {
  return "";
}

export function writeGeminiKey(next: string): void {
  keyCache = next;
  try {
    if (next) window.localStorage.setItem(GEMINI_KEY_STORAGE, next);
    else window.localStorage.removeItem(GEMINI_KEY_STORAGE);
  } catch {
    // The key still applies to this session; it just will not survive a reload.
  }
  keyListeners.forEach((fn) => fn());
}
