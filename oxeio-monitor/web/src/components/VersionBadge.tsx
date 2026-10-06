import { useEffect, useState } from 'react';

import { useT } from '../i18n';

/**
 * The build number in the corner: which code is running right now.
 *
 * Careful: the number is not hand-written; it comes from git (`git rev-list
 * --count`, filled in at build time by `deploy/vps-update.sh`). It goes up by
 * exactly one per commit, so "bump the version on every change" does not depend on
 * anyone remembering.
 *
 * Careful: a hand-bumped number would one day fall behind, and then the screen
 * would say new code is running while the old code ran. A wrong version is worse
 * than no version, because people go looking for the bug somewhere else.
 */

const BUILD = import.meta.env.VITE_APP_BUILD || 'dev';
const COMMIT = import.meta.env.VITE_APP_COMMIT || 'local';
const BUILT_AT = import.meta.env.VITE_APP_BUILT_AT || '';

interface ApiVersion {
  build: string;
  commit: string;
}

export function VersionBadge() {
  const t = useT();
  const [api, setApi] = useState<ApiVersion | null>(null);

  /**
   * The API's version is fetched once too: the only way to catch a half deploy.
   *
   * Careful: new web + old api is a completely silent state: the page looks new
   * while the API gives old answers. Without showing this match, the question "I
   * deployed the fix, why is it not working" would cost hours.
   *
   * Careful: called once, no polling: the version does not change during a page's
   * life. And `/health` opens without login, so the badge tells the truth on the
   * login page too.
   */
  useEffect(() => {
    let alive = true;
    fetch('/api/v1/health', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: ApiVersion | null) => {
        if (alive && j) setApi({ build: j.build, commit: j.commit });
      })
      // Careful: silent: being unable to show the version is never the page's problem.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Careful: warn whenever they differ, but not in a `dev` build; otherwise the
   * badge would be red all the time on a developer's machine and nobody would look.
   */
  const mismatch =
    api !== null && BUILD !== 'dev' && api.build !== 'dev' && api.build !== BUILD;

  const detail = [
    `web #${BUILD} · ${COMMIT}`,
    api ? `api #${api.build} · ${api.commit}` : t('api version unknown'),
    BUILT_AT ? t('built {{date}}', { date: BUILT_AT }) : null,
    mismatch ? t('Web and API are from different builds — redeploy') : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    /*
     * Careful: `fixed` + `pointer-events-none`: the badge sits in the corner but
     * does not block clicks on buttons or links beneath it. Only the inner text
     * catches hover, so details can be seen.
     * Careful: `z-40`: below modals (z-50) and their shadow. The badge can never sit
     * above a dialog.
     *
     * Careful: on touch screens the badge catches no clicks at all
     * (`pointer-events-auto` only if `hover: hover`). The reason is simple: the only
     * way to get details is the `title` tooltip, and a tooltip never appears on a
     * phone, so there the badge would catch clicks only to swallow someone else's
     * tap. The bottom-right corner is exactly where the Settings row's buttons and
     * the last actions on a page sit, so a finger there would do nothing and the
     * button would seem broken.
     */
    <div className="pointer-events-none fixed right-2 bottom-2 z-40 select-none">
      {/*
        Careful: this used to be unreadable (the owner's report): it was 10px,
           `ink-3` (the faintest ink) and a 70% transparent background, so three


        Now it is 12px, `ink-2`, a solid background and a border. It is still
           small: it is a receipt, not part of the page's work, and a larger one
           would draw the eye in every screen corner. It was enlarged only as
           much as needed to be readable.

        Careful: the border matters: the badge sits on any background (table,
           chart, empty space), and without a solid color it sometimes blended in.
      */}
      <span
        className={`num rounded-md border px-2 py-1 text-[12px] tabular-nums [@media(hover:hover)]:pointer-events-auto ${
          mismatch
            ? 'border-brand/40 bg-brand-bg text-brand-ink'
            : 'border-line bg-surface text-ink-2 hover:text-ink'
        }`}
        title={detail}
      >
        {mismatch ? '⚠ ' : ''}#{BUILD}
      </span>
    </div>
  );
}
