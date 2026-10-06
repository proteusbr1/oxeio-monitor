import { useEffect, useRef } from 'react';

/**
 * I09: "Signing out in 60 seconds".
 *
 * Careful: `Modal` from `settings/ui.tsx` is deliberately not used. It locks the
 * scroll of `document.body` and covers the whole screen. Covering the whole page
 * in front of someone who has been reading a report for half an hour interrupts
 * their work, while the point of this message was to reduce interruption. So it
 * is a toast in the corner; the page behind stays fully usable.
 *
 * Careful: `role="alertdialog"` + `aria-live`: if the time were not announced to
 * screen readers, this would be exactly the silent logout, just for someone else.
 */
export function IdleWarning({
  secondsLeft,
  onStay,
  onLogoutNow,
}: {
  secondsLeft: number;
  onStay: () => void;
  onLogoutNow: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  /**
   * Careful: any click cancels, as the spec requires. `useIdleLogout` has its own
   * listener that does this too, but it is throttled to 5 seconds; during the
   * warning even that delay is uncomfortable, because the user would click and
   * still watch the countdown drop. So this one has no throttle and runs in the
   * capture phase.
   *
   * Careful: clicks inside the box are excluded. Otherwise "Sign out now" would not
   * work: `onStay` would run on `mousedown` and unmount the box, and the `click`
   * event would never reach any button.
   */
  useEffect(() => {
    const cancel = (e: Event): void => {
      const target = e.target;
      if (target instanceof Node && boxRef.current?.contains(target)) return;
      onStay();
    };
    const events = ['mousedown', 'keydown', 'touchstart'] as const;
    for (const ev of events) {
      window.addEventListener(ev, cancel, { capture: true });
    }
    return () => {
      for (const ev of events) {
        window.removeEventListener(ev, cancel, { capture: true });
      }
    };
  }, [onStay]);

  return (
    <div
      ref={boxRef}
      role="alertdialog"
      aria-live="assertive"
      aria-label="Your session is about to end"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-sm rounded-xl border border-brand/40 bg-surface p-4 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4"
    >
      {/*
        Careful: singular/plural: "1 seconds" would be noticed on the last second of
           the countdown every single time.
      */}
      <h2 className="text-[14px] font-semibold text-brand-ink">
        Signing out in {secondsLeft} second{secondsLeft === 1 ? '' : 's'}
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
        Nothing has happened for a while, so the session will close for
        security. Any click or key press cancels this.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onStay}
          className="rounded-md border border-ink bg-ink px-3 py-1.5 text-[13px] font-medium text-on-ink transition hover:bg-ink-strong focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          Stay signed in
        </button>
        <button
          type="button"
          onClick={onLogoutNow}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-2 transition hover:border-brand hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          Sign out now
        </button>
      </div>
    </div>
  );
}
