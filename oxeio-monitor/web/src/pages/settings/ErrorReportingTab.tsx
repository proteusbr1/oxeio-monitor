import { useState } from 'react';
import { Trans } from 'react-i18next';

import {
  getErrorReporting,
  saveErrorReporting,
  testErrorReporting,
  type ErrorReportingTest,
  type ErrorReportingView,
} from '../../api/errorReporting';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Caveat, ErrorBox, Loading } from '../../components/States';
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

/**
 * Settings → Error reporting: crashes go to Sentry (or a self-hosted
 * GlitchTip), so a bug is found before someone has to describe it. Off until
 * a DSN is set; a value saved here wins over SENTRY_DSN in the .env, and
 * takes effect at once.
 */
export function ErrorReportingTab() {
  const view = useApi(getErrorReporting, []);
  const current = view.data;

  if (view.loading && !current) return <Loading />;
  if (view.error && !current) {
    return <ErrorBox error={view.error} retry={view.reload} />;
  }
  if (!current) return null;

  // remount the form after each save, so it starts from what is saved
  return (
    <ErrorReportingForm
      key={`${current.source}:${current.dsn ?? ''}:${current.environment}:${current.browser}:${current.logErrors}`}
      current={current}
      onSaved={view.reload}
    />
  );
}

function ErrorReportingForm({
  current,
  onSaved,
}: {
  current: ErrorReportingView;
  onSaved: () => void;
}) {
  const t = useT();
  const fromScreen = current.source === 'dashboard';
  const [dsn, setDsn] = useState(fromScreen ? (current.dsn ?? '') : '');
  const [environment, setEnvironment] = useState(current.environment);
  const [browser, setBrowser] = useState(current.browser);
  const [logErrors, setLogErrors] = useState(current.logErrors);
  const [test, setTest] = useState<ErrorReportingTest | null>(null);

  const save = useMutation();
  const probe = useMutation();

  const store = (next: {
    dsn: string;
    environment: string;
    browser: boolean;
    logErrors: boolean;
  }) =>
    save.run(async () => {
      await saveErrorReporting(next);
      setTest(null);
      onSaved();
    });

  const changed =
    dsn.trim() !== (fromScreen ? (current.dsn ?? '') : '') ||
    environment.trim() !== current.environment ||
    browser !== current.browser ||
    logErrors !== current.logErrors;

  return (
    <div className="space-y-3">
      <Card
        title="Sentry"
        hint={t('Crashes are sent to Sentry, so a bug is found before anyone has to describe it')}
      >
        <div className="space-y-3.5 p-4">
          <Status current={current} />

          <Notice>
            <Trans
              i18nKey="In Sentry, create a project (platform <b>Node.js</b>) and copy its DSN from <b>Project settings → Client Keys (DSN)</b>. A self-hosted <b>GlitchTip</b> works the same way, and keeps everything on your own server."
              components={{ b: <b /> }}
            />
          </Notice>

          <TextField
            label="DSN"
            value={dsn}
            onChange={setDsn}
            mono
            placeholder={
              current.source === 'environment'
                ? t('from the .env: {{host}} — type here to replace it', { host: current.host ?? '' })
                : 'https://<key>@o0.ingest.sentry.io/<project>'
            }
            hint={t('Leave empty and save to turn reporting off (or fall back to SENTRY_DSN in the .env).')}
          />

          <TextField
            label={t('Environment')}
            value={environment}
            onChange={setEnvironment}
            mono
            placeholder="production"
            hint={t('How this server is labelled in Sentry — e.g. production or staging.')}
          />

          <CheckboxField
            label={t('Also report crashes in the dashboard')}
            checked={browser}
            onChange={setBrowser}
            hint={t("When a page breaks in someone's browser, the error goes to Sentry too — through this server, so the browser never talks to Sentry.")}
          />

          <CheckboxField
            label={t('Also report errors from the server log')}
            checked={logErrors}
            onChange={setLogErrors}
            hint={
              <Trans
                i18nKey="Failures the server caught and only logged — a backup, the daily summary, an email or Telegram delivery, a scheduled job. The same message is sent at most once an hour. <b>Some of these lines name a staff member or a PC</b> (e.g. “alert email failed for …”) — leave it off if that should not leave this server."
                components={{ b: <b /> }}
              />
            }
          />

          <ServerError error={save.error ?? probe.error} />

          {test && (
            <Notice tone={test.ok ? 'info' : 'attention'}>
              {test.ok ? '✓ ' : ''}
              {translateServerMessage(test.message)}
              {test.ok && test.eventId && (
                <>
                  {' '}
                  <Trans
                    i18nKey="Event <num>{{id}}</num>."
                    values={{ id: test.eventId.slice(0, 8) }}
                    components={{ num: <span className="num" /> }}
                  />
                </>
              )}
            </Notice>
          )}

          <div className="flex flex-wrap gap-2">
            <MiniButton
              disabled={save.busy || !changed}
              onClick={() =>
                store({
                  dsn: dsn.trim(),
                  environment: environment.trim(),
                  browser,
                  logErrors,
                })
              }
            >
              {save.busy ? t('Saving…') : t('Save')}
            </MiniButton>

            {/* the part that matters: proves the DSN works before a real crash */}
            <MiniButton
              disabled={probe.busy || !current.enabled || changed}
              title={changed ? t('Save first') : undefined}
              onClick={() =>
                probe.run(async () => {
                  setTest(await testErrorReporting());
                })
              }
            >
              {probe.busy ? t('Sending…') : t('Send a test error')}
            </MiniButton>

            {fromScreen && <BackToEnv subject="errorReporting" onDone={onSaved} />}

            {fromScreen && (
              <MiniButton
                tone="danger"
                disabled={save.busy}
                onClick={() =>
                  store({ dsn: '', environment: '', browser: false, logErrors: false })
                }
              >
                {t('Turn off')}
              </MiniButton>
            )}
          </div>
        </div>

        <Caveat>
          <Trans
            i18nKey="<b>Sent:</b> the error’s type, message and stack trace, the route or page it happened on (as <num>/staff/:id</num>), the user’s role and the server version. <b>Never sent:</b> request bodies, cookies, IP addresses, names, email addresses (masked even inside messages), salaries or screenshots — unless you tick the server log above, whose lines can name a staff member or a PC. Expected answers — not found, no access, a wrong password — are not reported. Changes apply immediately, no restart."
            components={{ b: <b />, num: <span className="num" /> }}
          />
        </Caveat>
      </Card>
    </div>
  );
}

function Status({ current }: { current: ErrorReportingView }) {
  const t = useT();
  if (!current.enabled) {
    return (
      <p className="text-[13px] text-ink-3">
        {t('Off — errors only go to the server log.')}
      </p>
    );
  }

  const where =
    current.source === 'environment' ? (
      <Trans
        i18nKey="from the server’s <num>.env</num>"
        components={{ num: <span className="num" /> }}
      />
    ) : (
      t('set here')
    );

  return (
    <p className="text-[13px] text-ok">
      {t('On')} · <span className="num">{current.host}</span> ·{' '}
      <span className="num">{current.environment}</span> · {where}
      {current.browser ? ` · ${t('dashboard crashes')}` : ''}
      {current.logErrors ? ` · ${t('log errors')}` : ''}
    </p>
  );
}
