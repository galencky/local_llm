import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Gate everything behind sign-in.
 *
 * This instance is exposed through a Cloudflare Tunnel, so an unauthenticated
 * route is an open door to the clinical pipeline. Only the auth endpoints, the
 * sign-in page and static assets are public.
 *
 * The session cookie's *presence* is the gate here, and presence is NOT proof:
 * anyone can send `authjs.session-token=anything`. Middleware deliberately
 * avoids a database round-trip on every request, so this is a cheap filter for
 * the unauthenticated, never an authorisation check.
 *
 * Every route that returns data therefore calls `auth()` itself. Treat that as
 * mandatory for anything added here: a handler that trusts the middleware is a
 * handler any stranger can read.
 */
const PUBLIC = [
  /^\/signin/,
  /^\/api\/auth\//,
  /^\/api\/health$/,
  /^\/_next\//,
  /^\/favicon/,
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => p.test(pathname))) return NextResponse.next();

  const hasSession =
    req.cookies.has("authjs.session-token") ||
    req.cookies.has("__Secure-authjs.session-token");

  if (hasSession) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in required.", code: "UNAUTHENTICATED" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/signin";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
