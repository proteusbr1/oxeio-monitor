import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Trans } from 'react-i18next';

import { ApiError } from '../../api/client';
import { runSetup, type SetupBody, type SetupResult } from '../../api/setup';
import { Wordmark } from '../../components/Brand';
import { ErrorNote, Field } from '../../components/Field';
import { Button } from '../../components/Page';
import { CheckboxField, SelectField } from '../../components/ui';
import { useT } from '../../i18n';
import {
  countryOptions,
  currencyOf,
  timeZoneOptions,
  LOCALE_CHOICES,
  localeOf,
  supportedValues,
  twoDecimalCurrencies,
} from '../settings/region.math';

/**
 * First run: an install without an owner asks for the basics here instead of
 * showing the login — the company, its region, the owner's account and the
 * work week. Everything can be changed later on Settings.
 *
 * The link needs the one-time token the server printed in its log at start
 * (/setup?token=…), so a stranger reaching a fresh install cannot claim it.
 */

const WEEKDAYS = [
  { iso: 1, label: 'Mon' },
  { iso: 2, label: 'Tue' },
  { iso: 3, label: 'Wed' },
  { iso: 4, label: 'Thu' },
  { iso: 5, label: 'Fri' },
  { iso: 6, label: 'Sat' },
  { iso: 7, label: 'Sun' },
];

/** The local weekend where it is not Saturday + Sunday (as the server suggests) */
const FRI_SAT = ['SA', 'EG', 'QA', 'KW', 'BH', 'OM', 'JO', 'IL', 'DZ', 'IQ', 'LY', 'SY', 'YE'];
function weekendOf(country: string): number[] {
  if (['BD', 'IR', 'AF'].includes(country)) return [5];
  if (FRI_SAT.includes(country)) return [5, 6];
  if (country === 'NP') return [6];
  return [6, 7];
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

function browserCountry(): string {
  const tag = navigator.language || '';
  const m = /-([A-Z]{2})\b/.exec(tag);
  return m ? m[1] : '';
}

type StepId = 'company' | 'region' | 'owner' | 'week';
const STEPS: { id: StepId; title: string }[] = [
  { id: 'company', title: 'Company' },
  { id: 'region', title: 'Region' },
  { id: 'owner', title: 'Your account' },
  { id: 'week', title: 'Work week' },
];

export function SetupPage() {
  const t = useT();
  const token = new URLSearchParams(window.location.search).get('token') ?? '';

  const zones = useMemo(() => timeZoneOptions(supportedValues('timeZone')), []);
  const currencies = useMemo(() => twoDecimalCurrencies(supportedValues('currency')), []);
  const countries = useMemo(() => countryOptions(), []);

  const initialCountry = browserCountry();
  const initialZone = zones.some((z) => z.value === browserZone()) ? browserZone() : '';

  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    organizationName: '',
    country: initialCountry,
    timeZone: initialZone,
    currency: currencyOf(initialCountry) ?? '',
    displayLocale: localeOf(initialCountry),
    ownerName: '',
    ownerEmail: '',
    ownerPassword: '',
    ownerPassword2: '',
    monthlyTargetHours: 0,
    weeklyOffDays: weekendOf(initialCountry),
    importHolidays: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SetupResult | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const workdays = Math.round(((7 - form.weeklyOffDays.length) * 52) / 12);
  const hours = form.monthlyTargetHours || workdays * 8;

  const problem = (): string | null => {
    const id = STEPS[step].id;
    if (id === 'company' && form.organizationName.trim().length < 2) return t('Give the company a name.');
    if (id === 'region' && !form.timeZone) return t('Choose the time zone the work day follows.');
    if (id === 'region' && !form.currency) return t('Choose the currency salaries are in.');
    if (id === 'owner') {
      if (form.ownerName.trim().length < 2) return t('Write your name.');
      if (!/^\S+@\S+\.\S+$/.test(form.ownerEmail.trim())) return t('That email does not look right.');
      if (form.ownerPassword.length < 10) return t('The password needs at least 10 characters.');
      if (form.ownerPassword !== form.ownerPassword2) return t('The two passwords are not the same.');
    }
    if (id === 'week' && form.weeklyOffDays.length > 6) return t('At least one working day a week is needed.');
    return null;
  };

  const next = async (e: FormEvent) => {
    e.preventDefault();
    const p = problem();
    if (p) return setError(p);
    setError(null);
    if (step < STEPS.length - 1) return setStep(step + 1);

    setBusy(true);
    try {
      const body: SetupBody = {
        token,
        organizationName: form.organizationName.trim(),
        country: form.country,
        timeZone: form.timeZone,
        currency: form.currency,
        displayLocale: form.displayLocale,
        ownerName: form.ownerName.trim(),
        ownerEmail: form.ownerEmail.trim(),
        ownerPassword: form.ownerPassword,
        monthlyTargetHours: hours,
        expectedWorkdays: workdays,
        weeklyOffDays: form.weeklyOffDays,
        importHolidays: form.importHolidays && form.country !== '',
      };
      const result = await runSetup(body);
      setDone(result);
      if (result.restartNeeded) await waitForRestart();
      // a full load: the dashboard reads the time zone, currency and format at
      // start, and they were just chosen
      window.location.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Can't reach the server"));
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">{t('Set up oXeio')}</h1>
        <p className="text-sm text-ink-2">
          <Trans
            i18nKey="This install has no owner yet. To set it up, open the link the server printed in its log when it started — it looks like <num>…/setup?token=…</num>."
            components={{ num: <span className="num" /> }}
          />
        </p>
        <p className="text-xs text-ink-3">
          {t('With Docker:')} <span className="num">docker compose logs api | grep setup</span>
        </p>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">{t('All set')}</h1>
        <p className="text-sm text-ink-2">
          {done.restartNeeded
            ? t('Applying your time zone — the server restarts once. This takes a few seconds…')
            : t('Opening the dashboard…')}
        </p>
        {done.holidaysAdded > 0 && (
          <p className="text-xs text-ink-3">
            {t('{{count}} public holidays added.', { count: done.holidaysAdded })}
          </p>
        )}
      </Shell>
    );
  }

  const id = STEPS[step].id;
  return (
    <Shell>
      <form onSubmit={next} className="space-y-4">
        <div>
          <p className="text-[11px] tracking-wider text-ink-3 uppercase">
            {t('Step {{step}} of {{total}} · {{title}}', {
              step: step + 1,
              total: STEPS.length,
              title: t(STEPS[step].title),
            })}
          </p>
          <h1 className="mt-1 text-lg font-semibold">
            {id === 'company' && t('Set up oXeio')}
            {id === 'region' && t('Where you work')}
            {id === 'owner' && t('Your account')}
            {id === 'week' && t('Your work week')}
          </h1>
          <p className="mt-1 text-sm text-ink-3">
            {id === 'company' && t('A few basics to get started. Everything can be changed later in Settings.')}
            {id === 'region' && t('The time zone decides when a work day starts and ends.')}
            {id === 'owner' && t('You will be the owner: you see everything and manage the rest.')}
            {id === 'week' && t('Used for monthly targets. Adjust per person later if needed.')}
          </p>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        {id === 'company' && (
          <>
            <Field
              id="org"
              label={t('Company name')}
              required
              autoFocus
              maxLength={80}
              value={form.organizationName}
              onChange={(e) => set('organizationName', e.target.value)}
              placeholder={t('Acme Design Studio')}
            />
            <SelectField
              label={t('Country')}
              value={form.country}
              onChange={(v) => {
                setForm((f) => ({
                  ...f,
                  country: v,
                  currency: currencyOf(v) ?? f.currency,
                  displayLocale: localeOf(v) || f.displayLocale,
                  weeklyOffDays: weekendOf(v),
                }));
              }}
              options={[{ value: '', label: t('Choose…') }, ...countries]}
            />
          </>
        )}

        {id === 'region' && (
          <>
            <SelectField
              label={t('Time zone')}
              value={form.timeZone}
              onChange={(v) => set('timeZone', v)}
              options={[{ value: '', label: t('Choose…') }, ...zones]}
            />
            <SelectField
              label={t('Currency')}
              value={form.currency}
              onChange={(v) => set('currency', v)}
              options={[{ value: '', label: t('Choose…') }, ...currencies]}
            />
            <SelectField
              label={t('Dates and numbers')}
              value={form.displayLocale}
              onChange={(v) => set('displayLocale', v)}
              options={LOCALE_CHOICES}
            />
          </>
        )}

        {id === 'owner' && (
          <>
            <Field
              id="name"
              label={t('Your name')}
              required
              autoFocus
              value={form.ownerName}
              onChange={(e) => set('ownerName', e.target.value)}
            />
            <Field
              id="email"
              label={t('Email')}
              type="email"
              autoComplete="username"
              required
              value={form.ownerEmail}
              onChange={(e) => set('ownerEmail', e.target.value)}
            />
            <Field
              id="password"
              label={t('Password')}
              type="password"
              autoComplete="new-password"
              required
              value={form.ownerPassword}
              onChange={(e) => set('ownerPassword', e.target.value)}
            />
            <Field
              id="password2"
              label={t('Password again')}
              type="password"
              autoComplete="new-password"
              required
              value={form.ownerPassword2}
              onChange={(e) => set('ownerPassword2', e.target.value)}
            />
          </>
        )}

        {id === 'week' && (
          <>
            <div>
              <span className="mb-1 block text-[11.5px] text-ink-3">{t('Days off each week')}</span>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((d) => {
                  const off = form.weeklyOffDays.includes(d.iso);
                  return (
                    <button
                      key={d.iso}
                      type="button"
                      aria-pressed={off}
                      onClick={() =>
                        set(
                          'weeklyOffDays',
                          off
                            ? form.weeklyOffDays.filter((x) => x !== d.iso)
                            : [...form.weeklyOffDays, d.iso].sort(),
                        )
                      }
                      className={`tap rounded-md border px-2.5 py-1.5 text-[12.5px] ${
                        off ? 'border-brand bg-brand-bg text-brand-ink' : 'border-line text-ink-2'
                      }`}
                    >
                      {t(d.label)}
                    </button>
                  );
                })}
              </div>
            </div>
            <Field
              id="hours"
              label={t('Hours per month (target)')}
              type="number"
              min={1}
              max={744}
              value={String(hours)}
              onChange={(e) => set('monthlyTargetHours', Number(e.target.value))}
              hint={t('About {{count}} working days × 8 hours.', { count: workdays })}
            />
            {form.country && (
              <CheckboxField
                label={t("Add the country's public holidays (this year and next)")}
                checked={form.importHolidays}
                onChange={(v) => set('importHolidays', v)}
                hint={t('From a public calendar. Regional and company days are added later in Settings.')}
              />
            )}
          </>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0 || busy}>
            {t('Back')}
          </Button>
          <Button tone="primary" type="submit" disabled={busy}>
            {busy ? t('Setting up…') : step === STEPS.length - 1 ? t('Finish') : t('Next')}
          </Button>
        </div>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2.5 rounded-lg bg-chrome px-4 py-3 text-white">
          <Wordmark className="text-lg" />
          <span className="text-xs text-white/55">{t('Workforce Monitor')}</span>
        </div>
        <div className="space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm">{children}</div>
      </div>
    </div>
  );
}

/** The server restarts to apply the time zone: wait until it answers again */
async function waitForRestart(): Promise<void> {
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('/api/v1/health', { cache: 'no-store' });
      if (res.ok) return;
    } catch {
      // still restarting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
