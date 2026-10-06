import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import * as authApi from '../api/auth';
import type { Me } from '../api/auth';
import { updateAccount } from '../api/account';
import { setUnauthorizedHandler } from '../api/client';
import { applyTheme, setThemeSaver } from '../components/ThemeToggle';
import { loadSession } from './session';
import { IdleWarning } from './IdleWarning';
import { login as loginRequest, type LoginCredentials } from './twoFactorApi';
import { useIdleLogout } from './useIdleLogout';

/** Result of a login attempt: even with the right password the flow may not be finished (I06). */
export interface SignInResult {
  /** When true, ask for the code and call `signIn` again. */
  needsTotp: boolean;
  /** Signed in with a recovery code; the user must be told how many remain. */
  usedRecoveryCode: boolean;
  recoveryCodesLeft: number | null;
}

interface AuthState {
  user: Me | null;
  /** Route decisions cannot be made before the first `/auth/me` call finishes. */
  loading: boolean;
  signIn: (creds: LoginCredentials) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * I09: true after being signed out automatically for inactivity. The login screen
   * uses it to show a "time ran out" message instead of "wrong password".
   */
  timedOut: boolean;
  /**
   * The server could not be reached at all; this is NOT an ended session.
   *
   * Careful: the two states used to be merged: whatever the reason `me()` failed
   * (a 401, or just no network), the login screen came up. In a browser tab that is
   * rare, but a home-screen PWA cold-starts repeatedly on mobile data, and there it
   * is routine. Both outcomes were bad: the owner thought the session had ended
   * (while the cookie was perfectly alive), and the app did not recover by itself
   * when the network returned. Treating "don't know" as "logged out" is another
   * face of the forbidden conversion.
   */
  offline: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [timedOut, setTimedOut] = useState(false);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    const result = await loadSession();
    if (result.kind === 'authenticated') {
      setUser(result.user);
      setOffline(false);
    } else if (result.kind === 'signed-out') {
      setUser(null);
      setOffline(false);
    } else {
      // A server/network failure cannot establish that a session expired.
      setOffline(true);
    }
    setLoading(false);
  }, []);

  /**
   * The theme follows the person: the one saved on their account is applied
   * at sign-in, and a switch made while signed in is saved back to it.
   */
  const savedTheme = user?.preferences?.theme;
  const signedIn = user !== null;
  useEffect(() => {
    if (!signedIn) {
      setThemeSaver(null);
      return;
    }
    if (savedTheme) applyTheme(savedTheme);
    setThemeSaver((theme) => {
      updateAccount({ theme }).catch(() => {
        // not saved on the account: it still applies in this browser
      });
    });
  }, [signedIn, savedTheme]);

  useEffect(() => {
    // When a session ends on any request (30 minutes of inactivity, I09),
    // go back to the login screen immediately.
    setUnauthorizedHandler(() => setUser(null));
    void refresh();
  }, [refresh]);

  /**
   * When the network returns, check again on its own. Without this the user would
   * have to refresh by hand, and a home-screen app has no "refresh" button, so they
   * would have to close and reopen the app.
   */
  useEffect(() => {
    const onOnline = (): void => void refresh();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refresh]);

  const signIn = useCallback(
    async (creds: LoginCredentials): Promise<SignInResult> => {
      const res = await loginRequest(creds);

      // Careful: `needsTotp` means no cookie was set. Calling `refresh()` here would
      // get a 401 and the user would start over from zero.
      if (res.needsTotp) {
        return { needsTotp: true, usedRecoveryCode: false, recoveryCodesLeft: null };
      }

      setTimedOut(false);
      await refresh();
      return {
        needsTotp: false,
        usedRecoveryCode: res.usedRecoveryCode === true,
        recoveryCodesLeft: res.recoveryCodesLeft ?? null,
      };
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
    }
  }, []);

  /**
   * I09: when time runs out, the cookie is also cleared on the server.
   * Careful: with only `setUser(null)` the cookie would stay in the browser; after
   * a page refresh `/auth/me` would succeed and the user would be back in, so
   * auto-logout would effectively do nothing.
   */
  const expire = useCallback(() => {
    setTimedOut(true);
    void signOut();
  }, [signOut]);

  const idle = useIdleLogout(user !== null, expire);

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, refresh, timedOut, offline }),
    [user, loading, signIn, signOut, refresh, timedOut, offline],
  );

  return (
    <AuthContext value={value}>
      {children}
      {/*
        Careful: the warning is mounted in the provider, not in any one page, so
        the user gets it whichever page they are on. Putting it in `Layout`
        would leave out the login and change-password screens.
      */}
      {user !== null && idle.phase === 'warning' && (
        <IdleWarning
          secondsLeft={Math.ceil(idle.msLeft / 1000)}
          onStay={idle.stayLoggedIn}
          onLogoutNow={expire}
        />
      )}
    </AuthContext>
  );
}

export function useAuth(): AuthState {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
