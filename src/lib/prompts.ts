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
  instruction: string;
  format?: string | null;
  isDefault?: boolean;
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

  const specialty = input.specialty?.trim() || null;
  assertNoPii(name, specialty, instruction);

  return { name, specialty, instruction, format, isDefault: Boolean(input.isDefault) };
}

/** Only one template may be the default; clear the others in the same transaction. */
async function clearOtherDefaults(userId: string, keepId: string | null): Promise<void> {
  await prisma.promptTemplate.updateMany({
    where: { isDefault: true, userId, ...(keepId ? { NOT: { id: keepId } } : {}) },
    data: { isDefault: false },
  });
}

/** A clinician's own routines plus any shared (ownerless) ones. */
export async function listTemplates(userId: string) {
  return prisma.promptTemplate.findMany({
    where: { OR: [{ userId }, { userId: null }] },
    orderBy: [{ isDefault: "desc" }, { specialty: "asc" }, { name: "asc" }],
  });
}

export async function createTemplate(userId: string, input: PromptTemplateInput) {
  const data = normalise(input);
  return prisma.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.promptTemplate.updateMany({
        where: { isDefault: true, userId },
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
  if (data.isDefault) await clearOtherDefaults(userId, id);
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
