import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";

/**
 * Mint a real Auth.js database session for the acceptance suite.
 *
 * The app is fully gated behind Google sign-in, which a headless test cannot
 * complete. Rather than adding a bypass to the app — a permanent hole in a
 * PHI-handling service — the harness writes a genuine Session row and presents
 * the cookie exactly as a browser would. Nothing in `src/` knows about tests.
 */
export interface TestSession {
  userId: string;
  email: string;
  cookie: Record<string, string>;
}

export async function createTestSession(label = "harness"): Promise<TestSession> {
  const email = `${label}@airlock.test`;
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: `Airlock ${label}` },
  });

  const sessionToken = randomUUID();
  await prisma.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  // Auth.js derives the __Secure- prefix from AUTH_URL, so the harness must
  // too — once AUTH_URL is the public HTTPS host, a plain-named cookie is a
  // cookie Auth.js never reads, and every request comes back 401.
  const secure = (process.env.AUTH_URL ?? "").startsWith("https://");
  const name = secure ? "__Secure-authjs.session-token" : "authjs.session-token";

  return {
    userId: user.id,
    email,
    cookie: { Cookie: `${name}=${sessionToken}` },
  };
}

export async function destroyTestUser(userId: string): Promise<void> {
  // Cascades to sessions, audit rows and routines.
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
}
