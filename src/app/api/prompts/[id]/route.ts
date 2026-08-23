import { NextRequest, NextResponse } from "next/server";
import {
  deleteTemplate,
  updateTemplate,
  PromptValidationError,
  type PromptTemplateInput,
} from "@/lib/prompts";
import { auth } from "@/lib/auth";

async function requireUser() {
  const session = await auth();
  return session?.user?.id ?? null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/prompts/[id]">) {
  const userId = await requireUser();
  if (!userId) {
    return NextResponse.json({ error: "Sign in required.", code: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: PromptTemplateInput;
  try {
    body = (await req.json()) as PromptTemplateInput;
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  try {
    return NextResponse.json({ template: await updateTemplate(userId, id, body) });
  } catch (err) {
    if (err instanceof PromptValidationError) {
      return NextResponse.json({ error: err.message, detail: err.detail }, { status: 422 });
    }
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A template with that name already exists." }, { status: 409 });
    }
    console.error("[prompts] update failed:", err instanceof Error ? err.message.split("\n")[0] : err);
    return NextResponse.json({ error: "Could not update the template." }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/prompts/[id]">) {
  const userId = await requireUser();
  if (!userId) {
    return NextResponse.json({ error: "Sign in required.", code: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await deleteTemplate(userId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PromptValidationError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error("[prompts] delete failed:", err instanceof Error ? err.message.split("\n")[0] : err);
    return NextResponse.json({ error: "Could not delete the template." }, { status: 500 });
  }
}
