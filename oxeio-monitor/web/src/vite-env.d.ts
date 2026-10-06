/// <reference types="vite/client" />

/**
 * The version variables set at build time (web/Dockerfile → VITE_APP_*).
 *
 * Careful: without types, `import.meta.env.VITE_APP_BUILD` would be `any`,
 *    and a misspelt name would go unnoticed by the compiler: the badge would say "dev" forever.
 */
interface ImportMetaEnv {
  readonly VITE_APP_BUILD?: string;
  readonly VITE_APP_COMMIT?: string;
  readonly VITE_APP_BUILT_AT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
