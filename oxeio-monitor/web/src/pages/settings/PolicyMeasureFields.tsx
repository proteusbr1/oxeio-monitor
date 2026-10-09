import { FullWidth, SelectField, TextField } from '../../components/ui';
import { useT } from '../../i18n';

/**
 * What counts as worked time on this policy. "Presence" suits people paid by
 * the hour or held to a schedule: reading, a call or a short pause still
 * counts; a pause longer than the limit does not.
 *
 * Careful: with the schedule checked the gap field shows under active time
 * too — the check reads presence blocks merged by the gap, and the required
 * break must be longer than it (the server refuses a shorter one).
 */
export function PolicyMeasureFields({
  measure,
  gapMin,
  onMeasure,
  onGapMin,
  scheduleChecked = false,
}: {
  measure: 'active' | 'presence';
  gapMin: string;
  onMeasure: (value: 'active' | 'presence') => void;
  onGapMin: (value: string) => void;
  scheduleChecked?: boolean;
}) {
  const t = useT();
  return (
    <>
      <SelectField
        label={t('What counts as worked time')}
        value={measure}
        onChange={(v) => onMeasure(v === 'presence' ? 'presence' : 'active')}
        options={[
          {
            value: 'active',
            label: t('Active time — keyboard and mouse in use'),
          },
          {
            value: 'presence',
            label: t('Presence — first to last use, minus long pauses'),
          },
        ]}
      />
      {measure === 'presence' || scheduleChecked ? (
        <TextField
          label={t('Longest pause that still counts (minutes)')}
          type="number"
          value={gapMin}
          onChange={onGapMin}
          mono
          min={1}
          max={120}
          hint={
            measure === 'presence'
              ? t(
                  'A pause up to this long (reading, a call, a coffee) counts as work; a longer one does not.',
                )
              : t(
                  'Hours still count active time only. For the schedule check, a pause up to this long is not a break, so the break must be longer.',
                )
          }
        />
      ) : (
        <FullWidth>
          <p className="text-[11.5px] leading-relaxed text-ink-3">
            {t(
              'Only time with the keyboard or mouse in use counts; it stops after the idle threshold below.',
            )}
          </p>
        </FullWidth>
      )}
    </>
  );
}
