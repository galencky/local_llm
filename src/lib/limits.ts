/**
 * Input budget for a single narrative.
 *
 * These are SAFETY limits before they are performance limits. The local NER
 * pass runs on a ~4B model with a 34k context; feed it a note longer than it
 * can attend to reliably and it starts missing names — which is a PHI leak,
 * not merely a quality dip. The soft threshold warns, the hard cap refuses.
 *
 * Shared by the browser (live counter) and the server (enforcement), so the two
 * can never disagree.
 */

/** Comfortable working size: a full shift handover fits well inside this. */
export const SOFT_CHAR_LIMIT = 6000;

/**
 * Refusal point. Roughly 20k characters of CJK-heavy clinical text against a
 * 34,304-token context, leaving headroom for the system prompt and the entity
 * list the model has to write back.
 */
export const HARD_CHAR_LIMIT = 20000;

export interface TextMeasure {
  chars: number;
  /**
   * Latin words plus CJK characters counted individually — CJK is unspaced, so
   * a whitespace split alone would report a 400-character Chinese note as
   * "1 word".
   */
  words: number;
  overSoft: boolean;
  overHard: boolean;
  /** 0–1 against the hard cap, for the progress meter. */
  fraction: number;
}

const CJK =
  /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/gu;

export function measure(text: string): TextMeasure {
  const chars = text.length;
  const cjkCount = text.match(CJK)?.length ?? 0;
  const latinWords = text
    .replace(CJK, " ")
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w)).length;

  return {
    chars,
    words: latinWords + cjkCount,
    overSoft: chars > SOFT_CHAR_LIMIT,
    overHard: chars > HARD_CHAR_LIMIT,
    fraction: Math.min(1, chars / HARD_CHAR_LIMIT),
  };
}
