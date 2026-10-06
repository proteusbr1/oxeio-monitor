import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { VersionBadge } from './components/VersionBadge';
import { AlertsPage } from './pages/alerts/AlertsPage';
import { PayrollPage } from './pages/payroll/PayrollPage';
import { SetupPage } from './pages/setup/SetupPage';
import { getSetupStatus } from './api/setup';
import { useApi } from './api/useApi';
import { WorklogPage } from './pages/worklog/WorklogPage';
import { ChangePasswordPage } from './pages/account/ChangePasswordPage';
import { EmployeeDetailPage } from './pages/staff/EmployeeDetailPage';
import { StaffPage } from './pages/staff/StaffPage';
import { GalleryPage } from './pages/screenshots/GalleryPage';
import { LiveBoardPage } from './pages/live/LiveBoardPage';
import { LoginPage } from './pages/account/LoginPage';
import { MonthlyPage } from './pages/monthly/MonthlyPage';
import { AllTargetsPage } from './pages/targets/AllTargetsPage';
import { ReviewPage } from './pages/targets/ReviewPage';
import { TargetsPage } from './pages/targets/TargetsPage';
import { MyDataPage } from './pages/me/MyDataPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ReportsPage } from './pages/reports/ReportsPage';
import { AccountPage } from './pages/account/AccountPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { homePathFor, seesEveryone } from './api/auth';
import { FeaturesProvider, useFeatures } from './features/FeaturesContext';

/**
 * Three states, three separate route trees — so "not logged in but looking at
 * an inner page" or "wandering around without changing the password" cannot happen.
 */
function Router() {
  const { user, loading, offline, refresh } = useAuth();
  const { features, ready: featuresReady } = useFeatures();

  // the module switches decide the sidebar, so wait for them too
  if (loading || (user && !user.mustChangePassword && !featuresReady)) {
    return (
      <div className="grid min-h-full place-items-center text-sm text-ink-3">
        Loading…
      </div>
    );
  }

  /**
   * "Could not reach the server" and "session ended" are different things,
   * so they get different screens.
   *
   * Showing the login screen here would tell the user a **lie**: their cookie
   * is perfectly alive, the request just did not get through. The home-screen
   * PWA cold-starts repeatedly on mobile data, so on a phone this would be an
   * everyday event, and the real cause would stay hidden until they typed a
   * password and submitted.
   */
  if (offline) {
    return (
      <div className="grid min-h-full place-items-center p-6 text-center">
        <div className="max-w-xs">
          <p className="text-sm font-medium text-ink">Unable to verify your session</p>
          <p className="mt-2 text-sm text-ink-3">
            The server could not confirm your session. Try again in a moment;
            you do not need to re-enter your password unless your session has expired.
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-4 rounded-md border border-line px-3 py-2 text-sm text-ink-2 hover:bg-surface-2"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!user) return <SignedOut />;

  if (user.mustChangePassword) {
    return (
      <Routes>
        <Route path="*" element={<ChangePasswordPage />} />
      </Routes>
    );
  }

  const isOwner = user.role === 'owner';
  /**
   * Managers get the Settings route too — they see Staff · Categories ·
   * Holidays. Which tabs they see inside is `SettingsPage`'s job.
   *
   * This is a separate variable, not `isOwner || isManager`: **the nav, the
   * route and the screen must all share the same condition**. This exact gap
   * was caught in the field: the `Layout` nav and `SettingsPage` both let the
   * manager in, but the route stayed owner-only, so managers saw Settings in
   * the nav and got **"Not found"** when they clicked it.
   */
  const mayOpenSettings = isOwner || user.role === 'manager';
  /**
   * Read from the server guards: for staff, nothing in the dashboard is open
   * **except** `/screenshots` and `/me` (`live`, `employees`, `activity`,
   * `reports` all have a class-level `@Roles(owner, manager)`). So landing on
   * the live board after login would first show them a 403 box.
   */
  /**
   * The name `isStaff` **stays**, but the logic is inverted. It used to be
   * `role === 'employee'`, so once the `researcher` role arrived the
   * researcher no longer counted as "staff": they landed on the live board,
   * where there is nothing for them but a 403 box.
   * The real question is *"does this person not see the whole team?"* — and
   * that is what the code now says.
   */
  const isStaff = !seesEveryone(user.role);

  /**
   * Worklog — owner and manager, same as the Live Board.
   *
   * A **separate name** like `mayOpenSettings`, not `!isStaff`. The condition
   * lives in three places (nav · route · screen); without a name, one day one
   * would change and not the other two — which is exactly what happened in G134.
   */
  const mayOpenWorklog = isOwner || user.role === 'manager';

  /**
   * **A researcher lands on their own work list after login.**
   *
   * They used to land on `/me`: four **hours** tiles, none about their work.
   * The first screen of the day said *"you are being measured"* and said
   * nothing about their output. Field result: both researchers' **last login
   * was 13 August**, the day the system went live; they never came back.
   *
   * This used to be `user.canAddTargets ? ... : '/me'`, when that flag carried
   * the meaning "this is a researcher" because the role was `employee`.
   * Now the role is separate, so the question is direct, and the rule lives in
   * **one place**, `homePathFor`; the "not found" page reads it too.
   */
  const staffLanding = homePathFor(user.role, features.designTargets);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          index
          element={
            /*
              Staff land on **their own page**, not the gallery. It used to be
              the gallery (there was nothing else then), but the first thing
              to see after login is not their own picture grid — it is their hours.
            */
            isStaff ? <Navigate to={staffLanding} replace /> : <LiveBoardPage />
          }
        />

        {/*
          **Staff list** (requested by the owner — the mockup's sidebar has it).

          This used to say "there is no `staff` list screen", which was the
          reason the tab was removed from the sidebar. The page exists now, so
          the tab is back.

          owner + manager — the data comes from `/live`, and that endpoint is
          a 403 for staff. So the nav shows it to those two only.
        */}
        {(isOwner || user?.role === 'manager') && (
          <Route path="staff" element={<StaffPage />} />
        )}
        <Route path="staff/:id" element={<EmployeeDetailPage />} />

        {/*
          **J05 · J08** — the tray's "My data" menu lands exactly here
          (`StaffPortalUrl`). Without this page that menu showed a 404 for a long time.

          The route is **for every role**, not wrapped in `isStaff &&`: an owner
          or manager can also be an employee (`users.employee_id` set). For
          someone without it, the server answers a clear 403 and the page shows that.
        */}
        <Route path="me" element={<MyDataPage />} />

        {/*
          Targets — researcher · manager · owner.

          The route is **open to everyone**, deliberately: the real guard is on
          the server (`assertCanSubmit` → 403). If someone types the address, the
          page just shows the server's message, which is this code base's rule:
          hiding things on screen is the first safeguard, not the last.
        */}
        {features.designTargets && (
          <Route path="targets" element={<TargetsPage />} />
        )}
        {features.designTargets && (
          <Route path="targets/all" element={<AllTargetsPage />} />
        )}
        {/*
          owner + manager — the sidebar, this route and the server's
          `@Roles(owner, manager)` are the same in all three places (lesson from
          G134: change one of the three and the other two must change too).
        */}
        {features.designTargets && (
          <Route path="targets/review" element={<ReviewPage />} />
        )}

        {/* staff see their own pictures unless the owner turned that off */}
        {(!isStaff || features.staffScreenshots) && (
          <Route path="screenshots" element={<GalleryPage />} />
        )}
        <Route path="monthly" element={<MonthlyPage />} />
        <Route path="reports" element={<ReportsPage />} />

        {/*
          I06 — unconditional, **for every role**. Turning on 2FA for your own
          account is not a privilege; staff can protect their own account too.
          (It opens no new way to watch them — the page is only about their own login.)
        */}
        <Route path="account" element={<AccountPage />} />
        {/* the Security page became a part of Account */}
        <Route path="security" element={<Navigate to="/account" replace />} />

        {/*
          If not owner, the route **does not exist** — same as Settings. An alert
          carries the hostname, the employee's name and the device state together,
          and those are out of managers' reach (spec section 4.3).
        */}
        {isOwner && <Route path="alerts" element={<AlertsPage />} />}

        {/*
          **R21** — Deposits used to be a `Settings → Deposits` tab, then a page
          of its own in the sidebar. Settings hold things you set once and forget;
          the deposit calculation needs visiting again and again.

          Like alerts, the route **does not exist** unless owner — deposits are
          directly part of pay (ADR-023 · ADR-027).
        */}
        {/*
          owner **and** manager — exactly the same as `@Roles` on `/live`.
          Lesson from G134: one permission lives in three places (nav · route ·
          screen), and if the three do not match, the user sees it in the nav
          but gets "nothing here" when clicking.
        */}
        {mayOpenWorklog && <Route path="worklog" element={<WorklogPage />} />}
        {isOwner && <Route path="payroll" element={<PayrollPage />} />}
        {/* deposits are a tab of the Payroll page now */}
        {isOwner && features.deposits && (
          <Route path="deposits" element={<Navigate to="/payroll?tab=deposits" replace />} />
        )}

        {/*
          For someone without the right, the route **does not exist** — typing
          `/settings` directly gives "not found", not 403. A 403 would admit
          that the screen exists. (`createRoutesFromChildren` silently drops
          non-element children, so putting `false` here is safe — documented v7
          behaviour, kept for exactly this kind of condition.)
        */}
        {mayOpenSettings && (
          <Route path="settings" element={<SettingsPage />} />
        )}

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <FeaturesProvider>
          <Router />
        </FeaturesProvider>
        {/*
          **Outside** the router and Layout, deliberately — so the badge shows on
          **every** screen, including the login page, the change-password page
          and the 404. Inside, it would be missing in exactly the states where
          knowing "which build is running" matters most.
        */}
        <VersionBadge />
      </AuthProvider>
    </BrowserRouter>
  );
}

/**
 * Nobody signed in: the login — or, on an install that has no owner yet, the
 * first-run setup wizard. If the check fails the login is shown, as before.
 */
function SignedOut() {
  const status = useApi((signal) => getSetupStatus(signal), []);
  if (status.loading && !status.data && !status.error) {
    return (
      <div className="grid min-h-full place-items-center text-sm text-ink-3">
        Loading…
      </div>
    );
  }
  return (
    <Routes>
      <Route path="*" element={status.data?.needed ? <SetupPage /> : <LoginPage />} />
    </Routes>
  );
}
