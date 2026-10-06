import {
  createContext,
  use,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import { isAbortError } from '../api/client';
import { ALL_FEATURES_ON, getFeatures, type Features } from '../api/features';
import { useAuth } from '../auth/AuthContext';

interface FeaturesState {
  features: Features;
  /** false until the server answered (or failed) — see `FeaturesProvider` */
  ready: boolean;
  /**
   * Settings → Modules hands back what is now on (`effective` — a child module
   * is off while its parent is); the sidebar follows at once
   */
  setFeatures: (features: Features) => void;
}

const FeaturesContext = createContext<FeaturesState>({
  features: ALL_FEATURES_ON,
  ready: true,
  setFeatures: () => undefined,
});

/**
 * Loads which modules are on (`GET /features` — the effective state, not the
 * owner's raw switches) once per sign-in (the endpoint needs a session,
 * so nothing is asked while signed out or before the password is changed).
 *
 * ⚠️ If the request fails every module stays on — the dashboard as it always
 *    was. Hiding a screen because of a network blip would look like data loss;
 *    the server still blocks a switched-off module either way.
 */
export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const signedIn = user !== null && !user.mustChangePassword;
  const userId = user?.userId;

  const [features, setFeatures] = useState<Features>(ALL_FEATURES_ON);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!signedIn) return;
    setReady(false);
    const controller = new AbortController();
    getFeatures(controller.signal)
      .then(setFeatures)
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
      })
      .finally(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => controller.abort();
  }, [signedIn, userId]);

  const set = useCallback((next: Features) => setFeatures(next), []);

  return (
    <FeaturesContext value={{ features, ready, setFeatures: set }}>
      {children}
    </FeaturesContext>
  );
}

export function useFeatures(): FeaturesState {
  return use(FeaturesContext);
}
