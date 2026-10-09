import { useState, type ReactNode } from 'react';

import {
  FEATURE_PARENT,
  getFeatureSettings,
  saveFeatures,
  type FeatureKey,
  type Features,
  type FeatureUsage,
} from '../../api/features';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { useFeatures } from '../../features/FeaturesContext';
import { Chip, ConfirmDialog, Notice, ServerError, useMutation } from '../../components/ui';
import { currentLanguage, translate, useT } from '../../i18n';

/**
 * Settings → Modules: switch off the parts of the product a company does not
 * use. Off hides the screens, the server blocks the endpoints and, for the
 * capture modules, the agents stop collecting. No table is dropped, so
 * switching back on brings everything back as it was.
 *
 * ⚠️ Whole modules only. A choice *inside* a module (who sees screenshots,
 *    how long they are kept) belongs on that module's own settings page —
 *    Settings → Privacy — never as a switch here.
 */

/**
 * `title`, `what` and `hides` are the English text and the translation keys:
 * translated where they are shown. `holds` and the warnings are called at
 * render time, so they translate themselves.
 */
interface ModuleInfo {
  key: FeatureKey;
  title: string;
  what: string;
  /** what disappears while the module is off */
  hides: string[];
  /** what is already stored — shown so a switch never hides data by surprise */
  holds: (usage: FeatureUsage) => string | null;
  /** extra consequence spelled out before switching off */
  offWarning?: (usage: FeatureUsage) => string | null;
  /** consequence spelled out before switching back on; none = no question */
  onWarning?: (usage: FeatureUsage) => string | null;
}

/** In screen order; a child module (`FEATURE_PARENT`) is drawn under its parent */
const MODULES: ModuleInfo[] = [
  {
    key: 'payroll',
    title: 'Payroll',
    what: 'The monthly pay sheet, worked out from salaries or hourly rates, hours, overtime and leave.',
    hides: [
      'Payroll’s Pay sheet and each person’s pay terms (the page becomes “Leave & months”)',
      'The pay column and fields in Staff',
      'The pay rules on work policies',
    ],
    holds: (u) =>
      u.paidStaff > 0
        ? translate('{{count}} people have pay terms set — they stay saved', { count: u.paidStaff })
        : null,
  },
  {
    key: 'deposits',
    title: 'Security deposits',
    what: 'A monthly instalment held back from pay, refunded or kept when someone leaves.',
    hides: [
      'The Deposits tab of Payroll',
      'The deposit card on each person’s My data',
      'The deposit line on the payroll sheet',
    ],
    holds: (u) =>
      u.depositMonths > 0
        ? translate('{{count}} monthly instalments on record — they stay saved', { count: u.depositMonths })
        : null,
    offWarning: (u) =>
      u.depositMonths > 0
        ? translate('While deposits are off, the payroll sheet holds nothing back — net pay equals payable. The instalments already on record are kept.')
        : null,
    onWarning: (u) =>
      u.depositMonths > 0
        ? translate('Months that are still open get their instalment the next time the deposits ledger is opened, including months that passed while this was off. Close finished months first (Payroll → Close month) if they should stay as they are.')
        : null,
  },
  {
    key: 'screenshots',
    title: 'Screenshots',
    what: 'Pictures of each person’s screen through the day, inside their work policy’s window.',
    hides: [
      'The Screenshots page, for everyone',
      'The Screen column of the Worklog',
      'The day’s pictures on each person’s Staff page',
      'Settings › Privacy, the screenshot storage choice and the screenshot window on work policies',
    ],
    holds: (u) =>
      u.hasScreenshots
        ? translate('Pictures are stored — the nightly cleanup keeps deleting them as they pass the retention period')
        : null,
    offWarning: () =>
      translate('The agents stop taking pictures for everyone. Idle detection keeps working, so hours are counted exactly as before. Pictures already stored stay until the retention period (Settings › Privacy) removes them.'),
    onWarning: () =>
      translate('The agents start taking pictures again at their next sync, inside each work policy’s window. Staff see their own only if Settings › Privacy allows it.'),
  },
  {
    key: 'appTracking',
    title: 'Apps & websites',
    what: 'Which app or website is in front and for how long — for productivity, the top apps and the category rules.',
    hides: [
      '“Where today went” on the Live Board',
      'Productivity and top apps on each person’s Staff page',
      'Reports › Apps & sites',
      'Settings › Apps & sites',
    ],
    holds: (u) =>
      u.hasAppUsage ? translate('App and website history is stored — it stays saved') : null,
    offWarning: () =>
      translate('The agents stop recording which apps and sites are used. Counted hours do not change — they come from keyboard and mouse activity. The jiggler check (synthetic input) reads app data too, so it goes quiet.'),
    onWarning: () =>
      translate('Recording starts again at the agents’ next sync. The time while it was off stays without app data.'),
  },
  /**
   * Not nested under Apps & websites: the tasks work on their own. Only start
   * detection (Settings › Tasks) reads window titles, and it simply rests
   * while Apps & websites is off.
   */
  {
    key: 'tasks',
    title: 'Tasks',
    what: 'A pool of work items handed out to people each day, with a daily target, an optional check step and review of what was dropped.',
    hides: [
      'Add tasks, Task pool and Review',
      'The task panels on the Live Board and in the daily summary',
      'Each person’s task list on My data',
      'Receives tasks and the daily task target in Staff',
      'Settings › Tasks',
    ],
    holds: (u) => {
      const parts = [
        u.tasks > 0 ? translate('{{count}} tasks', { count: u.tasks }) : null,
        u.taskReceivers > 0
          ? translate('{{count}} people receive tasks', { count: u.taskReceivers })
          : null,
      ].filter(Boolean);
      return parts.length > 0
        ? translate('{{parts}} — nothing is deleted', { parts: parts.join(' · ') })
        : null;
    },
    offWarning: () =>
      translate('The daily hand-out stops too: tasks already handed out stay with their assignee until the module is back on.'),
  },
  /**
   * Not nested under Payroll: finance gets hours, never pay, so the
   * statement must work with the payroll module off.
   */
  {
    key: 'hoursStatement',
    title: 'Hours statement',
    what: 'Pay periods with a cutoff day; the hours of hourly staff emailed to finance and shown to the finance role.',
    hides: [
      'The Hours statement page, for the owner and finance',
      'Settings › Hours statement',
    ],
    holds: () => null,
    offWarning: () =>
      translate('While it is off no period is frozen or emailed; statements already frozen stay saved. Turned back on, the periods that ended meanwhile are frozen and emailed at the next hourly run.'),
  },
];

const TITLE = Object.fromEntries(MODULES.map((m) => [m.key, m.title])) as Record<
  FeatureKey,
  string
>;

/** the modules that sit inside `key` */
const childrenOf = (key: FeatureKey) =>
  MODULES.filter((m) => FEATURE_PARENT[m.key] === key);

export function ModulesTab() {
  const t = useT();
  const view = useApi((signal) => getFeatureSettings(signal), []);
  const { setFeatures } = useFeatures();
  const { refresh } = useAuth();

  const [asking, setAsking] = useState<{
    module: ModuleInfo;
    on: boolean;
  } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { busy, error, run, reset } = useMutation();

  if (view.loading && !view.data) return <Loading />;
  if (view.error && !view.data) {
    return <ErrorBox error={view.error} retry={view.reload} />;
  }
  if (!view.data) return null;

  const { features, effective, usage } = view.data;

  const apply = (module: ModuleInfo, on: boolean) =>
    run(async () => {
      const next = await saveFeatures({ [module.key]: on });
      view.reload();
      // the sidebar and routes follow at once — no reload needed
      setFeatures(next.effective);
      // the Screenshots entry also reads `canSeeScreenshots` from `/auth/me`
      if (module.key === 'screenshots') await refresh();
      setAsking(null);
      setSaved(
        on
          ? t('{{module}} is back on.', { module: t(module.title) })
          : t('{{module}} is off. Nothing was deleted.', { module: t(module.title) }),
      );
    });

  const toggle = (module: ModuleInfo) => {
    const on = !features[module.key];
    setSaved(null);
    reset();
    // switching off always asks; switching on only when something follows
    if (!on || module.onWarning?.(usage)) setAsking({ module, on });
    else apply(module, on);
  };

  const card = (module: ModuleInfo) => (
    <ModuleCard
      module={module}
      switches={features}
      effective={effective}
      holds={module.holds(usage)}
      busy={busy}
      onToggle={() => toggle(module)}
    />
  );

  // the children that go off with the module being switched off
  const goingWith = asking
    ? childrenOf(asking.module.key).filter((child) => effective[child.key])
    : [];

  return (
    <div className="space-y-4">
      <Notice>
        {t('Modules switch whole parts of the product on or off. Settings inside a module are on that module’s own page — who sees screenshots and how long they are kept is under Settings › Privacy. Turning a module off deletes nothing; turning it back on brings everything back as it was.')}
      </Notice>

      {saved && (
        <p role="status" className="text-xs text-ink-2">
          {saved}
        </p>
      )}
      {!asking && <ServerError error={error} />}

      <div className="grid gap-3">
        {MODULES.filter((m) => !FEATURE_PARENT[m.key]).map((module) => {
          const kids = childrenOf(module.key);
          return (
            <div key={module.key} className="space-y-2">
              {card(module)}
              {kids.length > 0 && (
                // nested under the parent: it only works inside it
                <div className="ml-4 space-y-2 border-l-2 border-line pl-3 sm:ml-6 sm:pl-4">
                  {kids.map((child) => (
                    <div key={child.key}>{card(child)}</div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {asking && (
        <ConfirmDialog
          title={
            asking.on
              ? t('Turn {{module}} back on?', { module: t(asking.module.title).toLowerCase() })
              : t('Turn off {{module}}?', { module: t(asking.module.title).toLowerCase() })
          }
          intro={
            asking.on ? undefined : (
              <>
                {t('This hides:')}
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                  {asking.module.hides.map((line) => (
                    <li key={line}>{t(line)}</li>
                  ))}
                  {goingWith.map((child) => (
                    <li key={child.key}>
                      {t('{{child}} — it needs {{parent}}', {
                        child: t(child.title),
                        parent: t(asking.module.title),
                      })}
                    </li>
                  ))}
                </ul>
              </>
            )
          }
          warning={
            (asking.on
              ? asking.module.onWarning?.(usage)
              : asking.module.offWarning?.(usage)) ?? undefined
          }
          extra={
            asking.on ? undefined : (
              <Notice>
                {t('Nothing is deleted.')}
                {goingWith.length > 0 &&
                  ` ${t('{{modules}} keeps its own switch and comes back with {{parent}}.', {
                    modules: new Intl.ListFormat(currentLanguage(), { type: 'conjunction' }).format(
                      goingWith.map((c) => t(c.title)),
                    ),
                    parent: t(asking.module.title),
                  })}`}{' '}
                {t('You can turn it back on here at any time.')}
              </Notice>
            )
          }
          confirmLabel={asking.on ? t('Turn on') : t('Turn off')}
          tone="primary"
          busy={busy}
          error={error}
          onConfirm={() => apply(asking.module, asking.on)}
          onClose={() => {
            setAsking(null);
            reset();
          }}
        />
      )}
    </div>
  );
}

function ModuleCard({
  module,
  switches,
  effective,
  holds,
  busy,
  onToggle,
}: {
  module: ModuleInfo;
  /** the owner's switches, as saved */
  switches: Features;
  /** what is actually on */
  effective: Features;
  holds: string | null;
  busy: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const labelId = `module-${module.key}`;
  const saved = switches[module.key];
  const on = effective[module.key];
  const parent = FEATURE_PARENT[module.key];
  /**
   * The parent is off, so this one is off whatever its own switch says. The
   * switch is shown as saved but locked: changing it would change nothing
   * now, and it is what comes back when the parent is turned on.
   */
  const blocked = parent !== undefined && !effective[parent];
  const parentTitle = parent ? t(TITLE[parent]) : '';

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={labelId} className="text-[14px] font-semibold tracking-tight">
              {t(module.title)}
            </h3>
            {blocked ? (
              <Chip>{t('Needs {{parent}}', { parent: parentTitle })}</Chip>
            ) : (
              <Chip tone={on ? 'counted' : 'muted'}>{on ? t('On') : t('Off')}</Chip>
            )}
          </div>
          <p className="text-[13px] text-ink-2">{t(module.what)}</p>
          {blocked ? (
            <Detail label={t('Unavailable')}>
              {saved
                ? t('Off while {{parent}} is off. Its own switch is kept (on) and applies again when {{parent}} is back on.', { parent: parentTitle })
                : t('Off while {{parent}} is off. Its own switch is kept (off) and applies again when {{parent}} is back on.', { parent: parentTitle })}
            </Detail>
          ) : (
            <Detail label={on ? t('Turning it off hides') : t('Hidden now')}>
              {module.hides.map((line) => t(line)).join(' · ')}
            </Detail>
          )}
          {holds && <Detail label={t('Stored')}>{holds}</Detail>}
        </div>

        <Switch
          on={saved}
          disabled={busy || blocked}
          labelledBy={labelId}
          onClick={onToggle}
        />
      </div>
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-xs text-ink-3">
      <span className="text-ink-2">{label}:</span> {children}
    </p>
  );
}

function Switch({
  on,
  disabled,
  labelledBy,
  onClick,
}: {
  on: boolean;
  disabled: boolean;
  labelledBy: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={onClick}
      className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 ${
        on ? 'border-brand bg-brand' : 'border-line bg-paper'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-4.5 w-4.5 rounded-full bg-surface shadow transition-transform ${
          on ? 'translate-x-5.5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
