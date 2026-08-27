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
  X,
} from "lucide-react";
import {
  ComputeBusyError,
  isLocalDestination,
  LOCAL_MODEL_ID,
  runPipeline,
  stageLocus,
  stageTitle,
  type BusyInfo,
  type PipelineStage,
  type ProgressEvent,
} from "@/lib/pipeline-client";
import { base64ToBytes, type CryptoEnvelope } from "@/lib/crypto";
import {
  budgetedText,
  normalisePromptRun,
  PROMPT_DEFAULTS,
  PromptRunError,
  DEID_SAMPLING_DEFAULTS,
  SAMPLING_DEFAULTS,
  SAMPLING_PARAMS,
  deidentifies,
  stagesFor,
  type PromptRun,
  type Sampling,
  type Workspace,
} from "@/lib/workspace";
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
    destination: "cloud" | "local";
    workspace: "note" | "prompt";
    /** False only for a raw local prompt — the one run that is not scrubbed. */
    deidentified: boolean;
    patternScrub: boolean;
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
  lmStudio: {
    online: boolean;
    /** What LM Studio has loaded. */
    models: string[];
    /** What a request will actually ask for — the pin, if one is set. */
    requestModel?: string;
    busy?: boolean;
    error?: string;
  };
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
  kind?: string | null;
  systemInstruction?: string | null;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  maxTokens?: number | null;
  id: string;
  name: string;
  specialty: string | null;
  instruction: string;
  format: string | null;
  isDefault: boolean;
  /** Null owner = a shared routine anyone on this instance can manage. */
  userId: string | null;
}

/** Labels are kept short enough that all six fit one line at 1024px — the
 *  width this is built for. The full name is each button's tooltip. */
const FORMATS = [
  { id: "SOAP", label: "SOAP" },
  { id: "ADMISSION_NOTE", label: "Admission" },
  { id: "PROGRESS_NOTE", label: "Progress" },
  { id: "HOSPITAL_COURSE", label: "Course" },
  { id: "DISCHARGE_SUMMARY", label: "Discharge" },
  /**
   * No built-in shape — the saved routine is the whole instruction.
   *
   * The five above each carry a compiled-in structure, which is what makes two
   * notes labelled "SOAP" comparable. A routine that describes its own
   * headings was previously fighting a set it never asked for; this is the way
   * out. It requires a routine, because there is nothing else left to say what
   * the note should be.
   */
  { id: "OTHER", label: "Others" },
] as const;

/** The full name behind each short button label. */
const NOTE_FORMAT_TITLES: Record<string, string> = {
  SOAP: "SOAP note",
  ADMISSION_NOTE: "Admission note",
  PROGRESS_NOTE: "Daily progress note",
  HOSPITAL_COURSE: "Hospital course timeline",
  DISCHARGE_SUMMARY: "Discharge summary",
  OTHER: "No built-in shape — runs on a saved routine alone",
};

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
  EMAIL: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
  STAFF_CODE: "bg-lime-600/10 text-lime-700 dark:text-lime-400",
  OTHER_ID: "bg-stone-500/10 text-stone-700 dark:text-stone-400",
};

/**
 * The two things you can be doing here.
 *
 * This replaced a guided/custom toggle, a CUSTOM note format, and the pair of
 * prompt editors behind them — four controls that could all express "I want to
 * write the prompt myself", and that needed a table to tell apart. One toggle,
 * two states, and the workspace below it changes to match.
 */
const WORKSPACES: {
  id: Workspace;
  label: string;
  icon: typeof ShieldCheck;
  /** Shown in the row, which is one line. ~40 characters survive at 1024px. */
  summary: string;
  /** The whole sentence, as the tooltip. */
  blurb: string;
}[] = [
  {
    id: "note",
    label: "Note",
    icon: ShieldCheck,
    summary: "A ward narrative becomes a chart entry.",
    blurb:
      "Paste a ward narrative and get a structured note. Identifiers are stripped on this Mac before anything is sent, whichever model writes it.",
  },
  {
    id: "prompt",
    label: "Custom prompt",
    icon: SlidersHorizontal,
    summary: "You write the instruction and the prompt.",
    blurb:
      "Write a system instruction and a prompt, and read the answer. On Gemini it is de-identified first, exactly as a note is; on the local model it runs raw.",
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
const WORKSPACE_KEY = "airlock.workspace.v1";
const PROMPT_RUN_KEY = "airlock.prompt-run.v1";
const SAMPLING_KEY = "airlock.sampling.v1";
const DEID_SAMPLING_KEY = "airlock.deid-sampling.v1";
const PATTERN_SCRUB_KEY = "airlock.pattern-scrub.v1";

interface RunSettings {
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

function readRunSettings(): RunSettings {
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

function subscribeRunSettings(fn: () => void) {
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

function getRunSettings(): RunSettings {
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

function getServerRunSettings(): RunSettings {
  return SERVER_RUN_SETTINGS;
}

function writeRunSettings(next: RunSettings): void {
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
  /**
   * On a phone the four detail rows push the input — and the run button — a
   * long way down the page. Mode and model stay visible because they are the
   * two choices that change what a run does; the rest folds away. Always open
   * from `lg`, where there is room and the two-panel layout depends on these
   * heights being constant.
   */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [copied, setCopied] = useState<"identified" | "deidentified" | null>(null);
  const [queued, setQueued] = useState<BusyInfo | null>(null);
  const [models, setModels] = useState<ModelAvailability[]>([]);
  const [chosenModel, setChosenModel] = useState<string>("");
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const liveRef = useRef<HTMLPreElement>(null);

  /* --- run mode, remembered per browser -------------------------------- */
  const {
    workspace,
    prompt: promptRun,
    sampling,
    deidSampling,
    patternScrub,
  } = useSyncExternalStore(
    subscribeRunSettings,
    getRunSettings,
    getServerRunSettings,
  );

  const setPromptRun = useCallback((patch: Partial<PromptRun>) => {
    const current = getRunSettings();
    writeRunSettings({ ...current, prompt: { ...current.prompt, ...patch } });
  }, []);

  const setSampling = useCallback((patch: Partial<Sampling>) => {
    const current = getRunSettings();
    writeRunSettings({ ...current, sampling: { ...current.sampling, ...patch } });
  }, []);

  const setDeidSampling = useCallback((patch: Partial<Sampling>) => {
    const current = getRunSettings();
    writeRunSettings({ ...current, deidSampling: { ...current.deidSampling, ...patch } });
  }, []);

  const setPatternScrub = useCallback((on: boolean) => {
    writeRunSettings({ ...getRunSettings(), patternScrub: on });
  }, []);

  const chooseWorkspace = useCallback((next: Workspace) => {
    writeRunSettings({ ...getRunSettings(), workspace: next });
    // A routine belongs to one workspace, so a selection made in the other is
    // not merely inapplicable — it would be silently ignored at request time.
    setActiveTemplateId("");
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

  // Deferred into a promise rather than called in the effect body: `loadModels`
  // sets state, and a synchronous setState inside an effect is a cascading
  // render (and a lint error). The state lands after the fetch resolves.
  useEffect(() => {
    void (async () => {
      await loadModels();
    })();
  }, [loadModels]);

  /* --- health polling -------------------------------------------------- */
  // Tighten the cadence whenever this tab has work outstanding — queued OR
  // running. A five-second poll can miss a short run entirely, which is how
  // "Mac Mini Busy" could fail to appear for a note that had plainly run.
  const pollMs = queued || submitting ? 1000 : 5000;
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

  /**
   * Which model writes the note. The local destination is not a separate
   * control: it is a rung on the same selector, because it answers the same
   * question, and it composes with either workspace unchanged.
   */
  const localDestination = isLocalDestination(chosenModel);

  /**
   * What the input budget applies to — the same answer the route computes, from
   * the same function, so the live counter cannot promise room the server will
   * refuse. On a cloud prompt run that is the system instruction and the prompt
   * together, because the de-identification pass reads them joined.
   */
  const size = measure(
    budgetedText({
      workspace,
      narrative: input,
      promptRun: workspace === "prompt" ? promptRun : null,
      localDestination,
    }),
  );

  /**
   * The same check the route runs, run early so a broken prompt is caught
   * while it is still on screen rather than after the workspace has cleared.
   */
  const promptError = useMemo(() => {
    if (workspace !== "prompt") return null;
    try {
      normalisePromptRun(promptRun);
      return null;
    } catch (e) {
      return e instanceof PromptRunError ? e.message : "That prompt is not usable.";
    }
  }, [workspace, promptRun]);

  /**
   * An empty prompt is the starting state, not a mistake, and it should not
   * push the standing privacy notice off the screen to say so — that notice is
   * exactly what someone opening this for the first time needs to read. The
   * disabled run button explains the empty case on hover; the banner is kept
   * for problems you can only have once you have typed something.
   */
  const promptBannerError = promptRun.prompt.trim() ? promptError : null;

  /** In the prompt workspace the prompt IS the input. */
  const hasInput = workspace === "prompt" ? promptRun.prompt.trim().length > 0 : input.trim().length > 0;

  /** "Others" has no built-in shape, so a routine is the whole instruction. */
  const routineRequired = workspace === "note" && format === "OTHER" && !activeTemplateId;

  const ready =
    Boolean(publicKey) && !submitting && hasInput && !size.overHard && !promptError && !routineRequired;

  /**
   * A greyed-out primary action with no explanation is a dead end. Say which
   * precondition is missing, in the order it would be hit.
   */
  const disabledReason = submitting
    ? "Something is already running on this Mac."
    : !publicKey
      ? "Waiting for the server's public key — nothing can be sealed yet."
      : !hasInput
        ? workspace === "prompt"
          ? "Write a prompt first."
          : "Paste the ward narrative first."
        : size.overHard
          ? `That input is ${size.chars.toLocaleString()} characters. The cap is ${HARD_CHAR_LIMIT.toLocaleString()} — past that the local model starts missing names.`
          : routineRequired
            ? 'The "Others" format runs on a saved routine alone — pick one below, or choose a built-in format.'
            : (promptError ?? "Cmd/Ctrl + Enter");

  /** Routines belong to a workspace; the selector only offers this one's. */
  const kindOf = (t: PromptTemplate) => (t.kind === "prompt" ? "prompt" : "note");
  const visibleTemplates = templates.filter((t) => kindOf(t) === workspace);
  const activeTemplate = visibleTemplates.find((t) => t.id === activeTemplateId) ?? null;

  /**
   * Selecting a prompt routine loads it into the editor.
   *
   * A note routine is *appended* to the prompt at request time and never
   * touches what is on screen. A prompt routine IS the prompt, so it has to
   * land in the boxes — otherwise the clinician would be looking at one thing
   * and running another.
   */
  const chooseRoutine = useCallback(
    (id: string) => {
      setActiveTemplateId(id);
      const t = templates.find((x) => x.id === id);
      if (!t || t.kind !== "prompt") return;
      setPromptRun({
        systemInstruction: t.systemInstruction ?? "",
        prompt: t.instruction,
      });
      const patch: Partial<Sampling> = {};
      if (t.temperature !== null && t.temperature !== undefined) patch.temperature = t.temperature;
      if (t.topP !== null && t.topP !== undefined) patch.topP = t.topP;
      if (t.topK !== null && t.topK !== undefined) patch.topK = t.topK;
      if (t.maxTokens !== null && t.maxTokens !== undefined) patch.maxTokens = t.maxTokens;
      if (Object.keys(patch).length) setSampling(patch);
    },
    [templates, setPromptRun, setSampling],
  );

  /** Live pipeline stages for the current run. */
  const [progress, setProgress] = useState<Map<PipelineStage, ProgressEvent>>(new Map());
  const [wire, setWire] = useState<{ envelope: CryptoEnvelope; plaintext: string } | null>(null);
  /** Live output from the local model, decrypted, while a run is in flight. */
  const [live, setLive] = useState<{ stage: PipelineStage; text: string } | null>(null);

  // Follow the output as it arrives, the way a terminal does.
  useLayoutEffect(() => {
    const el = liveRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live]);
  const [wireOpen, setWireOpen] = useState(false);
  const queuedRef = useRef(false);

  const runOnce = useCallback(
    async (text: string): Promise<"done" | "busy"> => {
      setProgress(new Map());
      setLive(null);
      try {
        const out = await runPipeline<ProcessNoteResult>({
          text,
          format,
          promptId: activeTemplateId || undefined,
          model: chosenModel || undefined,
          workspace,
          promptRun: workspace === "prompt" ? promptRun : undefined,
          sampling,
          deidSampling,
          patternScrub,
          onSealed: (sealed) => {
            setWire(sealed);
            setStage("Sealed in the browser — sending");
          },
          onStream: (stage, chunk) =>
            setLive((prev) =>
              prev && prev.stage === stage
                ? { stage, text: prev.text + chunk }
                : { stage, text: chunk },
            ),
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
        setLive(null);
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
    [format, activeTemplateId, chosenModel, workspace, promptRun, sampling, deidSampling, patternScrub, loadModels],
  );

  const submit = useCallback(async () => {
    if (!ready) return;

    const text = workspace === "prompt" ? getRunSettings().prompt.prompt : input;
    setSubmitting(true);
    setError(null);
    setResult(null);
    setCopied(null);
    setQueued(null);
    queuedRef.current = true;
    setStage("Encrypting in browser…");

    // The raw note leaves the visible workspace the moment it is sealed: a
    // chart entry sitting on screen is itself a PDPA exposure. A prompt is not
    // patient data by construction, and clearing it would throw away something
    // the user means to iterate on — so that one stays.
    if (workspace === "note") setInput("");

    try {
      // The server refuses rather than queues, to protect the single slot — so
      // the queue lives here, retrying while showing what the box is busy with.
      while (queuedRef.current) {
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
  }, [ready, workspace, input, runOnce, loadModels]);

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

  /**
   * The box is busy if the server says so — or if this tab is the one keeping
   * it busy. Waiting for a poll to confirm what this tab already knows left
   * the badge reading "Online" for up to five seconds into a run, and for the
   * whole of a run shorter than the poll interval.
   */
  const busy = (status?.busy ?? false) || submitting;

  /** Short name of whatever LM Studio has loaded, for labelling its row. */
  const localModelName = status?.lmStudio.requestModel?.split("/").pop() ?? null;

  /**
   * Will this run's output be raw? Before there is a result, that is a
   * question about the destination you have picked; afterwards it is a fact
   * about the run that produced it. Both answers matter, because the copy
   * buttons should already read correctly while you are still typing.
   */
  const rawOutput = result ? !result.meta.deidentified : localDestination;


  return (
    <div className="flex min-h-full flex-col lg:h-full lg:min-h-0">
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
              // The vendor prefix is noise on a chip capped at 9rem: with it,
              // "google/gemma-4-12b" was cut mid-name at 1024px, which is the
              // width this is built for. Short name on the chip, full id in
              // the tooltip — the same choice the model selector makes.
              title={
                status?.lmStudio.online
                  ? `LM Studio · ${status.lmStudio.models[0] ?? "a model is loaded"}${status.lmStudio.busy ? " · working" : ""}`
                  : `LM Studio is not answering${status?.lmStudio.error ? ` — ${status.lmStudio.error}` : ""}`
              }
              label={
                status?.lmStudio.online
                  ? `LM Studio${status.lmStudio.busy ? " (working)" : ""} · ${
                      status.lmStudio.models[0]?.split("/").pop() ?? "loaded"
                    }`
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


      {/* ---------------- workspace ---------------- */}
      <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 gap-3 p-3 sm:gap-4 sm:p-5 lg:min-h-0 lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]">
        {/* ---- input ---- */}
        <section className="flex min-h-[60vh] flex-col overflow-hidden panel rounded-lg border border-[var(--border)] bg-[var(--surface)] lg:min-h-0">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
              {/* Short enough not to wrap beside the counter at 1024, which
                would make this header taller than the other workspace's and
                move every control below it. */}
            {workspace === "prompt" ? "Prompt" : "Raw narrative"}
            </h2>
            <WordCounter size={size} />
          </div>

          {/* EVERY CHOICE ABOVE EVERYTHING YOU WRITE.
               The page now reads in the order it is used: pick what this run
               is and which model does it, set what that workspace needs, then
               write, then press the one button underneath. It also means the
               only thing below the input is the button — so nothing above it
               can move when a selector changes. */}
          <WorkspaceBar
            workspace={workspace}
            onChoose={chooseWorkspace}
            patternScrub={patternScrub}
            error={promptBannerError}
            disabled={submitting}
            localDestination={localDestination}
          />

          <ModelBar
            models={models}
            chosen={chosenModel}
            onChoose={setChosenModel}
            disabled={submitting}
            lmStudio={status?.lmStudio ?? null}
          />

          {/* ---- run detail ----
               Folded away on a phone, where these four rows put the input and
               the run button a thousand pixels down the page. Mode and model
               above stay visible: they are the two choices that change what a
               run does. Open and non-collapsible from `lg`, where there is
               room and the two-panel layout depends on these heights. */}
          <button
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            className="flex w-full items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-left text-[11px] text-[var(--muted)] lg:hidden"
          >
            <SlidersHorizontal className="size-3.5 shrink-0" />
            <span className="font-semibold uppercase tracking-wider">Run detail</span>
            <span className="min-w-0 flex-1 truncate text-[var(--faint)]">
              {workspace === "note" ? NOTE_FORMAT_TITLES[format] : "prompt decides the shape"}
              {activeTemplate ? ` · ${activeTemplate.name}` : ""}
              {!patternScrub && deidentifies(localDestination) ? " · no patterns" : ""}
            </span>
            <ChevronRight
              className={cn("size-4 shrink-0 transition-transform", detailsOpen && "rotate-90")}
            />
          </button>

          <div className={cn("lg:block", !detailsOpen && "hidden")}>
          {/* ---- what this run produces ----
               One row, present in both workspaces, so switching cannot change
               the height of anything below it. */}
          <div className="flex min-h-[3.25rem] flex-wrap items-center gap-1 border-b border-[var(--border)] px-3 py-2 sm:px-4">
            {workspace === "note" ? (
              FORMATS.map((f) => (
                <button
                  key={f.id}
                  title={NOTE_FORMAT_TITLES[f.id]}
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
              ))
            ) : (
              <span className="text-[11px] text-[var(--muted)]">
                Your prompt decides the shape — there is no format to pick.
              </span>
            )}
          </div>

          {/* ---- sampling, named for the model it drives ----
               Two rows, both always present so nothing below them moves. The
               top one is the de-identification pass, which only runs on a
               cloud-bound note; the bottom one is whichever model answers. A
               row of unlabelled numbers is a row of numbers nobody can act on,
               so each says whose it is. */}
          <SamplingRow
            icon={ShieldCheck}
            label={
              deidentifies(localDestination)
                ? `De-identification · ${localModelName ?? "local model"}`
                : "De-identification · not used"
            }
            hint={
              deidentifies(localDestination)
                ? "The pass that strips identifiers before anything is sent to Google. The prompt is fixed; these are not. Temperature above 0 costs recall — an invented span is discarded, so it buys nothing."
                : "Nothing is de-identified on a local run, so these do not apply. Pick a Gemini model and they come back."
            }
            values={deidSampling}
            onChange={setDeidSampling}
            disabled={submitting || !deidentifies(localDestination)}
          >
            {/* The deterministic pass, as a switch rather than a law.
                It is high-precision and over-eager by design — that is the
                trade — and on some notes the over-eagerness costs more than it
                saves: a bed number reads as a month/day, an accession number
                reads as an MRN. Off, the local model alone is responsible for
                every identifier, including the structured ones the rules would
                have caught for certain. Marked, warned about, and recorded on
                the audit row. */}
            <label
              className={cn(
                "mr-3 flex shrink-0 items-center gap-1.5",
                deidentifies(localDestination) ? "cursor-pointer" : "cursor-not-allowed",
              )}
              title={
                patternScrub
                  ? "Pattern rules ON: Taiwan IDs, MRNs, phone numbers and dates are removed deterministically before the model looks. Deliberately over-eager — a bed number can read as a date."
                  : "Pattern rules OFF: the local model alone must catch every identifier, including the structured ones the rules would have caught for certain. Recorded on the audit row."
              }
            >
              <input
                type="checkbox"
                checked={patternScrub}
                disabled={submitting || !deidentifies(localDestination)}
                onChange={(e) => setPatternScrub(e.target.checked)}
                className="size-3.5 shrink-0 accent-[var(--accent-solid)] disabled:cursor-not-allowed"
              />
              <span
                className={cn(
                  "whitespace-nowrap text-[10px] uppercase tracking-wider",
                  !patternScrub && deidentifies(localDestination)
                    ? "font-semibold text-amber-700 dark:text-amber-400"
                    : "text-[var(--muted)]",
                )}
              >
                Patterns
              </span>
            </label>
          </SamplingRow>

          <SamplingRow
            icon={localDestination ? Cpu : Cloud}
            label={
              localDestination
                ? `Local model · ${localModelName ?? "LM Studio"}`
                : `Google Gemini · ${chosenModel || "ladder"}`
            }
            hint={
              localDestination
                ? "Sampling for the model on this Mac — the one that writes the answer."
                : "Sampling for the Gemini model that writes the answer. Anything left at its off value is not sent, so Google's own default applies."
            }
            values={sampling}
            onChange={setSampling}
            disabled={submitting}
          />

          {/* ---- saved routine ---- */}
          <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-1.5 sm:px-4 sm:py-2">
            <BookMarked className="size-3.5 shrink-0 text-[var(--muted)]" />
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Saved routine
            </span>
            <select
              aria-label="Saved specialty routine"
              value={activeTemplateId}
              onChange={(e) => chooseRoutine(e.target.value)}
              disabled={submitting}
              className="min-w-0 flex-1 cursor-pointer truncate bg-transparent text-xs outline-none disabled:cursor-not-allowed disabled:text-[var(--muted)]"
            >
              <option value="">
                {routineRequired ? "Pick one — “Others” has no built-in shape" : "None — no saved routine"}
              </option>
              {visibleTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.specialty ? `${t.specialty} — ${t.name}` : t.name}
                  {t.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => setLibraryOpen(true)}
              className={cn(
                "shrink-0 rounded border px-2 py-1 text-[11px]",
                routineRequired
                  ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
              )}
            >
              Manage
            </button>
          </div>

          </div>

          {/* The workspace IS the left panel. A narrative in one, a system
              instruction and a prompt in the other — rather than a narrative
              box that quietly stops meaning "narrative". */}
          {workspace === "prompt" ? (
            <div className="scroll-visible flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
              <label className="block shrink-0">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  System instruction
                  <span className="ml-1.5 font-normal normal-case tracking-normal">
                    — optional; how the model should behave
                  </span>
                </span>
                <textarea
                  aria-label="System instruction"
                  value={promptRun.systemInstruction}
                  onChange={(e) => setPromptRun({ systemInstruction: e.target.value })}
                  onKeyDown={onKeyDown}
                  disabled={submitting}
                  spellCheck={false}
                  rows={4}
                  placeholder="You are a careful clinical assistant…"
                  className="scroll-visible mt-1 block max-h-40 w-full resize-y overflow-auto rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[12px] leading-relaxed outline-none placeholder:text-[var(--muted)]/60 disabled:cursor-not-allowed disabled:text-[var(--muted)]"
                />
              </label>
              <label className="flex min-h-0 flex-1 flex-col">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Prompt
                  <span className="ml-1.5 font-normal normal-case tracking-normal">
                    — Cmd/Ctrl + Enter to run
                  </span>
                </span>
                <textarea
                  aria-label="Prompt"
                  value={promptRun.prompt}
                  onChange={(e) => setPromptRun({ prompt: e.target.value })}
                  onKeyDown={onKeyDown}
                  disabled={submitting}
                  spellCheck={false}
                  rows={12}
                  placeholder="Ask anything. On Gemini this is de-identified first; on the local model it goes as written."
                  className="scroll-visible mt-1 block min-h-[8rem] w-full flex-1 resize-y overflow-auto rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[13px] leading-relaxed outline-none placeholder:text-[var(--muted)]/60 disabled:cursor-not-allowed disabled:text-[var(--muted)]"
                />
              </label>
            </div>
          ) : (
            /* Scroll container: the textarea itself grows to fit the note. */
            <div className="min-h-0 flex-1 overflow-y-auto">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                disabled={submitting}
                spellCheck={false}
                rows={10}
                placeholder={
                  "Paste or dictate the ward narrative here — names, IDs, dates and MRNs are stripped on this machine before anything reaches the cloud.\n\nCmd/Ctrl + Enter to run."
                }
                className="field-flush block min-h-[26vh] w-full resize-none overflow-hidden bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed outline-none placeholder:text-[var(--muted)]/60 md:min-h-[36vh] xl:min-h-[46vh]"
              />
            </div>
          )}

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

          <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-2 sm:px-4 sm:py-3">
            <button
              onClick={() => void submit()}
              disabled={!ready}
              title={ready ? "Cmd/Ctrl + Enter" : disabledReason}
              className="ml-auto flex items-center gap-2 rounded bg-[var(--accent-solid)] px-4 py-1.5 text-sm font-medium text-[var(--on-accent)] transition-opacity disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-[var(--border)]/40 disabled:text-[var(--faint)]"
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
              {submitting ? "Processing" : workspace === "prompt" ? "Encrypt & run" : "Encrypt & structure"}
            </button>
          </div>

        </section>

        {/* ---- output ---- */}
        <section className="flex min-h-[60vh] flex-col overflow-hidden panel rounded-lg border border-[var(--border)] bg-[var(--surface)] lg:min-h-0">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
              {workspace === "prompt" ? "Output" : "Structured note"}
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
              {result && result.meta.deidentified && (
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
                title={
                  rawOutput
                    ? "The model's answer, exactly as it came back. Nothing is redacted on a local run, so there is only one version of it."
                    : "The finished note with the real names, MRN and dates put back. This is what goes in the chart."
                }
                className="flex items-center gap-1.5 rounded border border-[var(--accent-solid)] bg-[var(--accent-solid)] px-2 py-1 text-[11px] text-[var(--on-accent)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--faint)]"
              >
                {copied === "identified" ? (
                  <CheckCheck className="size-3.5 shrink-0" />
                ) : (
                  <Copy className="size-3.5 shrink-0" />
                )}
                {copied === "identified"
                  ? "Copied"
                  : rawOutput
                    ? "Copy output"
                    : workspace === "prompt"
                      ? "Copy answer · with names"
                      : "Copy note · with names"}
              </button>

              {/* There is no second version of a local run. Nothing was
                  replaced, so a "de-identified" copy would be the same text
                  under a name that promises something it did not do. */}
              {!rawOutput && (
                <button
                  onClick={() => void copyNote("deidentified")}
                  disabled={!result}
                  title="The placeholder version — [PATIENT_1], [MRN_1] and so on. This is exactly what the formatting model was given, and carries no identifiers."
                  className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)] disabled:text-[var(--faint)] disabled:hover:text-[var(--faint)]"
                >
                  {copied === "deidentified" ? (
                    <CheckCheck className="size-3.5 text-[var(--accent)]" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copied === "deidentified" ? "Copied" : "Copy de-identified"}
                </button>
              )}
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
                <PipelineProgress
                  progress={progress}
                  paused={Boolean(queued)}
                  localDestination={localDestination}
                  stages={stagesFor(localDestination, patternScrub)}
                />

                {/* The local model writing, as it writes. A minute of spinner
                    on a large model is indistinguishable from a hang; this is
                    the difference. Each chunk arrived sealed with the same key
                    as the result, so nothing is given away by showing it. */}
                {live && (
                  <div className="rounded border border-[var(--border)] bg-[var(--background)]">
                    <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5">
                      <Cpu className="size-3 shrink-0 text-emerald-700 dark:text-emerald-400" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                        {live.stage === "ner"
                          ? "Local model — finding identifiers"
                          : "Local model — writing"}
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">
                        {live.text.length.toLocaleString()} chars
                      </span>
                    </div>
                    <pre
                      ref={liveRef}
                      className="scroll-visible max-h-48 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] leading-relaxed"
                    >
                      {live.text}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {!submitting && !error && !result && (
              <p className="text-sm text-[var(--muted)]">
                {localDestination
                  ? `${workspace === "prompt" ? "The answer" : "The formatted note"} appears here. Nothing is de-identified and nothing is logged — this is your machine talking to your model.`
                  : `${workspace === "prompt" ? "The answer" : "The formatted note"} appears here with identifiers restored. Only placeholder text ever leaves this machine.`}
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
              {result.meta.destination === "local" && (
                <span
                  title="Written by the model on this Mac. No outbound call at all, and no audit row — this run is not in History."
                  className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400"
                >
                  <Cpu className="size-3" />
                  stayed on this Mac
                </span>
              )}
              {result.meta.workspace === "prompt" && (
                <span
                  title="Produced by your own prompt. It was not stored — the audit row records that, not the text."
                  className="text-amber-700 dark:text-amber-400"
                >
                  custom prompt
                </span>
              )}
              {result.meta.deidentified && !result.meta.patternScrub && (
                <span
                  title="This note ran with the deterministic pattern rules switched off — the local model alone was responsible for every identifier. The audit row records it."
                  className="text-amber-700 dark:text-amber-400"
                >
                  no pattern rules
                </span>
              )}
              {!result.meta.deidentified && (
                <span
                  title="This ran raw on the local model: nothing was redacted, and nothing was written to the note log."
                  className="text-amber-700 dark:text-amber-400"
                >
                  not de-identified · not logged
                </span>
              )}
              {result.meta.promptTemplateName && <span>routine {result.meta.promptTemplateName}</span>}
              {result.meta.deidentified && <span>scrub {result.meta.scrubMs} ms</span>}
              <span>
                {result.meta.destination === "local" ? "local" : "cloud"} {result.meta.geminiMs} ms
              </span>
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
      {wireOpen && wire && <WireView wire={wire} onClose={() => setWireOpen(false)} />}
      {historyOpen && (
        <HistoryDrawer
          onClose={() => setHistoryOpen(false)}
          onReuse={(text) => {
            // Reusing a past note always lands in the note workspace: it is a
            // narrative, and dropping it into a prompt box would be nonsense.
            chooseWorkspace("note");
            setInput(text);
            setHistoryOpen(false);
          }}
        />
      )}
      {libraryOpen && (
        <PromptLibrary
          workspace={workspace}
          promptRun={promptRun}
          sampling={sampling}
          templates={templates}
          onClose={() => setLibraryOpen(false)}
          onChanged={loadTemplates}
        />
      )}
    </div>
  );
}



/* ------------------------------------------------------------------ */
/* Drawer behaviour                                                    */
/* ------------------------------------------------------------------ */

/**
 * Everything a drawer has to do besides render.
 *
 * Seven drawers open over this page and every one of them was missing the
 * same four things: Escape did nothing, focus stayed on the button behind the
 * overlay, Tab walked through the thirty controls underneath it, and the page
 * scrolled when you turned the wheel over a drawer that had already reached
 * its own end. Measured at 1024x600, a wheel gesture over an open drawer moved
 * the page behind it 342px.
 *
 * Returns a ref for the drawer's own element. Attach it and pass
 * `role="dialog" aria-modal="true"`, which the callers do.
 */
function useDrawer(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  // Held in a ref so the effect runs once per open, not on every parent
  // render — re-running it would yank focus back to the top mid-typing.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => el.offsetParent !== null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Keep Tab inside the drawer rather than walking the page behind it.
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !ref.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The close button is first in every drawer's markup and is a safe, quiet
    // landing place — it does not read a whole panel of text at the reader.
    focusable()[0]?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      // Put the keyboard back where it was, or the next Tab starts from the
      // top of the document.
      opener?.focus?.();
    };
  }, []);

  return ref;
}

/* ------------------------------------------------------------------ */
/* Run mode                                                            */
/* ------------------------------------------------------------------ */

/**
 * One labelled row of sampling numbers.
 *
 * Used twice — once for the de-identification pass and once for whichever
 * model answers — because those are two different models doing two different
 * jobs, and a single unlabelled row of numbers left it ambiguous which was
 * being tuned.
 */
function SamplingRow({
  icon: Icon,
  label,
  hint,
  values,
  onChange,
  disabled,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  values: Sampling;
  onChange: (patch: Partial<Sampling>) => void;
  disabled: boolean;
  /** An extra control belonging to this row, shown before the numbers. */
  children?: React.ReactNode;
}) {
  return (
    <div
      // Not `opacity`: dimming drags text toward whatever it sits on, and the
      // contrast audit caught these ten labels at 2.78:1 while a run was in
      // flight. The disabled state is a quieter COLOUR, which stays legible.
      className={cn(
        "flex min-h-[2.75rem] flex-wrap items-center gap-x-1 gap-y-1 border-b border-[var(--border)] px-3 sm:px-4",
        disabled && "bg-[var(--background)]",
      )}
      title={hint}
    >
      <Icon className="mr-1 size-3.5 shrink-0 text-[var(--muted)]" />
      <span className="mr-2 min-w-0 max-w-[11rem] truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
        {label}
      </span>
      {children}
      {SAMPLING_PARAMS.map((param) => (
        <label
          key={param.key}
          className="mr-2 flex items-center gap-1"
          title={`${param.label} — ${param.hint}`}
        >
          <span className="whitespace-nowrap text-[10px] uppercase tracking-wider text-[var(--muted)]">
            {param.label}
          </span>
          <input
            type="number"
            aria-label={`${label} ${param.label}`}
            value={values[param.key]}
            min={param.min}
            max={param.max}
            step={param.step}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange({ [param.key]: n } as Partial<Sampling>);
            }}
            className="w-[4rem] rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-right font-mono text-[11px] outline-none disabled:cursor-not-allowed disabled:text-[var(--muted)]"
          />
        </label>
      ))}
    </div>
  );
}

/**
 * Which workspace, as a two-state toggle directly above the model bar.
 *
 * These two controls answer the same question between them — what am I doing,
 * and which model does it — so they belong together. It is a toggle rather
 * than two buttons because there are exactly two states and only one can hold.
 *
 * The strip below it is the one that matters: what a run does to your text
 * depends on the workspace AND the destination, and this is where that is
 * stated in words rather than left to be inferred from two separate chips.
 */
function WorkspaceBar({
  workspace,
  onChoose,
  error,
  disabled,
  localDestination,
  patternScrub,
}: {
  workspace: Workspace;
  onChoose: (workspace: Workspace) => void;
  error: string | null;
  disabled: boolean;
  localDestination: boolean;
  /** False turns the notice into a warning: the rules are not running. */
  patternScrub: boolean;
}) {
  const active = WORKSPACES.find((w) => w.id === workspace) ?? WORKSPACES[0];
  // The notice tracks the DESTINATION, because that is what decides what
  // happens to the text. A local run is raw whichever workspace asked for it.
  const raw = localDestination;
  const warn = raw || !patternScrub;
  const notice = raw
    ? {
        short: "Nothing de-identified, nothing logged — stays on this Mac.",
        full: "The local model gets your text exactly as written. Nothing leaves this Mac, and no row is written to the note log, so this run will not appear in History. Switch to a Gemini model and the de-identification passes come back automatically.",
      }
    : patternScrub
      ? {
          short: "De-identified on this Mac before anything reaches Google.",
          full: "Both de-identification passes run here before anything is sent, and the answer is re-hydrated on the way back. The run is refused outright if the local model is not available to do it.",
        }
      : {
          short: "Pattern rules off — the local model alone must catch every identifier.",
          full: "The deterministic pass is switched off, so IDs, MRNs, phone numbers and dates are no longer removed for certain before the model looks — the local model has to find them, and it is probabilistic where the rules were not. Read the redaction list before filing. The audit row records that this note ran without them.",
        };

  return (
    <div className="border-t border-[var(--border)]">
      <div className="flex flex-nowrap items-center gap-x-3 px-3 py-2 sm:px-4 sm:py-2.5">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Mode
        </span>

        {/* Segmented toggle. The track is a solid token rather than an alpha
            wash — a translucent fill over an off-white panel is exactly what
            once made inactive controls hard to read in light mode. */}
        <div
          role="group"
          aria-label="Workspace"
          className="inline-flex shrink-0 rounded-full border border-[var(--border)] bg-[var(--background)] p-0.5"
        >
          {WORKSPACES.map((w) => {
            const Icon = w.icon;
            const chosen = w.id === workspace;
            return (
              <button
                key={w.id}
                onClick={() => onChoose(w.id)}
                disabled={disabled}
                aria-pressed={chosen}
                title={w.blurb}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed",
                  chosen
                    ? "bg-[var(--accent-solid)] text-[var(--on-accent)]"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                {w.label}
              </button>
            );
          })}
        </div>

        {/* The summary and the parameters used to share this space, and at
            1024px the summary lost it entirely — measured at 0px wide. They
            do not need to share it: when the parameters are here, the notice
            directly below already explains the workspace, so the one-line
            summary has nothing left to say. */}
        {/* The summary has this space to itself now — the sampling parameters
            moved up to the settings row, where they sit in the slot the format
            buttons occupy in the other workspace. Nothing competes, so nothing
            truncates. */}
        <p
          title={active.blurb}
          className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]"
        >
          {active.summary}
        </p>
      </div>

      {/* ALWAYS PRESENT, ALWAYS ONE LINE.
          This used to appear and disappear, and inside a panel of fixed height
          that stole space from the textarea above it — which moved the toggle
          the moment you pressed it. A line that is always here cannot do that,
          and it is the most useful line on the page anyway: it says what this
          particular run will do to your text, in four words or so. */}
      <div
        className={cn(
          "flex items-center gap-2 border-t px-3 py-1.5 text-[11px] sm:px-4",
          error
            ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
            : warn
              ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "border-[var(--border)] bg-[var(--background)] text-[var(--muted)]",
        )}
      >
        {error || warn ? (
          <AlertTriangle className="size-3.5 shrink-0" />
        ) : (
          <ShieldCheck className="size-3.5 shrink-0 text-[var(--accent)]" />
        )}
        <span className="min-w-0 flex-1 truncate" title={error ?? notice.full}>
          {error ?? notice.short}
        </span>
      </div>
    </div>
  );
}

/**
 * Who writes the note: this Mac, or a rung of the Gemini ladder.
 *
 * The local option lives here rather than in its own control because it
 * answers the same question the ladder does. It is placed first and fenced off
 * with a divider, because it is not a rung — it does not participate in the
 * fallback walk, has no quota to spend, and crosses no boundary. Choosing it
 * means the request makes no outbound call at all.
 *
 * A cloud rung greys out only once Google has actually refused it —
 * availability is observed, never predicted. Picking a rung sets where the run
 * *starts*; if it is spent by the time the note is sent, the server walks down
 * from there and says so in the progress list.
 */
function ModelBar({
  models,
  chosen,
  onChoose,
  disabled,
  lmStudio,
}: {
  models: ModelAvailability[];
  chosen: string;
  onChoose: (id: string) => void;
  disabled: boolean;
  /** Health of the local server — the local option's own availability. */
  lmStudio: StatusPayload["lmStudio"] | null;
}) {
  const local = chosen === LOCAL_MODEL_ID;
  const localReady = Boolean(lmStudio?.online);
  // Detected from LM Studio, exactly like the status badge in the header —
  // there is nothing to configure and nothing that can go stale.
  const detected = lmStudio?.requestModel ?? lmStudio?.models[0] ?? null;
  // "google/gemma-4-12b" does not fit on a chip. The full id is in the tooltip.
  const localName = detected?.split("/").pop() ?? null;
  // LM Studio reports "not online" both when it is unreachable and when it is
  // up with nothing loaded. Only the first carries an error string, and the
  // two need different advice.
  const localHint = lmStudio?.error
    ? "LM Studio is not reachable"
    : "LM Studio has no model loaded";

  if (models.length === 0 && !lmStudio) return null;

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
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        {local ? (
          <Cpu className="size-3.5 text-emerald-700 dark:text-emerald-400" />
        ) : (
          <Cloud className="size-3.5 text-[var(--muted)]" />
        )}
        <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          {local
            ? `Running on this Mac${detected ? ` · ${detected}` : ""} — nothing leaves, nothing logged`
            : "Model — cloud ladder falls back rightward"}
        </span>
        {!local && nextUp && nextUp.id !== chosen && (
          <span className="text-[10px] text-amber-700 dark:text-amber-400">
            starts on {nextUp.label}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {/* Reads like the status badges in the header: a light that is on when
            LM Studio answers, and the name of whatever it has loaded. There is
            no model to choose and nothing to keep in step — the name is
            detected on every status poll. */}
        <button
          onClick={() => onChoose(LOCAL_MODEL_ID)}
          disabled={disabled || !localReady}
          title={
            localReady
              ? `${detected} — detected in LM Studio. Runs on this Mac: no cloud call, no quota, and no de-identification, because nothing leaves the box.`
              : `${localHint}, so there is no local model to write with.`
          }
          className={cn(
            "flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed",
            !localReady
              ? "border-[var(--border)] bg-[var(--background)] text-[var(--muted)]"
              : local
                ? "border-[var(--accent-solid)] bg-[var(--accent-solid)] text-[var(--on-accent)]"
                // Plain border when unselected. A green outline on a control
                // nobody has chosen reads as an alert; the lit dot inside
                // already says the model was detected.
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
          )}
        >
          {/* Solid dot, not a translucent one: an alpha wash over an off-white
              panel is what once made a control invisible in light mode. */}
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              !localReady
                ? "bg-[var(--faint)]"
                : local
                  ? "bg-[var(--on-accent)]"
                  : "bg-emerald-600 dark:bg-emerald-400",
            )}
          />
          <Cpu className="size-3 shrink-0" />
          Local
          {localReady && localName ? (
            <span
              className={cn(
                "font-mono text-[9px]",
                local ? "text-[var(--on-accent)]/80" : "text-[var(--muted)]",
              )}
            >
              {localName}
            </span>
          ) : (
            <span className="text-[var(--muted)]">· {lmStudio?.error ? "offline" : "no model"}</span>
          )}
        </button>

        {models.length > 0 && (
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[var(--border)]" />
        )}

        {models.map((m) => {
          const isChosen = m.id === chosen;
          // Gemini is unreachable without the local model, because everything
          // bound for Google is de-identified first and that pass runs in LM
          // Studio. Greying the rungs out states the rule where it applies,
          // instead of letting the run fail closed after the click.
          const spent = !m.available || !localReady;
          return (
            <button
              key={m.id}
              onClick={() => onChoose(m.id)}
              disabled={disabled || !localReady}
              title={
                !localReady
                  ? `${m.id} needs the local model: everything sent to Google is de-identified first, and that pass runs in LM Studio. ${localHint}.`
                  : spent
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
              {spent && localReady && (
                <span className="text-[var(--muted)]">· {resetHint(m)}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* One line, always — for the same reason the notice above is: a caption
          that comes and goes changes the height of everything around it. */}
      <p
        className={cn(
          "mt-1.5 truncate text-[10px]",
          !localReady || (!local && !nextUp)
            ? "text-rose-700 dark:text-rose-400"
            : "text-[var(--muted)]",
        )}
        title={
          !localReady
            ? `${localHint}. The cloud rungs need it for de-identification and the local option needs it to answer.`
            : local
              ? "Your text reaches the model as written, and the run leaves no audit row, so it will not appear in History. The draft will be weaker than a Flash model."
              : "A rung greys out only once Google has actually refused it. If the one you pick is spent by the time you run, the server walks down from there and says so."
        }
      >
        {!localReady
          ? `${localHint} — nothing can run until it is up.`
          : local
            ? "Raw and unlogged. Weaker draft than a Flash model, and no quota to spend."
            : !nextUp
              ? "Every cloud model is spent. Pick Local to keep working until quota resets."
              : "Google never sees an identifier — the local model strips them first."}
      </p>
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
  localDestination,
  stages,
}: {
  progress: Map<PipelineStage, ProgressEvent>;
  paused: boolean;
  /** When true the format stage is drawn as a Mac step, because it is one. */
  localDestination: boolean;
  /**
   * The stages this run will actually emit. A raw local prompt performs three
   * of the seven, and listing four it will never reach reads as a run that
   * stalled rather than one that had less to do.
   */
  stages: PipelineStage[];
}) {
  return (
    <ol className="space-y-0.5">
      {stages.map((stage) => {
        const ev = progress.get(stage);
        const locus = LOCUS_STYLE[stageLocus(stage, localDestination)];
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
            <span className="flex-1 truncate">{stageTitle(stage, localDestination)}</span>

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

  const drawerRef = useDrawer(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Past notes"
          tabIndex={-1}
          className="drawer-panel relative flex h-full w-full max-w-2xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
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

  const drawerRef = useDrawer(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Wire view"
          tabIndex={-1}
          className="drawer-panel relative flex h-full w-full max-w-3xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
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
            <WireStat label="Wrapped AES key" value={`${keyBytes.length} B`} sub="RSA-OAEP-2048" />
            <WireStat label="Nonce (iv)" value={`${ivBytes.length} B`} sub="AES-GCM" />
            <WireStat label="Ciphertext" value={`${dataBytes.length} B`} sub={`${note.length} chars in`} />
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

function WireStat({ label, value, sub }: { label: string; value: string; sub: string }) {
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
  local: {
    /** The model actually answering right now. */
    model: string;
    /** What LM Studio has loaded, or null when it is unreachable. */
    loadedModel: string | null;
    /** What LMSTUDIO_MODEL pins each request to, or null when unset. */
    configuredModel: string | null;
    prompt: string;
  };
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

  const drawerRef = useDrawer(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="What each model is told"
          tabIndex={-1}
          className="drawer-panel relative flex h-full w-full max-w-3xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
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
              {/* The name above is read from LM Studio, not from the config.
                  When the two disagree the pin is what each request asks for,
                  which is worth saying out loud rather than quietly showing
                  one of the two names. */}
              {/* Not a warning any more: detection wins, so a stale
                  LMSTUDIO_MODEL changes nothing. Worth one quiet line so the
                  value in .env does not look like it is in force. */}
              {cfg.local.loadedModel &&
                cfg.local.configuredModel &&
                cfg.local.loadedModel !== cfg.local.configuredModel && (
                  <p className="mb-3 text-[11px] leading-relaxed text-[var(--muted)]">
                    <code className="font-mono">LMSTUDIO_MODEL</code> is set to{" "}
                    <span className="font-mono">{cfg.local.configuredModel}</span> and is not in
                    use — the loaded model above is detected from LM Studio and is what reads the
                    notes. The setting is only a fallback for when LM Studio cannot be reached.
                  </p>
                )}
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
                  <strong className="font-semibold">saved routine</strong>, or into the Custom
                  prompt workspace for a one-off. Both are read <em>beneath</em> these rules, so
                  neither can override the parts that protect the patient.
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
  const drawerRef = useDrawer(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="How it works"
          tabIndex={-1}
          className="drawer-panel relative flex h-full w-full max-w-xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
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

const BLANK = {
  name: "",
  specialty: "",
  instruction: "",
  systemInstruction: "",
  format: "",
  isDefault: false,
  /**
   * A prompt routine stores the sampling it was saved with. Held in the draft
   * rather than read off the screen at save time, because editing a routine's
   * NAME must not silently replace the numbers it restores with whatever
   * happens to be in the sampling row at that moment.
   */
  sampling: null as Sampling | null,
};

function PromptLibrary({
  templates,
  onClose,
  onChanged,
  workspace,
  promptRun,
  sampling,
}: {
  templates: PromptTemplate[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  /** Which kind of routine this drawer creates. */
  workspace: Workspace;
  /** Offered as the starting point for a new prompt routine. */
  promptRun: PromptRun;
  sampling: Sampling;
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

  const isPrompt = workspace === "prompt";
  const visible = templates.filter((t) => (t.kind === "prompt") === isPrompt);

  const startEdit = (t: PromptTemplate) => {
    setEditingId(t.id);
    setDraft({
      name: t.name,
      specialty: t.specialty ?? "",
      instruction: t.instruction,
      systemInstruction: t.systemInstruction ?? "",
      format: t.format ?? "",
      isDefault: t.isDefault,
      // Its own saved numbers, not the ones on screen. A row with nulls
      // (written before routines carried sampling) keeps them.
      sampling: {
        temperature: t.temperature ?? SAMPLING_DEFAULTS.temperature,
        topP: t.topP ?? SAMPLING_DEFAULTS.topP,
        topK: t.topK ?? SAMPLING_DEFAULTS.topK,
        maxTokens: t.maxTokens ?? SAMPLING_DEFAULTS.maxTokens,
      },
    });
    setError(null);
  };

  /**
   * Pull the live workspace — both bodies and the sampling — into the draft.
   *
   * Deliberately does NOT leave edit mode. It is the only way to change what an
   * existing prompt routine restores, now that saving an edit keeps the
   * routine's own numbers rather than silently adopting whatever was on screen.
   */
  const pullFromScreen = () => {
    setDraft((d) => ({
      ...d,
      instruction: promptRun.prompt,
      systemInstruction: promptRun.systemInstruction,
      sampling,
    }));
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(editingId ? `/api/prompts/${editingId}` : "/api/prompts", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          sampling: undefined,
          kind: workspace,
          // A prompt routine carries its sampling, so selecting it later
          // restores the whole run and not just the words. A new one starts
          // from what is on screen; an edit keeps the routine's own numbers
          // unless "Use what is on screen" is pressed — otherwise renaming a
          // routine would silently replace what it restores.
          ...(isPrompt ? (draft.sampling ?? sampling) : {}),
        }),
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

  const drawerRef = useDrawer(onClose);
  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Specialty routines"
          tabIndex={-1}
          className="drawer-panel relative flex h-full w-full max-w-2xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Specialty routines</h3>
            <p className="text-[11px] text-[var(--muted)]">
              {workspace === "prompt"
                ? "Saved prompts, with their sampling. Configuration only — never patient data."
                : "Saved instructions appended to every note. Configuration only — never patient data."}
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
            {visible.length === 0 && (
              <li className="px-4 py-3 text-sm text-[var(--muted)]">
                No routines yet. Create one below — e.g. a nephrology round that always wants the
                dialysis access and dry weight called out.
              </li>
            )}
            {visible.map((t) => (
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
                {editingId
                  ? "Edit routine"
                  : workspace === "prompt"
                    ? "New prompt routine"
                    : "New note routine"}
              </h4>
              {workspace === "prompt" && (
                <button
                  onClick={pullFromScreen}
                  title="Copy the system instruction, the prompt and the sampling from the workspace into this draft."
                  className={cn(
                    "rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]",
                    !editingId && "ml-auto",
                  )}
                >
                  Use what is on screen
                </button>
              )}
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

            {workspace === "prompt" && (
              <label className="block">
                <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                  System instruction
                </span>
                <textarea
                  value={draft.systemInstruction}
                  onChange={(e) => setDraft({ ...draft, systemInstruction: e.target.value })}
                  rows={4}
                  placeholder="You are a careful clinical assistant…"
                  className="mt-1 w-full resize-y rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[12px] leading-relaxed outline-none"
                />
              </label>
            )}

            {workspace === "note" && (
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
            )}

            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
                {workspace === "prompt" ? "Prompt" : "Instruction to the model"}
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
/**
 * Inline markdown: code, bold, italic, strikethrough, links.
 *
 * One pass, one alternation, so the pieces cannot fight each other — a naive
 * chain of `split`s turns `**a `b` c**` into nonsense. Everything is rendered
 * as React children, never as HTML, so a model cannot emit markup that runs.
 */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const pattern =
    /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(__[^_]+__)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  const push = (node: React.ReactNode) => out.push(node);

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) push(<span key={`${keyBase}-t${i++}`}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    const key = `${keyBase}-m${i++}`;

    if (tok.startsWith("`")) {
      push(
        <code
          key={key}
          className="rounded bg-[var(--border)]/50 px-1 py-0.5 font-mono text-[0.95em]"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("***")) {
      push(
        <strong key={key} className="font-semibold italic text-[var(--foreground)]">
          {tok.slice(3, -3)}
        </strong>,
      );
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      push(
        <strong key={key} className="font-semibold text-[var(--foreground)]">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("~~")) {
      push(
        <span key={key} className="line-through decoration-[var(--muted)]">
          {tok.slice(2, -2)}
        </span>,
      );
    } else if (tok.startsWith("[")) {
      const split = tok.indexOf("](");
      const label = tok.slice(1, split);
      const href = tok.slice(split + 2, -1);
      // Only http(s). A model emitting `javascript:` is not a threat we have
      // to render.
      push(
        /^https?:\/\//i.test(href) ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-[var(--muted)] underline-offset-2 hover:text-[var(--accent)]"
          >
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else {
      push(
        <em key={key} className="italic">
          {tok.slice(1, -1)}
        </em>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) push(<span key={`${keyBase}-t${i++}`}>{text.slice(last)}</span>);
  return out;
}

/** A pipe-table row split into cells, with the outer pipes discarded. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * The finished note, rendered.
 *
 * Models emit whatever markdown they feel like — fenced blocks, pipe tables of
 * labs, nested plans, the occasional blockquote — and a renderer that only
 * knew `**bold**` showed the rest as literal asterisks and pipes in the middle
 * of a chart entry. This handles what they actually produce.
 *
 * Block-level parsing is a small state machine over the lines rather than a
 * dependency: this page holds PHI, and a markdown library is a supply chain.
 */
function NoteBody({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;

    // ``` fenced code ```
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence
      blocks.push(
        <pre
          key={key}
          className="scroll-visible my-2 overflow-x-auto rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12px] leading-relaxed"
        >
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    // | a | b |   with a |---|---| under it
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const head = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(tableCells(lines[i++]));
      }
      blocks.push(
        <div key={key} className="scroll-visible my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {head.map((c, x) => (
                  <th key={x} className="px-2 py-1 text-left font-semibold">
                    {inline(c, `${key}h${x}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y} className="border-b border-[var(--border)]/50">
                  {r.map((c, x) => (
                    <td key={x} className="px-2 py-1 align-top">
                      {inline(c, `${key}r${y}c${x}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    i++;

    if (!line.trim()) {
      blocks.push(<div key={key} className="h-2.5" />);
      continue;
    }

    // --- horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={key} className="my-3 border-[var(--border)]" />);
      continue;
    }

    // > blockquote
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push(
        <div
          key={key}
          className="my-1 border-l-2 border-[var(--border)] pl-3 text-[var(--muted)]"
        >
          {inline(quote[1], key)}
        </div>,
      );
      continue;
    }

    // # heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <h3
          key={key}
          className={cn(
            "mt-3 mb-1 font-semibold tracking-wide",
            heading[1].length <= 2
              ? "border-b border-[var(--border)] pb-1 text-[14px]"
              : "text-[13px]",
          )}
        >
          {inline(heading[2], key)}
        </h3>,
      );
      continue;
    }

    // A line that is nothing but a bold run is how most models write a
    // section header, whatever the prompt asked for.
    const boldOnly = line.trim().match(/^\*\*(.+)\*\*:?$/);
    if (boldOnly) {
      blocks.push(
        <h3
          key={key}
          className="mt-3 mb-1 border-b border-[var(--border)] pb-1 text-[13px] font-semibold tracking-wide"
        >
          {boldOnly[1]}
        </h3>,
      );
      continue;
    }

    // - bullets and 1. numbers, nested by their indentation
    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      const depth = Math.min(3, Math.floor(listItem[1].replace(/\t/g, "  ").length / 2));
      const ordered = /\d/.test(listItem[2]);
      blocks.push(
        <div key={key} className="flex gap-2" style={{ paddingLeft: `${depth * 1.1 + 0.25}rem` }}>
          <span
            className={cn(
              "select-none text-[var(--muted)]",
              ordered ? "min-w-[1.4rem] text-right" : "min-w-[0.75rem]",
            )}
          >
            {ordered ? listItem[2] : "•"}
          </span>
          <span className="min-w-0 flex-1">{inline(listItem[3], key)}</span>
        </div>,
      );
      continue;
    }

    blocks.push(
      <div key={key} className="whitespace-pre-wrap">
        {inline(line, key)}
      </div>,
    );
  }

  return <div className="font-mono text-[13px] leading-relaxed">{blocks}</div>;
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

  const drawerRef = useDrawer(onClose);
  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Redaction inspector"
          tabIndex={-1}
          className="drawer-panel relative flex h-full w-full max-w-xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">PII Scrubbed Inspector</h3>
            <p className="text-[11px] text-[var(--muted)]">
              Exactly what the formatting model received
              {meta.destination === "local" ? ", here on this Mac" : ", at Google"}. Values are
              masked here too.
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
              {meta.destination === "local"
                ? "De-identified prompt given to the local model"
                : "De-identified prompt sent to Gemini"}
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
