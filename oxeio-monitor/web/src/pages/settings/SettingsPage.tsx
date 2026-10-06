import { Navigate, useSearchParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Page } from '../../components/Page';
import { ErrorBox } from '../../components/States';
import { AgentVersionsTab } from './AgentVersionsTab';
import { BackupTab } from './BackupTab';
import { NotificationsTab } from './NotificationsTab';
import { AuditTab } from './AuditTab';
import { CategoriesTab } from './CategoriesTab';
import { ErrorReportingTab } from './ErrorReportingTab';
import { ModulesTab } from './ModulesTab';
import { PoliciesTab } from './PoliciesTab';
import { OrganizationCard } from './OrganizationCard';
import { RegionTab } from './RegionTab';

/**
 * Settings, grouped into sections (Work · Company · Integrations · System ·
 * Records) with a side menu; on a phone the menu becomes a grouped select.
 *
 * Managers get in too, but only to the Work section (categories and
 * holidays). Hiding a tab here is the first safeguard, not the last: the
 * real guard is `@Roles` on the server.
 *
 * Tabs are `?tab=` (linkable, survive a refresh). Old links to tabs that
 * moved elsewhere are redirected: Staff → /staff (Directory), Leave and
 * Months → /payroll.
 */

interface TabDef {
  id: string;
  label: string;
  /** a manager gets it too — written on every row so adding one forces the decision */
  manager: boolean;
  managerLabel?: string;
  subtitle: string;
  managerSubtitle?: string;
}

const SECTIONS: { title: string; tabs: TabDef[] }[] = [
  {
    title: 'Work',
    tabs: [
      {
        id: 'categories',
        label: 'Apps & sites',
        manager: true,
        subtitle: 'Which apps and sites count as work, and in which category',
      },
      {
        id: 'policies',
        label: 'Policies & holidays',
        managerLabel: 'Holidays',
        manager: true,
        subtitle: 'Monthly target, screenshot window, days off and holidays',
        managerSubtitle: 'Days off — the hours target moves with them',
      },
    ],
  },
  {
    title: 'Company',
    tabs: [
      {
        id: 'region',
        label: 'Company & region',
        manager: false,
        subtitle: 'Company name, country, time zone, currency and formats',
      },
      {
        id: 'modules',
        label: 'Modules',
        manager: false,
        subtitle: 'Turn off the parts your company does not use — nothing is deleted',
      },
    ],
  },
  {
    title: 'Integrations',
    tabs: [
      {
        id: 'notifications',
        label: 'Notifications',
        manager: false,
        subtitle: 'Where the weekly summary and alerts are sent',
      },
      {
        id: 'errors',
        label: 'Error reporting',
        manager: false,
        subtitle: 'Send crashes to Sentry, so bugs are found before anyone reports them',
      },
    ],
  },
  {
    title: 'System',
    tabs: [
      {
        id: 'backup',
        label: 'Storage & backup',
        manager: false,
        subtitle: 'Where screenshots are kept, and how the database is backed up',
      },
      {
        id: 'agent',
        label: 'Agent updates',
        manager: false,
        subtitle: 'Which agent build each PC is offered — and how widely',
      },
    ],
  },
  {
    title: 'Records',
    tabs: [
      {
        id: 'audit',
        label: 'Audit log',
        manager: false,
        subtitle: 'Who looked at what, and who changed what',
      },
    ],
  },
];

/** tabs that moved to other pages: old links still land in the right place */
const MOVED: Record<string, string> = {
  staff: '/staff?tab=directory',
  leave: '/payroll?tab=leave',
  months: '/payroll?tab=close',
};

export function SettingsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();

  const isOwner = user?.role === 'owner';
  const sections = SECTIONS.map((section) => ({
    ...section,
    tabs: section.tabs
      .filter((t) => isOwner || t.manager)
      .map((t) => (isOwner ? t : { ...t, label: t.managerLabel ?? t.label })),
  })).filter((section) => section.tabs.length > 0);
  const tabs = sections.flatMap((section) => section.tabs);

  const raw = params.get('tab');
  // valid for THIS user, not just a known name — a manager typing ?tab=audit
  // gets their first tab, not an empty page
  const active = tabs.find((t) => t.id === raw) ?? tabs[0];

  if (raw && MOVED[raw]) return <Navigate to={MOVED[raw]} replace />;

  if (!isOwner && user?.role !== 'manager') {
    return (
      <Page title="Settings">
        {/* the same 403 box as everywhere else (it hides its useless retry) */}
        <ErrorBox error={new ApiError(403, "You don't have access")} />
      </Page>
    );
  }

  const open = (id: string) => setParams({ tab: id }, { replace: true });
  const subtitle = (!isOwner && active.managerSubtitle) || active.subtitle;

  return (
    <Page title="Settings" subtitle={subtitle}>
      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-6">
        <nav aria-label="Settings sections">
          {/* phone: one grouped select instead of a long row of tabs */}
          <label className="mb-4 block lg:hidden">
            <span className="sr-only">Section</span>
            <select
              value={active.id}
              onChange={(e) => open(e.target.value)}
              className="tap w-full rounded-md border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
            >
              {sections.map((section) => (
                <optgroup key={section.title} label={section.title}>
                  {section.tabs.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          <div className="hidden space-y-4 lg:block">
            {sections.map((section) => (
              <div key={section.title}>
                <p className="mb-1 px-2.5 text-[10.5px] font-semibold tracking-wider text-ink-3 uppercase">
                  {section.title}
                </p>
                <ul className="space-y-0.5">
                  {section.tabs.map((t) => {
                    const selected = t.id === active.id;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          aria-current={selected ? 'page' : undefined}
                          onClick={() => open(t.id)}
                          className={`w-full rounded-md px-2.5 py-1.5 text-left text-[13px] transition focus:outline-none focus:ring-2 focus:ring-brand/30 ${
                            selected
                              ? 'bg-brand-bg font-semibold text-brand-ink'
                              : 'text-ink-2 hover:bg-surface hover:text-ink'
                          }`}
                        >
                          {t.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0">
          {active.id === 'categories' && <CategoriesTab />}
          {active.id === 'policies' && <PoliciesTab />}
          {active.id === 'modules' && <ModulesTab />}
          {active.id === 'notifications' && <NotificationsTab />}
          {active.id === 'errors' && <ErrorReportingTab />}
          {active.id === 'region' && (
            <div className="space-y-4">
              <OrganizationCard />
              <RegionTab />
            </div>
          )}
          {active.id === 'backup' && <BackupTab />}
          {active.id === 'agent' && <AgentVersionsTab />}
          {active.id === 'audit' && <AuditTab />}
        </div>
      </div>
    </Page>
  );
}
