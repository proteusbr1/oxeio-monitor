import { useState, type FormEvent } from 'react';

import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Wordmark } from '../../components/Brand';
import { ErrorNote, Field, SubmitButton } from '../../components/Field';

/**
 * Two steps, but only one form state: the email/password are not cleared. The
 * server's second step needs the email and password again as well (there is no
 * half-logged-in token in between; see `auth.service.ts`).
 */
type Step = 'password' | 'totp';

export function LoginPage() {
  const { signIn, timedOut } = useAuth();
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn({
        email,
        password,
        // Careful: in step 1 the two fields are not sent at all. An empty string would
        // not be treated by the server as "code given but wrong", but there is no
        // point going near the throttle for nothing.
        ...(step === 'totp' && !useRecovery ? { totp: code } : {}),
        ...(step === 'totp' && useRecovery ? { recoveryCode: code } : {}),
      });

      if (result.needsTotp) {
        setStep('totp');
        setBusy(false);
        return;
      }

      /**
       * Careful: it is important to tell the user when a recovery code was used up. If
       * someone spent the last of 10 without noticing, there would be no way in next
       * time. There is no option but `alert` before the route changes: this component
       * unmounts immediately.
       */
      if (result.usedRecoveryCode) {
        const left = result.recoveryCodesLeft ?? 0;
        window.alert(
          `That recovery code is now used up — ${left} left.` +
            (left <= 2
              ? ' Go to the Security page and generate new ones.'
              : ''),
        );
      }
      // On success routing changes by itself, as soon as the user is set
    } catch (err) {
      /**
       * Careful: `err.message` is the server's message (e.g. "wrong email or
       * password"), in the server's own wording, so it is shown as it comes.
       * The network-failure sentence below is our own, so it is in English.
       */
      setError(
        err instanceof ApiError ? err.message : "Can't reach the server",
      );
      setBusy(false);
      // Careful: a wrong code does not send the user back to step 1; that would make
      // them type the whole password again when only the 6 digits were wrong.
      if (step === 'totp') setCode('');
    }
  }

  function backToPassword(): void {
    setStep('password');
    setCode('');
    setUseRecovery(false);
    setError(null);
  }

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5 rounded-lg bg-chrome px-4 py-3 text-white">
          <Wordmark className="text-lg" />
          <span className="text-xs text-white/55">Workforce Monitor</span>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm"
        >
          {step === 'password' ? (
            <>
              <div>
                <h1 className="text-lg font-semibold">Sign in</h1>
                <p className="mt-1 text-sm text-ink-3">
                  Owner and Manager — staff sign in here too, to see their own
                  hours.
                </p>
              </div>

              {/* I09: the answer to "why am I suddenly on the login screen?" */}
              {timedOut && !error && (
                <p className="rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink-2">
                  Your session closed after a long stretch of no activity.
                  Please sign in again.
                </p>
              )}

              {error && <ErrorNote>{error}</ErrorNote>}

              <Field
                id="email"
                label="Email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@oxeio.local"
              />

              <Field
                id="password"
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />

              <SubmitButton busy={busy}>Sign in</SubmitButton>

              <p className="text-center text-xs text-ink-3">
                Forgot your password? Ask the Owner — they can reset it for you.
              </p>
            </>
          ) : (
            <>
              <div>
                <h1 className="text-lg font-semibold">Two-step verification</h1>
                <p className="mt-1 text-sm text-ink-3">
                  {email} — {useRecovery
                    ? 'Enter one of the recovery codes you wrote down.'
                    : 'Enter the 6-digit code from your authenticator app.'}
                </p>
              </div>

              {error && <ErrorNote>{error}</ErrorNote>}

              {useRecovery ? (
                <Field
                  id="recovery"
                  label="Recovery code"
                  type="text"
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="ABCDE-FGHJK"
                  hint="Each code works only once."
                />
              ) : (
                <Field
                  id="totp"
                  label="Verification code"
                  /*
                   * Careful: `type="text"` + `inputMode="numeric"`: with `type="number"`
                   * leading zeros would be dropped (`012345` becomes `12345`) and
                   * scrolling would change the number.
                   */
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  /*
                   * Careful: ASCII digits in the placeholder, never localised digits: the
                   * authenticator app gives the code in ASCII digits. Seeing the two not
                   * match, someone might think they are typing in the wrong field.
                   */
                  placeholder="123456"
                  hint="Each code works only once — an old one won't do."
                />
              )}

              <SubmitButton busy={busy}>Verify</SubmitButton>

              <div className="flex flex-wrap justify-between gap-2 text-center text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setUseRecovery((v) => !v);
                    setCode('');
                    setError(null);
                  }}
                  className="text-ink-2 underline underline-offset-2 hover:text-ink"
                >
                  {useRecovery
                    ? 'Use the app code instead'
                    : "Phone not with me — use a recovery code"}
                </button>
                <button
                  type="button"
                  onClick={backToPassword}
                  className="text-ink-3 underline underline-offset-2 hover:text-ink"
                >
                  Back
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
