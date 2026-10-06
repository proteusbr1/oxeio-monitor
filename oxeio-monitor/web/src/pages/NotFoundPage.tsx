import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { Page } from '../components/Page';
import { Empty } from '../components/States';
import { homePathFor } from '../api/auth';
import { useFeatures } from '../features/FeaturesContext';

/**
 * 404: no such address.
 *
 * When anyone but the owner types `/settings`, they get this page, not "no
 * permission". The route is not even registered for them in `App.tsx`, so a
 * manager cannot tell that a Settings screen exists. A 403 would instead confirm
 * that the thing exists and is merely out of reach.
 *
 * Careful: the link back depends on the role. For staff, `/` means the live
 * board, which is a 403 for them. Pushing them there makes no sense, so their
 * label is different: "My screenshots".
 */
/**
 * Careful: the name of the way back must say where the path actually lands. The
 * condition used to be written twice (once for the path, once for the text), and
 * when a new role arrived the two drifted in different directions.
 */
const HOME_WORD: Record<string, string> = {
  '/': 'Back to Live Board',
  '/targets/all': 'Back to the Design Pool',
  '/me': 'My data',
};

export function NotFoundPage() {
  const { user } = useAuth();
  const { features } = useFeatures();
  /**
   * Careful: this used to read `role === 'employee' ? '/screenshots' : '/'`; with
   * the researcher role, a researcher got `/` (the Live Board), which is a 403 for
   * them. Now the rule is in one place, matching the landing logic in App.tsx.
   */
  const home = homePathFor(user?.role, features.designTargets);

  return (
    <Page title="Not found">
      <Empty
        title="There's nothing at this address"
        hint="The link may be old, or the address has a typo."
        action={
          <Link
            to={home}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-2 transition hover:border-brand hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
          >
            {HOME_WORD[home] ?? 'Back'}
          </Link>
        }
      />
    </Page>
  );
}
