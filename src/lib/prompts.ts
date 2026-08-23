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
async function clearOtherDefaults(keepId: string | null): Promise<void> {
  await prisma.promptTemplate.updateMany({
    where: { isDefault: true, ...(keepId ? { NOT: { id: keepId } } : {}) },
    data: { isDefault: false },
  });
}

export async function listTemplates() {
  return prisma.promptTemplate.findMany({
    orderBy: [{ isDefault: "desc" }, { specialty: "asc" }, { name: "asc" }],
  });
}

export async function createTemplate(input: PromptTemplateInput) {
  const data = normalise(input);
  return prisma.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.promptTemplate.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.promptTemplate.create({ data });
  });
}

export async function updateTemplate(id: string, input: PromptTemplateInput) {
  const data = normalise(input);
  if (data.isDefault) await clearOtherDefaults(id);
  return prisma.promptTemplate.update({ where: { id }, data });
}

export async function deleteTemplate(id: string) {
  return prisma.promptTemplate.delete({ where: { id } });
}

export async function getTemplate(id: string) {
  return prisma.promptTemplate.findUnique({ where: { id } });
}
