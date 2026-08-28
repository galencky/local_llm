"use client";

/**
 * Saved routines, for both workspaces.
 *
 * A routine is CONFIGURATION, not clinical data: the API screens every saved
 * body through the deterministic scrubber and refuses anything that matches,
 * because a routine lives in Postgres forever.
 */
import { useState } from "react";
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type { PromptTemplate } from "@/lib/contract";
import { SAMPLING_DEFAULTS, type PromptRun, type Sampling, type Workspace } from "@/lib/workspace";
import { Drawer, DrawerBody } from "./drawer";
import { Field } from "./controls";
import { FORMATS } from "./formats";
import { cn } from "@/lib/utils";

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

export function PromptLibrary({
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

  return (
    <Drawer
      title="Specialty routines"
      subtitle={
        <>
  {workspace === "prompt"
                  ? "Saved prompts, with their sampling. Configuration only — never patient data."
                  : "Saved instructions appended to every note. Configuration only — never patient data."}
        </>
      }
      width="2xl"
      onClose={onClose}
    >

        <DrawerBody>
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
        </DrawerBody>
    </Drawer>
  );
}
