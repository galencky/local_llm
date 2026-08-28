"use client";

/**
 * What the pipeline is doing, and what it is waiting for.
 *
 * Two views of the same single compute slot: the stage list for the run this
 * tab started, and the queued panel for a run it is waiting behind.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Circle, Cloud, Cpu, Loader2, Monitor, X } from "lucide-react";
import {
  stageLocus,
  stageTitle,
  type BusyInfo,
  type PipelineStage,
  type ProgressEvent,
} from "@/lib/pipeline-client";
import { cn } from "@/lib/utils";

export const LOCUS_STYLE = {
  browser: { icon: Monitor, tint: "text-sky-700 dark:text-sky-400", where: "your browser" },
  mac: { icon: Cpu, tint: "text-emerald-700 dark:text-emerald-400", where: "Mac Mini" },
  cloud: { icon: Cloud, tint: "text-violet-700 dark:text-violet-400", where: "Gemini" },
} as const;

/** The pipeline as it actually happens, one row per server stage. */
export function PipelineProgress({
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
export function QueuedPanel({
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
