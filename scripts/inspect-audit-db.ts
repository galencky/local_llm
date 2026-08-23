/**
 * Show exactly what the audit database holds, and prove what it does not.
 *
 *   npx tsx scripts/inspect-audit-db.ts
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";

/** Identifiers from the mock notes — anything here would be a leak. */
const IDENTIFIERS = [
  "黃文昌", "黃李秀蘭", "蘇建誠", "詹佩蓉", "林淑惠", "吳承翰", "林佳玲",
  "K184525646", "H284549486", "3308914", "4471902",
  "0955-217-403", "0937-882-146", "2024/11/07", "2024/04/18",
];

async function main() {
  console.log("\n=== TABLES ===");
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  for (const t of tables) {
    const n = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT count(*)::bigint AS c FROM "${t.tablename}"`,
    );
    console.log(`  ${t.tablename.padEnd(20)} ${String(n[0].c).padStart(5)} rows`);
  }

  console.log("\n=== AuditLog COLUMNS ===");
  const cols = await prisma.$queryRaw<{ column_name: string; data_type: string; is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_name='AuditLog' ORDER BY ordinal_position`;
  for (const c of cols) {
    console.log(`  ${c.column_name.padEnd(20)} ${c.data_type.padEnd(28)} ${c.is_nullable === "YES" ? "null ok" : "required"}`);
  }

  const total = await prisma.auditLog.count();
  console.log(`\n=== CONTENT (${total} rows) ===`);
  const latest = await prisma.auditLog.findFirst({
    orderBy: { createdAt: "desc" },
    include: { user: { select: { email: true } } },
  });

  if (!latest) {
    console.log("  (empty — run a note first)");
  } else {
    console.log(`  id                 ${latest.id}`);
    console.log(`  createdAt          ${latest.createdAt.toISOString()}`);
    console.log(`  userId             ${latest.userId ?? "(none)"}  ${latest.user?.email ?? ""}`);
    console.log(`  noteFormat         ${latest.noteFormat ?? "(none)"}`);
    console.log(`  promptTemplateName ${latest.promptTemplateName ?? "(none)"}`);
    console.log(`  modelUsed          ${latest.modelUsed}`);
    console.log(`  processingTimeMs   ${latest.processingTimeMs}`);
    console.log("\n  deidentifiedInput  (what was sent to Gemini):");
    console.log(latest.deidentifiedInput.split("\n").map((l) => "    │ " + l).join("\n"));
    console.log("\n  deidentifiedOutput (what Gemini returned, tokens intact):");
    console.log(latest.deidentifiedOutput.split("\n").slice(0, 6).map((l) => "    │ " + l).join("\n"));
  }

  console.log("\n=== WHAT IS *NOT* HERE ===");
  console.log("  There is no column for the raw note, and none for the token map.");
  console.log("  The map lives only in RAM for the life of one request.\n");

  let leaked = 0;
  for (const id of IDENTIFIERS) {
    const n = await prisma.auditLog.count({
      where: {
        OR: [
          { deidentifiedInput: { contains: id } },
          { deidentifiedOutput: { contains: id } },
        ],
      },
    });
    if (n > 0) {
      console.log(`  LEAK  "${id}" appears in ${n} row(s)`);
      leaked += n;
    }
  }
  console.log(
    leaked === 0
      ? `  Scanned all ${total} rows for ${IDENTIFIERS.length} known identifiers: none present.`
      : `  ${leaked} LEAKED ROWS`,
  );

  console.log("\n=== OTHER TABLES, BRIEFLY ===");
  console.log("  User / Account / Session  Auth.js. Name, email, avatar from Google. No clinical data.");
  console.log("  PromptTemplate            Saved instructions. Rejected at write time if they contain PII.");
  console.log("  ModelCooldown             Which Gemini models are spent, and until when.\n");

  process.exit(leaked === 0 ? 0 : 1);
}

void main();
