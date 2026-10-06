import { useState } from 'react';
import { Trans } from 'react-i18next';

import { getOffsiteSettings, saveOffsiteSettings, testOffsite } from '../../api/settings';
import { getOpsHealth } from '../../api/ops';
import { useApi } from '../../api/useApi';
import { useFeatures } from '../../features/FeaturesContext';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { formatAgo, workTimeZoneLabel } from '../../lib/format';
import { DatabaseBackupSection, ScreenshotStorageCard } from './StorageSections';
import {
  Chip,
  MiniButton,
  Notice,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';
import { BackToEnv } from './BackToEnv';
import { useT } from '../../i18n';
import { translateServerMessage } from '../../i18n/server-messages';

/**
 * Offsite backup settings, from the screen.
 *
 * Careful — why this was needed: setting the B2 key meant SSH into the VPS, running
 * `rclone config`, then editing `/etc/oxeio-offsite.env`. The owner tried, got
 * `401 bad_auth_token` from a partially pasted key, and had to dig around in a
 * terminal to understand why.
 *
 * Important: this screen is now enough, and **the test button is the real point**:
 * the server asks Backblaze directly, so a wrong key is caught at once and nobody
 * waits for Saturday's timer to fail.
 *
 * Careful: **the full application key never reaches this screen**; the server sends
 * only the last four characters.
 */
/** oXeio's own backup: the offsite copy and last night's run (author's cards) */
function OwnBackupCards() {
  const t = useT();
  const offsite = useApi(getOffsiteSettings, []);
  const health = useApi(getOpsHealth, []);
  const save = useMutation();
  const probe = useMutation();

  const [keyId, setKeyId] = useState('');
  const [appKey, setAppKey] = useState('');
  const [bucket, setBucket] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const current = offsite.data;

  if (offsite.loading && !current) return <Loading />;
  if (offsite.error && !current) {
    return <ErrorBox error={offsite.error} retry={offsite.reload} />;
  }

  const backup = health.data?.backup;


  return (
    <div className="space-y-3">
      <Card
        title={t('Offsite Copy — Backblaze B2')}
        hint={t('A second copy of the nightly backup, off this server')}
      >
        <div className="space-y-3.5 p-4">
          <Notice>
            <Trans
              i18nKey="The nightly backup already runs, but it sits on <b>the same machine as the data</b>. If that disk dies, both go together. Three steps at <num>backblaze.com</num>: create a <b>Private</b> bucket, then an <b>Application Key</b> limited to that bucket, then paste the two values here."
              components={{ b: <b />, num: <span className="num" /> }}
            />
          </Notice>

          {/*
            Careful: this says which value is **actually** in effect. Without it the
               owner would enter a new value, think it was not saved (though it was),
               because the one in the server's file was still winning.
          */}
          {current && (
            <div className="text-[13px]">
              {current.source === 'database' && (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-ok">
                    <Trans
                      i18nKey="Set here · key {{keyHint}} · bucket <num>{{bucket}}</num>"
                      values={{ keyHint: current.keyHint, bucket: current.bucket }}
                      components={{ num: <span className="num" /> }}
                    />
                  </span>
                  <BackToEnv subject="offsite" onDone={() => offsite.reload()} />
                </span>
              )}
              {current.source === 'env' && (
                <span className="text-idle">
                  <Trans
                    i18nKey="Currently using the server’s own settings · key {{keyHint}} · bucket <num>{{bucket}}</num>"
                    values={{ keyHint: current.keyHint, bucket: current.bucket }}
                    components={{ num: <span className="num" /> }}
                  />
                </span>
              )}
              {current.source === 'none' && (
                <span className="text-ink-3">
                  {t('Not set — the backup exists only on this server')}
                </span>
              )}
            </div>
          )}

          <TextField
            label={t('Key ID')}
            value={keyId}
            onChange={setKeyId}
            mono
            placeholder={current?.keyId || ''}
            hint={t('25 characters, shown next to the key on Backblaze')}
          />

          <TextField
            label={t('Application key')}
            value={appKey}
            onChange={setAppKey}
            mono
            placeholder={current?.configured ? t('leave empty to keep the current one') : ''}
            /*
              Careful: this sentence is not decoration. Backblaze shows the key **only
                 once**, and that is exactly where the owner got stuck: it was partially
                 pasted and there was no way to see it again.
            */
            hint={t('31 characters. Backblaze shows it only once — copy all of it.')}
          />

          <TextField
            label={t('Bucket')}
            value={bucket}
            onChange={setBucket}
            mono
            placeholder={current?.bucket || 'oxeio-backups'}
            hint={t('The bucket the key is limited to')}
          />

          <ServerError error={save.error ?? probe.error} />

          {result && (
            <Notice tone={result.ok ? 'info' : 'attention'}>{translateServerMessage(result.text)}</Notice>
          )}

          <div className="flex gap-2">
            <MiniButton
              disabled={save.busy}
              onClick={() =>
                save.run(async () => {
                  /**
                   * Careful: an empty field sends the **existing** value. Otherwise
                   * fixing just the bucket name would wipe the key, and since Backblaze
                   * shows an application key **only once**, it could not be recovered;
                   * the only way out would be creating a new key.
                   */
                  await saveOffsiteSettings(
                    keyId.trim() || (current?.keyId ?? ''),
                    appKey.trim(),
                    bucket.trim() || (current?.bucket ?? ''),
                  );
                  setKeyId('');
                  setAppKey('');
                  setBucket('');
                  setResult(null);
                  offsite.reload();
                })
              }
            >
              {save.busy ? t('Saving…') : t('Save')}
            </MiniButton>

            {/*
              Important: **this button is the whole reason for this screen.** Without it
                 you would save, wait until Saturday, and only realise something was
                 wrong if nothing went through, with no way to tell what.
            */}
            <MiniButton
              disabled={probe.busy || !current?.configured}
              onClick={() =>
                probe.run(async () => {
                  const verdict = await testOffsite();
                  setResult({ ok: verdict.ok, text: verdict.message });
                })
              }
            >
              {probe.busy ? t('Checking…') : t('Test the connection')}
            </MiniButton>
          </div>

          <p className="text-[12px] text-ink-3">
            <Trans
              i18nKey="The copy runs every Saturday at 10:00 {{zone}}. Files are encrypted before they leave this server, so Backblaze cannot read them — <b>which also means the passphrase is the only way back in</b>. Keep it somewhere other than this server."
              values={{ zone: workTimeZoneLabel() }}
              components={{ b: <b /> }}
            />
          </p>
        </div>
      </Card>

      {/*
        "Configured" and "backups are really happening" are not the same, so the last
           run's state is on the same screen.
      */}
      <Card title={t('Nightly Backup')} hint={t('What the server managed last night')}>
        <div className="p-4">
          {health.loading && !backup && <Loading />}
          {health.error && !backup && (
            <ErrorBox error={health.error} retry={health.reload} />
          )}

          {backup && (
            <div className="space-y-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                {backup.lastOutcome === 'failed' ? (
                  <Chip tone="attention">{t('Failed')}</Chip>
                ) : backup.lastSuccessAt ? (
                  <Chip tone="counted">{t('Ok')}</Chip>
                ) : (
                  <Chip tone="muted">{t('Never run')}</Chip>
                )}
                <span className="text-ink-2">
                  {backup.lastSuccessAt
                    ? t('Last good backup {{ago}}', { ago: formatAgo(backup.lastSuccessAt) })
                    : t('No successful backup yet')}
                </span>
                {/* Careful: the server sends this **already formatted** (a string);
                    running formatBytes again broke the types */}
                {backup.lastSize ? (
                  <span className="num text-ink-3">{backup.lastSize}</span>
                ) : null}
              </div>

              {backup.lastError && (
                <Notice tone="attention">{backup.lastError}</Notice>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

/**
 * Settings → Storage & backup: two choices, each with what it needs.
 *   1. Where screenshots are kept — this server's disk, or a bucket.
 *   2. Who backs up the database — oXeio (the cards above, unchanged), or
 *      another tool such as Databasus.
 */
export function BackupTab() {
  const { features } = useFeatures();
  return (
    <div className="space-y-6">
      {/* Screenshots switched off: nothing new is stored, so there is no
          storage choice to make (the saved one is kept for when it is back on) */}
      {features.screenshots && <ScreenshotStorageCard />}
      <DatabaseBackupSection>
        <OwnBackupCards />
      </DatabaseBackupSection>
    </div>
  );
}
