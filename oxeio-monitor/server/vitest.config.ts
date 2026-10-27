import { resolve } from 'node:path';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

import { testDatabaseUrl } from './test/setup/test-db-url';

export default defineConfig({
  /**
   * Careful: without SWC, NestJS DI breaks in tests.
   * Vitest transpiles with esbuild, which does not support
   * `emitDecoratorMetadata`, so no `design:paramtypes` metadata is emitted and
   * every constructor injection comes through as `undefined`.
   */
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    // Plain `*.spec.ts` files run too, not just `*.e2e.spec.ts`: pure-function
    // tests (e.g. payroll.math) need no database but must run in the same command.
    include: ['test/**/*.spec.ts'],
    globalSetup: ['./test/setup/global-setup.ts'],
    // All tests share one database, so files run one after another
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      /**
       * The tests' fixed instants were written for a zone 6 hours ahead of
       * UTC with no daylight saving. `Etc/GMT-6` is exactly that, without a
       * place name (POSIX sign: GMT-6 = UTC+6). The product default is UTC;
       * a test about the default clears this variable itself.
       */
      WORK_TIMEZONE: 'Etc/GMT-6',
      /**
       * Fixtures sit at today's work-noon (`test/setup/clock.ts`), which in
       * the morning is hours ahead of the real clock, and ingest drops records
       * that end in the future (M1). A day of allowance keeps them in; the
       * bounds' own spec checks the real 5-minute default.
       */
      INGEST_FUTURE_SKEW_SEC: '86400',
      // Keep screenshot tests from writing files into the real storage
      STORAGE_ROOT: resolve(import.meta.dirname, '.tmp-test-storage'),
      JWT_SECRET:
        process.env.JWT_SECRET ??
        'test-only-secret-at-least-32-characters-long',
    },
  },
});
