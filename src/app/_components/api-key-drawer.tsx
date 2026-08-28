"use client";

/**
 * Paste a Google AI Studio key so cloud runs spend YOUR quota.
 *
 * See `src/lib/gemini-key.ts` for where the key lives and why that is the
 * shape rather than an encrypted column in Postgres.
 */
import { useState } from "react";
import { AlertTriangle, CheckCheck, KeyRound, Loader2, Lock, ShieldCheck, Trash2 } from "lucide-react";
import { verifyGeminiKey, type GeminiKeyCheck } from "@/lib/pipeline-client";
import { GEMINI_KEY_HINT, looksLikeGeminiKey, maskGeminiKey } from "@/lib/gemini-key";
import { Drawer, DrawerBody } from "./drawer";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Bring your own Gemini key                                           */
/* ------------------------------------------------------------------ */

/**
 * Paste a Google AI Studio key so cloud runs spend YOUR quota.
 *
 * The key is stored in this browser and sent, sealed inside the same AES-GCM
 * envelope as the note, on each cloud run. The Mac Mini uses it for the life of
 * that request and keeps nothing — see `src/lib/gemini-key.ts` for why that is
 * the shape rather than an encrypted column in Postgres.
 *
 * Saving checks the key against Google first. A key that is well-formed but
 * revoked, restricted, or attached to a project without the API enabled looks
 * exactly like a good one until the moment it matters, and the moment it
 * matters is halfway through a ward round.
 */
export function ApiKeyDrawer({
  current,
  instanceKey,
  onClose,
  onChanged,
}: {
  current: string;
  /** Whether this deployment has a Gemini key of its own to fall back to. */
  instanceKey: boolean;
  onClose: () => void;
  onChanged: (key: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<GeminiKeyCheck | null>(null);

  const shapeOk = looksLikeGeminiKey(draft);

  const save = async () => {
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      const result = await verifyGeminiKey(draft.trim());
      setCheck(result);
      if (!result.ok) {
        setError(result.error ?? "Google rejected that key.");
        return;
      }
      onChanged(draft.trim());
      setDraft("");
    } catch (e: unknown) {
      // The check itself could not run — the server or the network, not the
      // key. Refusing to save on that would make an unreachable Google a
      // reason you cannot configure Airlock, which is backwards.
      setError(
        `${e instanceof Error ? e.message : "The check could not run."} ` +
          "The key itself may be fine — save it without checking if you are sure.",
      );
    } finally {
      setBusy(false);
    }
  };

  const saveUnchecked = () => {
    onChanged(draft.trim());
    setDraft("");
    setError(null);
    setCheck(null);
  };

  return (
    <Drawer
      title="Gemini API key"
      subtitle={
        <>
  Use your own Google quota instead of this instance&apos;s.
        </>
      }
      onClose={onClose}
    >

        <DrawerBody className="p-4">
          {/* ---- what is in force right now ---- */}
          <div
            className={cn(
              "mb-4 rounded-lg border p-3",
              current
                ? "border-emerald-500/30 bg-emerald-500/5"
                : instanceKey
                  ? "border-[var(--border)] bg-[var(--background)]"
                  : "border-amber-500/40 bg-amber-500/10",
            )}
          >
            <div className="flex items-center gap-1.5">
              <KeyRound
                className={cn(
                  "size-3.5 shrink-0",
                  current ? "text-emerald-700 dark:text-emerald-400" : "text-[var(--muted)]",
                )}
              />
              <span className="text-[11px] font-semibold">
                {current
                  ? "Cloud runs spend your quota"
                  : instanceKey
                    ? "Cloud runs spend this instance's quota"
                    : "No key at all — cloud runs cannot start"}
              </span>
              {current && (
                <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">
                  {maskGeminiKey(current)}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--muted)]">
              {current
                ? "Every model this instance offers is billed to your own Google project, and the daily free-tier allowance is yours alone. Remove the key to go back to the instance's."
                : instanceKey
                  ? "You are sharing this deployment's allowance with everyone else signed in to it. Add your own key and the free-tier quota resets to yours alone."
                  : "This deployment was started without a GEMINI_API_KEY, so the cloud models are only reachable by clinicians who bring their own. The local model works regardless."}
            </p>
            {current && (
              <button
                onClick={() => {
                  onChanged("");
                  setCheck(null);
                  setError(null);
                }}
                className="mt-2.5 flex items-center gap-1.5 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted)] hover:text-rose-700 dark:hover:text-rose-400"
              >
                <Trash2 className="size-3.5" />
                Remove this key
              </button>
            )}
          </div>

          {/* ---- paste a new one ---- */}
          <label className="block">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              {current ? "Replace with a different key" : "Add your key"}
            </span>
            <input
              type="password"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
                setCheck(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shapeOk && !busy) void save();
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="AIza…"
              className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[12px] outline-none placeholder:text-[var(--muted)]/60"
            />
          </label>
          <p className="mt-1 text-[10px] text-[var(--muted)]">
            {GEMINI_KEY_HINT} Get one free at{" "}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
            >
              aistudio.google.com/apikey
            </a>
            .
          </p>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => void save()}
              disabled={!shapeOk || busy}
              title={
                shapeOk
                  ? "Checks the key against Google before saving it."
                  : draft
                    ? GEMINI_KEY_HINT
                    : "Paste a key first."
              }
              className="flex items-center gap-2 rounded bg-[var(--accent-solid)] px-4 py-1.5 text-sm font-medium text-[var(--on-accent)] transition-opacity disabled:cursor-not-allowed disabled:bg-[var(--border)]/40 disabled:text-[var(--faint)]"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              {busy ? "Checking with Google" : "Check and save"}
            </button>
            {/* Only offered when the CHECK failed to run, never when Google
                actively rejected the key — saving one Google has refused would
                just move the failure to the middle of a note. */}
            {error && !check && !busy && (
              <button
                onClick={saveUnchecked}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--muted)] hover:text-[var(--foreground)]"
              >
                Save without checking
              </button>
            )}
          </div>

          {error && (
            <div className="mt-3 flex gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-700 dark:text-rose-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {check?.ok && (
            <div className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs">
              <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <CheckCheck className="size-3.5 shrink-0" />
                <span className="font-medium">
                  Google accepted it — {check.usable.length} of{" "}
                  {check.usable.length + check.missing.length} models on this ladder
                </span>
              </div>
              {check.missing.length > 0 && (
                <p className="mt-1.5 leading-relaxed text-[var(--muted)]">
                  Not reachable on this key: {check.missing.join(", ")}. The run
                  walks down the ladder, so it will simply start lower — but a
                  restricted key or a project without the Generative Language API
                  enabled is the usual reason.
                </p>
              )}
            </div>
          )}

          {/* ---- the part that matters ---- */}
          <div className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
            <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              <Lock className="size-3.5" />
              Where this key lives
            </h4>
            <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-[var(--muted)]">
              <li>
                <strong className="text-[var(--foreground)]">In this browser.</strong> It is
                stored here, on this device, under this profile. Another browser or another
                machine will not have it.
              </li>
              <li>
                <strong className="text-[var(--foreground)]">Sealed on the way out.</strong> It
                travels inside the same encrypted envelope as the note, so Cloudflare relays it
                as ciphertext exactly like everything else. Check it yourself in{" "}
                <em>Wire view</em> after a run.
              </li>
              <li>
                <strong className="text-[var(--foreground)]">Never stored on the server.</strong>{" "}
                The Mac Mini uses it for the life of one request and drops it. It is not written
                to the database, not written to disk, not logged, and not recorded on the audit
                row — only a one-way fingerprint of it, and only so that your exhausted models
                are not marked as everybody&apos;s.
              </li>
              <li>
                <strong className="text-[var(--foreground)]">Never sent on a local run.</strong>{" "}
                Those make no outbound call, so there is nothing for a credential to do.
              </li>
            </ul>
            <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--muted)]">
              The honest limit: browser storage is readable by any script running on this page.
              Airlock loads no third-party scripts and ships no production source maps, but
              anyone who can run script here can also read the note on screen — the key is no
              softer a target than the clinical text beside it.
            </p>
          </div>
        </DrawerBody>
    </Drawer>
  );
}
