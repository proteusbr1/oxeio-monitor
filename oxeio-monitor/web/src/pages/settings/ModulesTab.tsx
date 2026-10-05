import { useState, type ReactNode } from 'react';

import {
  getFeatureSettings,
  saveFeatures,
  type FeatureKey,
  type FeatureUsage,
} from '../../api/features';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { useFeatures } from '../../features/FeaturesContext';
import { Chip, ConfirmDialog, Notice, ServerError, useMutation } from './ui';

/**
 * Settings → Modules: switch off the parts of the dashboard a company does
 * not use. Off hides the screens and the server blocks the endpoints; no
 * table is dropped, so switching back on brings everything back as it was.
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

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const MODULES: ModuleInfo[] = [
  {
    key: 'payroll',
    title: 'Payroll',
    what: 'Monthly pay sheet worked out from salaries, hours and leave.',
    hides: [
      'The Pay sheet and Salaries tabs of Payroll (the page becomes “Leave & months”)',
      'The salary column and field in Staff',
    ],
    holds: (u) =>
      u.salariedStaff > 0
        ? `${plural(u.salariedStaff, 'person has', 'people have')} a salary set — it stays saved`
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
        ? `${plural(u.depositMonths, 'monthly instalment', 'monthly instalments')} on record — they stay saved`
        : null,
    offWarning: (u) =>
      u.depositMonths > 0
        ? 'While deposits are off, the payroll sheet holds nothing back — net pay equals payable. The instalments already on record are kept.'
        : null,
    onWarning: (u) =>
      u.depositMonths > 0
        ? 'Months that are still open get their instalment the next time the deposits ledger is opened, including months that passed while this was off. Close finished months first (Payroll → Close month) if they should stay as they are.'
        : null,
  },
  {
    key: 'designTargets',
    title: 'Design targets',
    what: 'A pool of design jobs handed out to designers each day, with review and progress.',
    hides: [
      'Add target design, Design Pool and Review',
      'The design panels on the Live Board and in the daily summary',
      'Each designer’s target list on My data',
      'The daily design target field in Staff',
    ],
    holds: (u) => {
      const parts = [
        u.designTargets > 0
          ? plural(u.designTargets, 'design target', 'design targets')
          : null,
        u.designers > 0 ? plural(u.designers, 'designer', 'designers') : null,
      ].filter(Boolean);
      return parts.length > 0
        ? `${parts.join(' · ')} on record — nothing is deleted`
        : null;
    },
    offWarning: () =>
      'The daily hand-out stops too: jobs already handed out stay with their designer until the module is back on.',
  },
  {
    key: 'staffScreenshots',
    title: 'Screenshots for staff',
    what: 'Staff and researcher logins can open the pictures taken of their own screen.',
    hides: [
      'Screenshots in the menu of staff and researcher logins',
      'The “see yours” link on their My data',
    ],
    holds: (u) =>
      u.staffLogins > 0
        ? `${plural(u.staffLogins, 'staff login is', 'staff logins are')} affected — you and managers still see every picture`
        : null,
    offWarning: () =>
      'Pictures are still taken and kept, and you and managers see them as before — only staff stop seeing their own. My data still tells them that screenshots are taken and for how long.',
  },
];

export function ModulesTab() {
  const view = useApi((signal) => getFeatureSettings(signal), []);
  const { setFeatures } = useFeatures();

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

  const { features, usage } = view.data;

  const apply = (module: ModuleInfo, on: boolean) =>
    run(async () => {
      const next = await saveFeatures({ [module.key]: on });
      view.reload();
      // the sidebar and routes follow at once — no reload needed
      setFeatures(next.features);
      setAsking(null);
      setSaved(
        on
          ? `${module.title} is back on — it is in the menu again.`
          : `${module.title} is off — it is gone from the menu. Nothing was deleted.`,
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

  return (
    <div className="space-y-4">
      <Notice>
        Turn off the parts your company does not use. Off only hides them —
        nothing is deleted, and turning a module back on brings everything back
        exactly as it was.
      </Notice>

      {saved && (
        <p role="status" className="text-xs text-ink-2">
          {saved}
        </p>
      )}
      {!asking && <ServerError error={error} />}

      <div className="grid gap-3">
        {MODULES.map((module) => (
          <ModuleCard
            key={module.key}
            module={module}
            on={features[module.key]}
            holds={module.holds(usage)}
            busy={busy}
            onToggle={() => toggle(module)}
          />
        ))}
      </div>

      {asking && (
        <ConfirmDialog
          title={
            asking.on
              ? `Turn ${asking.module.title.toLowerCase()} back on?`
              : `Turn off ${asking.module.title.toLowerCase()}?`
          }
          intro={
            asking.on ? undefined : (
              <>
                This hides:
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                  {asking.module.hides.map((line) => (
                    <li key={line}>{line}</li>
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
                Nothing is deleted. You can turn it back on here at any time.
              </Notice>
            )
          }
          confirmLabel={asking.on ? 'Turn on' : 'Turn off'}
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
  on,
  holds,
  busy,
  onToggle,
}: {
  module: ModuleInfo;
  on: boolean;
  holds: string | null;
  busy: boolean;
  onToggle: () => void;
}) {
  const labelId = `module-${module.key}`;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={labelId} className="text-[14px] font-semibold tracking-tight">
              {module.title}
            </h3>
            <Chip tone={on ? 'counted' : 'muted'}>{on ? 'On' : 'Off'}</Chip>
          </div>
          <p className="text-[13px] text-ink-2">{module.what}</p>
          <Detail label={on ? 'Turning it off hides' : 'Hidden now'}>
            {module.hides.join(' · ')}
          </Detail>
          {holds && <Detail label="Stored">{holds}</Detail>}
        </div>

        <Switch
          on={on}
          disabled={busy}
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
