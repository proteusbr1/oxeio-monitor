import { useState } from 'react';

import { importHolidays, type HolidayImportPlan } from '../../api/calendar';
import { Button } from '../../components/Page';
import { formatDate } from '../../lib/format';
import { CheckboxField, Modal, Notice, ServerError, useMutation } from '../../components/ui';

/**
 * Holidays from a calendar file — any country, state or city.
 *
 * Two steps on purpose: the file is shown first (what goes in, what is
 * already there, what falls in a month already counted), and only then
 * written. Current and past months change targets and salary, so they are
 * left out unless ticked — the same rule as the seed (deploy/README § ২.১গ).
 */
export function HolidayImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
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

  const run = (dryRun: boolean, past = allowPast) =>
    (dryRun ? preview : write).run(async () => {
      if (!file) return;
      const result = await importHolidays({
        fileName: file.name,
        content: file.content,
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
      title="Import holidays"
      hint="A CSV (date,name,type) or ICS calendar from an official source"
      onClose={onClose}
      footer={
        done !== null ? (
          <Button tone="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              tone="primary"
              disabled={!plan || plan.add.length === 0 || write.busy}
              onClick={() => run(false)}
            >
              {write.busy
                ? 'Importing…'
                : plan
                  ? `Import ${plan.add.length}`
                  : 'Import'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-[13px]">
        <input
          type="file"
          accept=".csv,.ics,text/csv,text/calendar"
          onChange={(e) =>
            void load(e.target.files?.[0]).then(() => setPlan(null))
          }
          className="block text-[12.5px]"
        />
        <p className="text-[11.5px] text-ink-3">
          CSV, one per line:{' '}
          <span className="num">2027-04-21,Tiradentes,public</span> — type is
          public, optional or company (public if left out). ICS: all-day events,
          as calendar apps export them.
        </p>

        <CheckboxField
          label="Also the current and past months"
          checked={allowPast}
          onChange={(v) => {
            setAllowPast(v);
            if (file) run(true, v);
          }}
          hint="A holiday there lowers that month's workdays — its targets and prorated salary change. Leave off unless you mean it."
        />

        {file && !plan && (
          <Button onClick={() => run(true)} disabled={preview.busy}>
            {preview.busy ? 'Reading…' : 'Preview'}
          </Button>
        )}

        <ServerError error={preview.error ?? write.error} />

        {done !== null && <Notice>{done} holiday(s) added.</Notice>}

        {plan && done === null && (
          <div className="space-y-2">
            <Section
              title={`Will be added — ${plan.add.length}`}
              rows={plan.add.map(
                (h) => `${formatDate(h.date)} · ${h.name} (${h.type})`,
              )}
            />
            <Section
              title={`Already holidays, left as they are — ${plan.existing.length}`}
              rows={plan.existing.map((h) =>
                h.nameInDb === h.name
                  ? `${formatDate(h.date)} · ${h.name}`
                  : `${formatDate(h.date)} · "${h.nameInDb}" here, "${h.name}" in the file`,
              )}
            />
            <Section
              title={`In a month already counted, left out — ${plan.pastMonths.length}`}
              rows={plan.pastMonths.map(
                (h) => `${formatDate(h.date)} · ${h.name}`,
              )}
              tone="attention"
            />
            <Section
              title={`Could not be read — ${plan.problems.length}`}
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
