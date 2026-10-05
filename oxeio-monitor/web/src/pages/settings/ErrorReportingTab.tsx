import { useState } from 'react';

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
} from './ui';

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
      key={`${current.source}:${current.dsn ?? ''}:${current.environment}:${current.browser}`}
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
  const fromScreen = current.source === 'dashboard';
  const [dsn, setDsn] = useState(fromScreen ? (current.dsn ?? '') : '');
  const [environment, setEnvironment] = useState(current.environment);
  const [browser, setBrowser] = useState(current.browser);
  const [test, setTest] = useState<ErrorReportingTest | null>(null);

  const save = useMutation();
  const probe = useMutation();

  const store = (next: { dsn: string; environment: string; browser: boolean }) =>
    save.run(async () => {
      await saveErrorReporting(next);
      setTest(null);
      onSaved();
    });

  const changed =
    dsn.trim() !== (fromScreen ? (current.dsn ?? '') : '') ||
    environment.trim() !== current.environment ||
    browser !== current.browser;

  return (
    <div className="space-y-3">
      <Card
        title="Sentry"
        hint="Crashes are sent to Sentry, so a bug is found before anyone has to describe it"
      >
        <div className="space-y-3.5 p-4">
          <Status current={current} />

          <Notice>
            In Sentry, create a project (platform <b>Node.js</b>) and copy its
            DSN from <b>Project settings → Client Keys (DSN)</b>. A self-hosted{' '}
            <b>GlitchTip</b> works the same way, and keeps everything on your
            own server.
          </Notice>

          <TextField
            label="DSN"
            value={dsn}
            onChange={setDsn}
            mono
            placeholder={
              current.source === 'environment'
                ? `from the .env: ${current.host ?? ''} — type here to replace it`
                : 'https://<key>@o0.ingest.sentry.io/<project>'
            }
            hint="Leave empty and save to turn reporting off (or fall back to SENTRY_DSN in the .env)."
          />

          <TextField
            label="Environment"
            value={environment}
            onChange={setEnvironment}
            mono
            placeholder="production"
            hint="How this server is labelled in Sentry — e.g. production or staging."
          />

          <CheckboxField
            label="Also report crashes in the dashboard"
            checked={browser}
            onChange={setBrowser}
            hint="When a page breaks in someone's browser, the error goes to Sentry too — through this server, so the browser never talks to Sentry."
          />

          <ServerError error={save.error ?? probe.error} />

          {test && (
            <Notice tone={test.ok ? 'info' : 'attention'}>
              {test.ok ? '✓ ' : ''}
              {test.message}
              {test.ok && test.eventId && (
                <>
                  {' '}
                  Event <span className="num">{test.eventId.slice(0, 8)}</span>.
                </>
              )}
            </Notice>
          )}

          <div className="flex flex-wrap gap-2">
            <MiniButton
              disabled={save.busy || !changed}
              onClick={() =>
                store({ dsn: dsn.trim(), environment: environment.trim(), browser })
              }
            >
              {save.busy ? 'Saving…' : 'Save'}
            </MiniButton>

            {/* the part that matters: proves the DSN works before a real crash */}
            <MiniButton
              disabled={probe.busy || !current.enabled || changed}
              title={changed ? 'Save first' : undefined}
              onClick={() =>
                probe.run(async () => {
                  setTest(await testErrorReporting());
                })
              }
            >
              {probe.busy ? 'Sending…' : 'Send a test error'}
            </MiniButton>

            {fromScreen && (
              <MiniButton
                tone="danger"
                disabled={save.busy}
                onClick={() => store({ dsn: '', environment: '', browser: false })}
              >
                Turn off
              </MiniButton>
            )}
          </div>
        </div>

        <Caveat>
          <b>Sent:</b> the error&rsquo;s type, message and stack trace, the
          route or page it happened on (as <span className="num">/staff/:id</span>),
          the user&rsquo;s role and the server version.{' '}
          <b>Never sent:</b> request bodies, cookies, IP addresses, names,
          email addresses (masked even inside messages), salaries or
          screenshots. Expected answers — not found, no access, a wrong
          password — are not reported. Changes apply immediately, no restart.
        </Caveat>
      </Card>
    </div>
  );
}

function Status({ current }: { current: ErrorReportingView }) {
  if (!current.enabled) {
    return (
      <p className="text-[13px] text-ink-3">
        Off — errors only go to the server log.
      </p>
    );
  }

  const where =
    current.source === 'environment' ? (
      <>
        from the server&rsquo;s <span className="num">.env</span>
      </>
    ) : (
      'set here'
    );

  return (
    <p className="text-[13px] text-ok">
      On · <span className="num">{current.host}</span> ·{' '}
      <span className="num">{current.environment}</span> · {where}
      {current.browser ? ' · dashboard crashes too' : ' · server only'}
    </p>
  );
}
