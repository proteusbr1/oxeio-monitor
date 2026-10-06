import { Navigate, useSearchParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useFeatures } from '../../features/FeaturesContext';
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
import { PrivacyTab } from './PrivacyTab';
import { TasksTab } from './TasksTab';
import { OrganizationCard } from './OrganizationCard';
import { RegionTab } from './RegionTab';
import { settingsSections } from './sections';

/**
 * Settings, grouped into sections (Work · Company · Integrations · System ·
 * Records) with a side menu; on a phone the menu becomes a grouped select.
 *
 * Managers get in too, but only to the Work section (categories and
 * holidays); a tab of a switched-off module is left out (`sections.ts`).
 * Hiding a tab here is the first safeguard, not the last: the real guard is
 * `@Roles` on the server.
 *
 * Tabs are `?tab=` (linkable, survive a refresh). Old links to tabs that
 * moved elsewhere are redirected: Staff → /staff (Directory), Leave and
 * Months → /payroll.
 */

/** tabs that moved to other pages: old links still land in the right place */
const MOVED: Record<string, string> = {
  staff: '/staff?tab=directory',
  leave: '/payroll?tab=leave',
  months: '/payroll?tab=close',
};

export function SettingsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { features } = useFeatures();

  const isOwner = user?.role === 'owner';
  const sections = settingsSections(user?.role, features);
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

  return (
    <Page title="Settings" subtitle={active.subtitle}>
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
          {active.id === 'privacy' && <PrivacyTab />}
          {active.id === 'tasks' && <TasksTab />}
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
