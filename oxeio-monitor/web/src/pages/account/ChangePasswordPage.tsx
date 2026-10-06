import { useState, type FormEvent } from 'react';

import { changePassword } from '../../api/auth';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Wordmark } from '../../components/Brand';
import { ErrorNote, Field, SubmitButton } from '../../components/Field';
import { useT } from '../../i18n';

const MIN_LENGTH = 10;

/**
 * G33: the system cannot be used with a seeded or owner-given temporary password.
 * When `mustChangePw` is set, the server returns 403 on every other route, so
 * there is no way around this screen.
 */
export function ChangePasswordPage() {
  const t = useT();
  const { user, signOut, refresh } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mismatch) return;

    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      await refresh();
    } catch (err) {
      // Careful: `err.message` is the server's message, in its own wording,
      // and is passed on as is
      setError(err instanceof ApiError ? err.message : t("Couldn't change it"));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5 rounded-lg bg-chrome px-4 py-3 text-white">
          <Wordmark className="text-lg" />
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm"
        >
          <div>
            <h1 className="text-lg font-semibold">{t('Change your password')}</h1>
            <p className="mt-1 text-sm text-ink-3">
              {t('{{email}} — the password has to be changed on first sign-in. Nothing else can be done until then.', { email: user?.email ?? '' })}
            </p>
          </div>

          {error && <ErrorNote>{error}</ErrorNote>}

          <Field
            id="current"
            label={t('Current password')}
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />

          <Field
            id="next"
            label={t('New password')}
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_LENGTH}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            hint={t('At least {{count}} characters, and not the old one', { count: MIN_LENGTH })}
          />

          <Field
            id="confirm"
            label={t('New password again')}
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />

          {mismatch && <ErrorNote>{t("The two passwords don't match")}</ErrorNote>}

          <SubmitButton busy={busy} disabled={mismatch}>
            {t('Change password')}
          </SubmitButton>

          <button
            type="button"
            onClick={() => void signOut()}
            className="w-full text-center text-xs text-ink-3 underline-offset-2 hover:underline"
          >
            {t('Sign out')}
          </button>
        </form>
      </div>
    </div>
  );
}
