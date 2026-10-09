import { useState, type FormEvent } from 'react';

import {
  getAccount,
  getAccountActivity,
  signOutOtherDevices,
  updateAccount,
  type AccountEvent,
  type AccountView,
} from '../../api/account';
import { changePassword } from '../../api/auth';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { Card } from '../../components/Card';
import { Button, Page } from '../../components/Page';
import { ErrorBox, Loading } from '../../components/States';
import { useTheme } from '../../components/ThemeToggle';
import {
  FormGrid,
  Notice,
  SelectField,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';
import { formatAgo, formatDateTime } from '../../lib/format';
import { LANGUAGES, setLanguage, useT, type Language } from '../../i18n';
import { TwoFactorCard } from './TwoFactorCard';

/**
 * Account: everything about one's own login in one place — who you are,
 * your password and 2FA, how the dashboard looks for you, and where you are
 * signed in. Every role has it; nothing here touches anyone else's account.
 */

const ROLE_LABEL: Record<AccountView['role'], string> = {
  owner: 'Owner',
  manager: 'Manager',
  coordinator: 'Coordinator',
  employee: 'Staff member',
  finance: 'Finance',
};

/** must match MIN_PASSWORD_LENGTH on the server */
const MIN_PASSWORD = 10;

export function AccountPage() {
  const t = useT();
  const account = useApi((signal) => getAccount(signal), []);
  const { data, error, loading, reload } = account;

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return null;

  return (
    <Page title={t('Account')} subtitle={data.email}>
      <div className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-4">
            <ProfileCard account={data} onSaved={reload} />
            <AppearanceCard />
            <LanguageCard account={data} onSaved={reload} />
          </div>
          <div className="space-y-4">
            <PasswordCard account={data} onSaved={reload} />
            <TwoFactorCard />
          </div>
        </div>
        <SessionsCard />
      </div>
    </Page>
  );
}

function ProfileCard({
  account,
  onSaved,
}: {
  account: AccountView;
  onSaved: () => void;
}) {
  const t = useT();
  const { refresh } = useAuth();
  const [name, setName] = useState(account.fullName);
  const save = useMutation();
  const changed = name.trim() !== account.fullName && name.trim().length >= 2;

  return (
    <Card title={t('Profile')}>
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-ink-3">{t('Sign-in email')}</dt>
        <dd className="min-w-0 truncate">{account.email}</dd>
        <dt className="text-ink-3">{t('Role')}</dt>
        <dd>{t(ROLE_LABEL[account.role])}</dd>
        {account.staff && (
          <>
            <dt className="text-ink-3">{t('Staff record')}</dt>
            <dd>
              <span className="num">{account.staff.empCode}</span>
              {account.staff.designation && ` · ${account.staff.designation}`}
            </dd>
          </>
        )}
        <dt className="text-ink-3">{t('Member since')}</dt>
        <dd>{formatDateTime(account.createdAt)}</dd>
        <dt className="text-ink-3">{t('Last sign-in')}</dt>
        <dd>
          {account.lastLoginAt ? formatDateTime(account.lastLoginAt) : '—'}
        </dd>
      </dl>

      {account.nameFromStaffRecord ? (
        <Notice>
          {t('Your name and email come from your staff record. Ask the owner or a manager if they need correcting.')}
        </Notice>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.run(async () => {
              await updateAccount({ fullName: name.trim() });
              await refresh();
              onSaved();
            });
          }}
        >
          <TextField
            label={t('Your name')}
            value={name}
            onChange={setName}
            maxLength={120}
          />
          <ServerError error={save.error} />
          <Button type="submit" tone="primary" disabled={!changed || save.busy}>
            {save.busy ? t('Saving…') : t('Save name')}
          </Button>
        </form>
      )}
    </Card>
  );
}

function PasswordCard({
  account,
  onSaved,
}: {
  account: AccountView;
  onSaved: () => void;
}) {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const save = useMutation();

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready =
    current.length > 0 && next.length >= MIN_PASSWORD && next === confirm;

  return (
    <Card
      title={t('Password')}
      hint={
        account.pwChangedAt
          ? t('Last changed {{ago}}', { ago: formatAgo(account.pwChangedAt) })
          : undefined
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setDone(false);
          save.run(async () => {
            await changePassword(current, next);
            setCurrent('');
            setNext('');
            setConfirm('');
            setDone(true);
            onSaved();
          });
        }}
      >
        <TextField
          label={t('Current password')}
          type="password"
          value={current}
          onChange={setCurrent}
        />
        <FormGrid>
          <TextField
            label={t('New password')}
            type="password"
            value={next}
            onChange={setNext}
            hint={t('At least {{count}} characters', { count: MIN_PASSWORD })}
          />
          <TextField
            label={t('New password again')}
            type="password"
            value={confirm}
            onChange={setConfirm}
            hint={mismatch ? t('The two do not match') : undefined}
          />
        </FormGrid>
        <ServerError error={save.error} />
        {done && (
          <Notice>
            {t('Password changed. Your other devices will be signed out within 5 minutes.')}
          </Notice>
        )}
        <Button type="submit" tone="primary" disabled={!ready || save.busy}>
          {save.busy ? t('Saving…') : t('Change password')}
        </Button>
      </form>
    </Card>
  );
}

function LanguageCard({ account, onSaved }: { account: AccountView; onSaved: () => void }) {
  const t = useT();
  const { refresh } = useAuth();
  const save = useMutation();
  const current = account.preferences.language ?? '';

  return (
    <Card title={t('Language')} hint={t('The dashboard’s language for you, on every computer')}>
      <SelectField
        label={t('Language')}
        value={current}
        onChange={(value) =>
          save.run(async () => {
            const language = value === '' ? null : (value as Language);
            await updateAccount({ language });
            setLanguage(language);
            await refresh();
            onSaved();
          })
        }
        options={[
          { value: '', label: t('The company’s default') },
          ...LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
        ]}
      />
      <ServerError error={save.error} />
    </Card>
  );
}

function AppearanceCard() {
  const t = useT();
  const { theme, set } = useTheme();
  const options = [
    { value: 'dark' as const, label: 'Dark' },
    { value: 'light' as const, label: 'Light' },
  ];

  return (
    <Card
      title={t('Appearance')}
      hint={t('Saved on your account, so it follows you to other computers')}
    >
      <div role="radiogroup" aria-label={t('Theme')} className="flex gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={theme === o.value}
            onClick={() => set(o.value)}
            className={`rounded-md border px-3 py-1.5 text-[13px] transition ${
              theme === o.value
                ? 'border-brand bg-brand-bg text-brand-ink'
                : 'border-line text-ink-2 hover:border-brand/50'
            }`}
          >
            {t(o.label)}
          </button>
        ))}
      </div>
    </Card>
  );
}

const EVENT_LABEL: Record<string, string> = {
  login: 'Signed in',
  login_failed: 'Wrong password',
  change_password: 'Password changed',
  reset_password: 'Password reset by the owner',
  change_login_email: 'Sign-in email changed by the owner',
  '2fa_enable': '2FA turned on',
  '2fa_disable': '2FA turned off',
  '2fa_recovery_regenerate': 'New recovery codes',
  '2fa_recovery_used': 'Signed in with a recovery code',
  '2fa_failed': 'Wrong 2FA code',
  sign_out_other_sessions: 'Signed out other devices',
};

/** the events worth a second look if they were not you */
const WARNING_EVENTS = new Set([
  'login_failed',
  '2fa_failed',
  'reset_password',
  'change_login_email',
]);

function SessionsCard() {
  const t = useT();
  const { data, error, loading, reload } = useApi(
    (signal) => getAccountActivity(signal),
    [],
  );
  const signOut = useMutation();
  const [signedOut, setSignedOut] = useState(false);

  return (
    <Card
      title={t('Devices & recent activity')}
      hint={t('Your last sign-ins and security changes')}
      actions={
        <Button
          disabled={signOut.busy}
          onClick={() =>
            signOut.run(async () => {
              await signOutOtherDevices();
              setSignedOut(true);
              reload();
            })
          }
        >
          {signOut.busy ? t('Please wait…') : t('Sign out other devices')}
        </Button>
      }
    >
      <ServerError error={signOut.error} />
      {signedOut && (
        <div className="mb-3">
          <Notice>
            {t('Done — any other browser or phone signed in as you is signed out within 5 minutes.')}
          </Notice>
        </div>
      )}
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : !data || data.length === 0 ? (
        <p className="text-[13px] text-ink-3">{t('Nothing recorded yet.')}</p>
      ) : (
        <ul className="divide-y divide-line text-[13px]">
          {data.map((e: AccountEvent, i) => (
            <li
              key={`${e.at}-${i}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2"
            >
              <span
                className={
                  WARNING_EVENTS.has(e.action) ? 'text-brand-ink' : undefined
                }
              >
                {EVENT_LABEL[e.action] ? t(EVENT_LABEL[e.action]) : e.action}
              </span>
              <span className="text-ink-3">
                {e.ip && <span className="num mr-3">{e.ip}</span>}
                <span title={formatDateTime(e.at)}>{formatAgo(e.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
