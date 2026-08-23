/** Confirms the Prisma pg adapter can reach the local audit database. */
import "dotenv/config";
import { prisma } from "../src/lib/db";

async function main() {
  const row = await prisma.auditLog.create({
    data: {
      deidentifiedInput: "[PATIENT_1] fever since [DATE_1]",
      deidentifiedOutput: "**S:** [PATIENT_1] presented with fever.",
      modelUsed: "smoke-test",
      processingTimeMs: 42,
    },
  });
  console.log("insert ok:", row.id);
  console.log("rows:", await prisma.auditLog.count());
  await prisma.auditLog.delete({ where: { id: row.id } });
  console.log("delete ok, rows:", await prisma.auditLog.count());
  process.exit(0);
}

void main();
