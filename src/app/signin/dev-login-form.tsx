"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, TerminalSquare } from "lucide-react";

/**
 * Developer bypass form. Only rendered when DEV_LOGIN_ENABLED is on; the route
 * behind it enforces the same rule server-side, so hiding this is convenience,
 * not the control.
 */
export function DevLoginForm({ from, remote }: { from: string; remote: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/dev-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Sign-in failed.");
      }
      window.location.href = from;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 border-t border-[var(--border)] pt-5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
        <TerminalSquare className="size-3.5" />
        Developer sign-in
      </div>

      <form onSubmit={submit} className="mt-2 flex gap-2">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          autoComplete="off"
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-sm outline-none placeholder:text-[var(--muted)]/60"
        />
        <button
          type="submit"
          disabled={busy || !password}
          className="flex items-center gap-1.5 rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)] disabled:opacity-40"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          Enter
        </button>
      </form>

      {error && (
        <div className="mt-2 flex gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-[11px] text-rose-700 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted)]">
        Signs in as <code>airlock_dev</code> with a normal session — same ownership and history
        rules as any account.{" "}
        {remote ? (
          <span className="text-amber-600 dark:text-amber-400">
            DEV_LOGIN_ALLOW_REMOTE is on, so this password works from the internet too. Turn it off
            before this instance sees real patients.
          </span>
        ) : (
          "Restricted to localhost."
        )}
      </p>
    </div>
  );
}
