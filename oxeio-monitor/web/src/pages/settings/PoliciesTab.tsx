import { useState } from 'react';
import { Trans } from 'react-i18next';

import { createWorkPolicy, deactivateWorkPolicy, listWorkPolicies, reactivateWorkPolicy, updateWorkPolicy, type TargetBasis, type WorkPolicyBody, type WorkPolicyView } from '../../api/calendar';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { useFeatures } from '../../features/FeaturesContext';
import { Card } from '../../components/Card';
import { Button } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Table, type Column } from '../../components/Table';
import {
  formatDuration,
  formatHours,
  formatMonth,
  todayInWorkZone,
} from '../../lib/format';
import { useT } from '../../i18n';
import { HolidaysSection } from './HolidaysSection';
import { measureBody, targetPreview } from './policy.math';
import { PolicyMeasureFields } from './PolicyMeasureFields';
import { PolicyScheduleFields, type ScheduleFormState } from './PolicyScheduleFields';
import {
  CheckboxField,
  Chip,
  ConfirmDialog,
  FormGrid,
  FullWidth,
  MiniButton,
  Modal,
  Notice,
  RowActions,
  ServerError,
  TextField,
  useMutation,
  SelectField,
} from '../../components/ui';

/**
 * Work policy and holidays, together, because they answer the same question:
 * **how much work is expected this month?**
 *
 * Careful: changing a number here changes **every PC's behaviour** at the next
 * config sync (idle threshold, screenshot window, slots). And changing a target or a
 * holiday moves someone ahead or behind without them working a minute.
 */

/** ISO days, Monday first — the order the checkboxes are shown in */
const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7];

const OFF_DAY_LABEL: Record<number, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

/**
 * Careful: managers get **only the holidays part**. `work_policies` stays owner-only
 * on the server: changing the monthly target or screenshot window changes every
 * PC's behaviour. Without hiding the section above, a manager would open the tab
 * and see a 403 box, and think something was broken.
 */
export function PoliciesTab() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      {user?.role === 'owner' && <WorkPoliciesSection />}
      <HolidaysSection />
    </div>
  );
}

function WorkPoliciesSection() {
  const t = useT();
  const policies = useApi((signal) => listWorkPolicies(signal), []);

  const [editing, setEditing] = useState<WorkPolicyView | null>(null);
  const [creating, setCreating] = useState(false);
  const [closing, setClosing] = useState<WorkPolicyView | null>(null);
  const [reopening, setReopening] = useState<WorkPolicyView | null>(null);

  const rows = policies.data?.rows ?? [];
  // Screenshots switched off in Settings → Modules: the window means nothing,
  // so it is not shown (the saved values stay on the policy)
  const { features } = useFeatures();
  const withShots = features.screenshots;

  const columns: Column<WorkPolicyView>[] = [
    {
      key: 'name',
      header: t('Name'),
      render: (policy) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{policy.name}</div>
          <div className="num truncate text-[11px] text-ink-3">
            {policy.timezone}
          </div>
          <div className="truncate text-[11px] text-ink-3">
            {policy.hoursMeasure === 'presence'
              ? t('Presence (pauses up to {{n}} min count)', { n: policy.presenceGapMin })
              : t('Active time')}
          </div>
        </div>
      ),
    },
    {
      key: 'target',
      header: t('Target'),
      align: 'right',
      render: (policy) => <TargetCell policy={policy} />,
    },
    {
      key: 'off',
      header: t('Weekly off'),
      render: (policy) =>
        policy.weeklyOffDays.length === 0 ? (
          <span className="text-ink-3">{t('None')}</span>
        ) : (
          policy.weeklyOffDays.map((d) => (OFF_DAY_LABEL[d] ? t(OFF_DAY_LABEL[d]) : String(d))).join(' + ')
        ),
    },
    {
      key: 'office',
      header: t('Office hours'),
      render: (policy) =>
        policy.officeFrom && policy.officeTo ? (
          <span className="num">
            {policy.officeFrom}–{policy.officeTo}
          </span>
        ) : (
          // Careful: "all day" means the alert is never quiet; that is not hiding anything
          <span className="text-ink-3">{t('all day')}</span>
        ),
    },
    ...(withShots
      ? [
          {
            key: 'window',
            header: t('Screenshot window'),
            render: (policy: WorkPolicyView) =>
              // `false` only — an older server without the field means on
              policy.screenshotsEnabled === false ? (
                <span className="text-ink-3">{t('off')}</span>
              ) : (
                policy.screenshotFrom === null || policy.screenshotTo === null ? (
                  <span className="text-ink-3">{t('whenever in use')}</span>
                ) : (
                  <span className="num">
                    {policy.screenshotFrom}–{policy.screenshotTo}
                  </span>
                )
              ),
          },
        ]
      : []),
    {
      key: 'idle',
      header: t('Idle threshold'),
      align: 'right',
      render: (policy) => (
        <span className="num">{formatDuration(policy.idleThresholdSec)}</span>
      ),
    },
    {
      key: 'slot',
      header: t('Slot'),
      align: 'right',
      render: (policy) => (
        <span className="num">
          {policy.slotMinutes}
          <small className="ml-1 text-[11px] text-ink-3">min</small>
        </span>
      ),
    },
    {
      key: 'people',
      header: t('Staff'),
      align: 'right',
      render: (policy) => <span className="num">{policy.employeeCount}</span>,
    },
    {
      key: 'status',
      header: t('Status'),
      render: (policy) =>
        policy.isActive ? (
          <Chip tone="counted">{t('Open', { context: 'policy' })}</Chip>
        ) : (
          <Chip>{t('Closed', { context: 'policy' })}</Chip>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (policy) => (
        <RowActions>
          <MiniButton onClick={() => setEditing(policy)}>{t('Edit')}</MiniButton>
          {policy.isActive ? (
            <MiniButton
              tone="danger"
              onClick={() => setClosing(policy)}
              title={
                policy.employeeCount > 0
                  ? t('Move the people on this policy to another one first')
                  : undefined
              }
            >
              {t('Close', { context: 'policy' })}
            </MiniButton>
          ) : (
            /**
             * **The way back is here.** This branch used to be empty: a closed
             * policy's row had only "Edit", and the Edit form never sends `isActive`.
             * So if someone pressed Close by mistake there was no way back from the
             * web, though the server had the endpoint all along.
             *
             * Careful: not `danger`; opening is the safe direction.
             */
            <MiniButton onClick={() => setReopening(policy)}>{t('Reopen')}</MiniButton>
          )}
        </RowActions>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">
            {t('Work policies')}
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            {withShots
              ? t("Hours target, screenshot window and idle threshold — everything about a person's day comes from here")
              : t("Hours target and idle threshold — everything about a person's day comes from here")}
          </p>
        </div>
        <Button tone="primary" onClick={() => setCreating(true)}>
          {t('New policy')}
        </Button>
      </div>

      {/*
        Thin grey, not red: this is not an error, it is a condition. Solid red is kept
           for real danger (see the confirmation boxes).
      */}
      <Notice>
        {withShots ? (
          <Trans
            i18nKey="Change a number here and the next config sync changes <b>how every PC behaves</b> — when idle starts counting, when screenshots are taken. Change the monthly target and everyone's progress percentage moves with it."
            components={{ b: <strong /> }}
          />
        ) : (
          <Trans
            i18nKey="Change a number here and the next config sync changes <b>how every PC behaves</b> — when idle starts counting. Change the monthly target and everyone's progress percentage moves with it."
            components={{ b: <strong /> }}
          />
        )}
      </Notice>

      {policies.loading && !policies.data && <Loading />}
      {policies.error && (
        <ErrorBox error={policies.error} retry={policies.reload} />
      )}

      {!policies.loading && !policies.error && rows.length === 0 && (
        <Empty
          title={t('No work policy yet')}
          hint={t('At least one policy is needed — without it nobody has a monthly target and the progress ring never fills. Create one with the default 176 hours.')}
          action={
            <Button tone="primary" onClick={() => setCreating(true)}>
              {t('New policy')}
            </Button>
          }
        />
      )}

      {rows.length > 0 && (
        <Card padded={false}>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(policy) => String(policy.id)}
            rowMuted={(policy) => !policy.isActive}
          />
        </Card>
      )}

      {(creating || editing) && (
        <PolicyForm
          key={editing?.id ?? 'new'}
          policy={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            policies.reload();
          }}
        />
      )}

      {reopening && (
        <ReopenPolicyDialog
          policy={reopening}
          onClose={() => setReopening(null)}
          onDone={() => {
            setReopening(null);
            void policies.reload();
          }}
        />
      )}

      {closing && (
        <ClosePolicyDialog
          policy={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            policies.reload();
          }}
        />
      )}
    </section>
  );
}

// ── Policy form ─────────────────────────────────────────────────────────────

interface PolicyFormState {
  name: string;
  monthlyTargetHours: string;
  expectedWorkdays: string;
  screenshotFrom: string;
  screenshotTo: string;
  officeFrom: string;
  officeTo: string;
  idleThresholdSec: string;
  slotMinutes: string;
  weeklyTargetHours: string;
  dailyTargetHours: string;
  breakMinutes: string;
  overtimeMultiplier: string;
}

const BASIS_OPTIONS: { value: TargetBasis; label: string }[] = [
  { value: 'month', label: 'Hours per month' },
  { value: 'week', label: 'Hours per week' },
  { value: 'day', label: 'Hours per day (fixed schedule)' },
  { value: 'none', label: 'No target — record hours only' },
];

/** minutes between two 'HH:MM' times (0 if not a forward range) */
function minutesBetween(from: string, to: string): number {
  const m = (t: string) => {
    const [h, mm] = t.split(':').map(Number);
    return h * 60 + mm;
  };
  if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return 0;
  return Math.max(0, m(to) - m(from));
}

function PolicyForm({
  policy,
  onClose,
  onSaved,
}: {
  policy: WorkPolicyView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PolicyFormState>({
    name: policy?.name ?? '',
    monthlyTargetHours: String(policy?.monthlyTargetHours ?? 176),
    expectedWorkdays: String(policy?.expectedWorkdays ?? 22),
    screenshotFrom: policy?.screenshotFrom ?? '07:00',
    screenshotTo: policy?.screenshotTo ?? '23:00',
    // Careful: when empty, 9-6 is shown and that is what gets saved. Deliberate:
    //    saving with the field blank would make the server reject '', and the owner
    //    would not understand why nothing happened.
    officeFrom: policy?.officeFrom ?? '09:00',
    officeTo: policy?.officeTo ?? '18:00',
    idleThresholdSec: String(policy?.idleThresholdSec ?? 300),
    slotMinutes: String(policy?.slotMinutes ?? 10),
    weeklyTargetHours: policy?.weeklyTargetHours === null || policy?.weeklyTargetHours === undefined ? '40' : String(policy.weeklyTargetHours),
    dailyTargetHours: policy?.dailyTargetHours === null || policy?.dailyTargetHours === undefined ? '8' : String(policy.dailyTargetHours),
    breakMinutes: policy?.breakMinutes === null || policy?.breakMinutes === undefined ? '60' : String(policy.breakMinutes),
    overtimeMultiplier: policy?.overtimeMultiplier === null || policy?.overtimeMultiplier === undefined ? '' : String(policy.overtimeMultiplier),
  });
  const [basis, setBasis] = useState<TargetBasis>(policy?.targetBasis ?? 'month');
  const [deductShortfall, setDeductShortfall] = useState(policy?.deductShortfall !== false);
  const [measure, setMeasure] = useState<'active' | 'presence'>(policy?.hoursMeasure ?? 'active');
  const [gapMin, setGapMin] = useState(String(policy?.presenceGapMin ?? 15));
  const [schedule, setSchedule] = useState<ScheduleFormState>({
    scheduleEnforced: policy?.scheduleEnforced === true,
    breakWindowFrom: policy?.breakWindowFrom ?? '',
    breakWindowTo: policy?.breakWindowTo ?? '',
    toleranceMarkMin: String(policy?.toleranceMarkMin ?? 0),
    toleranceDayMin: String(policy?.toleranceDayMin ?? 0),
  });
  const { features } = useFeatures();
  const t = useT();

  // a boolean, so kept apart from the all-string form state above
  // no window = whenever the computer is in use (the default for a new policy)
  const [anyTime, setAnyTime] = useState(
    policy ? policy.screenshotFrom === null || policy.screenshotTo === null : true,
  );
  const [screenshotsEnabled, setScreenshotsEnabled] = useState(
    policy?.screenshotsEnabled !== false,
  );

  // a list, so kept apart from the all-string form state above
  // a new policy starts on Sat + Sun off, matching the default 176 h / 22 days
  const [offDays, setOffDays] = useState<number[]>(policy?.weeklyOffDays ?? [6, 7]);
  const toggleOffDay = (day: number) => (on: boolean) =>
    setOffDays((prev) =>
      on ? [...prev, day].sort((a, b) => a - b) : prev.filter((d) => d !== day),
    );

  const thisMonth = todayInWorkZone().slice(0, 7);
  const preview = targetPreview({
    yearMonth: thisMonth,
    monthlyTargetHours: Number(form.monthlyTargetHours),
    expectedWorkdays: Number(form.expectedWorkdays),
    offDays,
  });

  const { busy, error, run } = useMutation();
  const set = (key: keyof PolicyFormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = (): void => {
    run(async () => {
      const body: WorkPolicyBody = {
        targetBasis: basis,
        weeklyTargetHours: basis === 'week' ? Number(form.weeklyTargetHours) : undefined,
        dailyTargetHours: basis === 'day' ? Number(form.dailyTargetHours) : undefined,
        breakMinutes:
          (basis === 'day' || schedule.scheduleEnforced) && form.breakMinutes !== ''
            ? Number(form.breakMinutes)
            : undefined,
        overtimeMultiplier: form.overtimeMultiplier.trim() === '' ? null : Number(form.overtimeMultiplier),
        deductShortfall,
        monthlyTargetHours: Number(form.monthlyTargetHours),
        expectedWorkdays: Number(form.expectedWorkdays),
        // ⚠️ always sent, even empty: `[]` = "no weekly day off". Leaving it
        //    out would let the server keep the old days, and they could
        //    never be cleared
        weeklyOffDays: offDays,
        screenshotFrom: anyTime ? null : form.screenshotFrom,
        screenshotTo: anyTime ? null : form.screenshotTo,
        screenshotsEnabled,
        officeFrom: form.officeFrom,
        officeTo: form.officeTo,
        idleThresholdSec: Number(form.idleThresholdSec),
        slotMinutes: Number(form.slotMinutes),
        ...measureBody(measure, gapMin, policy?.presenceGapMin, schedule.scheduleEnforced),
        scheduleEnforced: schedule.scheduleEnforced,
        breakWindowFrom: schedule.breakWindowFrom || null,
        breakWindowTo: schedule.breakWindowTo || null,
        toleranceMarkMin: Number(schedule.toleranceMarkMin),
        toleranceDayMin: Number(schedule.toleranceDayMin),
      };

      if (policy) {
        await updateWorkPolicy(policy.id, { ...body, name: form.name.trim() });
      } else {
        await createWorkPolicy({ ...body, name: form.name.trim() });
      }
      onSaved();
    });
  };

  return (
    <Modal
      title={policy ? t('{{name}} — Edit', { name: policy.name }) : t('New Work Policy')}
      hint={
        policy && policy.employeeCount > 0
          ? t('{{count}} people are on this policy', { count: policy.employeeCount })
          : undefined
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            tone="primary"
            onClick={submit}
            disabled={busy || form.name.trim() === ''}
          >
            {busy ? t('Saving…') : t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormGrid>
          <FullWidth>
            <TextField
              label={t('Name')}
              value={form.name}
              onChange={set('name')}
              required
              autoFocus
              maxLength={120}
              placeholder={t('General staff')}
            />
          </FullWidth>

          <FullWidth>
            <SelectField
              label={t('Hours target')}
              value={basis}
              onChange={(v) => setBasis(v as TargetBasis)}
              options={BASIS_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            />
          </FullWidth>

          {basis === 'month' && (
            <>
          <TextField
            label={t('Monthly target (hours)')}
            type="number"
            value={form.monthlyTargetHours}
            onChange={set('monthlyTargetHours')}
            mono
            min={1}
            max={744}
            step="0.01"
            hint={t('The only target that is stored. The daily target is derived from this — monthly target ÷ workdays. Default 176.')}
          />
          <TextField
            label={t('Expected workdays')}
            type="number"
            value={form.expectedWorkdays}
            onChange={set('expectedWorkdays')}
            mono
            min={1}
            max={31}
            hint={t('How many days of work the month is assumed to hold — used for pace, and it divides the daily target')}
          />
            </>
          )}

          {basis === 'week' && (
            <FullWidth>
              <TextField
                label={t('Hours per week')}
                type="number"
                value={form.weeklyTargetHours}
                onChange={set('weeklyTargetHours')}
                mono
                min={1}
                max={168}
                step="0.5"
                hint={t("Spread over the {{count}} working days of the week → {{hours}} h a day. The month's target is its workdays × that.", {
                  count: Math.max(1, 7 - offDays.length),
                  hours: formatHours((Number(form.weeklyTargetHours) / Math.max(1, 7 - offDays.length)) * 3600),
                })}
              />
            </FullWidth>
          )}

          {basis === 'day' && (
            <>
              <TextField
                label={t('Hours per day')}
                type="number"
                value={form.dailyTargetHours}
                onChange={set('dailyTargetHours')}
                mono
                min={0.5}
                max={24}
                step="0.25"
              />
              {/* with the schedule on, the break field is the one in PolicyScheduleFields */}
              {!schedule.scheduleEnforced && (
                <TextField
                  label={t('Break (minutes)')}
                  type="number"
                  value={form.breakMinutes}
                  onChange={set('breakMinutes')}
                  mono
                  min={0}
                  max={480}
                />
              )}
              <FullWidth>
                {(() => {
                  const span = minutesBetween(form.officeFrom, form.officeTo) - Number(form.breakMinutes || 0);
                  const fromSchedule = Math.max(0, span) / 60;
                  return (
                    <p className="text-[11.5px] leading-relaxed text-ink-3">
                      {Number(form.breakMinutes) > 0
                        ? t('The schedule is the working hours below ({{range}}, minus a {{minutes}}-minute break)', {
                            range: `${form.officeFrom}–${form.officeTo}`,
                            minutes: form.breakMinutes,
                          })
                        : t('The schedule is the working hours below ({{range}})', {
                            range: `${form.officeFrom}–${form.officeTo}`,
                          })}
                      {fromSchedule > 0 && fromSchedule !== Number(form.dailyTargetHours) && (
                        <>
                          {' '}= {formatHours(fromSchedule * 3600)} h.{' '}
                          <MiniButton onClick={() => set('dailyTargetHours')(String(Math.round(fromSchedule * 100) / 100))}>
                            {t('Use {{hours}} h', { hours: formatHours(fromSchedule * 3600) })}
                          </MiniButton>
                        </>
                      )}
                      {fromSchedule > 0 && fromSchedule === Number(form.dailyTargetHours) && ` ${t('— matches the hours per day.')}`}
                    </p>
                  );
                })()}
              </FullWidth>
            </>
          )}

          {basis === 'none' && (
            <FullWidth>
              <Notice>
                {t('Hours are recorded and shown as usual, but nobody is ahead or behind and no missing hours are counted — for freelancers, owners or anyone without a quota.')}
              </Notice>
            </FullWidth>
          )}

          <FullWidth>
            <fieldset>
            <legend className="mb-1 text-[12px] font-medium text-ink-2">{t('Weekly off')}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {ISO_DAYS.map((day) => (
                <CheckboxField
                  key={day}
                  label={t(OFF_DAY_LABEL[day])}
                  checked={offDays.includes(day)}
                  onChange={toggleOffDay(day)}
                  // the server keeps at least one workday a week
                  disabled={!offDays.includes(day) && offDays.length >= 6}
                />
              ))}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
              {t('None ticked = every day is a workday. This is not a block — hours worked on a day off still count in full.')}
              {offDays.length >= 6 && ` ${t('A week keeps at least one workday, so the last day cannot be ticked.')}`}
            </p>
            </fieldset>
          </FullWidth>

          {/* what these numbers come to in a real month — see policy.math.ts */}
          {basis === 'month' && preview && (
            <FullWidth>
              <p className="text-[11.5px] leading-relaxed text-ink-3">
                <Trans
                  i18nKey="{{month}}: {{count}} workdays with these days off (before holidays) → {{count}} × {{daily}} h = <b>{{total}} h</b>."
                  count={preview.workdays}
                  values={{
                    month: formatMonth(thisMonth),
                    daily: formatHours(preview.dailyHours * 3600),
                    total: formatHours(preview.monthHours * 3600),
                  }}
                  components={{ b: <b className="text-ink-2" /> }}
                />
              </p>
              {preview.mismatch && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-idle/40 px-2.5 py-1.5 text-[12px] text-idle-ink">
                  <span>
                    {t('Expected workdays is {{expected}}, but this month has {{workdays}} — the target would come to {{hours}} h, not {{target}} h.', {
                      expected: form.expectedWorkdays,
                      workdays: preview.workdays,
                      hours: formatHours(preview.monthHours * 3600),
                      target: form.monthlyTargetHours,
                    })}
                  </span>
                  <MiniButton onClick={() => set('expectedWorkdays')(String(preview.workdays))}>
                    {t('Use {{n}}', { n: preview.workdays })}
                  </MiniButton>
                </div>
              )}
            </FullWidth>
          )}
          <PolicyMeasureFields
            measure={measure}
            gapMin={gapMin}
            onMeasure={setMeasure}
            onGapMin={setGapMin}
            scheduleChecked={schedule.scheduleEnforced}
          />
          <TextField
            label={basis === 'day' ? t('Working hours from') : t('Office opens')}
            type="time"
            value={form.officeFrom}
            onChange={set('officeFrom')}
            mono
          />
          <TextField
            label={basis === 'day' ? t('Working hours until') : t('Office closes')}
            type="time"
            value={form.officeTo}
            onChange={set('officeTo')}
            mono
            hint={
              t('Outside these hours — and on the weekly off day and holidays — a quiet PC raises no alert. Hours worked outside them still count in full.') +
              (schedule.scheduleEnforced ? ` ${t('With the schedule check on, these are also the hours checked every workday.')}` : '')
            }
          />
          <PolicyScheduleFields
            state={schedule}
            onChange={setSchedule}
            breakMinutes={form.breakMinutes}
            onBreakMinutes={set('breakMinutes')}
          />

          <TextField
            label={t('Idle threshold')}
            type="number"
            value={form.idleThresholdSec}
            onChange={set('idleThresholdSec')}
            mono
            min={10}
            max={3600}
            hint={t('Seconds. Once the keyboard and mouse have been quiet this long, the time stops counting.')}
          />

          {/*
            Hidden while the Screenshots module is off — nothing is taken then,
            whatever the policy says. The saved values are still sent back
            unchanged, so turning the module on restores them.
          */}
          {features.screenshots && (
            <>
              <FullWidth>
                <CheckboxField
                  label={t('Take screenshots')}
                  checked={screenshotsEnabled}
                  onChange={setScreenshotsEnabled}
                  hint={t('Off: no screenshot is taken, stored or sent. Idle and jiggler detection keep working, so hours are counted the same way.')}
                />
              </FullWidth>

              <FullWidth>
                <SelectField
                  label={t('When to take screenshots')}
                  value={anyTime ? 'any' : 'window'}
                  onChange={(v) => setAnyTime(v === 'any')}
                  disabled={!screenshotsEnabled}
                  options={[
                    { value: 'any', label: t('Whenever the computer is in use') },
                    { value: 'window', label: t('Only between two times') },
                  ]}
                  hint={t('Only while someone is at the keyboard or mouse — never while the computer is idle, locked or asleep.')}
                />
              </FullWidth>
              {!anyTime && (
                <>
                  <TextField
                    label={t('Screenshots from')}
                    type="time"
                    value={form.screenshotFrom}
                    onChange={set('screenshotFrom')}
                    mono
                    // kept, not cleared: turning screenshots back on restores the window
                    disabled={!screenshotsEnabled}
                  />
                  <TextField
                    label={t('Screenshots until')}
                    type="time"
                    value={form.screenshotTo}
                    onChange={set('screenshotTo')}
                    mono
                    disabled={!screenshotsEnabled}
                    hint={
                      screenshotsEnabled
                        ? t('No screenshot is ever taken outside this window')
                        : t('Not used while screenshots are off — kept for when they are turned back on')
                    }
                  />
                </>
              )}
            </>
          )}

          <TextField
            label={t('Slot (minutes)')}
            type="number"
            value={form.slotMinutes}
            onChange={set('slotMinutes')}
            mono
            min={1}
            max={60}
            hint={t('How long each cell of the timeline is')}
          />

          {features.payroll && (
            <FullWidth>
              <fieldset className="space-y-2.5 rounded-md border border-line px-3 py-2.5">
                <legend className="px-1 text-[12px] font-medium text-ink-2">{t('Pay rules')}</legend>
                <TextField
                  label={t('Overtime pay (× the hourly rate)')}
                  type="number"
                  value={form.overtimeMultiplier}
                  onChange={set('overtimeMultiplier')}
                  mono
                  min={1}
                  max={5}
                  step="0.05"
                  placeholder={t('Not paid')}
                  hint={t("Hours above the month's target, paid at this multiple — e.g. 1.5. Empty: overtime is shown but not paid.")}
                />
                {basis !== 'none' && (
                  <CheckboxField
                    label={t('Deduct missing hours from monthly salaries')}
                    checked={deductShortfall}
                    onChange={setDeductShortfall}
                    hint={t('Off: the salary is paid in full and the missing hours are only reported. Hourly pay is never deducted — fewer hours are simply fewer hours.')}
                  />
                )}
              </fieldset>
            </FullWidth>
          )}
        </FormGrid>

        <ServerError error={error} />
      </div>
    </Modal>
  );
}

/**
 * Reopening a closed policy: the pair of `ClosePolicyDialog`.
 *
 * Careful: **no** `employeeCount` warning here, deliberately. Closing is where it is
 * the real obstacle (the server refuses if people are on it), but the only server
 * condition for opening is different: *"it is already open"* (409). Having
 * employees on a closed policy is legitimate, so the number here would only
 * frighten.
 */
function ReopenPolicyDialog({
  policy,
  onClose,
  onDone,
}: {
  policy: WorkPolicyView;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { busy, error, run } = useMutation();

  return (
    <ConfirmDialog
      title={t('Reopen "{{name}}"?', { name: policy.name })}
      intro={t('New staff can be put on this policy again. Nothing about past months changes.')}
      confirmLabel={t('Reopen')}
      tone="primary"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() =>
        run(async () => {
          await reactivateWorkPolicy(policy.id);
          onDone();
        })
      }
    />
  );
}

function ClosePolicyDialog({
  policy,
  onClose,
  onDone,
}: {
  policy: WorkPolicyView;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { busy, error, run } = useMutation();
  const occupied = policy.employeeCount > 0;

  return (
    <ConfirmDialog
      title={t('Close "{{name}}"?', { name: policy.name })}
      intro={t('The policy is not deleted, only closed — past months rest on it, so the record stays.')}
      warning={
        occupied
          ? t('{{count}} people are still on this policy. The server will refuse to close it — move them to another policy first.', { count: policy.employeeCount })
          : t('No new staff member can be put on this policy again.')
      }
      confirmLabel={t('Close', { context: 'policy' })}
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() =>
        run(async () => {
          await deactivateWorkPolicy(policy.id);
          onDone();
        })
      }
    />
  );
}

/** The hours target the way the policy states it */
function TargetCell({ policy }: { policy: WorkPolicyView }) {
  const t = useT();
  const unit = (n: number | null, per: string) => (
    <span className="num">
      {n ?? '—'}
      <small className="ml-1 text-[11px] text-ink-3">{per}</small>
    </span>
  );
  switch (policy.targetBasis) {
    case 'week':
      return unit(policy.weeklyTargetHours, t('h/week'));
    case 'day':
      return unit(policy.dailyTargetHours, t('h/day'));
    case 'none':
      return <span className="text-ink-3">{t('No target')}</span>;
    default:
      return (
        <span className="num" title={t('Spread over {{count}} workdays', { count: policy.expectedWorkdays })}>
          {policy.monthlyTargetHours}
          <small className="ml-1 text-[11px] text-ink-3">{t('h/month')}</small>
        </span>
      );
  }
}
