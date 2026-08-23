"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookMarked,
  CheckCheck,
  ChevronRight,
  Copy,
  Cpu,
  Database,
  Eye,
  Loader2,
  Lock,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { openResponse, sealRequest, type CryptoEnvelope } from "@/lib/crypto";
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
  lmStudio: { online: boolean; models: string[]; error?: string };
  database: { online: boolean; error?: string };
  gemini: { configured: boolean; model: string };
  vaults: { active: number; ttlMs: number };
  degradedScrubAllowed: boolean;
}

interface PromptTemplate {
  id: string;
  name: string;
  specialty: string | null;
  instruction: string;
  format: string | null;
  isDefault: boolean;
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

export default function LimenPage() {
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
  const [copied, setCopied] = useState(false);
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

  /* --- health polling -------------------------------------------------- */
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
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  /* --- the input grows with the narrative ------------------------------ */
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const ready = Boolean(publicKey) && !submitting && input.trim().length > 0;
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? null;

  const submit = useCallback(async () => {
    if (!publicKey || !input.trim() || submitting) return;

    setSubmitting(true);
    setError(null);
    setResult(null);
    setCopied(false);

    try {
      setStage("Encrypting in browser…");
      const payload = JSON.stringify({
        text: input,
        format,
        instruction: instruction.trim() || undefined,
        promptId: activeTemplateId || undefined,
      });
      const { envelope, aesKey } = await sealRequest(publicKey, payload);

      // The raw note leaves the visible workspace the moment it is sealed:
      // a chart entry sitting on screen is itself a PDPA exposure.
      setInput("");
      setStage("De-identifying locally, then formatting…");

      const res = await fetch("/api/process-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed with status ${res.status}.`);
      }

      setStage("Decrypting response…");
      const sealed = (await res.json()) as CryptoEnvelope;
      setResult(JSON.parse(await openResponse(aesKey, sealed)) as ProcessNoteResult);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unexpected failure.");
    } finally {
      setSubmitting(false);
      setStage("");
    }
  }, [publicKey, input, format, instruction, activeTemplateId, submitting]);

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
            <span className="text-base font-semibold tracking-[0.2em]">LIMEN</span>
            <span className="hidden text-[11px] text-[var(--muted)] sm:inline">
              nothing identifying crosses the threshold
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
                  ? `LM Studio · ${status.lmStudio.models[0]?.slice(0, 20) ?? "loaded"}`
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
            <span className="font-mono text-[11px] text-[var(--muted)]">
              {input.length.toLocaleString()} ch
            </span>
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
              placeholder="One-off steer — e.g. 以中文輸出, emphasise the renal course, keep it under 200 words"
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
              <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                <Loader2 className="size-4 animate-spin" />
                {stage}
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
              <span>{result.meta.model}</span>
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
        <span className="tracking-[0.15em]">LIMEN</span> · created by{" "}
        <span className="text-[var(--foreground)]">Kuan-Yuan Chen</span> · built with{" "}
        <span className="text-[var(--foreground)]">Claude Code</span>
        {activeTemplate && <> · routine: {activeTemplate.name}</>}
      </footer>

      {inspectorOpen && result && (
        <Inspector result={result} onClose={() => setInspectorOpen(false)} />
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
