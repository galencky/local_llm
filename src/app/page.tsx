"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertTriangle,
  BookMarked,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  Cloud,
  Copy,
  Cpu,
  Database,
  Eye,
  Clock,
  HelpCircle,
  Loader2,
  LogOut,
  RotateCcw,
  Lock,
  Monitor,
  Pencil,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Radio,
  ScrollText,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import {
  ComputeBusyError,
  runPipeline,
  STAGE_LOCUS,
  STAGE_ORDER,
  STAGE_TITLES,
  type BusyInfo,
  type PipelineStage,
  type ProgressEvent,
} from "@/lib/pipeline-client";
import { base64ToBytes, type CryptoEnvelope } from "@/lib/crypto";
import {
  blankCustomConfig,
  CLOUD_PARAMS,
  CustomConfigError,
  LOCAL_PARAMS,
  MAX_CUSTOM_PROMPT_LENGTH,
  normaliseCustomConfig,
  PLACEHOLDER_KERNEL,
  type CustomConfig,
  type NumericParam,
} from "@/lib/custom-mode";
import { HARD_CHAR_LIMIT, measure } from "@/lib/limits";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

/* ------------------------------------------------------------------ */
/* API contract                                                        */
/* ------------------------------------------------------------------ */

interface RedactionEntry {
  token: string;
  category: string;
  preview: string;
  source: "regex" | "llm";
}

interface ProcessNoteResult {
  note: string;
  deidentifiedInput: string;
  deidentifiedOutput: string;
  redactions: RedactionEntry[];
  meta: {
    auditLogId: string | null;
    model: string;
    format: string;
    promptTemplateName: string | null;
    mode: "guided" | "custom";
    modelFallbacks: { model: string; reason: string }[];
    processingTimeMs: number;
    scrubMs: number;
    geminiMs: number;
    regexHits: Record<string, number>;
    llmEntityCount: number;
    hallucinatedSpans: number;
    rejectedClinicalSpans: number;
    unresolvedTokens: string[];
    degradedScrub: boolean;
  };
}

interface StatusPayload {
  state: "online" | "busy";
  busy: boolean;
  activity: BusyInfo | null;
  lmStudio: { online: boolean; models: string[]; busy?: boolean; error?: string };
  database: { online: boolean; error?: string };
  gemini: { configured: boolean; model: string };
  vaults: { active: number; ttlMs: number };
  degradedScrubAllowed: boolean;
  devLogin: { enabled: boolean; allowsRemote: boolean };
  buildId: string;
}

interface HistoryNote {
  id: string;
  createdAt: string;
  deidentifiedInput: string;
  deidentifiedOutput: string;
  modelUsed: string;
  noteFormat: string | null;
  promptTemplateName: string | null;
  processingTimeMs: number;
}

interface SessionUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface ModelAvailability {
  id: string;
  label: string;
  tier: "flagship" | "lite";
  dailyLimit: number;
  available: boolean;
  reason: "quota" | "overloaded" | "model" | null;
  retryInMs: number | null;
  daily: boolean;
}

interface PromptTemplate {
  id: string;
  name: string;
  specialty: string | null;
  instruction: string;
  format: string | null;
  isDefault: boolean;
  /** Null owner = a shared routine anyone on this instance can manage. */
  userId: string | null;
}

const FORMATS = [
  { id: "SOAP", label: "SOAP" },
  { id: "ADMISSION_NOTE", label: "Admission" },
  { id: "PROGRESS_NOTE", label: "Progress" },
  { id: "HOSPITAL_COURSE", label: "Course timeline" },
  { id: "DISCHARGE_SUMMARY", label: "Discharge" },
] as const;

const CATEGORY_TINT: Record<string, string> = {
  TAIWAN_ID: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  MRN: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
  PHONE: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  DATE: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  PATIENT: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  RELATIVE: "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400",
  DOCTOR: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  WARD: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
  LOCATION: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  ORG: "bg-slate-500/10 text-slate-700 dark:text-slate-400",
};

/**
 * The two ways to drive the pipeline.
 *
 * Guided is the default and the one a ward should stay on: the prompts that do
 * the de-identifying and the placeholder bookkeeping are compiled in, and the
 * only thing a clinician changes is a saved routine appended beneath them.
 *
 * Custom hands both prompts and both models' sampling parameters over. It is
 * for tuning, for a different entity taxonomy, for a note shape the built-in
 * skeletons do not cover — and it is where you find out what the guided
 * defaults are actually buying you.
 */
type RunMode = "guided" | "custom";

const MODES: {
  id: RunMode;
  label: string;
  icon: typeof ShieldCheck;
  blurb: string;
}[] = [
  {
    id: "guided",
    label: "Guided",
    icon: ShieldCheck,
    blurb:
      "Built-in prompts, fixed note skeletons, tuned sampling. Your instructions go in a saved routine.",
  },
  {
    id: "custom",
    label: "Custom",
    icon: SlidersHorizontal,
    blurb:
      "You write both prompts — the local de-identifier and Gemini — and set both models' parameters.",
  },
];

/**
 * The chosen mode and the custom prompts live in localStorage, with React as a
 * subscriber rather than the owner — the same shape as the theme toggle, and
 * for the same reason: it survives a reload, it cannot hydrate-mismatch, and a
 * second tab editing the prompts is seen here rather than silently overwritten.
 *
 * They are deliberately not in Postgres. A saved routine is PII-screened on
 * write and recorded by name on every audit row; a free-form prompt store would
 * be neither. These travel to the Mac Mini inside the sealed envelope, are used
 * once, and are gone when the request ends.
 */
const CUSTOM_STORAGE_KEY = "airlock.custom-config.v1";
const CUSTOM_MODE_KEY = "airlock.run-mode.v1";

interface RunSettings {
  mode: RunMode;
  config: CustomConfig;
}

const runListeners = new Set<() => void>();

/**
 * `useSyncExternalStore` compares snapshots by identity, so this has to be a
 * cached object rather than a fresh parse per call — otherwise every render
 * looks like a change and the component never settles.
 */
let runCache: RunSettings | null = null;

function readRunSettings(): RunSettings {
  const fresh = blankCustomConfig();
  try {
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<CustomConfig>) : {};
    return {
      mode: window.localStorage.getItem(CUSTOM_MODE_KEY) === "custom" ? "custom" : "guided",
      // Merged field by field: a config written by an older build is missing
      // whatever was added since, and a half-applied one is worse than none.
      config: {
        local: { ...fresh.local, ...(saved.local ?? {}) },
        cloud: { ...fresh.cloud, ...(saved.cloud ?? {}) },
      },
    };
  } catch {
    // Private window, disabled storage, or a corrupt entry. Guided is the
    // right thing to fall back to — never a half-read custom prompt.
    return { mode: "guided", config: fresh };
  }
}

function subscribeRunSettings(fn: () => void) {
  runListeners.add(fn);
  // Another tab writing the prompts fires `storage` here, never in the tab
  // that wrote them — hence the explicit notify in `writeRunSettings` too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === CUSTOM_STORAGE_KEY || e.key === CUSTOM_MODE_KEY) {
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

function getRunSettings(): RunSettings {
  return (runCache ??= readRunSettings());
}

/** The server cannot know what this browser saved; guided is the honest default. */
const SERVER_RUN_SETTINGS: RunSettings = { mode: "guided", config: blankCustomConfig() };

function getServerRunSettings(): RunSettings {
  return SERVER_RUN_SETTINGS;
}

function writeRunSettings(next: RunSettings): void {
  runCache = next;
  try {
    window.localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(next.config));
    window.localStorage.setItem(CUSTOM_MODE_KEY, next.mode);
  } catch {
    // The setting still applies to this session; it just will not survive.
  }
  runListeners.forEach((fn) => fn());
}

/** The prompt library is optional — a dead audit DB must not break formatting. */
async function fetchTemplates(): Promise<PromptTemplate[] | null> {
  try {
    const r = await fetch("/api/prompts", { cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json()) as { templates: PromptTemplate[] };
    return d.templates;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */

export default function AirlockPage() {
  const [input, setInput] = useState("");
  const [format, setFormat] = useState<string>("SOAP");
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState<ProcessNoteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [copied, setCopied] = useState<"identified" | "deidentified" | null>(null);
  const [queued, setQueued] = useState<BusyInfo | null>(null);
  const [models, setModels] = useState<ModelAvailability[]>([]);
  const [chosenModel, setChosenModel] = useState<string>("");
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string>("");
  const [customOpen, setCustomOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* --- run mode, remembered per browser -------------------------------- */
  const { mode, config: custom } = useSyncExternalStore(
    subscribeRunSettings,
    getRunSettings,
    getServerRunSettings,
  );

  const setCustom = useCallback((config: CustomConfig) => {
    writeRunSettings({ ...getRunSettings(), config });
  }, []);

  /**
   * Entering custom mode opens the editor.
   *
   * A mode whose whole point is "you write the prompts" is a trap if switching
   * into it silently changes what the next note runs under. Both boxes arrive
   * filled with a worked example, so the first thing seen is what a custom
   * prompt looks like rather than an empty field.
   */
  const chooseMode = useCallback((next: RunMode) => {
    writeRunSettings({ ...getRunSettings(), mode: next });
    if (next === "custom") setCustomOpen(true);
  }, []);

  /* --- server public key ---------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/keys")
      .then((r) => {
        if (!r.ok) throw new Error(`key endpoint returned ${r.status}`);
        return r.json();
      })
      .then((d: { publicKey: string }) => {
        if (!cancelled) setPublicKey(d.publicKey);
      })
      .catch((e: unknown) => {
        if (!cancelled) setKeyError(e instanceof Error ? e.message : "Could not load the server key.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* --- prompt library -------------------------------------------------- */
  const applyTemplates = useCallback((list: PromptTemplate[]) => {
    setTemplates(list);
    setActiveTemplateId((current) => {
      if (current && list.some((t) => t.id === current)) return current;
      return list.find((t) => t.isDefault)?.id ?? "";
    });
  }, []);

  const loadTemplates = useCallback(async () => {
    const list = await fetchTemplates();
    if (list) applyTemplates(list);
  }, [applyTemplates]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await fetchTemplates();
      if (!cancelled && list) applyTemplates(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyTemplates]);

  /* --- who is signed in ------------------------------------------------ */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/auth/session", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as { user?: SessionUser };
        if (d?.user) setUser(d.user);
      } catch {
        /* header just shows nothing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* --- model ladder ---------------------------------------------------- */
  const loadModels = useCallback(async () => {
    try {
      const r = await fetch("/api/models", { cache: "no-store" });
      if (!r.ok) return;
      const d = (await r.json()) as { models: ModelAvailability[]; default: string };
      setModels(d.models);
      setChosenModel((current) => current || d.default);
    } catch {
      /* selector is optional; the server picks a model regardless */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/models", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const d = (await r.json()) as { models: ModelAvailability[]; default: string };
        setModels(d.models);
        setChosenModel((c) => c || d.default);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* --- health polling -------------------------------------------------- */
  const pollMs = queued ? 1000 : 5000;
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        const d = (await r.json()) as StatusPayload;
        if (cancelled) return;

        // This tab is running JS from an older build than the server is now
        // serving. Reload once rather than showing a stale interface — a
        // removed element lingering on screen is worse than a flicker.
        const mine = process.env.NEXT_PUBLIC_BUILD_ID;
        if (mine && d.buildId && d.buildId !== "dev" && d.buildId !== mine) {
          window.location.reload();
          return;
        }
        setStatus(d);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    void poll();
    // Tighten the cadence while queued: a stale "what is it doing" read-out is
    // worse than none, and the wait is exactly when the user is watching.
    const id = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  /* --- the input grows with the narrative ------------------------------ */
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const size = measure(input);
  /**
   * The same check the route runs, run early so a broken custom prompt is
   * caught while the note is still on screen — rather than after the input has
   * been cleared and the note sealed.
   */
  const customError = useMemo(() => {
    if (mode !== "custom") return null;
    try {
      normaliseCustomConfig(custom);
      return null;
    } catch (e) {
      return e instanceof CustomConfigError ? e.message : "Custom configuration is not usable.";
    }
  }, [mode, custom]);

  const ready =
    Boolean(publicKey) &&
    !submitting &&
    input.trim().length > 0 &&
    !size.overHard &&
    !customError;
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? null;

  /** Live pipeline stages for the current run. */
  const [progress, setProgress] = useState<Map<PipelineStage, ProgressEvent>>(new Map());
  const [wire, setWire] = useState<{ envelope: CryptoEnvelope; plaintext: string } | null>(null);
  const [wireOpen, setWireOpen] = useState(false);
  const queuedRef = useRef(false);

  const runOnce = useCallback(
    async (text: string): Promise<"done" | "busy"> => {
      setProgress(new Map());
      try {
        const out = await runPipeline<ProcessNoteResult>({
          text,
          format,
          instruction: instruction.trim() || undefined,
          promptId: activeTemplateId || undefined,
          model: chosenModel || undefined,
          custom: mode === "custom" ? custom : null,
          onSealed: (sealed) => {
            setWire(sealed);
            setStage("Sealed in the browser — sending");
          },
          onProgress: (ev) => {
            setProgress((prev) => {
              const next = new Map(prev);
              next.set(ev.stage, ev);
              return next;
            });
            // "modelA quota → modelB" means modelA just died; grey it now
            // rather than waiting for the run to finish.
            if (ev.stage === "cloud" && ev.detail?.includes("→")) void loadModels();
          },
        });
        setResult(out);
        void loadModels();
        return "done";
      } catch (e: unknown) {
        if (e instanceof ComputeBusyError) {
          setQueued(e.activity);
          return "busy";
        }
        throw e;
      }
    },
    [format, instruction, activeTemplateId, chosenModel, mode, custom, loadModels],
  );

  const submit = useCallback(async () => {
    if (!publicKey || !input.trim() || submitting) return;
    if (measure(input).overHard) return;

    const text = input;
    setSubmitting(true);
    setError(null);
    setResult(null);
    setCopied(null);
    setQueued(null);
    queuedRef.current = true;
    setStage("Encrypting in browser…");

    // The raw note leaves the visible workspace the moment it is sealed:
    // a chart entry sitting on screen is itself a PDPA exposure.
    setInput("");

    try {
      // The server refuses rather than queues, to protect the single slot — so
      // the queue lives here, retrying while showing what the box is busy with.
      for (let attempt = 0; queuedRef.current; attempt++) {
        const outcome = await runOnce(text);
        if (outcome === "done") break;
        await new Promise((r) => setTimeout(r, 2000));
        if (!queuedRef.current) break;
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unexpected failure.");
      void loadModels();
    } finally {
      queuedRef.current = false;
      setSubmitting(false);
      setQueued(null);
      setStage("");
    }
  }, [publicKey, input, submitting, runOnce, loadModels]);

  const cancelQueue = useCallback(() => {
    queuedRef.current = false;
    setQueued(null);
  }, []);

  /**
   * Two copies, named for what they contain.
   *
   * "Clean" was ambiguous in the worst possible direction: a clinician could
   * reasonably read it as "de-identified" and paste a note full of real names
   * somewhere it should not go.
   */
  const copyNote = useCallback(
    async (which: "identified" | "deidentified") => {
      if (!result) return;
      await navigator.clipboard.writeText(
        which === "identified" ? result.note : result.deidentifiedOutput,
      );
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    },
    [result],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  const busy = status?.busy ?? false;

  return (
    <div className="flex min-h-full flex-col">
      {/* ---------------- header ---------------- */}
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 sm:px-5">
          <div className="flex shrink-0 items-baseline gap-2">
            <ShieldCheck className="size-5 shrink-0 translate-y-0.5 text-[var(--accent)]" />
            <span className="whitespace-nowrap text-sm font-semibold tracking-[0.14em] sm:text-base sm:tracking-[0.18em]">
              PROJECT AIRLOCK
            </span>
            {/* Only the strapline is ever dropped — it is decoration. Every
                control keeps its label and wraps to another row instead. */}
            <span className="hidden whitespace-nowrap text-[11px] text-[var(--muted)] 2xl:inline">
              a local AI strips patient identity before the cloud
            </span>
          </div>

          <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto lg:ml-auto">
            <HealthPill
              icon={Cpu}
              label={busy ? "Mac Mini Busy" : status ? "Mac Mini Online" : "Offline"}
              tone={busy ? "warn" : status ? "ok" : "bad"}
              pulse={busy}
            />
            <HealthPill
              icon={Sparkles}
              label={
                status?.lmStudio.online
                  ? `LM Studio${status.lmStudio.busy ? " (working)" : ""} · ${status.lmStudio.models[0] ?? "loaded"}`
                  : "LM Studio down"
              }
              tone={status?.lmStudio.online ? "ok" : "bad"}
            />
            <HealthPill
              title="Local Postgres on this Mac — de-identified copies of past notes, which is what History reads"
              icon={Database}
              label={status?.database.online ? "Note log" : "Note log down"}
              tone={status?.database.online ? "ok" : "bad"}
            />
            <HealthPill icon={Lock} label={publicKey ? "E2EE armed" : "No key"} tone={publicKey ? "ok" : "bad"} />
            <a
              href="https://github.com/galencky/local_llm"
              target="_blank"
              rel="noopener noreferrer"
              title="Read the source on GitHub"
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)] xl:px-2.5"
            >
              <GithubMark className="size-3.5" />
              Source
            </a>
            <button
              onClick={() => setHistoryOpen(true)}
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)] xl:px-2.5"
            >
              <Clock className="size-3.5" />
              History
            </button>
            <ThemeToggle />
            <button
              onClick={() => setPromptsOpen(true)}
              title="See exactly what each model is told"
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)] xl:px-2.5"
            >
              <ScrollText className="size-3.5" />
              Prompts
            </button>
            <button
              onClick={() => setHelpOpen(true)}
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)] xl:px-2.5"
            >
              <HelpCircle className="size-3.5" />
              How it works
            </button>
            {user && (
              <button
                onClick={() => {
                  // Auth.js requires a POST with the CSRF token to sign out.
                  void (async () => {
                    const { csrfToken } = (await (await fetch("/api/auth/csrf")).json()) as {
                      csrfToken: string;
                    };
                    const form = document.createElement("form");
                    form.method = "POST";
                    form.action = "/api/auth/signout";
                    const field = document.createElement("input");
                    field.name = "csrfToken";
                    field.value = csrfToken;
                    form.appendChild(field);
                    document.body.appendChild(form);
                    form.submit();
                  })();
                }}
                title={user.email ?? undefined}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)] xl:px-2.5"
              >
                <LogOut className="size-3.5 shrink-0" />
                <span className="max-w-[8rem] truncate">
                  {(user.name ?? user.email ?? "").split(" ")[0] || "Sign out"}
                </span>
              </button>
            )}
          </div>
        </div>
      </header>

      {(keyError || status?.degradedScrubAllowed) && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-xs text-amber-700 dark:text-amber-300">
          {keyError
            ? `Encryption unavailable: ${keyError}`
            : "ALLOW_DEGRADED_SCRUB is enabled — notes may reach Gemini with regex-only de-identification."}
        </div>
      )}


      {/* ---------------- run mode ---------------- */}
      {/* Full-width and directly under the header, because it changes what
          every other control on the page means. */}
      <ModeBar
        mode={mode}
        onChoose={chooseMode}
        custom={custom}
        error={customError}
        disabled={submitting}
        onEdit={() => setCustomOpen(true)}
      />

      {/* ---------------- workspace ---------------- */}
      <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 gap-3 p-3 sm:gap-4 sm:p-5 lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]">
        {/* ---- input ---- */}
        <section className="flex min-h-[60vh] flex-col overflow-hidden panel rounded-lg border border-[var(--border)] bg-[var(--surface)] lg:min-h-0">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
              Raw narrative
            </h2>
            <WordCounter size={size} />
          </div>

          {/* Scroll container: the textarea itself grows to fit the note. */}
          <div className="flex-1 overflow-y-auto">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={submitting}
              spellCheck={false}
              rows={16}
              placeholder={
                "Paste or dictate the ward narrative here — names, IDs, dates and MRNs are stripped on this machine before anything reaches the cloud.\n\nCmd/Ctrl + Enter to run."
              }
              className="block min-h-[26vh] w-full resize-none overflow-hidden bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed outline-none placeholder:text-[var(--muted)]/60 md:min-h-[36vh] xl:min-h-[46vh]"
            />
          </div>

          {(size.overSoft || size.overHard) && (
            <div
              className={cn(
                "border-t px-4 py-2 text-[11px]",
                size.overHard
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
              )}
            >
              {size.overHard ? (
                <>
                  Too long to de-identify safely. The local model can scan about{" "}
                  {HARD_CHAR_LIMIT.toLocaleString()} characters reliably; past that it starts
                  missing names. Split this into shorter sections.
                </>
              ) : (
                <>
                  Long note ({size.chars.toLocaleString()} characters). It will still run, but a
                  4B local model scans shorter passages more reliably — check the redaction list
                  carefully before filing.
                </>
              )}
            </div>
          )}

          {/* ---- extra instruction for this note only ---- */}
          <div className="border-t border-[var(--border)] px-3 py-1.5 sm:px-4 sm:py-2">
            <label className="flex items-center gap-2">
              <Wand2 className="size-3.5 shrink-0 text-[var(--muted)]" />
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                Extra instruction · this note only
              </span>
              <input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                disabled={submitting}
                placeholder="e.g. 以中文輸出 · emphasise the renal course · keep the plan to one line per problem"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--muted)]/60 disabled:cursor-not-allowed disabled:text-[var(--muted)]"
              />
            </label>
          </div>

          {/* ---- saved specialty routine ---- */}
          <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-1.5 sm:px-4 sm:py-2">
            <BookMarked className="size-3.5 shrink-0 text-[var(--muted)]" />
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Saved routine
            </span>
            <select
              value={activeTemplateId}
              onChange={(e) => setActiveTemplateId(e.target.value)}
              disabled={submitting}
              className="min-w-0 flex-1 cursor-pointer truncate bg-transparent text-xs outline-none disabled:cursor-not-allowed disabled:text-[var(--muted)]"
            >
              <option value="">None — no saved routine</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.specialty ? `${t.specialty} — ${t.name}` : t.name}
                  {t.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => setLibraryOpen(true)}
              className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Manage
            </button>
          </div>

          <ModelBar
            models={models}
            chosen={chosenModel}
            onChoose={setChosenModel}
            disabled={submitting}
          />

          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-3 py-2 sm:px-4 sm:py-3">
            <div className="flex flex-wrap gap-1">
              {mode === "custom" && (
                <span
                  title="Your custom instruction decides the note's shape. The format is kept only as the label on the audit row and in History."
                  className="mr-1 self-center whitespace-nowrap text-[10px] uppercase tracking-wider text-[var(--muted)]"
                >
                  label only
                </span>
              )}
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  disabled={submitting}
                  className={cn(
                    "rounded border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed",
                    format === f.id
                      ? "border-[var(--accent-solid)] bg-[var(--accent-solid)] text-[var(--on-accent)]"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <button
              onClick={() => void submit()}
              disabled={!ready}
              className="ml-auto flex items-center gap-2 rounded bg-[var(--accent-solid)] px-4 py-1.5 text-sm font-medium text-[var(--on-accent)] transition-opacity disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-[var(--border)]/40 disabled:text-[var(--faint)]"
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
              {submitting ? "Processing" : "Encrypt & structure"}
            </button>
          </div>

        </section>

        {/* ---- output ---- */}
        <section className="flex min-h-[60vh] flex-col overflow-hidden panel rounded-lg border border-[var(--border)] bg-[var(--surface)] lg:min-h-0">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
              Structured note
            </h2>
            <div className="flex items-center gap-2">
              {wire && (
                <button
                  onClick={() => setWireOpen(true)}
                  title="See the exact bytes that crossed the internet"
                  className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <Radio className="size-3.5" />
                  Wire view
                </button>
              )}
              {result && (
                <button
                  onClick={() => setInspectorOpen(true)}
                  className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <Eye className="size-3.5" />
                  {result.redactions.length} redactions
                </button>
              )}
              <button
                onClick={() => void copyNote("identified")}
                disabled={!result}
                title="The finished note with the real names, MRN and dates put back. This is what goes in the chart."
                className="flex items-center gap-1.5 rounded border border-[var(--accent-solid)] bg-[var(--accent-solid)] px-2 py-1 text-[11px] text-[var(--on-accent)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--faint)]"
              >
                {copied === "identified" ? (
                  <CheckCheck className="size-3.5 shrink-0" />
                ) : (
                  <Copy className="size-3.5 shrink-0" />
                )}
                {copied === "identified" ? "Copied" : "Copy note · with names"}
              </button>
              <button
                onClick={() => void copyNote("deidentified")}
                disabled={!result}
                title="The placeholder version — [PATIENT_1], [MRN_1] and so on. This is exactly what was sent to Gemini, and carries no identifiers."
                className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)] disabled:text-[var(--faint)] disabled:hover:text-[var(--faint)]"
              >
                {copied === "deidentified" ? (
                  <CheckCheck className="size-3.5 text-[var(--accent)]" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied === "deidentified" ? "Copied" : "Copy de-identified"}
              </button>
            </div>
          </div>

          <div className="scroll-visible flex-1 overflow-auto px-4 py-3">
            {error && (
              <div className="flex gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {submitting && !error && (
              <div className="space-y-4">
                {queued ? (
                  <QueuedPanel activity={queued} live={status?.activity ?? null} onCancel={cancelQueue} />
                ) : (
                  <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                    <Loader2 className="size-4 animate-spin" />
                    {stage}
                  </div>
                )}
                <PipelineProgress progress={progress} paused={Boolean(queued)} />
              </div>
            )}

            {!submitting && !error && !result && (
              <p className="text-sm text-[var(--muted)]">
                The formatted note appears here with identifiers restored. Only placeholder text ever
                leaves this machine.
              </p>
            )}

            {result && <NoteBody markdown={result.note} />}
          </div>

          {result && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border)] px-4 py-2 font-mono text-[11px] text-[var(--muted)]">
              <span
                className={cn(result.meta.modelFallbacks.length > 0 && "text-amber-700 dark:text-amber-400")}
                title={
                  result.meta.modelFallbacks.length > 0
                    ? `Fell back from ${result.meta.modelFallbacks.map((f) => `${f.model} (${f.reason})`).join(", ")}`
                    : undefined
                }
              >
                {result.meta.model}
                {result.meta.modelFallbacks.length > 0 &&
                  ` — downgraded from ${result.meta.modelFallbacks[0].model} (${result.meta.modelFallbacks[0].reason})`}
              </span>
              {result.meta.mode === "custom" && (
                <span
                  title="Produced by your own prompts and parameters. They were not stored — the audit row records that, not the text."
                  className="text-amber-700 dark:text-amber-400"
                >
                  custom prompts
                </span>
              )}
              {result.meta.promptTemplateName && <span>routine {result.meta.promptTemplateName}</span>}
              <span>scrub {result.meta.scrubMs} ms</span>
              <span>cloud {result.meta.geminiMs} ms</span>
              <span>total {result.meta.processingTimeMs} ms</span>
              {result.meta.auditLogId ? (
                <span>audit {result.meta.auditLogId.slice(0, 8)}</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">audit write failed</span>
              )}
              {result.meta.unresolvedTokens.length > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {result.meta.unresolvedTokens.length} token(s) unresolved — verify before filing
                </span>
              )}
            </div>
          )}
        </section>
      </main>

      <footer className="flex flex-wrap items-center justify-center gap-x-1.5 border-t border-[var(--border)] px-3 py-2 text-center text-[11px] text-[var(--muted)] sm:px-5 sm:py-3">
        <span className="tracking-[0.15em]">PROJECT AIRLOCK</span> · created by{" "}
        <span className="text-[var(--foreground)]">Kuan-Yuan Chen</span> · built with{" "}
        <span className="text-[var(--foreground)]">Claude Code</span> ·{" "}
        <a
          href="https://github.com/galencky/local_llm"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
        >
          source on GitHub
        </a>
        {activeTemplate && <> · routine: {activeTemplate.name}</>}
      </footer>

      {inspectorOpen && result && (
        <Inspector result={result} onClose={() => setInspectorOpen(false)} />
      )}
      {helpOpen && <HowItWorks onClose={() => setHelpOpen(false)} />}
      {promptsOpen && <PromptsDrawer onClose={() => setPromptsOpen(false)} />}
      {customOpen && (
        <CustomModeDrawer
          config={custom}
          onChange={setCustom}
          localModels={status?.lmStudio.models ?? []}
          onClose={() => setCustomOpen(false)}
        />
      )}
      {wireOpen && wire && <WireView wire={wire} onClose={() => setWireOpen(false)} />}
      {historyOpen && (
        <HistoryDrawer onClose={() => setHistoryOpen(false)} onReuse={(text) => {
          setInput(text);
          setHistoryOpen(false);
        }} />
      )}
      {libraryOpen && (
        <PromptLibrary
          templates={templates}
          onClose={() => setLibraryOpen(false)}
          onChanged={loadTemplates}
        />
      )}
    </div>
  );
}



/* ------------------------------------------------------------------ */
/* Run mode                                                            */
/* ------------------------------------------------------------------ */

/**
 * Guided or custom, across the full width of the page.
 *
 * It sits above the workspace rather than inside a menu because it changes
 * what every control below it means: in custom mode the format buttons stop
 * choosing the note's shape, and the prompts behind the whole pipeline are the
 * ones in the drawer rather than the ones compiled in.
 */
function ModeBar({
  mode,
  onChoose,
  custom,
  error,
  disabled,
  onEdit,
}: {
  mode: RunMode;
  onChoose: (mode: RunMode) => void;
  custom: CustomConfig;
  error: string | null;
  disabled: boolean;
  onEdit: () => void;
}) {
  const active = MODES.find((m) => m.id === mode) ?? MODES[0];

  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 sm:px-5">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Mode
        </span>

        <div className="flex shrink-0 gap-1">
          {MODES.map((m) => {
            const Icon = m.icon;
            const chosen = m.id === mode;
            return (
              <button
                key={m.id}
                onClick={() => onChoose(m.id)}
                disabled={disabled}
                title={m.blurb}
                className={cn(
                  "flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed",
                  chosen
                    ? "border-[var(--accent-solid)] bg-[var(--accent-solid)] text-[var(--on-accent)]"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                {m.label}
              </button>
            );
          })}
        </div>

        <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-[var(--muted)]">
          {active.blurb}
        </p>

        {mode === "custom" && (
          <>
            <span
              title="What the two models are running with right now"
              className="hidden shrink-0 font-mono text-[10px] text-[var(--muted)] xl:inline"
            >
              local {custom.local.temperature.toFixed(2)} · {custom.local.maxTokens} tok
              {" · "}cloud {custom.cloud.temperature.toFixed(2)} / {custom.cloud.topP.toFixed(2)}
            </span>
            <button
              onClick={onEdit}
              className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--accent-solid)] bg-[var(--accent-solid)] px-3 py-1.5 text-xs font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90"
            >
              <Pencil className="size-3.5 shrink-0" />
              Edit prompts &amp; parameters
            </button>
          </>
        )}
      </div>

      {mode === "custom" && (
        <div
          className={cn(
            "border-t px-3 py-2 text-[11px] sm:px-5",
            error
              ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
              : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
          )}
        >
          <div className="mx-auto flex max-w-[1600px] items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {error ? (
              <span>
                {error}{" "}
                <button onClick={onEdit} className="underline underline-offset-2">
                  Fix it in the editor
                </button>
                .
              </span>
            ) : (
              <span>
                Your prompt is now the de-identification step. The pattern scrub, the
                verbatim-span check and the fail-closed rule still run underneath it — but a
                weaker prompt catches fewer names, and what it misses goes to Google. Read the
                redaction list before filing.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Custom mode editor                                                  */
/* ------------------------------------------------------------------ */

/** The built-in text, fetched so "load the built-in" cannot drift from it. */
interface BuiltInPrompts {
  local: { model: string; prompt: string };
  cloud: {
    model: string;
    systemInstruction: string;
    formats: { format: string; label: string; instruction: string }[];
  };
}

/**
 * Both prompts and both models' parameters, in one drawer.
 *
 * It opens the moment custom mode is selected, with every box already carrying
 * a worked example — the point of the mode is the prompts, so landing on empty
 * fields would just be a puzzle. "Load the built-in" pulls the real guided-mode
 * text from the server, so a user can start from what actually ships and edit
 * one rule rather than reinventing the whole thing.
 */
function CustomModeDrawer({
  config,
  onChange,
  localModels,
  onClose,
}: {
  config: CustomConfig;
  onChange: (next: CustomConfig) => void;
  localModels: string[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"local" | "cloud">("local");
  const [builtIn, setBuiltIn] = useState<BuiltInPrompts | null>(null);
  const [skeletonFormat, setSkeletonFormat] = useState<string>("SOAP");
  const [kernelOpen, setKernelOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/prompt-config", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        setBuiltIn((await r.json()) as BuiltInPrompts);
      } catch {
        /* the examples still work; only "load the built-in" goes quiet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocal = (patch: Partial<CustomConfig["local"]>) =>
    onChange({ ...config, local: { ...config.local, ...patch } });
  const setCloud = (patch: Partial<CustomConfig["cloud"]>) =>
    onChange({ ...config, cloud: { ...config.cloud, ...patch } });

  const fresh = blankCustomConfig();

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-3xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <SlidersHorizontal className="size-4 text-[var(--accent)]" />
              Custom mode
            </h3>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">
              You write both prompts and set both models&rsquo; parameters. Kept in this browser,
              sent inside the sealed envelope, never stored on the server.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close custom mode editor"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        <div className="flex gap-1 border-b border-[var(--border)] px-4 py-2">
          {(
            [
              ["local", Cpu, "Local model — de-identification"],
              ["cloud", Cloud, "Gemini — formatting"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] transition-colors",
                tab === id
                  ? "border-[var(--accent-solid)] bg-[var(--accent-solid)] text-[var(--on-accent)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="scroll-visible flex-1 overflow-auto p-4">
          {tab === "local" && (
            <div className="space-y-4">
              <StillInForce
                heading="What still holds, whatever you write here"
                points={[
                  "The pattern scrub runs first, always. Taiwan IDs, MRNs, phone numbers and dates are gone before your prompt sees the note — the floor is regex-only, never nothing.",
                  "The answer must still be entity JSON in the six known categories. A prompt that talks the model out of that shape fails the run closed rather than passing names to the cloud.",
                  "Every span is still matched verbatim against the source, screened against the clinical stoplist, and length-capped, so an invented or mislabelled span cannot be redacted out of the note.",
                ]}
              />

              <label className="block">
                <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                  LM Studio model
                </span>
                <select
                  value={config.local.model}
                  onChange={(e) => setLocal({ model: e.target.value })}
                  className="mt-1 w-full cursor-pointer rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none"
                >
                  <option value="">
                    Server default{builtIn ? ` — ${builtIn.local.model}` : ""}
                  </option>
                  {localModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {config.local.model && !localModels.includes(config.local.model) && (
                    <option value={config.local.model}>{config.local.model} (not loaded)</option>
                  )}
                </select>
                <span className="mt-1 block text-[11px] text-[var(--muted)]">
                  Only models LM Studio currently has loaded will answer. Anything else fails the
                  run closed.
                </span>
              </label>

              <PromptEditor
                label="De-identification prompt"
                value={config.local.systemPrompt}
                onChange={(v) => setLocal({ systemPrompt: v })}
                rows={16}
                seeds={[
                  ["Example", fresh.local.systemPrompt],
                  ...(builtIn ? ([["Built-in", builtIn.local.prompt]] as const) : []),
                ]}
              />

              <ParamGrid
                params={LOCAL_PARAMS}
                values={config.local as unknown as Record<string, number>}
                onChange={(key, value) => setLocal({ [key]: value } as Partial<CustomConfig["local"]>)}
              />
            </div>
          )}

          {tab === "cloud" && (
            <div className="space-y-4">
              <StillInForce
                heading="What still holds, whatever you write here"
                points={[
                  "Only placeholder text ever reaches Google. That is settled two stages earlier, on this machine, and nothing on this tab can change it.",
                  "The placeholder-integrity rules below are appended to your system instruction. Without them the model renumbers [DATE_2] and the note can no longer be re-hydrated — that is every run broken, not a judgement call.",
                ]}
              />

              <PromptEditor
                label="System instruction"
                value={config.cloud.systemInstruction}
                onChange={(v) => setCloud({ systemInstruction: v })}
                rows={12}
                seeds={[
                  ["Example", fresh.cloud.systemInstruction],
                  ...(builtIn
                    ? ([["Built-in", builtIn.cloud.systemInstruction]] as const)
                    : []),
                ]}
              />

              <div className="rounded border border-[var(--border)] bg-[var(--background)]">
                <button
                  onClick={() => setKernelOpen(!kernelOpen)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px]"
                >
                  <Lock className="size-3.5 shrink-0 text-[var(--muted)]" />
                  <span className="font-medium">Always appended — placeholder integrity</span>
                  <ChevronRight
                    className={cn(
                      "ml-auto size-3.5 text-[var(--muted)] transition-transform",
                      kernelOpen && "rotate-90",
                    )}
                  />
                </button>
                {kernelOpen && (
                  <pre className="mx-3 mb-3 whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--surface)] p-2.5 font-mono text-[11px] leading-relaxed">
                    {PLACEHOLDER_KERNEL}
                  </pre>
                )}
              </div>

              <PromptEditor
                label="Formatting instruction — replaces the note skeleton"
                value={config.cloud.instruction}
                onChange={(v) => setCloud({ instruction: v })}
                rows={12}
                seeds={[
                  ["Example", fresh.cloud.instruction],
                  ...(builtIn
                    ? ([
                        [
                          `Built-in ${skeletonFormat.replace(/_/g, " ").toLowerCase()}`,
                          builtIn.cloud.formats.find((f) => f.format === skeletonFormat)
                            ?.instruction ?? "",
                        ],
                      ] as const)
                    : []),
                ]}
                extra={
                  builtIn ? (
                    <select
                      value={skeletonFormat}
                      onChange={(e) => setSkeletonFormat(e.target.value)}
                      title="Which built-in skeleton the button above loads"
                      className="cursor-pointer rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] outline-none"
                    >
                      {builtIn.cloud.formats.map((f) => (
                        <option key={f.format} value={f.format}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  ) : null
                }
              />

              <ParamGrid
                params={CLOUD_PARAMS}
                values={config.cloud as unknown as Record<string, number>}
                onChange={(key, value) => setCloud({ [key]: value } as Partial<CustomConfig["cloud"]>)}
              />

              <p className="text-[11px] leading-relaxed text-[var(--muted)]">
                The saved routine and the one-off instruction box are still appended beneath your
                formatting instruction, in that order — leave them empty if you want the prompt on
                this tab to be the whole of it. Which Gemini model runs is still the ladder on the
                main screen.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-3">
          <button
            onClick={() => onChange(blankCustomConfig())}
            className="flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <RotateCcw className="size-3.5" />
            Reset both tabs to the examples
          </button>
          <button
            onClick={onClose}
            className="ml-auto rounded bg-[var(--accent-solid)] px-4 py-1.5 text-sm font-medium text-[var(--on-accent)] transition-opacity hover:opacity-90"
          >
            Done
          </button>
        </div>
      </aside>
    </div>
  );
}

/** The properties a custom prompt cannot switch off, stated where it is written. */
function StillInForce({ heading, points }: { heading: string; points: string[] }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
      <div className="flex items-center gap-1.5">
        <ShieldCheck className="size-3.5 shrink-0 text-[var(--accent)]" />
        <span className="text-[11px] font-semibold">{heading}</span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {points.map((p) => (
          <li key={p} className="flex gap-1.5 text-[11px] leading-relaxed text-[var(--muted)]">
            <Check className="mt-0.5 size-3 shrink-0 text-[var(--accent)]" />
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A prompt box with its length budget and one-click starting points. */
function PromptEditor({
  label,
  value,
  onChange,
  rows,
  seeds,
  extra,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  seeds: readonly (readonly [string, string])[];
  extra?: React.ReactNode;
}) {
  const over = value.length > MAX_CUSTOM_PROMPT_LENGTH;
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">{label}</span>
        <span
          className={cn(
            "font-mono text-[10px] tabular-nums",
            over ? "text-rose-700 dark:text-rose-400" : "text-[var(--muted)]",
          )}
        >
          {value.length.toLocaleString()} / {MAX_CUSTOM_PROMPT_LENGTH.toLocaleString()}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {extra}
          {seeds
            .filter(([, body]) => body.length > 0)
            .map(([name, body]) => (
              <button
                key={name}
                onClick={() => onChange(body)}
                title={`Replace this box with the ${name.toLowerCase()} text`}
                className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                Load {name.toLowerCase()}
              </button>
            ))}
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        className={cn(
          "w-full resize-y rounded border bg-[var(--background)] px-3 py-2 font-mono text-[12px] leading-relaxed outline-none",
          over ? "border-rose-500/50" : "border-[var(--border)]",
        )}
      />
    </div>
  );
}

/** Sampling parameters: a slider for the feel, a number box for the exact value. */
function ParamGrid({
  params,
  values,
  onChange,
}: {
  params: NumericParam[];
  values: Record<string, number>;
  onChange: (key: string, value: number) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)]">
      <div className="border-b border-[var(--border)] px-3 py-2 text-[11px] uppercase tracking-wider text-[var(--muted)]">
        Parameters
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {params.map((p) => {
          const value = values[p.key] ?? p.min;
          return (
            <li key={p.key} className="px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="w-36 shrink-0 text-xs font-medium">{p.label}</span>
                <input
                  type="range"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={value}
                  onChange={(e) => onChange(p.key, Number(e.target.value))}
                  className="min-w-0 flex-1 accent-[var(--accent-solid)]"
                />
                <input
                  type="number"
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  value={value}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    // An empty or half-typed box parses as NaN; hold the last
                    // usable value rather than writing a broken config.
                    if (Number.isFinite(n)) onChange(p.key, Math.min(p.max, Math.max(p.min, n)));
                  }}
                  className="w-24 shrink-0 rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-right font-mono text-xs tabular-nums outline-none"
                />
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{p.hint}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The model ladder, best on the left.
 *
 * A rung greys out only once Google has actually refused it — availability is
 * observed, never predicted. Picking a rung sets where the run *starts*; if it
 * is spent by the time the note is sent, the server walks down from there and
 * says so in the progress list.
 */
function ModelBar({
  models,
  chosen,
  onChoose,
  disabled,
}: {
  models: ModelAvailability[];
  chosen: string;
  onChoose: (id: string) => void;
  disabled: boolean;
}) {
  if (models.length === 0) return null;

  const chosenIndex = models.findIndex((m) => m.id === chosen);
  const nextUp = models.find((m, i) => i >= chosenIndex && m.available);

  const resetHint = (m: ModelAvailability) => {
    if (m.available || m.retryInMs === null) return "";
    if (m.daily) {
      const hours = Math.round(m.retryInMs / 3_600_000);
      return hours >= 1 ? `resets in ~${hours}h` : "resets shortly";
    }
    return `retry in ${Math.ceil(m.retryInMs / 1000)}s`;
  };

  return (
    <div className="border-t border-[var(--border)] px-3 py-2 sm:px-4 sm:py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <Cloud className="size-3.5 text-[var(--muted)]" />
        <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Cloud model — best first, falls back rightward
        </span>
        {nextUp && nextUp.id !== chosen && (
          <span className="text-[10px] text-amber-700 dark:text-amber-400">
            starts on {nextUp.label}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1">
        {models.map((m) => {
          const isChosen = m.id === chosen;
          const spent = !m.available;
          return (
            <button
              key={m.id}
              onClick={() => onChoose(m.id)}
              disabled={disabled}
              title={
                spent
                  ? `${m.id} — ${m.reason === "quota" ? "out of quota" : m.reason} ${resetHint(m)}`
                  : `${m.id} · ${m.dailyLimit || "?"}/day on the free tier`
              }
              className={cn(
                "flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed",
                spent
                  // Was muted/60 on border/40 with a strikethrough — in light
                  // mode those two converge and the label vanished entirely.
                  // Spent now reads as "off", not as "erased".
                  // Solid tokens, not an alpha wash: a translucent fill over a
                  // white surface is hard to reason about and was how these
                  // ended up invisible in the first place.
                  ? "border-[var(--border)] bg-[var(--background)] text-[var(--muted)]"
                  : isChosen
                    ? "border-[var(--accent-solid)] bg-[var(--accent-solid)] text-[var(--on-accent)]"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
                disabled && "cursor-not-allowed",
              )}
            >
              {m.tier === "lite" && !spent && (
                <span
                  className={cn(
                    "text-[9px] uppercase",
                    isChosen ? "text-[var(--on-accent)]/80" : "text-[var(--muted)]",
                  )}
                >
                  lite
                </span>
              )}
              {m.label}
              {spent && <span className="text-[var(--muted)]">· {resetHint(m)}</span>}
            </button>
          );
        })}
      </div>

      {!nextUp && (
        <p className="mt-1.5 text-[10px] text-rose-700 dark:text-rose-400">
          Every model is spent. De-identification still runs locally, but there is nothing left to
          format with until quota resets.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live feedback                                                       */
/* ------------------------------------------------------------------ */

/** GitHub's mark. lucide-react v1 dropped brand icons, so it lives here. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function WordCounter({ size }: { size: ReturnType<typeof measure> }) {
  const tone = size.overHard
    ? "text-rose-700 dark:text-rose-400"
    : size.overSoft
      ? "text-amber-700 dark:text-amber-400"
      : "text-[var(--muted)]";
  const bar = size.overHard ? "bg-rose-500" : size.overSoft ? "bg-amber-500" : "bg-[var(--accent)]";

  return (
    <div className="flex items-center gap-2.5">
      {/* Fill against the hard cap, so "how much room is left" is glanceable. */}
      <div className="h-1 w-20 overflow-hidden rounded-full bg-[var(--border)]">
        <div
          className={cn("h-full transition-[width] duration-200", bar)}
          style={{ width: `${Math.max(2, size.fraction * 100)}%` }}
        />
      </div>
      <span className={cn("font-mono text-[11px] tabular-nums", tone)}>
        {size.words.toLocaleString()} words · {size.chars.toLocaleString()} /{" "}
        {HARD_CHAR_LIMIT.toLocaleString()} ch
      </span>
    </div>
  );
}

const LOCUS_STYLE = {
  browser: { icon: Monitor, tint: "text-sky-700 dark:text-sky-400", where: "your browser" },
  mac: { icon: Cpu, tint: "text-emerald-700 dark:text-emerald-400", where: "Mac Mini" },
  cloud: { icon: Cloud, tint: "text-violet-700 dark:text-violet-400", where: "Gemini" },
} as const;

/** The pipeline as it actually happens, one row per server stage. */
function PipelineProgress({
  progress,
  paused,
}: {
  progress: Map<PipelineStage, ProgressEvent>;
  paused: boolean;
}) {
  return (
    <ol className="space-y-0.5">
      {STAGE_ORDER.map((stage) => {
        const ev = progress.get(stage);
        const locus = LOCUS_STYLE[STAGE_LOCUS[stage]];
        const Icon = locus.icon;
        const state = ev?.status ?? (paused ? "waiting" : "pending");

        return (
          <li
            key={stage}
            className={cn(
              "flex items-center gap-2.5 rounded px-2 py-1.5 text-xs transition-colors",
              state === "running" && "border-l-2 border-[var(--accent-solid)] bg-[var(--border)]/30",
              // Not opacity: dimming a row drags its text toward the panel it
              // sits on. Pending steps are stated in a quieter colour instead.
              (state === "pending" || state === "waiting") && "text-[var(--faint)]",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {state === "running" ? (
                <Loader2 className="size-3.5 animate-spin text-[var(--accent)]" />
              ) : state === "done" ? (
                <Check className="size-3.5 text-[var(--accent)]" />
              ) : state === "failed" ? (
                <AlertTriangle className="size-3.5 text-amber-700 dark:text-amber-400" />
              ) : (
                <Circle className="size-2 text-[var(--muted)]" />
              )}
            </span>

            <Icon
              className={cn(
                "size-3.5 shrink-0",
                state === "pending" || state === "waiting" ? "text-[var(--faint)]" : locus.tint,
              )}
            />
            <span className="flex-1 truncate">{STAGE_TITLES[stage]}</span>

            {ev?.detail && (
              <span className="shrink-0 font-mono text-[10px] text-[var(--muted)]">
                {ev.detail}
              </span>
            )}
            {typeof ev?.ms === "number" && (
              <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-[var(--muted)]">
                {ev.ms < 1000 ? `${ev.ms} ms` : `${(ev.ms / 1000).toFixed(1)} s`}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Shown when the single compute slot is taken. The server refuses rather than
 * queues (that is what protects the box), so the wait is client-side — and the
 * clinician gets to see exactly what the Mac Mini is busy with meanwhile.
 */
function QueuedPanel({
  activity,
  live,
  onCancel,
}: {
  activity: BusyInfo;
  live: BusyInfo | null;
  onCancel: () => void;
}) {
  const current = live ?? activity;

  // The server reports elapsed time only when polled. Re-anchor on each poll
  // and advance locally in between, so the counter moves instead of freezing.
  const [seconds, setSeconds] = useState(() => Math.floor(activity.totalElapsedMs / 1000));
  const anchor = useRef({ ms: activity.totalElapsedMs, at: 0 });

  useEffect(() => {
    anchor.current = { ms: current.totalElapsedMs, at: Date.now() };
  }, [current.totalElapsedMs, current.stage]);

  useEffect(() => {
    const id = setInterval(() => {
      const { ms, at } = anchor.current;
      if (at) setSeconds(Math.floor((ms + (Date.now() - at)) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-amber-700 dark:text-amber-400" />
        <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
          Queued — the Mac Mini is running another note
        </span>
        <button
          onClick={onCancel}
          className="ml-auto flex items-center gap-1 rounded border border-amber-500/40 px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
        >
          <X className="size-3" />
          Cancel
        </button>
      </div>

      <div className="mt-2.5 flex items-center gap-2 text-xs text-amber-700/90 dark:text-amber-300/90">
        <Cpu className="size-3.5 shrink-0" />
        <span>{current.label}</span>
        {current.detail && <span className="font-mono text-[10px]">({current.detail})</span>}
        <span className="ml-auto font-mono tabular-nums">{seconds}s elapsed</span>
      </div>

      <p className="mt-2 text-[11px] text-amber-700/70 dark:text-amber-300/70">
        16GB of unified memory runs one inference at a time. Your note is sealed and waiting —
        it starts automatically the moment the slot frees.
      </p>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Past notes                                                          */
/* ------------------------------------------------------------------ */

/**
 * Everything here is de-identified and permanently so: the token→PII map is
 * destroyed when each note finishes, so history can never show a real name.
 * It is a record of what crossed to the cloud, not a second copy of the chart.
 */
function HistoryDrawer({
  onClose,
  onReuse,
}: {
  onClose: () => void;
  onReuse: (text: string) => void;
}) {
  const [notes, setNotes] = useState<HistoryNote[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async (q: string, after: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (after) params.set("cursor", after);
      const r = await fetch(`/api/history?${params}`, { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const d = (await r.json()) as { notes: HistoryNote[]; nextCursor: string | null };
      setNotes((prev) => (after ? [...prev, ...d.notes] : d.notes));
      setCursor(d.nextCursor);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not load history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(query, null), query ? 300 : 0);
    return () => clearTimeout(id);
  }, [query, load]);

  const remove = async (id: string) => {
    await fetch(`/api/history?id=${id}`, { method: "DELETE" });
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  const copy = async (n: HistoryNote) => {
    await navigator.clipboard.writeText(n.deidentifiedOutput);
    setCopiedId(n.id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Past notes</h3>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">
              De-identified copies only — the mapping back to real names was destroyed when each
              note finished.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close history"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        <div className="border-b border-[var(--border)] px-4 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search past notes (diagnoses, drugs, routines…)"
            className="w-full bg-transparent text-xs outline-none placeholder:text-[var(--muted)]/60"
          />
        </div>

        <div className="scroll-visible flex-1 overflow-auto">
          {error && (
            <div className="m-4 flex gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!error && notes.length === 0 && !loading && (
            <p className="px-4 py-6 text-sm text-[var(--muted)]">
              {query ? "Nothing matches that search." : "No notes yet. Your first run will appear here."}
            </p>
          )}

          <ul className="divide-y divide-[var(--border)]">
            {notes.map((n) => {
              const open = openId === n.id;
              return (
                <li key={n.id} className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setOpenId(open ? null : n.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] tabular-nums text-[var(--muted)]">
                          {new Date(n.createdAt).toLocaleString(undefined, {
                            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                          })}
                        </span>
                        {n.noteFormat && (
                          <span className="rounded bg-[var(--accent-solid)] px-1.5 py-0.5 text-[10px] text-[var(--on-accent)]">
                            {n.noteFormat.replace(/_/g, " ").toLowerCase()}
                          </span>
                        )}
                        {n.promptTemplateName && (
                          <span className="truncate text-[10px] text-[var(--muted)]">
                            {n.promptTemplateName}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-1 font-mono text-[11px] text-[var(--muted)]">
                        {n.deidentifiedInput.replace(/\s+/g, " ").slice(0, 110)}
                      </p>
                    </button>

                    <button
                      onClick={() => void copy(n)}
                      className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
                      aria-label="Copy de-identified note"
                    >
                      {copiedId === n.id ? (
                        <CheckCheck className="size-3.5 text-[var(--accent)]" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </button>
                    <button
                      onClick={() => onReuse(n.deidentifiedInput)}
                      title="Load the de-identified text back into the editor"
                      className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
                      aria-label="Reuse"
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                    <button
                      onClick={() => void remove(n.id)}
                      className="rounded p-1 text-[var(--muted)] hover:text-rose-700 dark:hover:text-rose-400"
                      aria-label="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>

                  {open && (
                    <div className="mt-2 space-y-2">
                      <Panel title="Sent to the cloud" body={n.deidentifiedInput} />
                      <Panel title="Returned by the cloud" body={n.deidentifiedOutput} />
                      <p className="font-mono text-[10px] text-[var(--muted)]">
                        {n.modelUsed} · {n.processingTimeMs} ms
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {loading && (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-[var(--muted)]">
              <Loader2 className="size-3.5 animate-spin" />
              Loading…
            </div>
          )}

          {cursor && !loading && (
            <button
              onClick={() => void load(query, cursor)}
              className="m-4 rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Load older notes
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function Panel({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
        {title}
      </h4>
      <pre className="scroll-visible max-h-56 overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--background)] p-2.5 font-mono text-[11px] leading-relaxed">
        {body}
      </pre>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Wire view                                                           */
/* ------------------------------------------------------------------ */

/**
 * The exact bytes that crossed the internet, beside the plaintext they
 * replaced. This is what Cloudflare relays: an RSA-wrapped AES key, a nonce,
 * and ciphertext. Everything shown here is already in the browser — nothing
 * extra is fetched to render it.
 */
function WireView({
  wire,
  onClose,
}: {
  wire: { envelope: CryptoEnvelope; plaintext: string };
  onClose: () => void;
}) {
  const { envelope, plaintext } = wire;
  const body = JSON.stringify(envelope);

  const keyBytes = base64ToBytes(envelope.encryptedKey ?? "");
  const ivBytes = base64ToBytes(envelope.iv);
  const dataBytes = base64ToBytes(envelope.encryptedData);

  // Decoding ciphertext as UTF-8 is meaningless by design — that is the point.
  const asText = new TextDecoder().decode(dataBytes).slice(0, 400);
  const hex = [...dataBytes.slice(0, 96)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  const note = (() => {
    try {
      return (JSON.parse(plaintext) as { text?: string }).text ?? plaintext;
    } catch {
      return plaintext;
    }
  })();

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-3xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">What Cloudflare sees</h3>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">
              The literal request body from your last run. Cloudflare terminates HTTPS at its
              edge, so this — not your note — is what it relays.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close wire view"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        <div className="scroll-visible flex-1 overflow-auto p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                <Monitor className="size-3.5 text-sky-700 dark:text-sky-400" />
                What you typed — stays in this browser
              </h4>
              <pre className="scroll-visible max-h-64 overflow-auto whitespace-pre-wrap rounded border border-sky-500/30 bg-sky-500/5 p-2.5 font-mono text-[11px] leading-relaxed">
                {note}
              </pre>
            </div>
            <div>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                <Radio className="size-3.5 text-violet-700 dark:text-violet-400" />
                What went on the wire
              </h4>
              <pre className="scroll-visible max-h-64 overflow-auto break-all whitespace-pre-wrap rounded border border-violet-500/30 bg-violet-500/5 p-2.5 font-mono text-[11px] leading-relaxed">
                {asText}
              </pre>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded border border-[var(--border)] bg-[var(--border)] text-center">
            <Field2 label="Wrapped AES key" value={`${keyBytes.length} B`} sub="RSA-OAEP-2048" />
            <Field2 label="Nonce (iv)" value={`${ivBytes.length} B`} sub="AES-GCM" />
            <Field2 label="Ciphertext" value={`${dataBytes.length} B`} sub={`${note.length} chars in`} />
          </div>

          <h4 className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            First 96 bytes, as hex
          </h4>
          <pre className="scroll-visible overflow-x-auto rounded border border-[var(--border)] bg-[var(--background)] p-2.5 font-mono text-[10px] leading-relaxed">
            {hex}
          </pre>

          <h4 className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            The whole POST body
          </h4>
          <pre className="scroll-visible max-h-48 overflow-auto break-all whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--background)] p-2.5 font-mono text-[10px] leading-relaxed">
            {body}
          </pre>

          <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Why this is unreadable
            </h4>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--muted)]">
              Your browser made a one-time AES-256 key, encrypted the note with it, then locked
              that key with the Mac Mini&apos;s public key. Only the matching private key — which
              never leaves your machine — can unlock it. Cloudflare relays the box without a way
              to open it. Tampering fails too: AES-GCM authenticates the ciphertext, so a single
              flipped bit is rejected rather than silently decrypted into something else.
            </p>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">
              One honest limit: the public key is served from{" "}
              <code className="text-[var(--foreground)]">/api/keys</code> over this same tunnel. An
              attacker who controlled the edge could substitute their own. This defeats passive
              inspection and incidental logging — not an active edge adversary.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Field2({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-[var(--surface)] px-3 py-2.5">
      <div className="font-mono text-sm">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 font-mono text-[9px] text-[var(--muted)]">{sub}</div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

interface PromptConfig {
  local: { model: string; prompt: string };
  cloud: {
    model: string;
    systemInstruction: string;
    formats: { format: string; label: string; instruction: string }[];
  };
  customisation: { where: string; why: string };
}

/**
 * Read-only view of what each model is told.
 *
 * Nothing here is editable on purpose. The local prompt IS the
 * de-identification step; the Gemini system instruction carries the rules that
 * keep placeholders intact and stop the model inventing findings. Tuning
 * belongs in a saved routine, which is owned, PII-screened and recorded on
 * every audit row.
 */
function PromptsDrawer({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<PromptConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"local" | "cloud">("local");
  const [openFormat, setOpenFormat] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/prompt-config", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as PromptConfig;
        if (!cancelled) setCfg(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load prompts.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-3xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">What each model is told</h3>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">
              The exact instructions behind every note. Read-only — see below for why.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close prompts"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        <div className="flex gap-1 border-b border-[var(--border)] px-4 py-2">
          {(
            [
              ["local", Cpu, "Local model — de-identification"],
              ["cloud", Cloud, "Gemini — formatting"],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] transition-colors",
                tab === id
                  ? "border-[var(--accent-solid)] bg-[var(--accent-solid)] text-[var(--on-accent)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="scroll-visible flex-1 overflow-auto p-4">
          {error && (
            <div className="flex gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {!cfg && !error && (
            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <Loader2 className="size-3.5 animate-spin" />
              Loading…
            </div>
          )}

          {cfg && tab === "local" && (
            <>
              <Locked
                heading={`Runs on this Mac · ${cfg.local.model}`}
                body="This prompt is the de-identification step itself. It is what finds the names, wards and addresses that pattern rules cannot. Weakening it would silently widen what reaches the cloud, so it is compiled in rather than configurable."
              />
              <PromptBlock title="System prompt" body={cfg.local.prompt} />
            </>
          )}

          {cfg && tab === "cloud" && (
            <>
              <Locked
                heading={`Runs at Google · ${cfg.cloud.model}`}
                body="These rules keep [PATIENT_1] intact through the round trip and stop the model inventing findings. They are the reason a note can be re-hydrated at all, so they are not a setting."
              />
              <PromptBlock title="System instruction" body={cfg.cloud.systemInstruction} />

              <h4 className="mt-5 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                Format skeletons — one per note type
              </h4>
              <ul className="divide-y divide-[var(--border)] rounded border border-[var(--border)]">
                {cfg.cloud.formats.map((f) => (
                  <li key={f.format}>
                    <button
                      onClick={() => setOpenFormat(openFormat === f.format ? null : f.format)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--background)]"
                    >
                      <span className="font-medium">{f.label}</span>
                      <span className="font-mono text-[10px] text-[var(--muted)]">{f.format}</span>
                      <ChevronRight
                        className={cn(
                          "ml-auto size-3.5 text-[var(--muted)] transition-transform",
                          openFormat === f.format && "rotate-90",
                        )}
                      />
                    </button>
                    {openFormat === f.format && (
                      <pre className="mx-3 mb-3 whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--background)] p-2.5 font-mono text-[11px] leading-relaxed">
                        {f.instruction}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>

              <div className="mt-5 rounded-lg bg-[var(--accent-solid)] p-3 text-[var(--on-accent)]">
                <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider">
                  <BookMarked className="size-3.5" />
                  Where you change things
                </h4>
                <p className="mt-1.5 text-[12px] leading-relaxed">
                  Everything above is fixed. Your instructions go in a{" "}
                  <strong className="font-semibold">saved routine</strong> — or the one-off box,
                  for a single note. Both are appended <em>beneath</em> these rules, so a routine
                  can shape the note without being able to override the parts that protect the
                  patient.
                </p>
                <p className="mt-2 text-[12px] leading-relaxed">{cfg.customisation.why}</p>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function Locked({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
      <div className="flex items-center gap-1.5">
        <Lock className="size-3.5 text-[var(--muted)]" />
        <span className="text-[11px] font-semibold">{heading}</span>
        <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--muted)]">
          read-only
        </span>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--muted)]">{body}</p>
    </div>
  );
}

function PromptBlock({ title, body }: { title: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          {title}
        </h4>
        <span className="font-mono text-[10px] text-[var(--muted)]">
          {body.length.toLocaleString()} chars
        </span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(body);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          className="ml-auto flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          {copied ? <CheckCheck className="size-3 text-[var(--accent)]" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-[11px] leading-relaxed">
        {body}
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Explainer                                                           */
/* ------------------------------------------------------------------ */

const STEPS: { n: string; where: keyof typeof LOCUS_STYLE; title: string; body: string }[] = [
  {
    n: "1",
    where: "browser",
    title: "Your browser locks the note",
    body:
      "Before anything is sent, the note is encrypted here in the page with a one-time key. That key is itself locked with the Mac Mini's public key. Cloudflare relays the traffic but can only see scrambled bytes — which matters, because Cloudflare decrypts ordinary HTTPS at its edge.",
  },
  {
    n: "2",
    where: "mac",
    title: "The Mac Mini opens it — nothing else can",
    body:
      "Only your machine holds the private key, so only your machine can read the note. Everything from here until step 6 happens on hardware you physically own.",
  },
  {
    n: "3",
    where: "mac",
    title: "Pattern rules strip the obvious identifiers",
    body:
      "Fixed rules catch national IDs, medical record numbers, phone numbers, and both ROC and Gregorian dates. Each one is swapped for a tag like [MRN_1], and the real value is kept only in memory.",
  },
  {
    n: "4",
    where: "mac",
    title: "A local AI model catches the rest",
    body:
      "Names, wards, addresses and hospitals do not follow a pattern, so a language model running on your Mac reads the note and flags them. It never touches the internet. If it is not running, the whole request is refused rather than risking a leak.",
  },
  {
    n: "5",
    where: "cloud",
    title: "Only the tagged version goes to Gemini",
    body:
      "Google receives a note where every person, place and number has become a tag. It writes the structured note around those tags. It cannot know who the patient is, because that information never left your desk.",
  },
  {
    n: "6",
    where: "mac",
    title: "Your Mac puts the real names back",
    body:
      "The tags are swapped for the real identifiers here, locally, and only then is the finished note encrypted and sent back to your browser. The lookup table is erased immediately, and expires after ten minutes regardless.",
  },
  {
    n: "7",
    where: "mac",
    title: "The audit log keeps the anonymous copy only",
    body:
      "The local database stores the tagged prompt and the tagged output — never a name, never a chart number. You keep a usable record without keeping a second copy of the patient's identity.",
  },
];

function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-start justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold">How Project Airlock works</h3>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">
              An airlock joins two rooms that must never meet. A model on this Mac removes every
              identifier before the outer door opens.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close explainer"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        <div className="scroll-visible flex-1 overflow-auto px-5 py-4">
          <div className="mb-5 flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-[11px]">
            {(["browser", "mac", "cloud"] as const).map((k, i) => {
              const L = LOCUS_STYLE[k];
              const Icon = L.icon;
              return (
                <div key={k} className="flex flex-1 items-center gap-2">
                  {i > 0 && <span className="text-[var(--muted)]">→</span>}
                  <Icon className={cn("size-4", L.tint)} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{L.where}</div>
                    <div className="truncate text-[10px] text-[var(--muted)]">
                      {k === "cloud" ? "sees tags only" : "sees real data"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <ol className="space-y-4">
            {STEPS.map((step) => {
              const L = LOCUS_STYLE[step.where];
              const Icon = L.icon;
              return (
                <li key={step.n} className="flex gap-3">
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                      "border-[var(--border)] bg-[var(--background)]",
                      L.tint,
                    )}
                  >
                    {step.n}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium">{step.title}</span>
                      <Icon className={cn("size-3.5", L.tint)} />
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--muted)]">
                      {step.body}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              What this does not promise
            </h4>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--muted)]">
              The name-finding step is a prediction, not a guarantee — always open the{" "}
              <strong className="text-[var(--foreground)]">redactions</strong> list and check what
              was caught before filing a note. And the formatted note is written by a model: it can
              drop or misplace a detail, so read it as a draft, not a record.
            </p>
          </div>
        </div>

        <div className="border-t border-[var(--border)] px-5 py-3 text-[11px] text-[var(--muted)]">
          One note at a time — 16GB of unified memory runs a single model pass, so a second
          request waits its turn rather than slowing yours down.
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Prompt library                                                      */
/* ------------------------------------------------------------------ */

const BLANK = { name: "", specialty: "", instruction: "", format: "", isDefault: false };

function PromptLibrary({
  templates,
  onClose,
  onChanged,
}: {
  templates: PromptTemplate[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<typeof BLANK>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const startNew = () => {
    setEditingId(null);
    setDraft(BLANK);
    setError(null);
  };

  const startEdit = (t: PromptTemplate) => {
    setEditingId(t.id);
    setDraft({
      name: t.name,
      specialty: t.specialty ?? "",
      instruction: t.instruction,
      format: t.format ?? "",
      isDefault: t.isDefault,
    });
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(editingId ? `/api/prompts/${editingId}` : "/api/prompts", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await res.json()) as { error?: string; detail?: string[] };
      if (!res.ok) {
        throw new Error(
          body.detail?.length ? `${body.error} (found: ${body.detail.join(", ")})` : body.error,
        );
      }
      await onChanged();
      startNew();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/prompts/${id}`, { method: "DELETE" });
    await onChanged();
    if (editingId === id) startNew();
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Specialty routines</h3>
            <p className="text-[11px] text-[var(--muted)]">
              Saved instructions appended to every note. Configuration only — never patient data.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close prompt library"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        <div className="scroll-visible flex-1 overflow-auto">
          <ul className="divide-y divide-[var(--border)] border-b border-[var(--border)]">
            {templates.length === 0 && (
              <li className="px-4 py-3 text-sm text-[var(--muted)]">
                No routines yet. Create one below — e.g. a nephrology round that always wants the
                dialysis access and dry weight called out.
              </li>
            )}
            {templates.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{t.name}</span>
                    {t.specialty && (
                      <span className="rounded bg-[var(--accent-solid)] px-1.5 py-0.5 text-[10px] text-[var(--on-accent)]">
                        {t.specialty}
                      </span>
                    )}
                    {t.isDefault && (
                      <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                        default
                      </span>
                    )}
                    {t.userId === null && (
                      <span
                        title="Shared with everyone on this instance"
                        className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]"
                      >
                        shared
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-[var(--muted)]">{t.instruction}</p>
                </div>
                <button
                  onClick={() => startEdit(t)}
                  className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
                  aria-label={`Edit ${t.name}`}
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  onClick={() => void remove(t.id)}
                  className="rounded p-1 text-[var(--muted)] hover:text-rose-700 dark:hover:text-rose-400"
                  aria-label={`Delete ${t.name}`}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>

          <div className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              <Plus className="size-4 text-[var(--accent)]" />
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                {editingId ? "Edit routine" : "New routine"}
              </h4>
              {editingId && (
                <button onClick={startNew} className="ml-auto text-[11px] text-[var(--muted)] underline">
                  cancel edit
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field
                label="Name"
                value={draft.name}
                onChange={(v) => setDraft({ ...draft, name: v })}
                placeholder="Nephrology ward round"
              />
              <Field
                label="Specialty"
                value={draft.specialty}
                onChange={(v) => setDraft({ ...draft, specialty: v })}
                placeholder="Nephrology"
              />
            </div>

            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                Default note format
              </span>
              <select
                value={draft.format}
                onChange={(e) => setDraft({ ...draft, format: e.target.value })}
                className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none"
              >
                <option value="">— none —</option>
                {FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                Instruction to Gemini
              </span>
              <textarea
                value={draft.instruction}
                onChange={(e) => setDraft({ ...draft, instruction: e.target.value })}
                rows={7}
                placeholder={
                  "Always list dialysis access type and dry weight under Objective.\nReport eGFR trend across the admission.\nKeep the Plan numbered, one line per problem."
                }
                className="mt-1 w-full resize-y rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[12px] leading-relaxed outline-none"
              />
            </label>

            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
              />
              Preselect this routine on load
            </label>

            {error && (
              <div className="flex gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-700 dark:text-rose-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              onClick={() => void save()}
              disabled={saving || !draft.name.trim() || !draft.instruction.trim()}
              className="flex items-center gap-2 rounded bg-[var(--accent-solid)] px-4 py-1.5 text-sm font-medium text-[var(--on-accent)] transition-opacity disabled:cursor-not-allowed disabled:bg-[var(--border)]/40 disabled:text-[var(--faint)]"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {editingId ? "Save changes" : "Create routine"}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none placeholder:text-[var(--muted)]/60"
      />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Note rendering                                                      */
/* ------------------------------------------------------------------ */

/**
 * Minimal Markdown renderer for the note body: headings, bold runs, and blank
 * lines. Deliberately not a full parser and never `dangerouslySetInnerHTML` —
 * this is model output shown to a clinician, so it renders as React nodes with
 * no path to injected markup. "Copy clean note" still yields raw Markdown,
 * which is what an EMR paste target wants.
 */
function inline(text: string, keyBase: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={`${keyBase}-${i}`} className="font-semibold text-[var(--foreground)]">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={`${keyBase}-${i}`}>{part}</span>
    ),
  );
}

function NoteBody({ markdown }: { markdown: string }) {
  return (
    <div className="font-mono text-[13px] leading-relaxed">
      {markdown.split("\n").map((line, i) => {
        const key = `l${i}`;
        if (!line.trim()) return <div key={key} className="h-3" />;

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
          return (
            <h3 key={key} className="mt-3 mb-1 text-[13px] font-semibold tracking-wide">
              {inline(heading[2], key)}
            </h3>
          );
        }

        // A line that is nothing but a bold run is a section header.
        if (/^\*\*[^*]+\*\*$/.test(line.trim())) {
          return (
            <h3
              key={key}
              className="mt-3 mb-1 border-b border-[var(--border)] pb-1 text-[13px] font-semibold tracking-wide"
            >
              {line.trim().slice(2, -2)}
            </h3>
          );
        }

        const listItem = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (listItem) {
          return (
            <div key={key} className="flex gap-2 pl-1">
              <span className="select-none text-[var(--muted)]">{line.trim().split(/\s+/)[0]}</span>
              <span className="flex-1">{inline(listItem[2], key)}</span>
            </div>
          );
        }

        return (
          <div key={key} className="whitespace-pre-wrap">
            {inline(line, key)}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Status chip. Sized for a 1024x768 ward screen: the text never wraps mid-pill,
 * the label is always shown, and the row of pills wraps to a second or third
 * line rather than hiding anything. A long model name truncates with the full
 * value in the tooltip.
 */
function HealthPill({
  icon: Icon,
  label,
  tone,
  pulse,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: "ok" | "warn" | "bad";
  pulse?: boolean;
  title?: string;
}) {
  const tones = {
    ok: "border-emerald-500/30 text-emerald-700 dark:text-emerald-400",
    warn: "border-amber-500/40 text-amber-700 dark:text-amber-400",
    bad: "border-rose-500/30 text-rose-700 dark:text-rose-400",
  } as const;
  return (
    <span
      title={title ?? label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] xl:px-2.5",
        tones[tone],
      )}
    >
      <Icon className={cn("size-3.5 shrink-0", pulse && "animate-pulse")} />
      <span className="max-w-[9rem] truncate xl:max-w-[15rem]">{label}</span>
    </span>
  );
}

/** Drawer showing exactly what was swapped out before the cloud call. */
function Inspector({ result, onClose }: { result: ProcessNoteResult; onClose: () => void }) {
  const { redactions, deidentifiedInput, meta } = result;

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="relative flex h-full w-full max-w-xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">PII Scrubbed Inspector</h3>
            <p className="text-[11px] text-[var(--muted)]">
              Exactly what Gemini received. Values are masked here too.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Close inspector"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        <div className="scroll-visible flex-1 overflow-auto">
          <div className="grid grid-cols-3 gap-px border-b border-[var(--border)] bg-[var(--border)] text-center">
            <Stat
              label="Regex hits"
              value={Object.values(meta.regexHits).reduce((a, b) => a + b, 0)}
            />
            <Stat label="Local NER" value={meta.llmEntityCount} />
            <Stat label="Rejected spans" value={meta.hallucinatedSpans + meta.rejectedClinicalSpans} />
          </div>

          {meta.degradedScrub && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
              Degraded run: the local NER pass did not execute. Names may not have been removed.
            </div>
          )}

          <ul className="divide-y divide-[var(--border)]">
            {redactions.length === 0 && (
              <li className="px-4 py-3 text-sm text-[var(--muted)]">
                Nothing matched. Confirm the narrative genuinely contains no identifiers before filing.
              </li>
            )}
            {redactions.map((r) => (
              <li key={r.token} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span
                  className={cn("rounded px-1.5 py-0.5 font-mono", CATEGORY_TINT[r.category] ?? "bg-slate-500/10")}
                >
                  {r.token}
                </span>
                <span className="font-mono text-[var(--muted)]">{r.preview}</span>
                <span className="ml-auto text-[10px] uppercase text-[var(--muted)]">{r.source}</span>
              </li>
            ))}
          </ul>

          <div className="border-t border-[var(--border)] p-4">
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              De-identified prompt sent to Gemini
            </h4>
            <pre className="scroll-visible max-h-80 overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-[11px] leading-relaxed">
              {deidentifiedInput}
            </pre>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[var(--surface)] px-3 py-3">
      <div className="font-mono text-lg">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</div>
    </div>
  );
}
