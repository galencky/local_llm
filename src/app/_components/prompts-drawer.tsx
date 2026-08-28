"use client";

/**
 * Read-only view of what each model is told, fetched live from the running
 * server so it cannot drift from what is actually sent.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, BookMarked, ChevronRight, Cloud, Cpu, Loader2 } from "lucide-react";
import type { PromptConfig } from "@/lib/contract";
import { Drawer, DrawerBody } from "./drawer";
import { Locked, PromptBlock } from "./controls";
import { cn } from "@/lib/utils";

/**
 * Read-only view of what each model is told.
 *
 * Nothing here is editable on purpose. The local prompt IS the
 * de-identification step; the Gemini system instruction carries the rules that
 * keep placeholders intact and stop the model inventing findings. Tuning
 * belongs in a saved routine, which is owned, PII-screened and recorded on
 * every audit row.
 */
export function PromptsDrawer({ onClose }: { onClose: () => void }) {
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
    <Drawer
      title="What each model is told"
      subtitle={
        <>
  The exact instructions behind every note. Read-only — see below for why.
        </>
      }
      width="3xl"
      onClose={onClose}
    >

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

        <DrawerBody className="p-4">
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
        </DrawerBody>
    </Drawer>
  );
}
