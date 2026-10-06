import { useMemo, useState } from 'react';

import { getRegionSettings, saveRegionSettings, type SettingSource } from '../../api/settings';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { RestartNotice } from './RestartNotice';
import {
  timeZoneOptions,
  LOCALE_CHOICES,
  twoDecimalCurrencies,
  supportedValues,
} from './region.math';
import {
  ConfirmDialog,
  MiniButton,
  Notice,
  SelectField,
  ServerError,
  useMutation,
} from '../../components/ui';

const SOURCE_LABEL: Record<SettingSource, string> = {
  dashboard: 'set here',
  environment: "from the server's .env",
  default: 'built-in default',
};

/**
 * Settings → Region: time zone, currency and how dates and numbers are
 * written — what used to need the server's .env (WORK_TIMEZONE, CURRENCY,
 * DISPLAY_LOCALE). A value saved here wins; the .env stays the starting
 * value. Nothing on screen is translated either way.
 */
export function RegionTab() {
  const region = useApi(getRegionSettings, []);
  const save = useMutation();

  const zones = useMemo(() => timeZoneOptions(supportedValues('timeZone')), []);
  const currencies = useMemo(
    () => twoDecimalCurrencies(supportedValues('currency')),
    [],
  );

  const current = region.data;
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [locale, setLocale] = useState<string | null>(null);
  const [confirmZone, setConfirmZone] = useState(false);

  if (region.loading && !current) return <Loading />;
  if (region.error && !current)
    return <ErrorBox error={region.error} retry={region.reload} />;
  if (!current) return null;

  const tz = timeZone ?? current.timeZone.value;
  const cur = currency ?? current.currency.code;
  const loc = locale ?? current.displayLocale.value ?? '';
  const zoneChanged = tz !== current.timeZone.value;
  const changed =
    zoneChanged ||
    cur !== current.currency.code ||
    loc !== (current.displayLocale.value ?? '');

  const withCurrent = (
    options: { value: string; label: string }[],
    value: string,
  ) =>
    options.some((o) => o.value === value)
      ? options
      : [{ value, label: value }, ...options];

  const submit = (): void =>
    save.run(async () => {
      await saveRegionSettings({
        timeZone: tz,
        currency: cur,
        displayLocale: loc === '' ? null : loc,
      });
      // currency and format are read before the first render — reload to apply
      if (!zoneChanged) {
        window.location.reload();
        return;
      }
      setConfirmZone(false);
      region.reload();
    });

  return (
    <div className="space-y-3">
      {current.restartNeeded && (
        <RestartNotice what={`The time zone ${current.timeZone.value}`} />
      )}

      <Card
        title="Region"
        hint="Time zone, currency and how dates and numbers are written"
      >
        <div className="space-y-4 p-4">
          <SelectField
            label="Time zone of the work day"
            value={tz}
            onChange={setTimeZone}
            options={withCurrent(zones, tz)}
            hint={
              <>
                Where midnight falls, when the nightly jobs run, the dates on
                reports ({SOURCE_LABEL[current.timeZone.source]}). Daylight
                saving is followed automatically. Running now:{' '}
                <b>{current.runningTimeZone}</b>.
              </>
            }
          />
          <SelectField
            label="Currency"
            value={cur}
            onChange={setCurrency}
            options={withCurrent(currencies, cur)}
            hint={`Of salaries, deductions and deposits — only the symbol changes, not the amounts (${SOURCE_LABEL[current.currency.source]})`}
          />
          <SelectField
            label="Dates and numbers"
            value={loc}
            onChange={setLocale}
            options={withCurrent([...LOCALE_CHOICES], loc)}
            hint={`The order and separators only — no word on screen is translated (${SOURCE_LABEL[current.displayLocale.source]})`}
          />

          {zoneChanged && (
            <Notice tone="attention">
              A new time zone moves where every day starts and ends from the
              next restart on. Days already summarised keep the cut they were
              counted with. Best set once, before people start working.
            </Notice>
          )}

          <ServerError error={save.error} />
          <div className="flex justify-end">
            <MiniButton
              disabled={!changed || save.busy}
              onClick={() => (zoneChanged ? setConfirmZone(true) : submit())}
            >
              {save.busy ? 'Saving…' : 'Save'}
            </MiniButton>
          </div>
        </div>
      </Card>

      {confirmZone && (
        <ConfirmDialog
          title={`Change the time zone to ${tz}?`}
          intro="It takes effect when the server restarts — there is a button for that once it is saved."
          warning="From then on, midnight, the nightly jobs and every new day follow this zone. Days already counted are not recalculated."
          confirmLabel="Save time zone"
          tone="primary"
          busy={save.busy}
          error={save.error}
          onClose={() => setConfirmZone(false)}
          onConfirm={submit}
        />
      )}
    </div>
  );
}
