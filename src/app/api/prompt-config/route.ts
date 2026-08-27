import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadedLmStudioModel, NER_SYSTEM_PROMPT } from "@/lib/scrubber-llm";
import { defaultModel } from "@/lib/model-registry";
import { PLACEHOLDER_KERNEL } from "@/lib/placeholders";
import {
  BUILT_IN_FORMATS,
  builtInFormatInstruction,
  NOTE_FORMATS,
  systemInstruction,
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
 * The custom-prompt workspace is the other door, and deliberately a different
 * one: it asks its own question entirely, keeps nothing, and is marked as such
 * on the audit row.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  // Report the model that is actually there. LMSTUDIO_MODEL is only a fallback
  // for when LM Studio cannot be reached, so it is surfaced separately rather
  // than mixed into the name this page shows.
  const configuredLocal = process.env.LMSTUDIO_MODEL?.trim() || null;
  const loadedLocal = await loadedLmStudioModel();

  return NextResponse.json(
    {
      local: {
        /** What is answering right now. */
        model: loadedLocal ?? configuredLocal ?? "local",
        /** What LM Studio has loaded, or null when it is unreachable. */
        loadedModel: loadedLocal,
        /** The LMSTUDIO_MODEL fallback, used only if detection fails. */
        configuredModel: configuredLocal,
        prompt: NER_SYSTEM_PROMPT,
      },
      cloud: {
        // The ladder's own answer, so this can never name a rung the pipeline
        // would not actually start on.
        model: defaultModel(),
        systemInstruction: systemInstruction(),
        // CUSTOM is deliberately absent: it has no compiled-in skeleton to
        // show, because the clinician writes it per run.
        formats: BUILT_IN_FORMATS.map((f) => ({
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
