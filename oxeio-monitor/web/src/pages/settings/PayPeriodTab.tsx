import { useEffect, useState } from 'react';

import {
  getPayPeriodSettings,
  savePayPeriodSettings,
} from '../../api/hoursStatement';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import {
  FormGrid,
  MiniButton,
  Notice,
  SelectField,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';
import { periodLabel } from '../hours/hours.format';

/** 1–28 — a cutoff on the 29th–31st would not exist in every month; those pick "End of month" */
const DAYS = Array.from({ length: 28 }, (_, i) => String(i + 1));

/**
 * Settings → Hours statement: the pay period's cutoff day and when the
 * statement is emailed. Owner only, while the module is on.
 *
 * Changing the cutoff never skips or repeats a day: the period running now
 * simply ends on the new cutoff (the server re-anchors it).
 */
export function PayPeriodTab() {
  const t = useT();
  const view = useApi(getPayPeriodSettings, []);
  const save = useMutation();
  const [cutoff, setCutoff] = useState('end');
  const [sendTime, setSendTime] = useState('07:00');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!view.data) return;
    setCutoff(String(view.data.cutoffDay));
    setSendTime(view.data.sendTime);
  }, [view.data]);

  if (view.loading && !view.data) return <Loading />;
  if (view.error && !view.data)
    return <ErrorBox error={view.error} retry={view.reload} />;
  if (!view.data) return null;

  const current = view.data;
  const changed =
    cutoff !== String(current.cutoffDay) || sendTime !== current.sendTime;

  const submit = () =>
    save.run(async () => {
      await savePayPeriodSettings({
        cutoffDay: cutoff === 'end' ? 'end' : Number(cutoff),
        sendTime,
      });
      setSaved(true);
      view.reload();
    });

  return (
    <Card
      title={t('Pay period')}
      hint={t('Pay period cutoff and when the statement is sent')}
    >
      <div className="space-y-4">
        <FormGrid>
          <SelectField
            label={t('Cutoff day')}
            value={cutoff}
            onChange={(v) => {
              setCutoff(v);
              setSaved(false);
            }}
            options={[
              { value: 'end', label: t('End of month') },
              ...DAYS.map((d) => ({ value: d, label: d })),
            ]}
            hint={t(
              'The last day of each period. With 25, a period runs from the 26th to the 25th of the next month.',
            )}
          />
          <TextField
            label={t('Send at')}
            type="time"
            value={sendTime}
            onChange={(v) => {
              setSendTime(v);
              setSaved(false);
            }}
            mono
          />
        </FormGrid>
        <Notice>
          {t(
            'The statement for each period is emailed the day after the cutoff at this time, to every finance login and the addresses in Settings → Notifications.',
          )}
        </Notice>
        <p className="text-[13px] text-ink-2">
          {current.open
            ? t('Current period: {{range}}', {
                range: periodLabel(current.open.start, current.open.end),
              })
            : t(
                'No period is open yet — the first one starts within the hour.',
              )}
        </p>
        <ServerError error={save.error} />
        <div className="flex items-center justify-end gap-3">
          {saved && !changed && (
            <span role="status" className="text-xs text-ink-2">
              {t('Saved')}
            </span>
          )}
          <MiniButton disabled={!changed || save.busy} onClick={submit}>
            {save.busy ? t('Saving…') : t('Save')}
          </MiniButton>
        </div>
      </div>
    </Card>
  );
}
