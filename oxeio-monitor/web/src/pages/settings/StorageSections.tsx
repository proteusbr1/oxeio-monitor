import { useState, type ReactNode } from 'react';
import { Trans } from 'react-i18next';

import { getBackupMode, getStorageSettings, saveBackupMode, saveStorageSettings, testStorageSettings, type SettingSource, type StorageForm } from '../../api/settings';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { RestartNotice } from './RestartNotice';
import {
  CheckboxField,
  MiniButton,
  Notice,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';
import { BackToEnv } from './BackToEnv';
import { useT } from '../../i18n';
import { translateServerMessage } from '../../i18n/server-messages';

const SOURCE_NOTE: Record<SettingSource, string> = {
  dashboard: 'Set on this screen.',
  environment: "Set in the server's .env — saving here takes over.",
  default: '',
};

/** Two or three exclusive options, each a sentence — a plain radio list */
function Choice<T extends string>({
  name,
  value,
  onChange,
  options,
}: {
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; hint: ReactNode }[];
}) {
  return (
    <fieldset className="space-y-2">
      {options.map((o) => (
        <label
          key={o.value}
          className="flex cursor-pointer items-start gap-2.5"
        >
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-0.5 accent-brand"
          />
          <span>
            <span className="block text-[13px] font-medium text-ink">
              {o.label}
            </span>
            <span className="mt-0.5 block text-[11.5px] text-ink-3">
              {o.hint}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

// ── 1 · where screenshots are kept ──────────────────────────────────────────

export function ScreenshotStorageCard() {
  const t = useT();
  const storage = useApi(getStorageSettings, []);
  const save = useMutation();
  const probe = useMutation();

  const [form, setForm] = useState<StorageForm | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const current = storage.data;
  if (storage.loading && !current) return <Loading />;
  if (storage.error && !current)
    return <ErrorBox error={storage.error} retry={storage.reload} />;
  if (!current) return null;

  const f: StorageForm = form ?? {
    driver: current.driver,
    provider: current.provider,
    bucket: current.bucket,
    endpoint: current.endpoint,
    region: current.region,
    prefix: current.prefix.replace(/\/$/, ''),
    forcePathStyle: current.forcePathStyle,
    useBackupKey: current.useBackupKey,
    accessKeyId: '',
    secretAccessKey: '',
  };
  const set = (patch: Partial<StorageForm>) => {
    setForm({ ...f, ...patch });
    setResult(null);
  };
  const bucketChosen = f.driver === 's3';
  const b2 = f.provider !== 's3';

  return (
    <Card
      title={t('Where screenshots are kept')}
      hint={t('Screenshots and their thumbnails')}
    >
      <div className="space-y-3.5 p-4">
        {current.restartNeeded && (
          <RestartNotice what={t('The new screenshot storage')} />
        )}

        <Choice
          name="storage-driver"
          value={f.driver}
          onChange={(driver) => set({ driver })}
          options={[
            {
              value: 'local',
              label: t("This server's disk"),
              hint: t('As it always was. Screenshots fill the disk until the retention period set in Settings → Privacy removes them.'),
            },
            {
              value: 's3',
              label: t('A bucket — Backblaze B2 or another S3-compatible store'),
              hint: t('The disk keeps only the database, backups and installers. The bucket stays private; the dashboard reads through this server.'),
            },
          ]}
        />

        {bucketChosen && (
          <div className="space-y-3 rounded-md border border-line p-3">
            <Choice
              name="storage-provider"
              value={b2 ? 'b2' : 's3'}
              onChange={(provider) => set({ provider })}
              options={[
                {
                  value: 'b2',
                  label: 'Backblaze B2',
                  hint: t('Only the bucket and a key — the address is found from the key.'),
                },
                {
                  value: 's3',
                  label: t('Another S3-compatible store'),
                  hint: t('MinIO, AWS, Wasabi … — give its address and region.'),
                },
              ]}
            />
            <TextField
              label={t('Bucket')}
              value={f.bucket ?? ''}
              onChange={(bucket) => set({ bucket })}
              mono
              placeholder="pericialmed-oxeio"
            />
            {!b2 && (
              <>
                <TextField
                  label={t('S3 address (endpoint)')}
                  value={f.endpoint ?? ''}
                  onChange={(endpoint) => set({ endpoint })}
                  mono
                  placeholder="https://s3.example.com"
                />
                <TextField
                  label={t('Region')}
                  value={f.region ?? ''}
                  onChange={(region) => set({ region })}
                  mono
                  placeholder="us-east-1"
                />
                <CheckboxField
                  label={t('Path-style addresses')}
                  checked={f.forcePathStyle === true}
                  onChange={(forcePathStyle) => set({ forcePathStyle })}
                  hint={t('Needed by MinIO; leave off for AWS')}
                />
              </>
            )}
            {b2 && (
              <CheckboxField
                label={t('Use the key of the backup copy')}
                checked={f.useBackupKey === true}
                onChange={(useBackupKey) => set({ useBackupKey })}
                hint={t('The Backblaze key set below under Database backup › Offsite copy. It must be allowed to reach this bucket.')}
              />
            )}
            {!f.useBackupKey && (
              <>
                <TextField
                  label={b2 ? 'keyID' : t('Access key ID')}
                  value={f.accessKeyId ?? ''}
                  onChange={(accessKeyId) => set({ accessKeyId })}
                  mono
                  placeholder={current.keyIdHint ?? ''}
                  hint={
                    current.keyIdHint
                      ? t('Saved: {{hint}} — leave both empty to keep it', { hint: current.keyIdHint })
                      : undefined
                  }
                />
                <TextField
                  label={b2 ? 'applicationKey' : t('Secret access key')}
                  type="password"
                  value={f.secretAccessKey ?? ''}
                  onChange={(secretAccessKey) => set({ secretAccessKey })}
                  mono
                  hint={
                    current.secretSet
                      ? t('A secret is saved — it is never shown again')
                      : undefined
                  }
                />
              </>
            )}
            <TextField
              label={t('Folder inside the bucket (optional)')}
              value={f.prefix ?? ''}
              onChange={(prefix) => set({ prefix })}
              mono
              placeholder="oxeio"
            />
          </div>
        )}

        {f.driver !== current.running.driver && (
          <Notice tone="attention">
            <Trans
              i18nKey="Screenshots already taken stay where they are ({{location}}). Copy the <num>screenshots/</num> folder there first, with the same paths, or the gallery will not find older days (see the S3 section of deploy/README.md)."
              values={{ location: current.running.location }}
              components={{ num: <span className="num" /> }}
            />
          </Notice>
        )}
        {SOURCE_NOTE[current.source] && (
          <p className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
            {t(SOURCE_NOTE[current.source])}
            {current.source === 'dashboard' && (
              <BackToEnv subject="storage" restartNote onDone={() => storage.reload()} />
            )}
          </p>
        )}

        {result && (
          <Notice tone={result.ok ? 'info' : 'attention'}>{translateServerMessage(result.text)}</Notice>
        )}
        <ServerError error={save.error ?? probe.error} />

        <div className="flex flex-wrap justify-end gap-2">
          {bucketChosen && (
            <MiniButton
              disabled={probe.busy}
              onClick={() =>
                probe.run(async () => {
                  const r = await testStorageSettings(f);
                  setResult({ ok: r.ok, text: r.message });
                })
              }
            >
              {probe.busy ? t('Testing…') : t('Test connection')}
            </MiniButton>
          )}
          <MiniButton
            disabled={save.busy || form === null}
            onClick={() =>
              save.run(async () => {
                await saveStorageSettings(f);
                setForm(null);
                setResult(null);
                storage.reload();
              })
            }
          >
            {save.busy ? t('Saving…') : t('Save')}
          </MiniButton>
        </div>
      </div>
    </Card>
  );
}

// ── 2 · who backs up the database ───────────────────────────────────────────

export function DatabaseBackupSection({ children }: { children: ReactNode }) {
  const t = useT();
  const mode = useApi(getBackupMode, []);
  const save = useMutation();

  const current = mode.data;
  if (mode.loading && !current) return <Loading />;
  if (mode.error && !current)
    return <ErrorBox error={mode.error} retry={mode.reload} />;
  if (!current) return null;

  return (
    <div className="space-y-3">
      <Card title={t('Database backup')} hint={t('Who keeps a copy of the database')}>
        <div className="space-y-3 p-4">
          <Choice
            name="backup-mode"
            value={current.mode}
            onChange={(next) =>
              save.run(async () => {
                await saveBackupMode(next);
                mode.reload();
              })
            }
            options={[
              {
                value: 'internal',
                label: t('oXeio — an encrypted backup every night'),
                hint: t('Set up below. oXeio warns you when it fails or is not set up.'),
              },
              {
                value: 'external',
                label: t('Another tool — e.g. Databasus or a managed database'),
                hint: t("oXeio's nightly backup and its warning are switched off. That tool has to tell you when a backup fails."),
              },
            ]}
          />
          {SOURCE_NOTE[current.source] && (
            <p className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
              {t(SOURCE_NOTE[current.source])}
              {current.source === 'dashboard' && (
                <BackToEnv subject="backup" onDone={() => mode.reload()} />
              )}
            </p>
          )}
          {current.mode === 'external' && (
            <Notice>
              {t('Screenshots are files, not database rows — another tool backing up the database does not cover them. Keep them in a bucket (above), or back up the storage folder too.')}
            </Notice>
          )}
          <ServerError error={save.error} />
        </div>
      </Card>

      {current.mode === 'internal' && children}
    </div>
  );
}
