import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Past notes for the signed-in clinician.
 *
 * Everything returned here is DE-IDENTIFIED and always will be: the token→PII
 * map is purged when the request that created it ends, so the real identifiers
 * are unrecoverable by design. History is a record of what was sent to the
 * cloud, not a second copy of the chart.
 */
const PAGE_SIZE = 25;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const url = req.nextUrl.searchParams;
  const cursor = url.get("cursor");
  const q = url.get("q")?.trim();
  const format = url.get("format")?.trim();

  try {
    const rows = await prisma.auditLog.findMany({
      where: {
        userId: session.user.id,
        ...(format ? { noteFormat: format } : {}),
        ...(q
          ? {
              OR: [
                { deidentifiedInput: { contains: q, mode: "insensitive" } },
                { deidentifiedOutput: { contains: q, mode: "insensitive" } },
                { promptTemplateName: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        createdAt: true,
        deidentifiedInput: true,
        deidentifiedOutput: true,
        modelUsed: true,
        noteFormat: true,
        promptTemplateName: true,
        processingTimeMs: true,
      },
    });

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    return NextResponse.json(
      { notes: page, nextCursor: hasMore ? page[page.length - 1].id : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[history] query failed:", err instanceof Error ? err.message.split("\n")[0] : err);
    return NextResponse.json({ error: "History unavailable." }, { status: 503 });
  }
}

/** Delete one of the signed-in user's own notes. */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  // Scoped by userId so one clinician can never delete another's row.
  const { count } = await prisma.auditLog.deleteMany({
    where: { id, userId: session.user.id },
  });
  return NextResponse.json({ ok: count > 0 }, { status: count > 0 ? 200 : 404 });
}
