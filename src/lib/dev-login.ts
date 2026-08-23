/**
 * Configuration for the developer password bypass.
 *
 * Kept in its own module so both the API route and the sign-in page read the
 * same rules, and so the guards are visible in one place rather than scattered.
 */

export const DEV_USER_EMAIL = "airlock_dev@airlock.local";
export const DEV_USER_NAME = "airlock_dev";

/** Off unless explicitly switched on. */
export function devLoginEnabled(): boolean {
  return process.env.DEV_LOGIN_ENABLED === "true";
}

export function devLoginPassword(): string {
  return process.env.DEV_LOGIN_PASSWORD || "llm";
}

/**
 * Localhost only by default.
 *
 * The whole point of this app is that it is reachable from a hospital over a
 * Cloudflare Tunnel. A shared short password on that hostname would hand the
 * clinical pipeline to anyone who guessed the URL, so remote use has to be
 * opted into deliberately.
 */
export function devLoginAllowsRemote(): boolean {
  return process.env.DEV_LOGIN_ALLOW_REMOTE === "true";
}

export function devLoginAllowedFromHost(host: string): boolean {
  if (devLoginAllowsRemote()) return true;
  const name = host.split(":")[0].toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/**
 * The session cookie name Auth.js will look for.
 *
 * Auth.js derives the `__Secure-` prefix from AUTH_URL, not from the transport
 * of the current request. Behind a tunnel those disagree — the browser is on
 * HTTPS while the container is spoken to over HTTP — so a cookie named from the
 * connection would be written under a name Auth.js never reads. Follow AUTH_URL
 * and the two stay in lockstep.
 */
export function sessionCookieName(): { name: string; secure: boolean } {
  const url = process.env.AUTH_URL || process.env.NEXTAUTH_URL || "";
  const secure = url.startsWith("https://");
  return {
    name: secure ? "__Secure-authjs.session-token" : "authjs.session-token",
    secure,
  };
}
