import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { NER_SYSTEM_PROMPT } from "@/lib/scrubber-llm";
import {
  builtInFormatInstruction,
  NOTE_FORMATS,
  systemInstruction,
  type NoteFormat,
} from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only view of everything the two models are told.
 *
 * Nothing here is editable, and that is deliberate rather than unfinished:
 *
 *  - The local NER prompt IS the de-identification step. A clinician
 *    weakening it would silently widen what reaches the cloud.
 *  - The Gemini system instruction carries the placeholder rules that keep
 *    `[PATIENT_1]` intact through the round trip, and the rules that stop the
 *    model inventing findings.
 *  - The format skeletons are what the audit log's `noteFormat` refers to.
 *    Letting them drift per user would make two rows labelled "SOAP"
 *    incomparable.
 *
 * Everything a clinician should tune goes in a **saved routine**, which is
 * versioned, owned, PII-screened on save, and recorded by name on every audit
 * row. That is the supported customisation path.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  return NextResponse.json(
    {
      local: {
        model: process.env.LMSTUDIO_MODEL ?? "local",
        prompt: NER_SYSTEM_PROMPT,
      },
      cloud: {
        model: process.env.GEMINI_MODEL ?? "gemini",
        systemInstruction: systemInstruction(),
        formats: (Object.keys(NOTE_FORMATS) as NoteFormat[]).map((f) => ({
          format: f,
          label: NOTE_FORMATS[f],
          instruction: builtInFormatInstruction(f),
        })),
      },
      customisation: {
        where: "saved routine",
        why: "Routines are owned, PII-screened on save, and recorded by name on every audit row — so a note can always be traced to the instructions that produced it.",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
