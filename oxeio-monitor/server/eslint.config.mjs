import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.tmp-test-storage/**',
      'prisma/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // An empty class (module) in NestJS DI constructors is normal
      '@typescript-eslint/no-extraneous-class': 'off',
      // Intentionally unused parameters are exempt when they start with `_`
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },

  {
    // any / non-null assertions are normal in tests: supertest's body is untyped,
    // and fixtures have values that are known for sure
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    /**
     * G140: the real clock is forbidden in spec files.
     *
     * Careful: date-dependent tests broke THREE times in this repo, in three different
     * files (G62, adjustments.e2e, agent-recovery.e2e). Each time the code already had a
     * way to inject time and the test just did not use it. The rule rested on someone
     * remembering, and after three times that is no longer an accident.
     *
     * Use the harness's two doors instead: `workNoon()` (a fixture moment 12 hours
     * from both day boundaries) and `uniqueSuffix()` (for unique names, no clock).
     *
     * Careful: `test/setup/**` is deliberately exempt: it is the only place where the
     * real clock is read, which is the helpers' job. The rule holds because the
     * exemption is kept narrow: a wide exemption means no rule.
     */
    files: ['test/**/*.ts'],
    /**
     * Careful: `test/setup/**`: the helpers touch the real clock themselves; that is
     * their job.
     *
     * Careful: `test/clock.spec.ts` is the rule's own guard. The whole claim of that
     *    file is "`workNoon()` lands in the right place relative to the real clock",
     *    and proving it requires comparing against the real clock. Without the
     *    exemption one of two things would happen: the rule suppressed inline, or the
     *    guard never written, and both are bad.
     */
    ignores: ['test/setup/**', 'test/clock.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'No `new Date()` in specs (G140) — take the fixture moment from the harness: `workNoon()`. Tests in this repo broke three times by landing on either side of midnight.',
        },
        {
          selector:
            "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'No `Date.now()` in specs (G140) — use `workNoon()` for time, or `realNow()` when the real clock is the point, and `uniqueSuffix()` for unique names (harness).',
        },
      ],
    },
  },
);
