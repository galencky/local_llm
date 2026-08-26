import type { PiiCategory, TokenVault } from "./memory-cache";

/**
 * Pass 3A — deterministic Taiwan PII scrubbing.
 *
 * This layer is high-precision and runs first so that structured identifiers
 * are gone before any text reaches the probabilistic LLM pass. It is
 * intentionally over-eager: a false positive costs a slightly odd note, a
 * false negative leaks PHI.
 */

interface RegexRule {
  category: PiiCategory;
  pattern: RegExp;
  label: string;
}

/**
 * ORDER IS LOAD-BEARING.
 *
 * The MRN rule (`\b\d{7,8}\b`) is a blunt instrument that would happily eat the
 * local part of a landline number ("02-27123456") or a bare year run. Every
 * narrower numeric rule must therefore fire before it.
 */
export const REGEX_RULES: readonly RegexRule[] = [
  {
    // National ID (A123456789), plus ARC/resident formats (old A[A-D]…, new A[89]…).
    category: "TAIWAN_ID",
    label: "National ID / ARC",
    pattern: /\b[A-Z](?:[12ABCD89])\d{8}\b/g,
  },
  {
    // Mobile 09xxxxxxxx, landline 0x-xxxxxxx / (02)2712-3456, +886 forms.
    category: "PHONE",
    label: "Phone number",
    pattern:
      /(?:\+?886[-\s]?\d{1,2}[-\s]?\d{3,4}[-\s]?\d{3,4}|09\d{2}[-\s]?\d{3}[-\s]?\d{3}|09\d{8}|\(0\d{1,2}\)\s?\d{3,4}[-\s]?\d{3,4}|0\d{1,2}-\d{6,8}(?:#\d{1,5})?)/g,
  },
  {
    // Gregorian 2024/08/23 or 2024-08-23; ROC 113/08/23 or 113-08-23.
    category: "DATE",
    label: "Date (Gregorian / ROC)",
    pattern: /\b(?:\d{4}|\d{2,3})[/-]\d{1,2}[/-]\d{1,2}\b/g,
  },
  {
    // CJK dates: 113年8月23日 / 2024年08月23日
    category: "DATE",
    label: "Date (CJK)",
    pattern: /(?:\d{2,4})\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g,
  },
  {
    // The CJK name printed beside a staff code in tabular EMR output. The local
    // NER missed these: in a header row like "DOC1234X   林建宏   [Progress
    // Note]" there is no sentence around the name to recognise it by.
    // Deliberately anchored to the code so it cannot fire on clinical text.
    //
    // MUST run before the staff-code rule below, which would otherwise replace
    // the very anchor this looks behind for.
    category: "DOCTOR",
    label: "Name beside a staff code",
    pattern: /(?<=\bDOC\d{3,6}[A-Z]?\s{1,8})[\u4e00-\u9fff]{2,4}/gi,
  },
  {
    // Staff/physician code as printed in EMR exports, e.g. "DOC1234X". These
    // identify a named clinician as surely as the name does, and were reaching
    // the cloud intact because they are neither 7-8 digits nor a word.
    category: "DOCTOR",
    label: "Staff code",
    pattern: /\bDOC\d{3,6}[A-Z]?\b/gi,
  },
  {
    // Ward-bed as printed by the EMR, e.g. "A092- 36", "A121- 6".
    category: "WARD",
    label: "Ward and bed",
    pattern: /\b[A-Z]\d{2,3}-\s?\d{1,3}\b/g,
  },
  {
    // Month/day with no year — overwhelmingly common in ward notes ("surgery
    // on 1/21") and previously invisible, because the date rule above needs
    // three components. Bounded to real months and days, and kept away from
    // anything that reads as a dose or a ratio, since mangling "1/2 tab" is a
    // patient-safety problem rather than a formatting one.
    category: "DATE",
    label: "Date (month/day, no year)",
    pattern:
      /(?<![\d/.])(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])(?![\d/])(?!\.\d)(?!\s*(?:tab|tabs|tablet|cap|caps|amp|vial|mg|ml|mL|%|units?)\b)/gi,
  },
  {
    // Hospital medical record number. Must run last — see note above.
    category: "MRN",
    label: "Medical record number",
    pattern: /\b\d{7,8}\b/g,
  },
] as const;

export interface RegexScrubResult {
  /** Text with every deterministic identifier replaced by a token. */
  text: string;
  /** Count of replacements per rule label, for the UI inspector. */
  hits: Record<string, number>;
  totalReplacements: number;
}

/**
 * Apply every deterministic rule, recording each match in `vault`.
 *
 * @param input raw clinical narrative (contains PHI)
 * @param vault volatile token store, mutated in place
 */
export function scrubWithRegex(
  input: string,
  vault: TokenVault,
): RegexScrubResult {
  const hits: Record<string, number> = {};
  let text = input;
  let totalReplacements = 0;

  for (const rule of REGEX_RULES) {
    // Fresh RegExp per pass: the module-level literals carry /g lastIndex state.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(pattern, (match) => {
      const trimmed = match.trim();
      if (!trimmed) return match;
      hits[rule.label] = (hits[rule.label] ?? 0) + 1;
      totalReplacements += 1;
      return vault.assign(rule.category, trimmed, "regex");
    });
  }

  return { text, hits, totalReplacements };
}

/**
 * Taiwan national-ID checksum, for callers that want to distinguish a real ID
 * from an eight-digit accession that happens to follow the shape.
 * Not used for redaction decisions — over-redaction is the safe failure mode.
 */
export function isValidTaiwanId(id: string): boolean {
  if (!/^[A-Z][12]\d{8}$/.test(id)) return false;
  const letterMap = "ABCDEFGHJKLMNPQRSTUVXYWZIO";
  const index = letterMap.indexOf(id[0]);
  if (index < 0) return false;
  const n = index + 10;
  const digits = [Math.floor(n / 10), n % 10, ...id.slice(1).split("").map(Number)];
  const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  return sum % 10 === 0;
}
