import type { Role } from '../../api/auth';
import type { FeatureKey, Features } from '../../api/features';
import { translate } from '../../i18n';

/**
 * Settings' side menu: which tabs exist, in which section, and who sees them.
 * Kept out of `SettingsPage` so the filtering can be tested without
 * rendering anything.
 *
 * Hiding a tab is the first safeguard, not the last: the real guard is
 * `@Roles` (and `@RequiresFeature`) on the server.
 */

interface TabDef {
  id: string;
  label: string;
  /** a manager gets it too — written on every row so adding one forces the decision */
  manager: boolean;
  managerLabel?: string;
  /** a function when the line depends on which modules are on */
  subtitle: string | ((features: Features) => string);
  managerSubtitle?: string;
  /**
   * Belongs to a module (Settings → Modules): hidden while it is off. Its
   * endpoints answer 404 then, so an open tab would only show an error.
   */
  feature?: FeatureKey;
}

/** A tab as this user sees it: the label and subtitle already chosen */
export interface SettingsTab {
  id: string;
  label: string;
  subtitle: string;
}

export interface SettingsSection {
  title: string;
  tabs: SettingsTab[];
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
        feature: 'appTracking',
      },
      {
        id: 'policies',
        label: 'Policies & holidays',
        managerLabel: 'Holidays',
        manager: true,
        subtitle: (f) =>
          f.screenshots
            ? 'Hours target, screenshot window, days off and holidays'
            : 'Hours target, idle threshold, days off and holidays',
        managerSubtitle: 'Days off — the hours target moves with them',
      },
      /**
       * The choices inside the Tasks module (start detection) — owner only,
       * like Privacy for screenshots; Modules only switches it on or off.
       */
      {
        id: 'tasks',
        label: 'Tasks',
        manager: false,
        subtitle: 'Which apps show that a task was started',
        feature: 'tasks',
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
      /**
       * The choices inside the Screenshots module (who sees the pictures, how
       * long they are kept) — beside Modules, but not on it: Modules only
       * switches whole parts on or off.
       */
      {
        id: 'privacy',
        label: 'Privacy',
        manager: false,
        subtitle: 'Who sees screenshots, and how long they are kept',
        feature: 'screenshots',
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
        subtitle: (f) =>
          f.screenshots
            ? 'Where screenshots are kept, and how the database is backed up'
            : 'How the database is backed up',
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

/**
 * The sections this user sees. Managers get the Work section only (with
 * their own labels); a tab of a switched-off module is left out, and a
 * section left with no tab disappears.
 */
export function settingsSections(
  role: Role | undefined,
  features: Features,
): SettingsSection[] {
  const isOwner = role === 'owner';
  // translated here, at call time (render), so a language switch shows at once
  return SECTIONS.map((section) => ({
    title: translate(section.title),
    tabs: section.tabs
      .filter((t) => isOwner || t.manager)
      .filter((t) => t.feature === undefined || features[t.feature])
      .map((t) => {
        const subtitle =
          typeof t.subtitle === 'function' ? t.subtitle(features) : t.subtitle;
        return isOwner
          ? { id: t.id, label: translate(t.label), subtitle: translate(subtitle) }
          : {
              id: t.id,
              label: translate(t.managerLabel ?? t.label),
              subtitle: translate(t.managerSubtitle ?? subtitle),
            };
      }),
  })).filter((section) => section.tabs.length > 0);
}
