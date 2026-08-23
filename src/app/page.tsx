"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  Sparkles,
  Trash2,
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
import { HARD_CHAR_LIMIT, measure } from "@/lib/limits";
import { cn } from "@/lib/utils";

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
  TAIWAN_ID: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  MRN: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  PHONE: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  DATE: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  PATIENT: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  RELATIVE: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400",
  DOCTOR: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  WARD: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  LOCATION: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  ORG: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [copied, setCopied] = useState(false);
  const [queued, setQueued] = useState<BusyInfo | null>(null);
  const [models, setModels] = useState<ModelAvailability[]>([]);
  const [chosenModel, setChosenModel] = useState<string>("");
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [activeTemplateId, setActiveTemplateId] = useState<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        if (!cancelled) setStatus(d);
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
  const ready =
    Boolean(publicKey) && !submitting && input.trim().length > 0 && !size.overHard;
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? null;

  /** Live pipeline stages for the current run. */
  const [progress, setProgress] = useState<Map<PipelineStage, ProgressEvent>>(new Map());
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
          onSealed: () => setStage("Sealed in the browser — sending"),
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
    [format, instruction, activeTemplateId, chosenModel, loadModels],
  );

  const submit = useCallback(async () => {
    if (!publicKey || !input.trim() || submitting) return;
    if (measure(input).overHard) return;

    const text = input;
    setSubmitting(true);
    setError(null);
    setResult(null);
    setCopied(false);
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

  const copyNote = useCallback(async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.note);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [result]);

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
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-5 py-3">
          <div className="flex items-baseline gap-2.5">
            <ShieldCheck className="size-5 translate-y-0.5 text-[var(--accent)]" />
            <span className="text-base font-semibold tracking-[0.18em]">
              PROJECT AIRLOCK
            </span>
            <span className="hidden text-[11px] text-[var(--muted)] sm:inline">
              both doors never open at once
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
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
                  ? `LM Studio${status.lmStudio.busy ? " (working)" : ""} · ${status.lmStudio.models[0]?.slice(0, 20) ?? "loaded"}`
                  : "LM Studio down"
              }
              tone={status?.lmStudio.online ? "ok" : "bad"}
            />
            <HealthPill
              icon={Database}
              label={status?.database.online ? "Audit DB" : "Audit DB down"}
              tone={status?.database.online ? "ok" : "bad"}
            />
            <HealthPill icon={Lock} label={publicKey ? "E2EE armed" : "No key"} tone={publicKey ? "ok" : "bad"} />
            <button
              onClick={() => setHistoryOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            >
              <Clock className="size-3.5" />
              History
            </button>
            <button
              onClick={() => setHelpOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
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
                className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
              >
                <LogOut className="size-3.5" />
                {(user.name ?? user.email ?? "").split(" ")[0] || "Sign out"}
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
      <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 gap-4 p-5 lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]">
        {/* ---- input ---- */}
        <section className="flex min-h-[60vh] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] lg:min-h-0">
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
              className="block min-h-[52vh] w-full resize-none overflow-hidden bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed outline-none placeholder:text-[var(--muted)]/60 disabled:opacity-50"
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

          {/* ---- specialty routine ---- */}
          <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2">
            <BookMarked className="size-3.5 shrink-0 text-[var(--muted)]" />
            <select
              value={activeTemplateId}
              onChange={(e) => setActiveTemplateId(e.target.value)}
              disabled={submitting}
              className="min-w-0 flex-1 cursor-pointer truncate bg-transparent text-xs outline-none disabled:opacity-50"
            >
              <option value="">No specialty routine</option>
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

          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-4 py-3">
            <div className="flex flex-wrap gap-1">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  disabled={submitting}
                  className={cn(
                    "rounded border px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                    format === f.id
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
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
              className="ml-auto flex items-center gap-2 rounded bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
              {submitting ? "Processing" : "Encrypt & structure"}
            </button>
          </div>

          <div className="border-t border-[var(--border)] px-4 py-2">
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={submitting}
              placeholder="One-off steer — e.g. 以中文輸出, emphasise the renal course, keep the plan terse"
              className="w-full bg-transparent text-xs outline-none placeholder:text-[var(--muted)]/60"
            />
          </div>
        </section>

        {/* ---- output ---- */}
        <section className="flex min-h-[60vh] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] lg:min-h-0">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
              Structured note
            </h2>
            <div className="flex items-center gap-2">
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
                onClick={() => void copyNote()}
                disabled={!result}
                className="flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] transition-colors hover:text-[var(--foreground)] disabled:opacity-40"
              >
                {copied ? <CheckCheck className="size-3.5 text-[var(--accent)]" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy clean note"}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto px-4 py-3">
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
                className={cn(result.meta.modelFallbacks.length > 0 && "text-amber-500")}
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
              {result.meta.promptTemplateName && <span>routine {result.meta.promptTemplateName}</span>}
              <span>scrub {result.meta.scrubMs} ms</span>
              <span>cloud {result.meta.geminiMs} ms</span>
              <span>total {result.meta.processingTimeMs} ms</span>
              {result.meta.auditLogId ? (
                <span>audit {result.meta.auditLogId.slice(0, 8)}</span>
              ) : (
                <span className="text-amber-500">audit write failed</span>
              )}
              {result.meta.unresolvedTokens.length > 0 && (
                <span className="text-amber-500">
                  {result.meta.unresolvedTokens.length} token(s) unresolved — verify before filing
                </span>
              )}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-[var(--border)] px-5 py-3 text-center text-[11px] text-[var(--muted)]">
        <span className="tracking-[0.15em]">PROJECT AIRLOCK</span> · created by{" "}
        <span className="text-[var(--foreground)]">Kuan-Yuan Chen</span> · built with{" "}
        <span className="text-[var(--foreground)]">Claude Code</span>
        {activeTemplate && <> · routine: {activeTemplate.name}</>}
      </footer>

      {inspectorOpen && result && (
        <Inspector result={result} onClose={() => setInspectorOpen(false)} />
      )}
      {helpOpen && <HowItWorks onClose={() => setHelpOpen(false)} />}
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
    <div className="border-t border-[var(--border)] px-4 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <Cloud className="size-3.5 text-[var(--muted)]" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Cloud model — best first, falls back rightward
        </span>
        {nextUp && nextUp.id !== chosen && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400">
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
                  ? "border-[var(--border)] bg-[var(--border)]/40 text-[var(--muted)]/60 line-through"
                  : isChosen
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
                disabled && "opacity-50",
              )}
            >
              {m.tier === "lite" && !spent && (
                <span className="text-[9px] uppercase opacity-60">lite</span>
              )}
              {m.label}
              {spent && <span className="no-underline opacity-80">· {resetHint(m)}</span>}
            </button>
          );
        })}
      </div>

      {!nextUp && (
        <p className="mt-1.5 text-[10px] text-rose-600 dark:text-rose-400">
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

function WordCounter({ size }: { size: ReturnType<typeof measure> }) {
  const tone = size.overHard
    ? "text-rose-600 dark:text-rose-400"
    : size.overSoft
      ? "text-amber-600 dark:text-amber-400"
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
  browser: { icon: Monitor, tint: "text-sky-600 dark:text-sky-400", where: "your browser" },
  mac: { icon: Cpu, tint: "text-emerald-600 dark:text-emerald-400", where: "Mac Mini" },
  cloud: { icon: Cloud, tint: "text-violet-600 dark:text-violet-400", where: "Gemini" },
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
              state === "running" && "bg-[var(--accent)]/8",
              state === "pending" && "opacity-40",
              state === "waiting" && "opacity-30",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {state === "running" ? (
                <Loader2 className="size-3.5 animate-spin text-[var(--accent)]" />
              ) : state === "done" ? (
                <Check className="size-3.5 text-[var(--accent)]" />
              ) : state === "failed" ? (
                <AlertTriangle className="size-3.5 text-amber-500" />
              ) : (
                <Circle className="size-2 text-[var(--muted)]" />
              )}
            </span>

            <Icon className={cn("size-3.5 shrink-0", locus.tint)} />
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
        <Loader2 className="size-4 animate-spin text-amber-600 dark:text-amber-400" />
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

        <div className="flex-1 overflow-auto">
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
                          <span className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
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
                      className="rounded p-1 text-[var(--muted)] hover:text-rose-500"
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
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--background)] p-2.5 font-mono text-[11px] leading-relaxed">
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
              An airlock joins two rooms that must never meet. Both doors never open at once.
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

        <div className="flex-1 overflow-auto px-5 py-4">
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

        <div className="flex-1 overflow-auto">
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
                      <span className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
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
                  className="rounded p-1 text-[var(--muted)] hover:text-rose-500"
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
              className="flex items-center gap-2 rounded bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
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

function HealthPill({
  icon: Icon,
  label,
  tone,
  pulse,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: "ok" | "warn" | "bad";
  pulse?: boolean;
}) {
  const tones = {
    ok: "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
    warn: "border-amber-500/40 text-amber-600 dark:text-amber-400",
    bad: "border-rose-500/30 text-rose-600 dark:text-rose-400",
  } as const;
  return (
    <span
      className={cn(
        "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] md:inline-flex",
        tones[tone],
        pulse && "animate-pulse",
      )}
    >
      <Icon className="size-3.5" />
      {label}
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

        <div className="flex-1 overflow-auto">
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
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-[11px] leading-relaxed">
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
