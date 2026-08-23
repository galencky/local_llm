import { NextRequest, NextResponse } from "next/server";
import {
  createTemplate,
  listTemplates,
  PromptValidationError,
  type PromptTemplateInput,
} from "@/lib/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { templates: await listTemplates() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[prompts] list failed:", err instanceof Error ? err.message.split("\n")[0] : err);
    return NextResponse.json(
      { error: "Prompt library unavailable — is the audit database running?" },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: PromptTemplateInput;
  try {
    body = (await req.json()) as PromptTemplateInput;
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  try {
    return NextResponse.json({ template: await createTemplate(body) }, { status: 201 });
  } catch (err) {
    if (err instanceof PromptValidationError) {
      return NextResponse.json({ error: err.message, detail: err.detail }, { status: 422 });
    }
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json(
        { error: "A template with that name already exists." },
        { status: 409 },
      );
    }
    console.error("[prompts] create failed:", err instanceof Error ? err.message.split("\n")[0] : err);
    return NextResponse.json({ error: "Could not save the template." }, { status: 500 });
  }
}
