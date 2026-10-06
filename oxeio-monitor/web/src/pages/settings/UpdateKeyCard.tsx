import { useState } from 'react';
import { Trans } from 'react-i18next';

import { getUpdateKey, saveUpdateKey } from '../../api/settings';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import {
  MiniButton,
  Notice,
  ServerError,
  TextAreaField,
  useMutation,
} from '../../components/ui';
import { BackToEnv } from './BackToEnv';
import { useT } from '../../i18n';

/**
 * The owner's public key for signed agent updates (deploy/README.md, "Signed agent updates").
 *
 * With a key here, this server refuses to publish an MSI whose `.sig` is
 * missing or wrong — PCs built with the same key would otherwise download
 * it and throw it away. Only the public half: the private key that signs
 * stays on the owner's own machine, never here.
 */
export function UpdateKeyCard() {
  const t = useT();
  const key = useApi(getUpdateKey, []);
  const save = useMutation();
  const [text, setText] = useState<string | null>(null);

  const current = key.data;
  if (key.loading && !current) return <Loading />;
  if (key.error && !current)
    return <ErrorBox error={key.error} retry={key.reload} />;
  if (!current) return null;

  const value = text ?? current.publicKey ?? '';
  const store = (publicKey: string | null) =>
    save.run(async () => {
      await saveUpdateKey(publicKey);
      setText(null);
      key.reload();
    });

  return (
    <Card
      title={t('Update signing key')}
      hint={t('Optional — only signed agent updates can be published')}
    >
      <div className="space-y-3 p-4">
        <Notice>
          <Trans
            i18nKey="Paste the <b>public</b> key (the contents of <num>update-key.pub.pem</num>). Build the MSI with <num>-UpdatePublicKey</num> and sign each release with the private key, which stays on your machine — never on this server."
            components={{ b: <b />, num: <span className="num" /> }}
          />
        </Notice>
        <TextAreaField
          label={t('Public key')}
          value={value}
          onChange={setText}
          rows={4}
          placeholder="-----BEGIN PUBLIC KEY----- …"
          hint={
            current.source === 'environment'
              ? t("Set in the server's .env — saving here takes over.")
              : current.publicKey
                ? t('Set. Unsigned MSIs can no longer be published.')
                : t('Not set — MSIs are checked by their hash only.')
          }
        />
        <ServerError error={save.error} />
        <div className="flex justify-end gap-2">
          {current.source === 'dashboard' && (
            <BackToEnv subject="updateKey" onDone={() => key.reload()} />
          )}
          {current.publicKey && (
            <MiniButton
              tone="danger"
              disabled={save.busy}
              onClick={() => store(null)}
            >
              {t('Remove key')}
            </MiniButton>
          )}
          <MiniButton
            disabled={save.busy || text === null}
            onClick={() => store(value.trim() || null)}
          >
            {save.busy ? t('Saving…') : t('Save')}
          </MiniButton>
        </div>
      </div>
    </Card>
  );
}
