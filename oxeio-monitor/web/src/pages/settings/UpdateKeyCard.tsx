import { useState } from 'react';

import { getUpdateKey, saveUpdateKey } from '../../api/admin';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import {
  MiniButton,
  Notice,
  ServerError,
  TextAreaField,
  useMutation,
} from './ui';

/**
 * The owner's public key for signed agent updates (deploy/README § ৮.১খ).
 *
 * With a key here, this server refuses to publish an MSI whose `.sig` is
 * missing or wrong — PCs built with the same key would otherwise download
 * it and throw it away. Only the public half: the private key that signs
 * stays on the owner's own machine, never here.
 */
export function UpdateKeyCard() {
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
      title="Update signing key"
      hint="Optional — only signed agent updates can be published"
    >
      <div className="space-y-3 p-4">
        <Notice>
          Paste the <b>public</b> key (the contents of{' '}
          <span className="num">update-key.pub.pem</span>). Build the MSI with{' '}
          <span className="num">-UpdatePublicKey</span> and sign each release
          with the private key, which stays on your machine — never on this
          server.
        </Notice>
        <TextAreaField
          label="Public key"
          value={value}
          onChange={setText}
          rows={4}
          placeholder="-----BEGIN PUBLIC KEY----- …"
          hint={
            current.source === 'environment'
              ? "Set in the server's .env — saving here takes over."
              : current.publicKey
                ? 'Set. Unsigned MSIs can no longer be published.'
                : 'Not set — MSIs are checked by their hash only.'
          }
        />
        <ServerError error={save.error} />
        <div className="flex justify-end gap-2">
          {current.publicKey && (
            <MiniButton
              tone="danger"
              disabled={save.busy}
              onClick={() => store(null)}
            >
              Remove key
            </MiniButton>
          )}
          <MiniButton
            disabled={save.busy || text === null}
            onClick={() => store(value.trim() || null)}
          >
            {save.busy ? 'Saving…' : 'Save'}
          </MiniButton>
        </div>
      </div>
    </Card>
  );
}
