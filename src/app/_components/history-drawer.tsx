"use client";

/**
 * Past notes, de-identified and permanently so.
 *
 * The token→PII map is destroyed when each note finishes, so this can never
 * show a real name. It is a record of what crossed to the cloud, not a second
 * copy of the chart — and a local run leaves no row here at all.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCheck, Copy, Loader2, RotateCcw, Trash2 } from "lucide-react";
import type { HistoryNote } from "@/lib/contract";
import { Drawer, DrawerBody } from "./drawer";
import { Panel } from "./controls";

/* ------------------------------------------------------------------ */
/* Past notes                                                          */
/* ------------------------------------------------------------------ */

/**
 * Everything here is de-identified and permanently so: the token→PII map is
 * destroyed when each note finishes, so history can never show a real name.
 * It is a record of what crossed to the cloud, not a second copy of the chart.
 */
export function HistoryDrawer({
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
    <Drawer
      title="Past notes"
      subtitle={
        <>
  De-identified copies only — the mapping back to real names was destroyed when each
                note finished.
        </>
      }
      width="2xl"
      onClose={onClose}
    >

        <div className="border-b border-[var(--border)] px-4 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search past notes (diagnoses, drugs, routines…)"
            className="w-full bg-transparent text-xs outline-none placeholder:text-[var(--muted)]/60"
          />
        </div>

        <DrawerBody>
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
                          <span className="rounded bg-[var(--accent-solid)] px-1.5 py-0.5 text-[10px] text-[var(--on-accent)]">
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
                      className="rounded p-1 text-[var(--muted)] hover:text-rose-700 dark:hover:text-rose-400"
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
        </DrawerBody>
    </Drawer>
  );
}
