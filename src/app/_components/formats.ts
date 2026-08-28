/**
 * Note formats as the interface names them.
 *
 * Shared by the format row and the routine editor, which both offer the same
 * six and must not disagree about what they are called. The ids are the wire
 * contract with `NOTE_FORMATS` in `gemini.ts`.
 */

/** Labels are kept short enough that all six fit one line at 1024px — the
 *  width this is built for. The full name is each button's tooltip. */
/** Labels are kept short enough that all six fit one line at 1024px — the
 *  width this is built for. The full name is each button's tooltip. */
export const FORMATS = [
  { id: "SOAP", label: "SOAP" },
  { id: "ADMISSION_NOTE", label: "Admission" },
  { id: "PROGRESS_NOTE", label: "Progress" },
  { id: "HOSPITAL_COURSE", label: "Course" },
  { id: "DISCHARGE_SUMMARY", label: "Discharge" },
  /**
   * No built-in shape — the saved routine is the whole instruction.
   *
   * The five above each carry a compiled-in structure, which is what makes two
   * notes labelled "SOAP" comparable. A routine that describes its own
   * headings was previously fighting a set it never asked for; this is the way
   * out. It requires a routine, because there is nothing else left to say what
   * the note should be.
   */
  { id: "OTHER", label: "Others" },
] as const;

/** The full name behind each short button label. */
export const NOTE_FORMAT_TITLES: Record<string, string> = {
  SOAP: "SOAP note",
  ADMISSION_NOTE: "Admission note",
  PROGRESS_NOTE: "Daily progress note",
  HOSPITAL_COURSE: "Hospital course timeline",
  DISCHARGE_SUMMARY: "Discharge summary",
  OTHER: "No built-in shape — runs on a saved routine alone",
};
