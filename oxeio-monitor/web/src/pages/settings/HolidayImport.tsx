import { useState } from 'react';
import { Trans } from 'react-i18next';

import {
  importHolidays,
  importPublicHolidays,
  listHolidayCountries,
  type HolidayImportPlan,
} from '../../api/calendar';
import { useApi } from '../../api/useApi';
import { Button } from '../../components/Page';
import { formatDate, todayInWorkZone } from '../../lib/format';
import { useT } from '../../i18n';
import {
  CheckboxField,
  Modal,
  Notice,
  SelectField,
  ServerError,
  useMutation,
} from '../../components/ui';

/**
 * Holidays from the public calendar (a country's nationwide holidays, from
 * date.nager.at) or from a calendar file — any country, state or city.
 *
 * Two steps on purpose: the file is shown first (what goes in, what is
 * already there, what falls in a month already counted), and only then
 * written. Current and past months change targets and salary, so they are
 * left out unless ticked — the same rule as the seed (server/prisma/seed.ts).
 */
export function HolidayImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [source, setSource] = useState<'public' | 'file'>('public');
  const thisYear = Number(todayInWorkZone().slice(0, 4));
  const [country, setCountry] = useState('');
  const [year, setYear] = useState(thisYear);
  const countries = useApi((signal) => listHolidayCountries(signal), []);
  const [file, setFile] = useState<{ name: string; content: string } | null>(
    null,
  );
  const [allowPast, setAllowPast] = useState(false);
  const [plan, setPlan] = useState<HolidayImportPlan | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const preview = useMutation();
  const write = useMutation();

  const load = async (picked: File | undefined): Promise<void> => {
    setPlan(null);
    setDone(null);
    if (!picked) return setFile(null);
    setFile({ name: picked.name, content: await picked.text() });
  };

  const ready = source === 'public' ? country !== '' : file !== null;

  const run = (dryRun: boolean, past = allowPast) =>
    (dryRun ? preview : write).run(async () => {
      if (!ready) return;
      const result =
        source === 'public'
          ? await importPublicHolidays({
              country,
              year,
              allowPast: past,
              dryRun,
            })
          : await importHolidays({
              fileName: file!.name,
              content: file!.content,
              allowPast: past,
              dryRun,
            });
      setPlan(result);
      if (!dryRun) {
        setDone(result.created);
        onDone();
      }
    });

  return (
    <Modal
      title={t('Import holidays')}
      hint={t("A country's public holidays, or a calendar file")}
      onClose={onClose}
      footer={
        done !== null ? (
          <Button tone="primary" onClick={onClose}>
            {t('Close')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('Cancel')}</Button>
            <Button
              tone="primary"
              disabled={!plan || plan.add.length === 0 || write.busy}
              onClick={() => run(false)}
            >
              {write.busy
                ? t('Importing…')
                : plan
                  ? t('Import {{n}}', { n: plan.add.length })
                  : t('Import')}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-[13px]">
        <div className="flex gap-2" role="radiogroup" aria-label={t('Source')}>
          {(['public', 'file'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={source === s}
              onClick={() => {
                setSource(s);
                setPlan(null);
              }}
              className={`rounded-md border px-3 py-1.5 text-[12.5px] transition ${
                source === s
                  ? 'border-brand bg-brand-bg text-brand-ink'
                  : 'border-line text-ink-2 hover:text-ink'
              }`}
            >
              {s === 'public' ? t('Public calendar') : t('File')}
            </button>
          ))}
        </div>

        {source === 'public' ? (
          <div className="flex flex-wrap items-end gap-2">
            <SelectField
              label={t('Country')}
              value={country}
              onChange={(v) => {
                setCountry(v);
                setPlan(null);
              }}
              options={[
                { value: '', label: countries.data ? t('Choose…') : t('Loading…') },
                ...(countries.data ?? []).map((c) => ({
                  value: c.code,
                  label: c.name,
                })),
              ]}
            />
            <SelectField
              label={t('Year')}
              value={String(year)}
              onChange={(v) => {
                setYear(Number(v));
                setPlan(null);
              }}
              options={[thisYear, thisYear + 1, thisYear + 2].map((y) => ({
                value: String(y),
                label: String(y),
              }))}
            />
          </div>
        ) : (
          <>
            <input
              type="file"
              accept=".csv,.ics,text/csv,text/calendar"
              onChange={(e) =>
                void load(e.target.files?.[0]).then(() => setPlan(null))
              }
              className="block text-[12.5px]"
            />
            <p className="text-[11.5px] text-ink-3">
              <Trans
                i18nKey="CSV, one per line: <code>2027-04-21,Tiradentes,public</code> — type is public, optional or company (public if left out). ICS: all-day events, as calendar apps export them."
                components={{ code: <span className="num" /> }}
              />
            </p>
          </>
        )}
        {source === 'public' && (
          <p className="text-[11.5px] text-ink-3">
            {t('Nationwide public holidays only — regional or company days are added by hand.')}
            {countries.error &&
              ` ${t('The public calendar could not be reached; use a file instead.')}`}
          </p>
        )}

        <CheckboxField
          label={t('Also the current and past months')}
          checked={allowPast}
          onChange={(v) => {
            setAllowPast(v);
            if (ready) run(true, v);
          }}
          hint={t("A holiday there lowers that month's workdays — its targets and prorated salary change. Leave off unless you mean it.")}
        />

        {ready && !plan && (
          <Button onClick={() => run(true)} disabled={preview.busy}>
            {preview.busy ? t('Reading…') : t('Preview')}
          </Button>
        )}

        <ServerError error={preview.error ?? write.error} />

        {done !== null && <Notice>{t('{{count}} holidays added.', { count: done })}</Notice>}

        {plan && done === null && (
          <div className="space-y-2">
            <Section
              title={t('Will be added — {{n}}', { n: plan.add.length })}
              rows={plan.add.map(
                (h) => `${formatDate(h.date)} · ${h.name} (${t(h.type)})`,
              )}
            />
            <Section
              title={t('Already holidays, left as they are — {{n}}', { n: plan.existing.length })}
              rows={plan.existing.map((h) =>
                h.nameInDb === h.name
                  ? `${formatDate(h.date)} · ${h.name}`
                  : `${formatDate(h.date)} · ${
                      source === 'public'
                        ? t('"{{here}}" here, "{{there}}" in the calendar', { here: h.nameInDb, there: h.name })
                        : t('"{{here}}" here, "{{there}}" in the file', { here: h.nameInDb, there: h.name })
                    }`,
              )}
            />
            <Section
              title={t('In a month already counted, left out — {{n}}', { n: plan.pastMonths.length })}
              rows={plan.pastMonths.map(
                (h) => `${formatDate(h.date)} · ${h.name}`,
              )}
              tone="attention"
            />
            <Section
              title={t('Could not be read — {{n}}', { n: plan.problems.length })}
              rows={plan.problems}
              tone="attention"
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

function Section({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: string[];
  tone?: 'attention';
}) {
  if (rows.length === 0) return null;
  return (
    <details
      open={rows.length <= 12}
      className="rounded-md border border-line px-3 py-2"
    >
      <summary
        className={`cursor-pointer text-[12.5px] font-medium ${tone ? 'text-brand-ink' : 'text-ink-2'}`}
      >
        {title}
      </summary>
      <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-auto text-[12px] text-ink-3">
        {rows.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </details>
  );
}
