import { useState } from 'react';

import { Button } from '../../components/Page';
import { Modal, Notice } from '../../components/ui';

/**
 * Careful: recovery codes can be seen this one time only; the server stores just a sha256.
 *
 * `SecretModal` in `ui.tsx` shows a single secret value; here there are 10, so
 * this is separate. But the safeguards are exactly the same:
 *   1. `dismissible={false}`: Escape or an outside click does not close it
 *   2. The close button is disabled until the "I have saved it" box is ticked
 *   3. Large, fixed-width characters, so copying by hand does not go wrong
 */
export function RecoveryCodesModal({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'failed'>('idle');

  const text = codes.join('\n');

  const copy = (): void => {
    // Careful: `navigator.clipboard` exists only on secure origins (HTTPS or
    // localhost). Over http it is `undefined`; the button would then silently do
    // nothing and the user would think the copy had happened.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setCopyState('failed');
      return;
    }
    void clipboard.writeText(text).then(
      () => {
        setCopyState('ok');
        setSaved(true);
      },
      () => setCopyState('failed'),
    );
  };

  return (
    <Modal
      title="Recovery codes"
      hint="These are how you get in if you lose your phone"
      dismissible={false}
      onClose={onClose}
      footer={
        <Button tone="primary" disabled={!saved} onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-3">
        <Notice tone="attention">
          These codes will not be shown again — the server keeps only their
          hashes. Copy them somewhere safe now, or write them down on paper.
        </Notice>

        <ul className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-paper px-4 py-4">
          {codes.map((code) => (
            <li
              key={code}
              className="num text-center text-[15px] font-semibold tracking-wide text-ink select-all"
            >
              {code}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={copy}>Copy all</Button>
          {copyState === 'ok' && (
            <span className="text-xs text-ink-3">Copied</span>
          )}
          {copyState === 'failed' && (
            <span className="text-xs text-brand-ink">
              Could not copy — select the codes and copy them by hand
            </span>
          )}
        </div>

        <Notice>
          Each code works once. When you run low you can generate a fresh set
          from this page — every old code stops working the moment you do.
        </Notice>

        <label className="flex items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-ink-2">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 accent-brand"
          />
          <span>I have copied or written down the codes</span>
        </label>
      </div>
    </Modal>
  );
}
