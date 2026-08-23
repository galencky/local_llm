import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./db";

/**
 * Google sign-in for Project Airlock.
 *
 * ======================== SECURITY NOTE ========================
 * This instance is reachable through a Cloudflare Tunnel. Without an
 * allowlist, *any* Google account on earth could sign in and submit clinical
 * text to your Mac Mini. AUTH_ALLOWED_EMAILS is therefore mandatory: an empty
 * or unset list denies everyone rather than allowing everyone.
 * ===============================================================
 */

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

/** Comma-separated emails, or `@domain.org` entries to allow a whole domain. */
function allowlist(): string[] {
  return (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = allowlist();
  // Fail closed: an unconfigured allowlist admits nobody.
  if (list.length === 0) return false;
  const addr = email.toLowerCase();
  const domain = `@${addr.split("@")[1] ?? ""}`;
  return list.includes(addr) || list.includes(domain);
}

export function allowlistConfigured(): boolean {
  return allowlist().length > 0;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // No offline access or extra scopes: Airlock needs identity, nothing else.
      authorization: { params: { prompt: "select_account" } },
    }),
  ],
  session: { strategy: "database", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    signIn({ profile, user }) {
      return isAllowed(profile?.email ?? user?.email);
    },
    session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
  trustHost: true,
});
