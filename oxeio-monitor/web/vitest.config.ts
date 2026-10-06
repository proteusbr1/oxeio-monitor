import { defineConfig } from 'vitest/config';

/**
 * Careful: the web app had **not a single test** until now, though the server
 * has over 600. The gap is no coincidence: a React test usually means DOM, jsdom,
 * render, a heavy setup, so it keeps getting postponed.
 *
 * So the start is from the other end: **the parts that can go wrong without any
 * DOM** come first. Formatting hours, working out work-zone dates, showing money:
 * if any is wrong, a wrong **number** lands on screen, and that is this
 * system's worst failure: nobody catches it, because it looks right.
 *
 * Careful: `environment: 'node'`: jsdom was deliberately not brought in. None
 * of the tests here need a DOM, and jsdom would add several seconds to every
 * run. It can be added the day component tests are written.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
  },
});
