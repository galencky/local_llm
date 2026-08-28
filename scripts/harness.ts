/**
 * The three lines every acceptance script had written out for itself.
 *
 * Five copies of `check`, five of `section`, five `let failures = 0` and five
 * slightly different exit blocks — which is how one of them ended up counting
 * failures but exiting 0, and reported green in CI while printing FAIL.
 *
 * Deliberately tiny and deliberately not a framework. These scripts are meant
 * to be readable end to end by somebody deciding whether to trust the claims
 * they make, and a test runner would put a layer between the reader and the
 * assertion.
 */

let failures = 0;

/**
 * Assert one thing, and say what it was either way.
 *
 * @param detail shown only on failure — the actual value, so a red line is
 * enough to start debugging from without re-running anything.
 */
export function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "  — " + detail}`);
  if (!ok) failures++;
}

/** A heading, so a long run reads as sections rather than a wall. */
export function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** An indented note that is not an assertion — context, counts, what was skipped. */
export function note(text: string): void {
  console.log(`       ${text}`);
}

export function failureCount(): number {
  return failures;
}

/**
 * Print the verdict and exit with a status that matches it.
 *
 * Always call this rather than `process.exit(0)`: a suite that counts failures
 * and then exits zero is worse than no suite, because it is trusted.
 */
export function finish(): never {
  console.log(
    failures === 0
      ? `\n\x1b[32mAll checks passed.\x1b[0m\n`
      : `\n\x1b[31m${failures} check(s) FAILED.\x1b[0m\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
