import { Navigate, useSearchParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Page } from '../../components/Page';
import { ErrorBox } from '../../components/States';
import { Tabs } from '../../components/Tabs';
import { AgentVersionsTab } from './AgentVersionsTab';
import { BackupTab } from './BackupTab';
import { NotificationsTab } from './NotificationsTab';
import { AuditTab } from './AuditTab';
import { CategoriesTab } from './CategoriesTab';
import { ErrorReportingTab } from './ErrorReportingTab';
import { ModulesTab } from './ModulesTab';
import { PoliciesTab } from './PoliciesTab';
import { RegionTab } from './RegionTab';
import { StaffTab } from './StaffTab';

/**
 * Settings.
 *
 * Important: **managers get in too**, but only on three tabs: Staff, Categories,
 *    Policies & holidays. Leave, Months, Agent updates and Audit log are the
 *    owner's alone.
 *
 * Careful: hiding a tab on screen is **the first safeguard, not the last**; the
 *    real guard is `@Roles` on the server. Hiding here just stops people seeing a
 *    button that would give a 403.
 *
 * Careful: staff (`role=employee`) arriving here get a plain "not permitted",
 *    better than being confused by an empty page or a failing call.
 *
 * Important: tabs are `?tab=`, not separate routes, for two reasons:
 *    1. `App.tsx` does not need touching (it belongs to another agent's files),
 *       yet "/settings?tab=audit" can be linked and survives a refresh.
 *    2. No inner component is reused when the tab changes: each tab fetches its
 *       own data, so returning from the staff tab cannot leave a stale list.
 */

/**
 * `manager: true` means a manager gets the tab too.
 *
 * Careful: the field **must be written on every row** (`false` too), it is not
 *    optional, so adding a tab makes TypeScript remind you to decide. If optional,
 *    forgetting and saying "no" would look the same, and one day someone would
 *    forget and assume that was intended.
 */
const TABS = [
  { id: 'staff', label: 'Staff', manager: true },
  { id: 'categories', label: 'Categories', manager: true },
  // Careful: a manager gets **only leave** here (the work policy is owner-only), so
  //    the name differs for them too; otherwise they would look for something absent.
  {
    id: 'policies',
    label: 'Policies & holidays',
    managerLabel: 'Holidays',
    manager: true,
  },
  // Leave and Months moved to the Payroll page (pages/payroll), with the
  // rest of the month's pay; old ?tab=leave|months links are sent there.
  // the owner's call: which parts of the dashboard this company uses
  { id: 'modules', label: 'Modules', manager: false },
  // Careful: **before** audit: not a daily-use tab, but audit log being last is
  //    established (it is opened once or twice a year)
  // Telegram token and chat ID. Owner-only, because that chat carries employee names
  //    and hours; who gets it is not the manager's decision.
  { id: 'notifications', label: 'Notifications', manager: false },
  // Sentry — where crashes are sent; owner-only like the other credentials
  { id: 'errors', label: 'Error reporting', manager: false },
  // time zone, currency, date format — what used to need the server's .env
  { id: 'region', label: 'Region', manager: false },
  // Offsite backup key. Owner-only: it is an infrastructure credential, and the
  //    backup holds the whole company's hours, pay and screenshots.
  // where screenshots are kept, and who backs up the database
  { id: 'backup', label: 'Storage & backup', manager: false },
  { id: 'agent', label: 'Agent updates', manager: false },
  // Careful: the audit log also records who viewed whose screenshots, so owner-only
  { id: 'audit', label: 'Audit log', manager: false },
] as const;

type TabKey = (typeof TABS)[number]['id'];

const SUBTITLE: Record<TabKey, string> = {
  // Careful: **the "Devices" tab was removed on purpose.** The owner said he did not
  //    want the Devices option because it made the whole system more complex, and
  //    he was right: the same question ("is Belal's PC OK?") had to be looked up on
  //    two screens.
  //
  // The one genuinely useful job of that screen, turning a stopped agent back on, is
  //    now in the Staff row itself, as "Turn agent on", and organised **by person**:
  //    the owner does not think in device numbers.
  staff: 'Add, edit and deactivate people — nothing is ever deleted',
  categories: 'Which apps and sites fall into which category',
  policies: 'Monthly target, screenshot window and days off',
  modules: 'Turn off the parts your company does not use — nothing is deleted',
  notifications: 'Where the weekly summary and alerts are sent',
  errors: 'Send crashes to Sentry, so bugs are found before anyone reports them',
  region: 'Time zone, currency and how dates and numbers are written',
  backup: 'Where screenshots are kept, and how the database is backed up',
  agent: 'Which build each PC is offered — and how widely',
  audit: 'Who looked at what, and who changed what',
};

function isTabKey(value: string | null): value is TabKey {
  return TABS.some((tab) => tab.id === value);
}

export function SettingsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();

  const isOwner = user?.role === 'owner';
  const tabs = isOwner
    ? TABS
    : TABS.filter((t) => t.manager).map((t) =>
        'managerLabel' in t ? { ...t, label: t.managerLabel } : t,
      );

  const raw = params.get('tab');
  // these two tabs live on the Payroll page now
  const moved = raw === 'leave' ? 'leave' : raw === 'months' ? 'close' : null;
  /**
   * Careful: whether the tab is valid **for this user**, not just whether the name
   * matches. Otherwise typing `?tab=audit` would show a manager an empty page, with
   * nothing in the nav and no content.
   */
  const active: TabKey =
    isTabKey(raw) && tabs.some((t) => t.id === raw) ? raw : 'staff';

  if (moved && isOwner) return <Navigate to={`/payroll?tab=${moved}`} replace />;

  if (user?.role !== 'owner' && user?.role !== 'manager') {
    return (
      <Page title="Settings">
        {/*
          Careful: `<ErrorBox>` itself recognises 403 and hides its "try again"
             button; pressing it repeatedly would never grant permission, only
             confuse. So the same box is shown instead of writing a separate message,
             keeping 403 looking the same across the whole product.
        */}
        <ErrorBox error={new ApiError(403, "You don't have access")} />
      </Page>
    );
  }

  /** Careful: the manager's policies tab has no work policy, so the text differs too */
  const subtitle =
    !isOwner && active === 'policies'
      ? 'Days off — the hours target moves with them'
      : SUBTITLE[active];

  return (
    <Page title="Settings" subtitle={subtitle}>
      <div className="mb-4">
        <Tabs
          items={tabs}
          active={active}
          label="Settings sections"
          // `replace`: if tab changes piled up in browser history, pressing "back"
          // to leave would step through the tabs five times
          onChange={(key) => setParams({ tab: key }, { replace: true })}
        />
      </div>

      {active === 'staff' && <StaffTab />}
      {active === 'categories' && <CategoriesTab />}
      {active === 'policies' && <PoliciesTab />}
      {active === 'modules' && <ModulesTab />}
      {active === 'notifications' && <NotificationsTab />}
      {active === 'errors' && <ErrorReportingTab />}
      {active === 'region' && <RegionTab />}
      {active === 'backup' && <BackupTab />}
      {active === 'agent' && <AgentVersionsTab />}
      {active === 'audit' && <AuditTab />}
    </Page>
  );
}
