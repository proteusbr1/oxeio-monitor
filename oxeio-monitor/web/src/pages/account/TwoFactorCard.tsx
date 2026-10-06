import { useState } from 'react';

import { useApi } from '../../api/useApi';
import {
  disableTwoFactor,
  enableTwoFactor,
  regenerateRecoveryCodes,
  setupTwoFactor,
  twoFactorStatus,
  type TwoFactorSetup,
} from '../../auth/twoFactorApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { Button } from '../../components/Page';
import { Modal, Notice, ServerError, useMutation } from '../../components/ui';
import { useT } from '../../i18n';
import { RecoveryCodesModal } from './RecoveryCodesModal';

/**
 * I06: 2FA for one's own account: one's own, nobody else's. Every endpoint works
 * on the session's user, so there is no need to make it owner-only; managers and
 * staff can harden their own accounts too. Lives on the Account page.
 */
export function TwoFactorCard() {
  const t = useT();
  const { data, error, loading, reload } = useApi(
    (signal) => twoFactorStatus(signal),
    [],
  );

  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState<'disable' | 'regenerate' | null>(
    null,
  );

  const start = useMutation();

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return null;

  return (
    <>
      <Card
        title={t('Two-factor authentication (2FA)')}
        hint={
          data.enabled
            ? t('On · {{count}} recovery codes left', { count: data.recoveryCodesLeft })
            : t('Off')
        }
      >

        {data.enabled ? (
          <div className="space-y-3">
            <Notice>
              {t('Signing in needs a 6-digit code from your authenticator app after the password. Even a leaked password will not let anyone in.')}
            </Notice>

            {/*
              Careful: once the codes run out, there is no way in on the day the phone is lost,
                 so warn when few are left instead of staying quiet.
            */}
            {data.recoveryCodesLeft <= 2 && (
              <Notice tone="attention">
                {t('You are nearly out of recovery codes ({{count}} left). Generate a fresh set now — if you lose your phone, these are the only way back in.', { count: data.recoveryCodesLeft })}
              </Notice>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setConfirming('regenerate')}>
                {t('New recovery codes')}
              </Button>
              <Button tone="danger" onClick={() => setConfirming('disable')}>
                {t('Turn off 2FA')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Notice>
              {t('Google Authenticator, Microsoft Authenticator, Authy — any TOTP app works. You get 10 recovery codes when you turn it on; those are what you sign in with if you lose your phone.')}
            </Notice>

            {data.pendingSetup && (
              <Notice tone="attention">
                {t('Setup was started once before and never finished. Starting again gives you a new QR code — if you already scanned the old one, delete it from your app.')}
              </Notice>
            )}

            <ServerError error={start.error} />

            <Button
              tone="primary"
              disabled={start.busy}
              onClick={() =>
                start.run(async () => {
                  setSetup(await setupTwoFactor());
                })
              }
            >
              {start.busy ? t('Please wait…') : t('Turn on 2FA')}
            </Button>
          </div>
        )}
      </Card>

      {setup && (
        <EnableModal
          setup={setup}
          onCancel={() => {
            setSetup(null);
            reload();
          }}
          onDone={(codes) => {
            setSetup(null);
            setFreshCodes(codes);
          }}
        />
      )}

      {confirming && (
        <PasswordConfirmModal
          mode={confirming}
          onCancel={() => setConfirming(null)}
          onDone={(codes) => {
            setConfirming(null);
            if (codes) setFreshCodes(codes);
            reload();
          }}
        />
      )}

      {freshCodes && (
        <RecoveryCodesModal
          codes={freshCodes}
          onClose={() => {
            setFreshCodes(null);
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Step 2: show the QR and prove with a code.
 *
 * Careful: closing this modal does not enable 2FA: the secret stays on the
 * server with `enabled: false`. Intentional: so nobody gets locked out of their
 * own account for good by forgetting to scan, or scanning with the wrong app.
 */
function EnableModal({
  setup,
  onCancel,
  onDone,
}: {
  setup: TwoFactorSetup;
  onCancel: () => void;
  onDone: (codes: string[]) => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const m = useMutation();

  const submit = (): void => {
    m.run(async () => {
      const { recoveryCodes } = await enableTwoFactor(code);
      onDone(recoveryCodes);
    });
  };

  return (
    <Modal
      title={t('Turn on 2FA')}
      hint={t('Scan the QR code, then enter the code from your app')}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('Cancel')}</Button>
          <Button tone="primary" disabled={m.busy} onClick={submit}>
            {m.busy ? t('Verifying…') : t('Verify and turn on')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ol className="list-inside list-decimal space-y-1 text-[13px] text-ink-2">
          <li>{t('Open the authenticator app on your phone')}</li>
          <li>{t('Scan the QR code below')}</li>
          <li>{t('Type the 6 digits your app is showing')}</li>
        </ol>

        {/*
          Careful: the image is a data URL and never goes to an outside server. The QR
             contains the secret; drawing it through a third-party API would put it in
             their logs.
          Careful: the white background is hard-coded. QR scanners look for light/dark
             contrast, so the quiet zone around the image must stay white in the dark theme too.
          Careful: the white box is on the inner div, not the outer bordered one, on
             purpose. `index.css` once had a bridge rule turning the `border-line bg-white`
             pair into `surface` in dark mode; it is gone now that the two inputs moved
             to `bg-surface`. The classes still sit on separate elements: if someone writes
             such a rule again, the quiet zone stays white (dark would block the scanner,
             and scanning is the only way to turn 2FA on).
        */}
        <div className="flex justify-center rounded-lg border border-line bg-paper p-3">
          <div className="rounded bg-white p-2">
            <img
              src={setup.qrDataUrl}
              alt={t('2FA QR code')}
              width={240}
              height={240}
              className="h-auto max-w-full"
            />
          </div>
        </div>

        <details className="rounded-md border border-line bg-paper px-3 py-2 text-[13px] text-ink-2">
          <summary className="cursor-pointer">{t('Can’t scan the QR?')}</summary>
          <p className="mt-2">
            {t('Choose “enter a setup key” in your app and give it this secret:')}
          </p>
          <p className="num mt-1.5 break-all text-ink select-all">
            {setup.secret}
          </p>
        </details>

        <ServerError error={m.error} />

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-2">
            {t('The 6-digit code from your app')}
          </span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !m.busy) submit();
            }}
            placeholder="123456"
            className="num w-full rounded-md border border-line bg-surface px-3 py-2 text-[15px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
          />
        </label>

        <Notice tone="attention">
          {t('2FA is not turned on until the code matches. Closing this dialog changes nothing — so there is no risk of locking yourself out by forgetting to scan.')}
        </Notice>
      </div>
    </Modal>
  );
}

/**
 * Careful: both disabling and generating new codes need the password. If the
 * session cookie alone were enough, anyone at a laptop left open could switch 2FA
 * off, yet the whole purpose of 2FA is protection against cookie theft.
 */
function PasswordConfirmModal({
  mode,
  onCancel,
  onDone,
}: {
  mode: 'disable' | 'regenerate';
  onCancel: () => void;
  onDone: (codes: string[] | null) => void;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  const m = useMutation();

  const submit = (): void => {
    m.run(async () => {
      if (mode === 'disable') {
        await disableTwoFactor(password);
        onDone(null);
        return;
      }
      const { recoveryCodes } = await regenerateRecoveryCodes(password);
      onDone(recoveryCodes);
    });
  };

  const isDisable = mode === 'disable';

  return (
    <Modal
      title={isDisable ? t('Turn off 2FA?') : t('New recovery codes')}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('Cancel')}</Button>
          <Button
            tone={isDisable ? 'danger' : 'primary'}
            disabled={m.busy || password === ''}
            onClick={submit}
          >
            {m.busy ? t('Please wait…') : isDisable ? t('Turn off') : t('Generate')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice tone="attention">
          {isDisable
            ? t('Once it is off, a password alone gets you in, and your recovery codes are deleted.')
            : t('Generating a new set makes every old recovery code stop working immediately.')}
        </Notice>

        <ServerError error={m.error} />

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-2">
            {t('Your password')}
          </span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !m.busy && password !== '') submit();
            }}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-[15px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
          />
        </label>
      </div>
    </Modal>
  );
}
