import { useState } from 'react';

import { restartServer } from '../../api/settings';
import { ConfirmDialog, MiniButton, Notice, useMutation } from '../../components/ui';

/**
 * "Saved — takes effect after a restart", with the button that does it.
 *
 * The time zone and the screenshot store are read when the server starts,
 * so a change on screen waits for a restart. The button stops the server
 * cleanly; Docker / Coolify start it again, and the page reloads once it
 * answers.
 */
export function RestartNotice({ what }: { what: string }) {
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const restart = useMutation();

  const waitAndReload = async (): Promise<void> => {
    setWaiting(true);
    // give it a moment to go down, then wait for it to answer again
    await new Promise((r) => setTimeout(r, 3000));
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch('/api/v1/health', { cache: 'no-store' });
        if (res.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // still down
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    setWaiting(false);
  };

  return (
    <>
      <Notice tone="attention">
        <span className="flex flex-wrap items-center gap-2">
          <span>
            {waiting
              ? 'Restarting — the page reloads when the server is back (usually under a minute)…'
              : `Saved. ${what} takes effect after the server restarts.`}
          </span>
          {!waiting && (
            <MiniButton onClick={() => setAsking(true)}>
              Restart server now
            </MiniButton>
          )}
        </span>
      </Notice>
      {asking && (
        <ConfirmDialog
          title="Restart the server?"
          intro="The dashboard and the agents lose the server for a few seconds; agents keep counting and send what they queued once it is back."
          warning="It starts again by itself under Docker / Coolify (restart: unless-stopped). On a server started by hand, it stays off until you start it."
          confirmLabel="Restart now"
          tone="primary"
          busy={restart.busy}
          error={restart.error}
          onClose={() => setAsking(false)}
          onConfirm={() =>
            restart.run(async () => {
              await restartServer();
              setAsking(false);
              void waitAndReload();
            })
          }
        />
      )}
    </>
  );
}
