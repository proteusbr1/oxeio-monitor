import { resolve } from 'node:path';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * **Tests without a database** — `npm run test:nodb`.
 *
 * Why a separate config: the `globalSetup` in `vitest.config.ts` starts a real
 * Postgres and runs migrations. That is fine in CI, but anyone without Docker on
 * their machine (the system now runs on a VPS) could not run even **a single
 * pure-function test** — although all payroll and deposit math is written as
 * pure functions for exactly this reason.
 *
 * `*.e2e.spec.ts` is deliberately **excluded**: those cannot run without a
 * database, and listing them would show red every time and look like a break.
 * Green here means "everything that could run is fine", **not** "everything is
 * fine" — CI has the final word.
 */
export default defineConfig({
  // Without SWC, NestJS DI breaks (see the note in `vitest.config.ts`)
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    exclude: ['test/**/*.e2e.spec.ts', 'node_modules/**'],
    env: {
      NODE_ENV: 'test',
      // `screenshot-heal.spec.ts` needs no database but wants a writable
      // folder. Without this it would be the only red test, and the cause
      // would be misread as "no database".
      STORAGE_ROOT: resolve(import.meta.dirname, '.tmp-test-storage'),
    },
  },
});
