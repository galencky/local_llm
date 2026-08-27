import "server-only";
import { prisma } from "./db";
import { TokenVault } from "./memory-cache";
import { scrubWithRegex } from "./scrubber-regex";
import { isNoteFormat } from "./gemini";

/**
 * Saved instruction blocks, one per specialty routine, appended to the Gemini
 * prompt at request time.
 *
 * A template is CONFIGURATION, not clinical data. `assertNoPii` refuses to save
 * anything that trips the deterministic scrubber: a template is persisted to
 * disk in Postgres forever, so a patient identifier pasted into one would
 * quietly defeat the whole pipeline.
 */

export const MAX_INSTRUCTION_LENGTH = 4000;
export const MAX_NAME_LENGTH = 80;

export interface PromptTemplateInput {
  name: string;
  specialty?: string | null;
  /** "note" (default) or "prompt" — which workspace this routine is for. */
  kind?: string | null;
  /** Note: the charting instruction. Prompt: the prompt itself. */
  instruction: string;
  /** Prompt routines only. */
  systemInstruction?: string | null;
  format?: string | null;
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  maxTokens?: number | null;
  isDefault?: boolean;
}

/** Null when absent, clamped when present — a saved number is still a number
 *  that arrived over the wire. */
function optionalNumber(
  value: unknown,
  min: number,
  max: number,
  round = false,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
}

export class PromptValidationError extends Error {
  constructor(message: string, readonly detail?: string[]) {
    super(message);
    this.name = "PromptValidationError";
  }
}

/**
 * Reject templates containing anything the regex scrubber recognises as a
 * patient identifier.
 *
 * @throws {PromptValidationError} naming the categories that matched.
 */
function assertNoPii(...fields: (string | null | undefined)[]): void {
  const text = fields.filter(Boolean).join("\n");
  if (!text.trim()) return;
  const found = scrubWithRegex(text, new TokenVault());
  if (found.totalReplacements > 0) {
    throw new PromptValidationError(
      "A saved prompt must not contain patient data. Remove the identifiers and save again.",
      Object.keys(found.hits),
    );
  }
}

function normalise(input: PromptTemplateInput) {
  const name = input.name?.trim();
  const instruction = input.instruction?.trim();
  const kind = input.kind === "prompt" ? "prompt" : "note";
  const systemInstruction = input.systemInstruction?.trim() || null;

  if (!name) throw new PromptValidationError("Give the template a name.");
  if (name.length > MAX_NAME_LENGTH) {
    throw new PromptValidationError(`Name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  if (!instruction) throw new PromptValidationError("The instruction is empty.");
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new PromptValidationError(
      `Instruction must be ${MAX_INSTRUCTION_LENGTH} characters or fewer.`,
    );
  }

  const format = input.format?.trim() || null;
  if (format && !isNoteFormat(format)) {
    throw new PromptValidationError(`"${format}" is not a known note format.`);
  }

  if (systemInstruction && systemInstruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new PromptValidationError(
      `System instruction must be ${MAX_INSTRUCTION_LENGTH} characters or fewer.`,
    );
  }

  const specialty = input.specialty?.trim() || null;
  // A saved routine lives in Postgres forever, so BOTH bodies are screened —
  // a prompt routine is no less permanent than a charting one.
  assertNoPii(name, specialty, instruction, systemInstruction);

  return {
    name,
    specialty,
    kind,
    instruction,
    systemInstruction,
    // A format only means anything to a note routine.
    format: kind === "note" ? format : null,
    temperature: optionalNumber(input.temperature, 0, 2),
    topP: optionalNumber(input.topP, 0, 1),
    topK: optionalNumber(input.topK, 0, 200, true),
    maxTokens: optionalNumber(input.maxTokens, 256, 32768, true),
    isDefault: Boolean(input.isDefault),
  };
}

/** A clinician's own routines plus any shared (ownerless) ones. */
export async function listTemplates(userId: string) {
  return prisma.promptTemplate.findMany({
    where: { OR: [{ userId }, { userId: null }] },
    orderBy: [{ isDefault: "desc" }, { specialty: "asc" }, { name: "asc" }],
  });
}

/** Only one routine may be preselected PER WORKSPACE. */
async function clearOtherDefaultsOfKind(userId: string, kind: string, keepId: string | null) {
  await prisma.promptTemplate.updateMany({
    where: { isDefault: true, userId, kind, ...(keepId ? { NOT: { id: keepId } } : {}) },
    data: { isDefault: false },
  });
}

export async function createTemplate(userId: string, input: PromptTemplateInput) {
  const data = normalise(input);
  return prisma.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.promptTemplate.updateMany({
        where: { isDefault: true, userId, kind: data.kind },
        data: { isDefault: false },
      });
    }
    return tx.promptTemplate.create({ data: { ...data, userId } });
  });
}

/**
 * A routine is manageable by its owner, or by anyone if it is shared.
 *
 * Ownerless rows (`userId: null`) are instance-wide shared routines. Scoping
 * writes to `{ id, userId }` alone made them visible to everyone and editable
 * by no one — an undeletable dead end. Anyone signed in to this instance may
 * manage a shared routine; a routine with an owner stays private to them.
 */
function writableBy(userId: string, id: string) {
  return { id, OR: [{ userId }, { userId: null }] };
}

export async function updateTemplate(userId: string, id: string, input: PromptTemplateInput) {
  const data = normalise(input);
  if (data.isDefault) await clearOtherDefaultsOfKind(userId, data.kind, id);
  const { count } = await prisma.promptTemplate.updateMany({
    where: writableBy(userId, id),
    data,
  });
  if (count === 0) throw new PromptValidationError("That routine is not yours to edit.");
  return prisma.promptTemplate.findUnique({ where: { id } });
}

export async function deleteTemplate(userId: string, id: string) {
  const { count } = await prisma.promptTemplate.deleteMany({ where: writableBy(userId, id) });
  if (count === 0) throw new PromptValidationError("That routine is not yours to delete.");
  return { ok: true };
}

/** Readable by the owner, or by anyone if it is a shared routine. */
export async function getTemplate(userId: string, id: string) {
  return prisma.promptTemplate.findFirst({
    where: { id, OR: [{ userId }, { userId: null }] },
  });
}
