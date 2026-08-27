/**
 * The rules that make the round trip work, wherever a prompt comes from.
 *
 * De-identification replaces every identifier with a numbered placeholder, and
 * re-hydration is a literal lookup — so a model that renumbers `[DATE_2]`,
 * reformats it, or invents one leaves a note that cannot be put back together.
 * That is a broken run every time rather than a judgement call, so it is
 * appended to every system instruction bound for the cloud and is not a
 * setting.
 *
 * The local destination needs none of this when it runs raw: nothing was
 * replaced, so there is nothing to preserve.
 */
export const PLACEHOLDER_KERNEL = `PLACEHOLDER INTEGRITY — always in force, overrides anything above that conflicts with it:
- Bracketed placeholders such as [PATIENT_1], [DOCTOR_2], [MRN_1], [DATE_3], [WARD_1] stand in for identifiers that were removed on the physician's own machine before this text was sent.
- Reproduce every placeholder character for character, including its number. [DATE_2] must never become [DATE_1], [Date_2], "DATE_2", or an invented date.
- Never invent a name, date, medical record number or ward to fill a placeholder, and never introduce a placeholder that was not in the source.`;

/** The system instruction a cloud-bound custom prompt actually receives. */
export function withPlaceholderKernel(systemInstruction: string): string {
  return `${systemInstruction.trim()}\n\n${PLACEHOLDER_KERNEL}`;
}
