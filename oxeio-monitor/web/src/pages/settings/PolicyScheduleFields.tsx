import { CheckboxField, FullWidth, TextField } from '../../components/ui';
import { useT } from '../../i18n';

export interface ScheduleFormState {
  scheduleEnforced: boolean;
  breakWindowFrom: string;
  breakWindowTo: string;
  toleranceMarkMin: string;
  toleranceDayMin: string;
}

/**
 * "Check this schedule": the working hours above become a schedule that is
 * checked every workday (arrival, leaving, the break). The break must start
 * inside the window; tolerances are minutes ignored at each end and per day.
 *
 * Careful: the "Break (minutes)" field is shown here, and only here, once the
 * schedule is on — the "Hours per day" basis shows it itself otherwise.
 */
export function PolicyScheduleFields({
  state,
  onChange,
  breakMinutes,
  onBreakMinutes,
}: {
  state: ScheduleFormState;
  onChange: (next: ScheduleFormState) => void;
  breakMinutes: string;
  onBreakMinutes: (value: string) => void;
}) {
  const t = useT();
  const set =
    <K extends keyof ScheduleFormState>(key: K) =>
    (value: ScheduleFormState[K]) =>
      onChange({ ...state, [key]: value });
  return (
    <>
      <FullWidth>
        <CheckboxField
          label={t(
            'Check this schedule every workday (arrival, leaving, break)',
          )}
          checked={state.scheduleEnforced}
          onChange={set('scheduleEnforced')}
        />
      </FullWidth>
      {state.scheduleEnforced && (
        <>
          <TextField
            label={t('Break (minutes)')}
            type="number"
            value={breakMinutes}
            onChange={onBreakMinutes}
            mono
            min={0}
            max={480}
          />
          <FullWidth>
            <p className="text-[11.5px] leading-relaxed text-ink-3">
              {t(
                'One continuous pause of at least this long must start inside the window below.',
              )}
            </p>
          </FullWidth>
          <TextField
            label={t('Break may start from')}
            type="time"
            value={state.breakWindowFrom}
            onChange={set('breakWindowFrom')}
            mono
          />
          <TextField
            label={t('Break may start until')}
            type="time"
            value={state.breakWindowTo}
            onChange={set('breakWindowTo')}
            mono
            hint={t(
              'Leave both empty to allow the break anywhere in the working day.',
            )}
          />
          <TextField
            label={t('Tolerance per clock mark (minutes)')}
            type="number"
            value={state.toleranceMarkMin}
            onChange={set('toleranceMarkMin')}
            mono
            min={0}
            max={60}
          />
          <TextField
            label={t('Tolerance per day (minutes)')}
            type="number"
            value={state.toleranceDayMin}
            onChange={set('toleranceDayMin')}
            mono
            min={0}
            max={60}
            hint={t(
              'Minutes off at arrival and at leaving are ignored up to the first number each, and up to the second number together.',
            )}
          />
        </>
      )}
    </>
  );
}
