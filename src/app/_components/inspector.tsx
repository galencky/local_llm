"use client";

/**
 * Exactly what was swapped out before the formatting model saw the note.
 *
 * Every preview is masked here too: the inspector proves a redaction happened
 * without becoming a second place the identifier is legible.
 */
import type { ProcessNoteResult } from "@/lib/contract";
import { Drawer, DrawerBody } from "./drawer";
import { Stat } from "./controls";
import { cn } from "@/lib/utils";

export const CATEGORY_TINT: Record<string, string> = {
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

/** Drawer showing exactly what was swapped out before the cloud call. */
export function Inspector({ result, onClose }: { result: ProcessNoteResult; onClose: () => void }) {
  const { redactions, deidentifiedInput, meta } = result;

  return (
    <Drawer
      title="PII Scrubbed Inspector"
      label="Redaction inspector"
      subtitle={
        <>
  Exactly what the formatting model received
                {meta.destination === "local" ? ", here on this Mac" : ", at Google"}. Values are
                masked here too.
        </>
      }
      onClose={onClose}
    >

        <DrawerBody>
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
        </DrawerBody>
    </Drawer>
  );
}
