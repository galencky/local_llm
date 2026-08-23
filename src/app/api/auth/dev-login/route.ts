import { NextRequest, NextResponse } from "next/server";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import {
  DEV_USER_EMAIL,
  DEV_USER_NAME,
  devLoginAllowedFromHost,
  devLoginEnabled,
  devLoginPassword,
} from "@/lib/dev-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Password bypass for development, deliberately implemented as a real session
 * rather than a special case threaded through the app.
 *
 * It mints a genuine Auth.js Session row for a fixed `airlock_dev` user, so
 * every downstream check — ownership, history scoping, tenant isolation —
 * behaves exactly as it does for a Google account. There is no "is this the
 * dev user?" branch anywhere in the pipeline, which is the point: a bypass
 * that takes a different code path is a bypass that hides bugs.
 *
 * Two guards, because a three-character password on an internet-facing
 * instance is not authentication:
 *   1. DEV_LOGIN_ENABLED must be "true" (default: off).
 *   2. The request must come from localhost, unless DEV_LOGIN_ALLOW_REMOTE.
 */

const SESSION_HOURS = 12;

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function POST(req: NextRequest) {
  if (!devLoginEnabled()) {
    return NextResponse.json(
      { error: "Developer sign-in is disabled. Set DEV_LOGIN_ENABLED=true to use it." },
      { status: 404 },
    );
  }

  const host = req.headers.get("host") ?? "";
  if (!devLoginAllowedFromHost(host)) {
    return NextResponse.json(
      {
        error:
          "Developer sign-in is restricted to localhost. This instance is reachable from the internet, where a shared password is not authentication. Set DEV_LOGIN_ALLOW_REMOTE=true only if you accept that.",
      },
      { status: 403 },
    );
  }

  let password = "";
  try {
    ({ password = "" } = (await req.json()) as { password?: string });
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  if (!constantTimeEquals(password, devLoginPassword())) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  try {
    const user = await prisma.user.upsert({
      where: { email: DEV_USER_EMAIL },
      update: {},
      create: { email: DEV_USER_EMAIL, name: DEV_USER_NAME },
    });

    const sessionToken = randomUUID();
    const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
    await prisma.session.create({ data: { sessionToken, userId: user.id, expires } });

    const secure = req.nextUrl.protocol === "https:";
    const res = NextResponse.json({ ok: true, user: { name: user.name, email: user.email } });
    res.cookies.set({
      // Same cookie Auth.js reads, so the session is indistinguishable
      // downstream from a real Google sign-in.
      name: secure ? "__Secure-authjs.session-token" : "authjs.session-token",
      value: sessionToken,
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      expires,
    });
    return res;
  } catch (err) {
    console.error(
      "[dev-login] failed:",
      err instanceof Error ? err.message.split("\n")[0] : "unknown error",
    );
    return NextResponse.json({ error: "Could not create a developer session." }, { status: 500 });
  }
}
