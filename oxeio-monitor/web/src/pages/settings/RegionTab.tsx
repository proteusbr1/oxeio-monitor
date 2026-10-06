import { useMemo, useState } from 'react';
import { Trans } from 'react-i18next';

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
import { BackToEnv } from './BackToEnv';
import { LANGUAGES, useT } from '../../i18n';

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
  const t = useT();
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
  const [language, setLanguageChoice] = useState<string | null>(null);
  const [confirmZone, setConfirmZone] = useState(false);

  if (region.loading && !current) return <Loading />;
  if (region.error && !current)
    return <ErrorBox error={region.error} retry={region.reload} />;
  if (!current) return null;

  const tz = timeZone ?? current.timeZone.value;
  const cur = currency ?? current.currency.code;
  const loc = locale ?? current.displayLocale.value ?? '';
  const lang = language ?? current.language.value;
  const zoneChanged = tz !== current.timeZone.value;
  const changed =
    zoneChanged ||
    cur !== current.currency.code ||
    loc !== (current.displayLocale.value ?? '') ||
    lang !== current.language.value;

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
        language: lang as 'en' | 'pt-BR' | 'es',
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
        <RestartNotice what={t('The time zone {{zone}}', { zone: current.timeZone.value })} />
      )}

      <Card
        title={t('Region')}
        hint={t('Time zone, currency and how dates and numbers are written')}
      >
        <div className="space-y-4 p-4">
          <SelectField
            label={t('Time zone of the work day')}
            value={tz}
            onChange={setTimeZone}
            options={withCurrent(zones, tz)}
            hint={
              <Trans
                i18nKey="Where midnight falls, when the nightly jobs run, the dates on reports ({{source}}). Daylight saving is followed automatically. Running now: <b>{{zone}}</b>."
                values={{
                  source: t(SOURCE_LABEL[current.timeZone.source]),
                  zone: current.runningTimeZone,
                }}
                components={{ b: <b /> }}
              />
            }
          />
          <SelectField
            label={t('Currency')}
            value={cur}
            onChange={setCurrency}
            options={withCurrent(currencies, cur)}
            hint={t('Of salaries, deductions and deposits — only the symbol changes, not the amounts ({{source}})', {
              source: t(SOURCE_LABEL[current.currency.source]),
            })}
          />
          <SelectField
            label={t('Dates and numbers')}
            value={loc}
            onChange={setLocale}
            options={withCurrent(
              LOCALE_CHOICES.map((o) => ({ ...o, label: t(o.label) })),
              loc,
            )}
            hint={t('The order and separators only ({{source}})', {
              source: t(SOURCE_LABEL[current.displayLocale.source]),
            })}
          />
          <SelectField
            label={t('Dashboard language')}
            value={lang}
            onChange={setLanguageChoice}
            options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            hint={t('For everyone who has not chosen their own on the Account page ({{source}})', {
              source: t(SOURCE_LABEL[current.language.source]),
            })}
          />

          {zoneChanged && (
            <Notice tone="attention">
              {t('A new time zone moves where every day starts and ends from the next restart on. Days already summarised keep the cut they were counted with. Best set once, before people start working.')}
            </Notice>
          )}

          <ServerError error={save.error} />
          <div className="flex justify-end gap-2">
            {[current.timeZone, current.currency, current.displayLocale].some(
              (v) => v.source === 'dashboard',
            ) && (
              // currency and formats are read before the first render, and the
              // page tells about a pending restart for the zone — so reload it
              <BackToEnv subject="region" restartNote onDone={() => window.location.reload()} />
            )}
            <MiniButton
              disabled={!changed || save.busy}
              onClick={() => (zoneChanged ? setConfirmZone(true) : submit())}
            >
              {save.busy ? t('Saving…') : t('Save')}
            </MiniButton>
          </div>
        </div>
      </Card>

      {confirmZone && (
        <ConfirmDialog
          title={t('Change the time zone to {{zone}}?', { zone: tz })}
          intro={t('It takes effect when the server restarts — there is a button for that once it is saved.')}
          warning={t('From then on, midnight, the nightly jobs and every new day follow this zone. Days already counted are not recalculated.')}
          confirmLabel={t('Save time zone')}
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
