import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';

import { listAlerts } from '../api/alerts';
import type { Role } from '../api/auth';
import { usePolling } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import { useFeatures } from '../features/FeaturesContext';
import { Wordmark } from './Brand';
import '../studio.css';
import { ErrorBoundary } from './ErrorBoundary';
import { navFor } from './nav';
import { ThemeToggle } from './ThemeToggle';
import { formatDateMedium, workTimeZoneLabel, workWallOf } from '../lib/format';

/**
 * Pace of the nav badge: slow, like the board's pulse.
 *
 * Careful: alerts do not change minute by minute, and this runs on every page
 * (Layout sits outside all routes). Polling quickly would cause pointless traffic
 * across the whole app.
 */
const ALERT_BADGE_MS = 120_000;

/**
 * Id of the slot in the top bar where page-specific items go.
 * Careful: both `Layout` and `LiveBoardPage` use it, so the constant is exported
 * from here; writing the string in two places would one day let one change while
 * the other stayed, and the slot would silently stay empty.
 */
export const TOPBAR_SLOT_ID = 'oxeio-topbar-slot';

/**
 * Careful: the role names are screen text, not the server's `role` values.
 * `employee` is shown as "Staff", because people are called Staff throughout the
 * dashboard (glossary section 1).
 */
/**
 * Work-zone date and time: `15 Aug 2026 · 18:40`.
 *
 * Careful: it reads the work zone's wall clock and cuts from the ISO string rather than using
 * `toLocaleString`, so the result is the same whatever the machine's timezone or locale.
 * Careful: no seconds: a number changing every second draws the eye, yet the
 * board refreshes every 30 seconds, so the clock would look fresher than the data.
 */
function workStamp(): string {
  const d = workWallOf(new Date());
  const iso = d.toISOString();
  // through lib/format, so DISPLAY_LOCALE reaches the top bar too
  return `${formatDateMedium(iso.slice(0, 10))} · ${iso.slice(11, 16)}`;
}

/**
 * Careful: `Record<Role, ...>`, not `Record<string, ...>`; this change is the real
 * work here. It used to be `string`, so when a fourth role was added the
 * compiler said nothing, and the name silently showed in the screen corner as
 * the raw lowercase value. Now when the enum grows, the error
 * appears right here.
 */
const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  manager: 'Manager',
  coordinator: 'Coordinator',
  employee: 'Staff',
};

export function Layout() {
  const { user, signOut } = useAuth();
  const { features } = useFeatures();
  const { pathname } = useLocation();
  /**
   * Count of unseen alerts, for the nav badge.
   *
   * Careful: only the owner calls it (`listAlerts` is owner-only); otherwise a
   * manager's browser would collect a 403 every two minutes.
   * Careful: on failure it is `undefined`, not 0. When the number is unknown the nav
   * stays quiet; it does not say "no alerts".
   */
  const alerts = usePolling(
    (signal) =>
      user?.role === 'owner'
        ? listAlerts({ limit: 1 }, signal)
        : Promise.resolve(null),
    ALERT_BADGE_MS,
    [user?.role],
  );

  const nav = user
    ? navFor(user, features).map((item) =>
        item.to === '/alerts' ? { ...item, badge: alerts.data?.total } : item,
      )
    : [];

  const currentPage = [...nav].sort((a, b) => b.to.length - a.to.length)
    .find((item) => item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`))?.label ?? 'Workspace';
  const initials = user?.fullName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('') ?? '';

  return (
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <div className="studio-brand"><Wordmark /><small>Workforce<br />Monitor</small></div>
        <nav className="studio-nav" aria-label="Sections">
          <div className="studio-nav-label">Workspace</div>
          {nav.map((item) => (
            <div key={item.to}>
              {item.section && <div className="studio-nav-label">{item.section}</div>}
              <NavLink to={item.to} end={item.end} className="studio-nav-link">
                <span className="studio-nav-name"><span className="studio-nav-dot" aria-hidden />{item.label}</span>
                {item.badge != null && item.badge > 0 && (
                  <span className="num rounded-full bg-brand-bg px-1.5 text-xs text-brand-ink">{item.badge}</span>
                )}
              </NavLink>
            </div>
          ))}
        </nav>
        <Link to="/account" className="studio-user" title="Your account">
          <span className="studio-avatar" aria-hidden>{initials}</span>
          <div className="min-w-0 text-xs"><div>{user?.fullName}</div><div className="mt-1 text-ink-2">{user ? ROLE_LABEL[user.role] : ''}</div></div>
        </Link>
      </aside>
      <div className="studio-workspace">
        <header className="studio-topbar">
          <div><span className="text-ink-2">Workspace / </span><span>{currentPage}</span></div>
          <div className="studio-topbar-actions">
            <span className="studio-topbar-time text-ink-2">{workTimeZoneLabel()} · {workStamp()}</span>
            <ThemeToggle />
            <button type="button" onClick={() => void signOut()} className="tap px-3 py-1.5 text-xs">Sign out</button>
          </div>
        </header>
        <nav className="studio-mobile-nav" aria-label="Mobile sections">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="studio-nav-link">
              {item.label}
              {item.badge != null && item.badge > 0 && <span className="num text-brand-ink">{item.badge}</span>}
            </NavLink>
          ))}
        </nav>
        <main className="studio-main">
          <ErrorBoundary resetKey={pathname}><Outlet /></ErrorBoundary>
        </main>
      </div>
    </div>
  );
}