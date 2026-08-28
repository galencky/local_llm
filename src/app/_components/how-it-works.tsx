"use client";

/**
 * The explainer, written for a clinician rather than an engineer.
 *
 * Each step is tagged with where it runs, and the drawer colours it by trust
 * boundary — the point of the whole design is which room a step happens in.
 */
import { Drawer, DrawerBody } from "./drawer";
import { LOCUS_STYLE } from "./progress";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Explainer                                                           */
/* ------------------------------------------------------------------ */

export const STEPS: { n: string; where: keyof typeof LOCUS_STYLE; title: string; body: string }[] = [
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

export function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <Drawer
      title="How Project Airlock works"
      label="How it works"
      subtitle={
        <>
  An airlock joins two rooms that must never meet. A model on this Mac removes every
                identifier before the outer door opens.
        </>
      }
      onClose={onClose}
    >

        <DrawerBody className="px-5 py-4">
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
        </DrawerBody>

        <div className="border-t border-[var(--border)] px-5 py-3 text-[11px] text-[var(--muted)]">
          One note at a time — 16GB of unified memory runs a single model pass, so a second
          request waits its turn rather than slowing yours down.
        </div>
    </Drawer>
  );
}
