import { describe, expect, it } from 'vitest';

/**
 * **Does every API function have a caller?** (G167)
 *
 * Important: **the failure this file catches** is this project's best-known
 * mistake: *"the contract is written, the caller was not"*. So far it has
 * happened **nine-plus times**: G141 · G144 · G146 · G149 · G156 · G159, and
 * lastly G167.
 *
 * In G167 the server had `POST /work-policies/:id/reactivate` **since G85**:
 * controller, service, audit row, five unit tests, all green. Only nobody on
 * the web called it. If a policy was closed by mistake, the way back was `curl`
 * or raw SQL, exactly the two things G85 was written to remove.
 *
 * This test closes half of that class. It cannot catch the other half (an
 * endpoint exists on the server but nobody wrote the function on the web);
 * that is still a job for the eye.
 *
 * Careful: the files are read with `import.meta.glob`, not `node:fs`: this
 * project has no `@types/node`, and the test files are also inside
 * `npm run typecheck` (see tsconfig.app.json). Using `fs` would let the test
 * run but break typecheck.
 */
const SOURCES = import.meta.glob('../src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Careful: functions for which having no caller is **valid**. Left empty on
 * purpose: today there is no exception, and adding a new one should be a
 * **decision**, not an accident.
 */
const ALLOWED_WITHOUT_CALLER: ReadonlySet<string> = new Set<string>();

/** Exactly `src/api/*.ts`, not the folders below */
const API_FILES = Object.keys(SOURCES)
  .filter((p) => /^\.\.\/src\/api\/[^/]+\.ts$/.test(p))
  .sort();

/** The `export function` names of one file */
function exportedFunctions(text: string): string[] {
  const names: string[] = [];
  const re = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm;

  for (const m of text.matchAll(re)) names.push(m[1]);
  return names;
}

describe('G167 — does the API function have a caller', () => {
  /** Careful: checks that the files were really read, otherwise the test would be an empty green */
  it('src/api/ and the src/ tree were read', () => {
    expect(API_FILES.length).toBeGreaterThan(5);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  for (const path of API_FILES) {
    const file = path.slice(path.lastIndexOf('/') + 1);

    for (const name of exportedFunctions(SOURCES[path])) {
      const test = ALLOWED_WITHOUT_CALLER.has(name) ? it.skip : it;

      test(`${file} :: ${name}() — someone calls it`, () => {
        const word = new RegExp(`\\b${name}\\b`);

        const callers = Object.entries(SOURCES).filter(
          ([p, text]) => p !== path && word.test(text),
        );

        expect(
          callers.length,
          `${file}-এর ${name}() কোথাও ডাকা হয় না — চুক্তি লেখা আছে, ` +
            'কলার লেখা হয়নি। হয় কলারটা লিখুন, নয় ফাংশনটা সরান।',
        ).toBeGreaterThan(0);
      });
    }
  }
});
