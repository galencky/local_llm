"use client";

/**
 * The small pieces every surface reuses.
 *
 * Gathered here because each was defined next to its first caller and then
 * used by three more — the panel bodies in History, the masked stat tiles in
 * Wire view, the read-only prompt blocks. One home, so a change to how a
 * label looks does not have to be made in five places.
 */
import { useState } from "react";
import type { ComponentType } from "react";
import { CheckCheck, Copy, Lock } from "lucide-react";
import { HARD_CHAR_LIMIT, measure } from "@/lib/limits";
import { SAMPLING_PARAMS, type Sampling } from "@/lib/workspace";
import { cn } from "@/lib/utils";

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
export function SamplingRow({
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

/* ------------------------------------------------------------------ */
/* Live feedback                                                       */
/* ------------------------------------------------------------------ */

/** GitHub's mark. lucide-react v1 dropped brand icons, so it lives here. */
export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function WordCounter({ size }: { size: ReturnType<typeof measure> }) {
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

/* ------------------------------------------------------------------ */

/**
 * Status chip. Sized for a 1024x768 ward screen: the text never wraps mid-pill,
 * the label is always shown, and the row of pills wraps to a second or third
 * line rather than hiding anything. A long model name truncates with the full
 * value in the tooltip.
 */
export function HealthPill({
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

export function Field({
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

export function Panel({ title, body }: { title: string; body: string }) {
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

export function Locked({ heading, body }: { heading: string; body: string }) {
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

export function PromptBlock({ title, body }: { title: string; body: string }) {
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

export function WireStat({ label, value, sub }: { label: string; value: string; sub: string }) {
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

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[var(--surface)] px-3 py-3">
      <div className="font-mono text-lg">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</div>
    </div>
  );
}


/**
 * A pill in the header bar.
 *
 * Five of these carried the same forty-character class string, and a sixth was
 * added by copying it. Sizing decisions for the 1024px ward screen — the label
 * never wraps, the row wraps instead — live here once.
 */
export function HeaderButton({
  icon: Icon,
  label,
  title,
  tone = "quiet",
  onClick,
  href,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  title?: string;
  /** `alert` for something that needs attention, `good` for something armed. */
  tone?: "quiet" | "good" | "alert";
  onClick?: () => void;
  /** Renders an anchor instead of a button. */
  href?: string;
}) {
  const className = cn(
    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] transition-colors xl:px-2.5",
    tone === "good"
      ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
      : tone === "alert"
        ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
        : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
  );
  const inner = (
    <>
      <Icon className="size-3.5 shrink-0" />
      {label}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={className}>
      {inner}
    </a>
  ) : (
    <button onClick={onClick} title={title} className={className}>
      {inner}
    </button>
  );
}
