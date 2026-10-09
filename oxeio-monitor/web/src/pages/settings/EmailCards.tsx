import { useEffect, useState } from 'react';

import {
  getMailRecipients,
  getSmtpSettings,
  saveMailRecipients,
  saveSmtpSettings,
  testSmtp,
  type MailKind,
} from '../../api/settings';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import {
  CheckboxField,
  MiniButton,
  Notice,
  ServerError,
  TextAreaField,
  TextField,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';
import { BackToEnv } from './BackToEnv';
import {
  formatAddressList,
  parseAddressList,
  senderFieldValue,
  testResultKey,
} from './email.math';

/**
 * The SMTP server every email leaves through. Any provider works (a company
 * mail server, a transactional email service); the password is never shown
 * again after saving — an empty field keeps it.
 */
export function SmtpCard() {
  const t = useT();
  const smtp = useApi(getSmtpSettings, []);
  const save = useMutation();
  const probe = useMutation();
  const [form, setForm] = useState({
    host: '',
    port: '587',
    user: '',
    pass: '',
    from: '',
  });
  const [forceTls, setForceTls] = useState(false);
  const [result, setResult] = useState<{ key: string; error?: string } | null>(
    null,
  );

  useEffect(() => {
    const v = smtp.data;
    if (!v) return;
    setForm({
      host: v.host,
      port: String(v.port),
      user: v.user,
      pass: '',
      from: senderFieldValue(v.host, v.from),
    });
    setForceTls(v.secure && v.port !== 465);
  }, [smtp.data]);

  if (smtp.loading && !smtp.data) return <Loading />;
  if (smtp.error && !smtp.data)
    return <ErrorBox error={smtp.error} retry={smtp.reload} />;
  const current = smtp.data;
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <Card
      title={t('Email (SMTP)')}
      hint={t('The server every email is sent through')}
    >
      <div className="space-y-3.5 p-4">
        {current && (
          <div className="text-[13px]">
            {current.source === 'database' && (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-ok">{t('Set here')}</span>
                <BackToEnv subject="smtp" onDone={() => smtp.reload()} />
              </span>
            )}
            {current.source === 'env' && (
              <span className="text-idle">
                {t('Currently using the server’s .env')}
              </span>
            )}
            {current.source === 'none' && (
              <span className="text-ink-3">
                {t('Not set — no email is being sent')}
              </span>
            )}
          </div>
        )}

        <TextField
          label={t('Server')}
          value={form.host}
          onChange={set('host')}
          mono
          placeholder="smtp.example.com"
        />
        <TextField
          label={t('Port')}
          type="number"
          value={form.port}
          onChange={set('port')}
          mono
          min={1}
          max={65535}
          hint={t(
            '587 for STARTTLS (most providers), 465 for TLS from the start.',
          )}
        />
        <CheckboxField
          label={t(
            'Use TLS from the first byte even though the port is not 465',
          )}
          checked={forceTls}
          onChange={setForceTls}
        />
        <TextField
          label={t('User')}
          value={form.user}
          onChange={set('user')}
          mono
        />
        <TextField
          label={t('Password')}
          type="password"
          value={form.pass}
          onChange={set('pass')}
          mono
          placeholder={
            current?.source === 'database' && current.passwordSet
              ? t('leave empty to keep the current one')
              : ''
          }
          hint={
            current?.source === 'env'
              ? t(
                  'Saving here replaces the .env settings: type the password too.',
                )
              : undefined
          }
        />
        <TextField
          label={t('Sender')}
          value={form.from}
          onChange={set('from')}
          mono
          placeholder="Company <no-reply@example.com>"
          hint={t(
            'The address must be one your provider allows you to send from. Left empty, it is built from the server name.',
          )}
        />

        <ServerError error={save.error ?? probe.error} />
        {result && (
          // `result.key` is the English sentence, so the ✓ check does not depend on the
          // language on screen
          <Notice tone={result.key.startsWith('✓') ? 'info' : 'attention'}>
            {t(result.key)}{' '}
            {result.error && <span className="num">{result.error}</span>}
          </Notice>
        )}

        <div className="flex gap-2">
          <MiniButton
            disabled={save.busy}
            onClick={() =>
              save.run(async () => {
                const port = Number(form.port);
                await saveSmtpSettings({
                  host: form.host.trim(),
                  port,
                  secure: port === 465 || forceTls ? true : null,
                  user: form.user.trim(),
                  pass: form.pass,
                  from: form.from.trim(),
                });
                setForm((f) => ({ ...f, pass: '' }));
                setResult(null);
                smtp.reload();
              })
            }
          >
            {save.busy ? t('Saving…') : t('Save')}
          </MiniButton>
          <MiniButton
            disabled={probe.busy}
            onClick={() =>
              probe.run(async () => {
                const r = await testSmtp();
                setResult({ key: testResultKey(r.outcome), error: r.error });
              })
            }
          >
            {probe.busy ? t('Sending…') : t('Send test email')}
          </MiniButton>
        </div>
      </div>
    </Card>
  );
}

const KIND_LABEL: Record<MailKind, string> = {
  alerts: 'Alerts',
  dailyDigest: 'Daily summary',
  weeklyDigest: 'Weekly summary',
  monthClosed: 'Month closed',
};

/** Who receives each kind of email. Empty = the old rule (the .env list, otherwise the owners). */
export function RecipientsCard() {
  const t = useT();
  const view = useApi(getMailRecipients, []);
  const save = useMutation();
  const [text, setText] = useState<Partial<Record<MailKind, string>>>({});

  useEffect(() => {
    if (!view.data) return;
    setText(
      Object.fromEntries(
        view.data.kinds.map((k) => [k.kind, formatAddressList(k.saved)]),
      ),
    );
  }, [view.data]);

  if (view.loading && !view.data) return <Loading />;
  if (view.error && !view.data)
    return <ErrorBox error={view.error} retry={view.reload} />;

  const anySaved = view.data?.kinds.some((k) => k.saved.length > 0) ?? false;

  return (
    <Card
      title={t('Who receives each email')}
      hint={t(
        'Leave a list empty to keep the default: the .env list, otherwise the owners',
      )}
    >
      <div className="space-y-3.5 p-4">
        {anySaved && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-ok">{t('Set here')}</span>
            <BackToEnv subject="recipients" onDone={() => view.reload()} />
          </div>
        )}
        {view.data?.kinds.map((k) => (
          <TextAreaField
            key={k.kind}
            label={t(KIND_LABEL[k.kind])}
            value={text[k.kind] ?? ''}
            onChange={(value) =>
              setText((prev) => ({ ...prev, [k.kind]: value }))
            }
            hint={t('Now going to: {{list}}', {
              list: k.effective.join(', ') || t('nobody'),
            })}
          />
        ))}
        <ServerError error={save.error} />
        <MiniButton
          disabled={save.busy}
          onClick={() =>
            save.run(async () => {
              // the whole object is replaced on the server, so every kind goes
              const body = Object.fromEntries(
                (Object.keys(KIND_LABEL) as MailKind[]).map((kind) => [
                  kind,
                  parseAddressList(text[kind] ?? ''),
                ]),
              );
              await saveMailRecipients(body);
              view.reload();
            })
          }
        >
          {save.busy ? t('Saving…') : t('Save')}
        </MiniButton>
      </div>
    </Card>
  );
}
