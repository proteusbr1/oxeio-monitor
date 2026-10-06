import { useState } from 'react';

import { backToEnvironment, type EnvSubject } from '../../api/settings';
import { ConfirmDialog, MiniButton, useMutation } from '../../components/ui';
import { useT } from '../../i18n';

/**
 * "Use the .env value": forgets what was saved on this card, so the server's
 * `.env` (or the built-in default) applies again. Shown only while the card's
 * value comes from the screen — saving here otherwise wins for good.
 */
export function BackToEnv({
  subject,
  onDone,
  restartNote,
}: {
  subject: EnvSubject;
  onDone: (restartNeeded: boolean) => void;
  /** say so when the value is only read when the server starts */
  restartNote?: boolean;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const run = useMutation();

  return (
    <>
      <MiniButton onClick={() => setAsking(true)} title={t('Forget the value saved here')}>
        {t('Use the .env value')}
      </MiniButton>
      {asking && (
        <ConfirmDialog
          title={t("Use the server's .env value?")}
          intro={t("What was saved on this screen is forgotten; the value in the server's .env applies again — or the built-in default if the .env has none.")}
          warning={restartNote ? t('This value is read when the server starts: restart it (Settings → Company & region) for the change to apply.') : undefined}
          confirmLabel={t('Use the .env value')}
          tone="primary"
          busy={run.busy}
          error={run.error}
          onConfirm={() =>
            run.run(async () => {
              const res = await backToEnvironment(subject);
              setAsking(false);
              onDone(res.restartNeeded);
            })
          }
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
}
