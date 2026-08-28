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
  CheckCheck,
  ChevronRight,
  Cloud,
  Copy,
  Cpu,
  Database,
  Eye,
  Clock,
  HelpCircle,
  KeyRound,
  Loader2,
  LogOut,
  Lock,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Radio,
  ScrollText,
} from "lucide-react";
import {
  ComputeBusyError,
  isLocalDestination,
  runPipeline,
  type BusyInfo,
  type PipelineStage,
  type ProgressEvent,
} from "@/lib/pipeline-client";
import type { CryptoEnvelope } from "@/lib/crypto";
import {
  budgetedText,
  normalisePromptRun,
  PromptRunError,
  deidentifies,
  stagesFor,
  type PromptRun,
  type Sampling,
  type Workspace,
} from "@/lib/workspace";
import { HARD_CHAR_LIMIT, measure } from "@/lib/limits";
// The wire contract, declared once in `contract.ts` and imported by both ends.
// These used to be re-declared here and had already drifted from the route.
import type {
  ModelAvailability,
  ModelsPayload,
  ProcessNoteResult,
  PromptTemplate,
  SessionUser,
  StatusPayload,
} from "@/lib/contract";
import {
  getGeminiKey,
  getRunSettings,
  getServerGeminiKey,
  getServerRunSettings,
  subscribeGeminiKey,
  subscribeRunSettings,
  writeGeminiKey,
  writeRunSettings,
} from "@/lib/settings";
import {
  INSTANCE_QUOTA,
  maskGeminiKey,
  quotaFingerprint,
} from "@/lib/gemini-key";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { FORMATS, NOTE_FORMAT_TITLES } from "./_components/formats";
import { ApiKeyDrawer } from "./_components/api-key-drawer";
import {
  GithubMark,
  HeaderButton,
  HealthPill,
  SamplingRow,
  WordCounter,
} from "./_components/controls";
import { HistoryDrawer } from "./_components/history-drawer";
import { HowItWorks } from "./_components/how-it-works";
import { Inspector } from "./_components/inspector";
import { NoteBody } from "./_components/markdown";
import { PipelineProgress, QueuedPanel } from "./_components/progress";
import { PromptLibrary } from "./_components/prompt-library";
import { PromptsDrawer } from "./_components/prompts-drawer";
import { ModelBar, WorkspaceBar } from "./_components/run-bars";
import { WireView } from "./_components/wire-view";








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

/** The drawers, of which exactly one may be open. */
type DrawerName =
  | "inspector"
  | "wire"
  | "history"
  | "prompts"
  | "help"
  | "key"
  | "library"
  | null;

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
  /**
   * Which drawer is open, if any.
   *
   * One value rather than six booleans, because only one can ever be open: they
   * are all modal, all scroll-lock the page, and all trap focus. Six
   * independent flags let two be true at once, and two drawers fighting over
   * `document.body.style.overflow` and over where focus returns is a state
   * nothing in the interface can get you out of.
   */
  const [drawer, setDrawer] = useState<DrawerName>(null);
  const closeDrawer = useCallback(() => setDrawer(null), []);
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
    // not merely inapplicable — it is invisible in the selector and would still
    // be sent with the run. Drop it, and fall to this workspace's own default.
    setTemplates((list) => {
      const mine = list.filter((t) => (t.kind === "prompt" ? "prompt" : "note") === next);
      setActiveTemplateId(mine.find((t) => t.isDefault)?.id ?? "");
      return list;
    });
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
  /**
   * `isDefault` is per workspace, so the preselection has to be too.
   *
   * Picking the first default of either kind meant a preselected *prompt*
   * routine was left selected while the note workspace was open — invisible in
   * the selector, which filters by kind, but still sent with the run. The
   * route now refuses a mismatched routine as well; this stops it being sent.
   */
  const applyTemplates = useCallback((list: PromptTemplate[], forWorkspace: Workspace) => {
    setTemplates(list);
    const mine = list.filter((t) => (t.kind === "prompt" ? "prompt" : "note") === forWorkspace);
    setActiveTemplateId((current) => {
      if (current && mine.some((t) => t.id === current)) return current;
      return mine.find((t) => t.isDefault)?.id ?? "";
    });
  }, []);

  const loadTemplates = useCallback(async () => {
    const list = await fetchTemplates();
    if (list) applyTemplates(list, getRunSettings().workspace);
  }, [applyTemplates]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await fetchTemplates();
      if (!cancelled && list) applyTemplates(list, getRunSettings().workspace);
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

  /* --- the clinician's own Gemini key ---------------------------------- */
  const geminiApiKey = useSyncExternalStore(
    subscribeGeminiKey,
    getGeminiKey,
    getServerGeminiKey,
  );

  /**
   * The one-way name for whichever quota this browser will spend.
   *
   * Derived rather than stored, so it cannot drift from the key it describes.
   * The KEY never goes near `/api/models` — only this does, because "which
   * models has my allowance already spent" is a question the server can answer
   * from a fingerprint alone.
   */
  const [quota, setQuota] = useState<string>(INSTANCE_QUOTA);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fingerprint = await quotaFingerprint(geminiApiKey || null);
      if (!cancelled) setQuota(fingerprint);
    })();
    return () => {
      cancelled = true;
    };
  }, [geminiApiKey]);

  /* --- model ladder ---------------------------------------------------- */
  /** False when this deployment has no Gemini key of its own. */
  const [instanceKey, setInstanceKey] = useState(true);
  const loadModels = useCallback(async (forQuota: string) => {
    try {
      const r = await fetch(`/api/models?quota=${encodeURIComponent(forQuota)}`, {
        cache: "no-store",
      });
      if (!r.ok) return;
      const d = (await r.json()) as ModelsPayload;
      setModels(d.models);
      setInstanceKey(d.instanceKey);
      setChosenModel((current) => current || d.default);
    } catch {
      /* selector is optional; the server picks a model regardless */
    }
  }, []);

  /** Re-read the ladder for whatever quota is in force right now. */
  const refreshModels = useCallback(() => loadModels(quota), [loadModels, quota]);

  // Deferred into a promise rather than called in the effect body: `loadModels`
  // sets state, and a synchronous setState inside an effect is a cascading
  // render (and a lint error). The state lands after the fetch resolves.
  // Re-runs when the quota changes, because availability is per allowance:
  // pasting your own key must not leave you looking at someone else's
  // exhausted afternoon.
  useEffect(() => {
    void (async () => {
      await loadModels(quota);
    })();
  }, [loadModels, quota]);

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

  /**
   * A cloud run needs a Gemini key from somewhere. Caught here as well as in
   * the selector, because `chosenModel` can already be a cloud rung from a
   * previous session when the deployment's own key is later removed.
   */
  const needsCloudKey = !localDestination && !geminiApiKey && !instanceKey;

  const ready =
    Boolean(publicKey) &&
    !submitting &&
    hasInput &&
    !size.overHard &&
    !promptError &&
    !routineRequired &&
    !needsCloudKey;

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
        : needsCloudKey
          ? "This instance has no Gemini API key, so the cloud models cannot run. Add your own under API key in the header, or pick the local model."
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
          // The only place a credential enters a request. Dropped by the
          // client on a local run, and by the route on anything but a cloud one.
          geminiApiKey: geminiApiKey || undefined,
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
            if (ev.stage === "cloud" && ev.detail?.includes("→")) void refreshModels();
          },
        });
        setResult(out);
        setLive(null);
        void refreshModels();
        return "done";
      } catch (e: unknown) {
        if (e instanceof ComputeBusyError) {
          setQueued(e.activity);
          return "busy";
        }
        throw e;
      }
    },
    [format, activeTemplateId, chosenModel, workspace, promptRun, sampling, deidSampling, patternScrub, geminiApiKey, refreshModels],
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
      void refreshModels();
    } finally {
      queuedRef.current = false;
      setSubmitting(false);
      setQueued(null);
      setStage("");
    }
  }, [ready, workspace, input, runOnce, refreshModels]);

  /**
   * Auth.js requires a POST carrying the CSRF token, so signing out means
   * building and submitting a form rather than following a link.
   */
  const signOut = useCallback(() => {
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
  }, []);

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
            <HeaderButton
              icon={GithubMark}
              label="Source"
              title="Read the source on GitHub"
              href="https://github.com/galencky/local_llm"
            />
            <HeaderButton icon={Clock} label="History" onClick={() => setDrawer("history")} />
            <ThemeToggle />
            <HeaderButton
              icon={KeyRound}
              label={geminiApiKey ? "Your key" : instanceKey ? "API key" : "No API key"}
              tone={geminiApiKey ? "good" : instanceKey ? "quiet" : "alert"}
              title={
                geminiApiKey
                  ? `Cloud runs spend your own Google quota — ${maskGeminiKey(geminiApiKey)}`
                  : instanceKey
                    ? "Cloud runs spend this instance's Google quota. Add your own key to spend yours instead."
                    : "This instance has no Gemini key. Add your own to use the cloud models."
              }
              onClick={() => setDrawer("key")}
            />
            <HeaderButton
              icon={ScrollText}
              label="Prompts"
              title="See exactly what each model is told"
              onClick={() => setDrawer("prompts")}
            />
            <HeaderButton
              icon={HelpCircle}
              label="How it works"
              onClick={() => setDrawer("help")}
            />
            {user && (
              <HeaderButton
                icon={LogOut}
                label={(user.name ?? user.email ?? "").split(" ")[0] || "Sign out"}
                title={user.email ?? undefined}
                onClick={signOut}
              />
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
            ownKey={Boolean(geminiApiKey)}
            instanceKey={instanceKey}
            onOpenKey={() => setDrawer("key")}
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
              onClick={() => setDrawer("library")}
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
                  onClick={() => setDrawer("wire")}
                  title="See the exact bytes that crossed the internet"
                  className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <Radio className="size-3.5" />
                  Wire view
                </button>
              )}
              {result && result.meta.deidentified && (
                <button
                  onClick={() => setDrawer("inspector")}
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
              {result.meta.quotaSource === "own" && (
                <span
                  title="Written on your own Gemini API key, so this run came out of your Google allowance rather than this instance's shared one."
                  className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400"
                >
                  <KeyRound className="size-3" />
                  your quota
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

      {drawer === "inspector" && result && <Inspector result={result} onClose={closeDrawer} />}
      {drawer === "help" && <HowItWorks onClose={closeDrawer} />}
      {drawer === "prompts" && <PromptsDrawer onClose={closeDrawer} />}
      {drawer === "key" && (
        <ApiKeyDrawer
          current={geminiApiKey}
          instanceKey={instanceKey}
          onClose={closeDrawer}
          // Writing the key is the whole of it: the store notifies, the
          // fingerprint is recomputed, and the ladder re-reads itself for the
          // new allowance. Availability is per quota, so that last step is not
          // cosmetic — it is what stops the previous key's greyed-out rungs
          // being shown as if they were yours.
          onChanged={writeGeminiKey}
        />
      )}
      {drawer === "wire" && wire && <WireView wire={wire} onClose={closeDrawer} />}
      {drawer === "history" && (
        <HistoryDrawer
          onClose={closeDrawer}
          onReuse={(text) => {
            // Reusing a past note always lands in the note workspace: it is a
            // narrative, and dropping it into a prompt box would be nonsense.
            chooseWorkspace("note");
            setInput(text);
            closeDrawer();
          }}
        />
      )}
      {drawer === "library" && (
        <PromptLibrary
          workspace={workspace}
          promptRun={promptRun}
          sampling={sampling}
          templates={templates}
          onClose={closeDrawer}
          onChanged={loadTemplates}
        />
      )}
    </div>
  );
}



