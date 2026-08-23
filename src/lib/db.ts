import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma singleton for the local Postgres audit store.
 *
 * Construction is LAZY and behind a proxy. Building the image has no database
 * and no DATABASE_URL, and Next collects route data at build time — an eager
 * client would throw during `next build` rather than at first query.
 *
 * Next.js dev hot-reload re-evaluates modules, so the instance is parked on
 * globalThis to avoid exhausting the connection pool on the Mac Mini.
 *
 * Reminder: this database holds DE-IDENTIFIED text only.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

let client: PrismaClient | null = null;

function getClient(): PrismaClient {
  if (client) return client;
  if (globalForPrisma.prisma) {
    client = globalForPrisma.prisma;
    return client;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to .env on the Mac Mini.");
  }

  client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = client;
  return client;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const instance = getClient();
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
