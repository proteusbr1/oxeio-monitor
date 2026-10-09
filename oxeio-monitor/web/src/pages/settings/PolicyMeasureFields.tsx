import { FullWidth, SelectField, TextField } from '../../components/ui';
import { useT } from '../../i18n';

/**
 * What counts as worked time on this policy. "Presence" suits people paid by
 * the hour or held to a schedule: reading, a call or a short pause still
 * counts; a pause longer than the limit does not.
 */
export function PolicyMeasureFields({
  measure,
  gapMin,
  onMeasure,
  onGapMin,
}: {
  measure: 'active' | 'presence';
  gapMin: string;
  onMeasure: (value: 'active' | 'presence') => void;
  onGapMin: (value: string) => void;
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
      {measure === 'presence' ? (
        <TextField
          label={t('Longest pause that still counts (minutes)')}
          type="number"
          value={gapMin}
          onChange={onGapMin}
          mono
          min={1}
          max={120}
          hint={t(
            'A pause up to this long (reading, a call, a coffee) counts as work; a longer one does not.',
          )}
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
