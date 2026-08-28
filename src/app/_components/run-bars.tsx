"use client";

/**
 * The two rows above everything you write: what this run is, and who answers.
 *
 * They sit together because between them they are the whole answer to "what
 * will this run do" — which prompts, and which model. Both are height-stable
 * by construction: a notice that comes and goes moves every control below it,
 * so each keeps exactly one line and changes only its text.
 */
import { AlertTriangle, Cloud, Cpu, KeyRound, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { LOCAL_MODEL_ID } from "@/lib/pipeline-client";
import type { ModelAvailability, StatusPayload } from "@/lib/contract";
import type { Workspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

/**
 * The two things you can be doing here.
 *
 * This replaced a guided/custom toggle, a CUSTOM note format, and the pair of
 * prompt editors behind them — four controls that could all express "I want to
 * write the prompt myself", and that needed a table to tell apart. One toggle,
 * two states, and the workspace below it changes to match.
 */
export const WORKSPACES: {
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
export function WorkspaceBar({
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
export function ModelBar({
  models,
  chosen,
  onChoose,
  disabled,
  lmStudio,
  ownKey,
  instanceKey,
  onOpenKey,
}: {
  models: ModelAvailability[];
  chosen: string;
  onChoose: (id: string) => void;
  disabled: boolean;
  /** Health of the local server — the local option's own availability. */
  lmStudio: StatusPayload["lmStudio"] | null;
  /** True when this browser holds the clinician's own Gemini key. */
  ownKey: boolean;
  /** True when this deployment has a Gemini key of its own. */
  instanceKey: boolean;
  onOpenKey: () => void;
}) {
  const local = chosen === LOCAL_MODEL_ID;
  const localReady = Boolean(lmStudio?.online);
  /**
   * A cloud rung needs a key from somewhere. Neither the instance nor this
   * browser having one is a real, common state — a deployment started without
   * GEMINI_API_KEY, where everyone brings their own — and it needs the same
   * treatment as LM Studio being down: grey the rungs out and say why, rather
   * than letting every click fail with an auth error after the scrub has run.
   */
  const cloudKeyed = ownKey || instanceKey;
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
        {/* Whose allowance a cloud run spends. Sits with the model selector
            because it answers the other half of the same question: not just
            which model, but on whose quota. Silent on a local run, which
            spends nobody's. */}
        {!local && (
          <button
            onClick={onOpenKey}
            title={
              ownKey
                ? "Cloud runs spend your own Google quota. Click to replace or remove the key."
                : instanceKey
                  ? "Cloud runs spend this instance's shared Google quota. Click to add your own key and use yours instead."
                  : "This instance has no Gemini key. Click to add your own."
            }
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors",
              ownKey
                ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
                : instanceKey
                  ? "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                  : "border-amber-500/40 text-amber-700 dark:text-amber-400",
            )}
          >
            <KeyRound className="size-3 shrink-0" />
            {ownKey ? "your quota" : instanceKey ? "shared quota" : "no key"}
          </button>
        )}
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
          const spent = !m.available || !localReady || !cloudKeyed;
          return (
            <button
              key={m.id}
              onClick={() => onChoose(m.id)}
              disabled={disabled || !localReady || !cloudKeyed}
              title={
                !localReady
                  ? `${m.id} needs the local model: everything sent to Google is de-identified first, and that pass runs in LM Studio. ${localHint}.`
                  : !cloudKeyed
                    ? `${m.id} needs a Gemini API key. This instance has none — add your own under API key in the header.`
                    : spent
                      ? `${m.id} — ${m.reason === "quota" ? "out of quota" : m.reason} ${resetHint(m)}`
                      : `${m.id} · ${m.dailyLimit || "?"}/day on the free tier${ownKey ? ", on your own key" : ""}`
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
              {spent && localReady && cloudKeyed && (
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
          !localReady || (!local && (!nextUp || !cloudKeyed))
            ? "text-rose-700 dark:text-rose-400"
            : "text-[var(--muted)]",
        )}
        title={
          !localReady
            ? `${localHint}. The cloud rungs need it for de-identification and the local option needs it to answer.`
            : local
              ? "Your text reaches the model as written, and the run leaves no audit row, so it will not appear in History. The draft will be weaker than a Flash model."
              : !cloudKeyed
                ? "Gemini needs an API key. This deployment was started without one, so the cloud ladder is reachable only by clinicians who bring their own."
                : "A rung greys out only once Google has actually refused it. If the one you pick is spent by the time you run, the server walks down from there and says so."
        }
      >
        {!localReady
          ? `${localHint} — nothing can run until it is up.`
          : local
            ? "Raw and unlogged. Weaker draft than a Flash model, and no quota to spend."
            : !cloudKeyed
              ? "No Gemini key on this instance — add your own to reach the cloud models."
              : !nextUp
                ? `Every cloud model is spent on ${ownKey ? "your key" : "this instance's key"}. ${ownKey ? "Pick Local, or wait for the reset." : "Add your own key, or pick Local."}`
                : "Google never sees an identifier — the local model strips them first."}
      </p>
    </div>
  );
}
