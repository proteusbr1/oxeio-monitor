/**
 * What the next employee code should be. Pure function, no I/O.
 *
 * Why a separate file: "which comes next" looks easy, but the edge cases are
 * not: mixed widths (`OX-01` vs `OX-001`), other prefixes, non-numeric codes,
 * an empty list. None of that could be tested while it sat inside the DB code.
 *
 * Careful: this is a **suggestion**, not a guarantee. The field stays editable
 * on screen, and the real protection is the database unique constraint: if
 * two people add at the same time, the second gets a 409, which is correct.
 */

/** Shape `OX-001`: a prefix, a hyphen, then digits only. */
const PATTERN = /^([A-Za-z_]+)-(\d+)$/;

const DEFAULT_PREFIX = 'OX';
const DEFAULT_WIDTH = 3;

interface Parsed {
  prefix: string;
  value: number;
  width: number;
}

function parse(code: string): Parsed | null {
  const m = PATTERN.exec(code.trim());
  if (!m) return null;

  return { prefix: m[1], value: Number(m[2]), width: m[2].length };
}

/**
 * @param existing Codes of **all** employees in the database, active and
 * inactive alike.
 *
 * Careful: inactive ones must be included. With only active ones, the code
 * of a departed employee would be suggested again and saving would fail with
 * 409, while nobody on screen has that code, so the cause would be unclear.
 */
export function nextEmployeeCode(existing: readonly string[]): string {
  const parsed = existing
    .map(parse)
    .filter((p): p is Parsed => p !== null);

  if (parsed.length === 0) {
    // Careful: `OX-001`, not `OX-1`. The on-screen hint gives this example,
    // and three digits keep the order correct up to 999 people.
    return `${DEFAULT_PREFIX}-${'1'.padStart(DEFAULT_WIDTH, '0')}`;
  }

  /**
   * The **largest number** is the base, and its width is used.
   *
   * Careful: real data has two styles side by side: `OX-001` (typed by the
   * owner) and `OX-01`...`OX-12` (from the seed). Taking "the widest" would
   * give `OX-013` next and break out of the running sequence. Instead it
   * continues from where the sequence stopped: `OX-12` -> `OX-13`.
   */
  let best = parsed[0];
  for (const p of parsed) {
    if (p.value > best.value) best = p;
  }

  const prefix = mostCommonPrefix(parsed) ?? best.prefix;
  const next = best.value + 1;

  // Careful: when the number outgrows the width (99 -> 100) nothing can be
  // truncated, so `padStart` simply lets it grow.
  return `${prefix}-${String(next).padStart(best.width, '0')}`;
}

/**
 * Careful: the prefix is taken from the **most common** one, not from the
 * largest code. If someone once entered `TMP-99`, every later suggestion
 * would become `TMP-` while the other 12 people are `OX-`.
 */
function mostCommonPrefix(parsed: readonly Parsed[]): string | null {
  const counts = new Map<string, number>();
  for (const p of parsed) counts.set(p.prefix, (counts.get(p.prefix) ?? 0) + 1);

  let winner: string | null = null;
  let top = 0;
  for (const [prefix, n] of counts) {
    if (n > top) {
      top = n;
      winner = prefix;
    }
  }
  return winner;
}
