import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadedLmStudioModel, NER_SYSTEM_PROMPT } from "@/lib/scrubber-llm";
import { defaultModel } from "@/lib/model-registry";
import { PLACEHOLDER_KERNEL } from "@/lib/custom-mode";
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
 *
 * Custom mode is the other one, and it is deliberately a different door: it
 * replaces both prompts wholesale for a single run, keeps nothing, and is
 * marked as such on the audit row. This endpoint is where its editor reads the
 * built-in text from, so "start from the built-in prompt" cannot drift from
 * what guided mode actually sends.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  // Report the model that is actually there, not the one the environment names.
  // A model swapped in LM Studio without updating LMSTUDIO_MODEL used to leave
  // this page naming a model that was not the one reading the notes.
  const configuredLocal = process.env.LMSTUDIO_MODEL?.trim() || null;
  const loadedLocal = await loadedLmStudioModel();

  return NextResponse.json(
    {
      local: {
        /** What is answering right now. */
        model: loadedLocal ?? configuredLocal ?? "local",
        /** What LM Studio has loaded, or null when it is unreachable. */
        loadedModel: loadedLocal,
        /** What LMSTUDIO_MODEL pins each request to, or null when unset. */
        configuredModel: configuredLocal,
        prompt: NER_SYSTEM_PROMPT,
      },
      cloud: {
        // The ladder's own answer, so this can never name a rung the pipeline
        // would not actually start on.
        model: defaultModel(),
        systemInstruction: systemInstruction(),
        formats: (Object.keys(NOTE_FORMATS) as NoteFormat[]).map((f) => ({
          format: f,
          label: NOTE_FORMATS[f],
          instruction: builtInFormatInstruction(f),
        })),
      },
      custom: {
        /** Appended to any custom system instruction; re-hydration needs it. */
        placeholderKernel: PLACEHOLDER_KERNEL,
      },
      customisation: {
        where: "saved routine",
        why: "Routines are owned, PII-screened on save, and recorded by name on every audit row — so a note can always be traced to the instructions that produced it.",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
