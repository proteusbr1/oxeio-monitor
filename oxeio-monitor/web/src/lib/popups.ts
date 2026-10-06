/**
 * Open many links in new tabs at once (a button to open the links of all 30
 * tasks in hand together).
 *
 * Careful: the browser blocks from the second tab on, and that is the whole
 * reason for this file. Several `window.open()` calls in one press count as a
 * pop-up to the browser: Chrome opens the first, blocks the other 29, and quietly
 * puts a small icon in the address bar. So "I opened them" cannot end the job: it
 * must count how many really opened. Otherwise someone who sees one tab would
 * think the button is broken, and nobody would say where the other 29 went.
 *
 * Careful: `'noopener'` is deliberately left out; `opener = null` is set by hand
 * instead. With `window.open(url, '_blank', 'noopener')` the security would be the
 * same, but the return value would then always be `null`, so there would be no way
 * to tell a blocked tab from an opened one, and the count above would be impossible.
 */

/**
 * Careful: not `Window`, only what is needed, so tests can build a fake tab
 * without jsdom (`environment: 'node'` in `vitest.config.ts`).
 */
export interface OpenedTab {
  opener: unknown;
}

export type TabOpener = (url: string) => OpenedTab | null;

export interface OpenTabsResult {
  opened: number;
  blocked: number;
}

/**
 * Each URL in its own tab, and it returns what happened: how many opened, how
 * many the browser blocked.
 *
 * Careful: the loop does not stop when one is blocked. Chrome opens the first and
 * blocks the rest, but not all browsers follow one rule; stopping midway would
 * lose the tabs that could have opened.
 */
export function openInTabs(
  urls: readonly string[],
  open: TabOpener,
): OpenTabsResult {
  let opened = 0;
  let blocked = 0;

  for (const url of urls) {
    const tab = open(url);
    if (tab === null) {
      blocked++;
      continue;
    }
    // Careful: tabnabbing: the new tab could use `window.opener` to send this page
    // elsewhere (the same reason as `rel="noopener"` in `MyTasks`)
    tab.opener = null;
    opened++;
  }

  return { opened, blocked };
}

/**
 * What to tell people when tabs were blocked: a pure function, so it is testable.
 *
 * Careful: the message must say what to do, not just "blocked". The fix is in
 * one place: the pop-up icon in the address bar, allowing this site, once. Without
 * that sentence the person would assume the button itself was broken and open 30
 * links by hand every day.
 *
 * Careful: `null` when everything opened: reassurance like "all good" does not go
 * on screen (the rule of `Notice`). When the job is done, the tabs themselves are the proof.
 */
export function blockedNotice(total: number, blocked: number): string | null {
  if (blocked <= 0) return null;

  const what =
    blocked === total
      ? `The browser blocked all ${total} tabs.`
      : `The browser blocked ${blocked} of ${total} tabs.`;

  return `${what} Allow pop-ups for this site — the icon at the right of the address bar — then press again.`;
}
