import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/* ═══ PWA: building the service worker ═══════════════════════════════════
 *
 * Why not `vite-plugin-pwa`: not the dependency, but **control**. The plugin
 *    brings workbox, and workbox caches many things at runtime by default. In
 *    this app `/api/v1/screenshots/*` is employees' screen pictures, and the
 *    numbers are live: neither may pile up on a device. The full explanation
 *    is at the top of `src/pwa-sw.ts`.
 *
 * What the plugin would really be needed for is the **list of hashed files**:
 *    a name like `assets/index-eB3mYKqm.js` changes on every build, so it
 *    cannot be hand-written. The ~60 lines below do just that much: after the
 *    build they inject the list and a version hash into the service worker.
 */

/** The service worker's source: rollup's second entry */
const SW_ENTRY = 'src/pwa-sw.ts';

/** The name it comes out with after the build. Careful: the same name in `index.html` and `Caddyfile` */
const SW_FILE = 'sw.js';

/**
 * A small, stable hash (FNV-1a, 32-bit): it changes whenever the file list changes.
 *
 * Careful: deliberately not `node:crypto`: for this one line the web app would
 *    need `@types/node` (the lib in `tsconfig.node.json` is only ES2023).
 *    This is not a security hash, just a signal to tell "did it change".
 */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Careful: `Math.imul`: a plain `*` would go past 32 bits into floating
    //    point and the hash would differ from machine to machine.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function serviceWorkerPlugin(): Plugin {
  return {
    name: 'oxeio-service-worker',

    // Careful: build only. The dev server does not produce `sw.js`, and that is
    //    wanted; the reason is written in `src/pwa.ts`.
    apply: 'build',

    /**
     * Adds the service worker as a **second entry**.
     *
     * This way the file stays ordinary TypeScript: `tsc -b` checks types,
     *    eslint reads it, and it behaves like the rest of the code. Written as
     *    a string, it would get none of those three.
     * Careful: the name is `sw.js`, not hashed: the browser always looks for
     *    the worker at the **same address**. With a hash, every build would make a
     *    new worker and the old one would never be replaced.
     * Careful: scope: because it sits at `/`, the whole site is under it. In
     *    `assets/` the scope would be `/assets/` and it would never catch navigation.
     */
    config() {
      return {
        build: {
          rollupOptions: {
            input: { index: 'index.html', sw: SW_ENTRY },
            output: {
              entryFileNames: (chunk: { name: string }) =>
                chunk.name === 'sw' ? SW_FILE : 'assets/[name]-[hash].js',
            },
          },
        },
      };
    },

    /**
     * Strips the comments from `index.html` in the build.
     *
     * Careful: Vite keeps HTML comments (unlike JS/CSS, it does not strip them).
     *    The explanations in this file are long; unstripped, about 5 KB of
     *    Bengali comments would be sent **every time**, and `index.html` is
     *    deliberately `no-cache` (Caddyfile), i.e. on every dashboard open.
     *    The owner and managers open it on phone data.
     * So the comments stay in the source at full length; they are just not sent.
     * Careful: `order: 'post'`: **after** Vite inserts the script/style tags;
     *    those contain no comments, so nothing is lost.
     */
    transformIndexHtml: {
      order: 'post',
      handler: (html: string) => html.replace(/<!--[\s\S]*?-->\s*/g, ''),
    },

    /**
     * The build's files are known now: the list goes into the worker.
     */
    generateBundle(_options, bundle) {
      /**
       * Careful: `/index.html` is added by hand, not from `bundle`. Vite's HTML
       *    plugin emits that file in **its own** `generateBundle`, and the order
       *    of the two hooks depends on how the plugins are sorted. If the order
       *    changed, `index.html` would silently drop out of the list, and then
       *    the app would not open offline at all, while the build stayed green.
       */
      const shell = ['/index.html'];

      for (const fileName of Object.keys(bundle)) {
        // Careful: the worker does not precache itself: otherwise a new version
        //    would never arrive, the very trap the `Caddyfile`'s no-cache prevents.
        if (fileName === SW_FILE) continue;
        // Sourcemaps are of no use to the user, they would only make the cache heavy.
        if (fileName.endsWith('.map')) continue;
        shell.push(`/${fileName}`);
      }

      /**
       * **A guard for this project's most important rule.**
       *
       * Careful: if someone ever pulls anything from `/api/*` into the bundle it
       *    would be silently precached, i.e. employee data on the phone's disk.
       *    Stopping the build is the only honest answer.
       */
      const leaked = shell.filter((path) => path.startsWith('/api'));
      if (leaked.length > 0) {
        this.error(
          `API paths ended up in the service worker precache list: ${leaked.join(', ')} — ` +
            'API responses must never be cached (live figures and screenshots).',
        );
      }

      const chunk = bundle[SW_FILE];
      if (!chunk || chunk.type !== 'chunk') {
        this.error(
          `${SW_FILE} was not generated — rollup's entry or \`entryFileNames\` changed. ` +
            'The app will run without the worker, but the PWA cannot be installed.',
        );
        return;
      }

      // Version = hash of the list. When code changes, the assets' hashes change, so this does too.
      const version = shortHash(shell.join('\n'));

      /**
       * Careful: the placeholder's quotes can be of two kinds: when esbuild
       *    minifies it turns `'...'` into `"..."`. Both are matched, otherwise
       *    this would silently break on the very day minify is switched on.
       */
      const before = chunk.code;
      chunk.code = before
        .replace(/(['"])__OXEIO_PRECACHE__\1/, JSON.stringify(JSON.stringify(shell)))
        .replace(/(['"])__OXEIO_SW_VERSION__\1/, JSON.stringify(version));

      /**
       * Careful: if nothing was replaced the build stops. Had the placeholder
       *    not been injected, `JSON.parse('__OXEIO_PRECACHE__')` would remain in
       *    the worker, which would die at install, the user would notice
       *    nothing, and the build would look green.
       *    **Silent failure is the real enemy here.**
       */
      if (chunk.code.includes('__OXEIO_PRECACHE__') || chunk.code.includes('__OXEIO_SW_VERSION__')) {
        this.error(
          `Could not inject the placeholders into ${SW_FILE} — check whether the names ` +
            'in \`src/pwa-sw.ts\` changed.',
        );
      }

      this.info(`sw.js: ${shell.length} files precached, version ${version}`);
    },
  };
}

/**
 * If the API runs on HTTPS, the proxy must go to HTTPS too.
 *
 * Careful: when the server gets `TLS_CERT`/`TLS_KEY` it speaks **only** TLS:
 *    there is no plain HTTP left on that port. If the proxy still held on to
 *    `http://`, every request would come back as `socket hang up` and the
 *    dashboard would be completely dead, while the server's log showed nothing
 *    wrong. The day TLS is switched on is the worst day to fall into this trap.
 *
 * So the scheme is decided from `TLS_CERT` in the same `.env`: with two places
 * holding two versions of the truth, one day they would differ.
 *
 * Careful: vite reads this file **only once, at startup**. So switching TLS
 *    on or off in `.env` also means **restarting the dev server**; otherwise
 *    the proxy keeps the old scheme and every call gives 500.
 */
export default defineConfig(({ mode }) => {
  // Careful: `.env` is not in web/ but one folder above it; the server reads the same one.
  //    The third argument `''` means all variables, not only the `VITE_` ones.
  // Careful: `'..'` is deliberately relative: `loadEnv` resolves it from cwd,
  //    exactly as vite resolves its `root`. Importing `node:path`/`node:url`
  //    would need `@types/node` in web for just this one line.
  const env = loadEnv(mode, '..', '');
  const https = Boolean(env.TLS_CERT?.trim());

  return {
    plugins: [react(), tailwindcss(), serviceWorkerPlugin()],
    server: {
      port: 5173,
      /**
       * Careful: without the proxy, login would not work at all.
       *
       * The session cookie is `SameSite=Strict` (ADR-016), so the browser sends
       * it only on **same-site** requests. If the frontend on :5173 called :3000
       * directly, the cookie would not go: login would look successful, but the
       * very next request would give 401.
       */
      proxy: {
        '/api': {
          target: `${https ? 'https' : 'http'}://localhost:3000`,
          changeOrigin: false,
          // Careful: self-signed cert (deploy/make-cert.ps1): the dev proxy has
          //    to be told to accept it. This is **only for the dev server**;
          //    the agent itself verifies with an SPKI pin, and the browser checks
          //    certs by its own rules.
          secure: false,
        },
      },
    },
  };
});
