import { redirect } from "next/navigation";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { auth, signIn, allowlistConfigured } from "@/lib/auth";
import { devLoginAllowsRemote, devLoginEnabled } from "@/lib/dev-login";
import { DevLoginForm } from "./dev-login-form";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const { from, error } = await searchParams;
  const session = await auth();
  // Only bounce a signed-in user onward when nothing went wrong. Redirecting
  // through an error swallowed it — a failed Google sign-in looked like it had
  // silently logged you in as whoever the browser still had a session for.
  if (session?.user && !error) redirect(from && from.startsWith("/") ? from : "/");

  const configured = allowlistConfigured();
  const googleReady = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);

  return (
    <main className="flex min-h-full flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
        <div className="flex items-baseline gap-2.5">
          <ShieldCheck className="size-5 translate-y-0.5 text-[var(--accent)]" />
          <span className="text-base font-semibold tracking-[0.18em]">PROJECT AIRLOCK</span>
        </div>
        <p className="mt-1 text-[11px] text-[var(--muted)]">a local AI strips patient identity before the cloud</p>

        <p className="mt-5 text-sm text-[var(--muted)]">
          Clinical notes are processed on this machine. Sign in to continue.
        </p>

        {error && session?.user && (
          <div className="mt-4 rounded border border-[var(--border)] bg-[var(--background)] p-3 text-xs">
            <p>
              You are still signed in as{" "}
              <strong>{session.user.name ?? session.user.email}</strong> from an earlier session.
              That is why the app may have looked like it let you in anyway.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 flex gap-2 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {error === "AccessDenied"
                ? "That Google account is not on this instance's allowlist. Add it to AUTH_ALLOWED_EMAILS and restart."
                : error === "OAuthAccountNotLinked"
                  ? "An account already exists with that email address but was not created through Google. Sign in the original way, or remove that user from the database."
                  : error === "Configuration"
                    ? "Sign-in is misconfigured. Check AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, AUTH_SECRET and AUTH_URL."
                    : `Sign-in failed (${error}). Try again.`}
            </span>
          </div>
        )}

        {!configured || !googleReady ? (
          <div className="mt-4 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <p className="font-medium">Sign-in is not configured yet.</p>
            <p className="mt-1.5 leading-relaxed">
              Set{" "}
              {!googleReady && <code>AUTH_GOOGLE_ID</code>}
              {!googleReady && !configured && ", "}
              {!googleReady && <code>AUTH_GOOGLE_SECRET</code>}
              {!googleReady && !configured && " and "}
              {!configured && <code>AUTH_ALLOWED_EMAILS</code>} in <code>.env</code>, then restart.
              An empty allowlist denies everyone on purpose — this instance is reachable from the
              internet.
            </p>
          </div>
        ) : (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: from && from.startsWith("/") ? from : "/" });
            }}
          >
            <button
              type="submit"
              className="mt-5 flex w-full items-center justify-center gap-2.5 rounded border border-[var(--border)] bg-[var(--background)] px-4 py-2.5 text-sm font-medium transition-colors hover:border-[var(--accent)]"
            >
              <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
                <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
              </svg>
              Continue with Google
            </button>
          </form>
        )}

        {devLoginEnabled() && (
          <DevLoginForm
            from={from && from.startsWith("/") ? from : "/"}
            remote={devLoginAllowsRemote()}
          />
        )}

        <p className="mt-4 text-[10px] leading-relaxed text-[var(--muted)]">
          Airlock stores only your name, email and avatar from Google. Past notes are kept
          de-identified — the mapping back to real identifiers is destroyed when each note finishes.{" "}
          <a
            href="https://github.com/galencky/local_llm"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
          >
            Read the source.
          </a>
        </p>
      </div>
    </main>
  );
}
