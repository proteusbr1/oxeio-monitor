import { useState } from 'react';

import { createHoliday, deleteHoliday, listHolidays, updateHoliday, type HolidayView } from '../../api/calendar';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Button } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Table, type Column } from '../../components/Table';
import { formatDate, todayInWorkZone, weekdayOf } from '../../lib/format';
import { useT } from '../../i18n';
import {
  Chip,
  ConfirmDialog,
  FormGrid,
  MiniButton,
  Modal,
  Notice,
  RowActions,
  SelectField,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';
import { HolidayAutoUpdate } from './HolidayAutoUpdate';
import { HolidayImportModal } from './HolidayImport';

/**
 * Holidays — `CRUD /holidays`.
 *
 * Careful: this is the only real DELETE in the whole settings area, and it is not
 * harmless: deleting a holiday adds working days to that month, so **everyone's
 * pace falls behind** without anyone doing anything differently. The confirmation
 * box therefore says so explicitly.
 */

const TYPE_OPTIONS = [
  { value: 'public', label: 'Public' },
  { value: 'optional', label: 'Optional' },
  { value: 'company', label: 'Company' },
];

const TYPE_LABEL: Record<string, string> = {
  public: 'Public',
  optional: 'Optional',
  company: 'Company',
};

export function HolidaysSection() {
  const t = useT();
  const thisYear = Number(todayInWorkZone().slice(0, 4));
  const [year, setYear] = useState(thisYear);

  const holidays = useApi((signal) => listHolidays(year, signal), [year]);

  const [editing, setEditing] = useState<HolidayView | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<HolidayView | null>(null);

  const rows = holidays.data?.rows ?? [];

  const columns: Column<HolidayView>[] = [
    {
      key: 'date',
      header: t('Date'),
      render: (holiday) => (
        <span className="num">
          {formatDate(holiday.holidayDate)}
          <small className="ml-1.5 text-[11px] text-ink-3">
            {weekdayOf(holiday.holidayDate)}
          </small>
        </span>
      ),
    },
    {
      key: 'name',
      header: t('Name'),
      render: (holiday) => holiday.name,
    },
    {
      key: 'type',
      header: t('Type'),
      render: (holiday) => (
        <span className="flex flex-wrap gap-1">
          <Chip>{TYPE_LABEL[holiday.type] ? t(TYPE_LABEL[holiday.type]) : holiday.type}</Chip>
          {/* the date can still move — pay and targets of that month may change with it */}
          {holiday.approximate && <Chip tone="pending">{t('Date may change')}</Chip>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (holiday) => (
        <RowActions>
          <MiniButton onClick={() => setEditing(holiday)}>{t('Edit')}</MiniButton>
          <MiniButton tone="danger" onClick={() => setRemoving(holiday)}>
            {t('Delete')}
          </MiniButton>
        </RowActions>
      ),
    },
  ];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">
            {t('Holidays')}
          </h2>
          <p className="mt-0.5 text-xs text-ink-3">
            {t('Workdays for the month are counted with these days taken out')}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {/*
            Careful: ◀ ▶ buttons, not a number input. With a controlled input, typing
               "2027" over "2026" passes through "2" and "20", which are out of range;
               state would not change and the year under the cursor would jump back
               to the old value. Changing the year is only a step or two anyway.
          */}
          <div>
            <span className="mb-1 block text-[11.5px] text-ink-3">{t('Year')}</span>
            <div className="flex items-center gap-1">
              <YearArrow
                label={t('Previous year')}
                disabled={year <= 2000}
                onClick={() => setYear((y) => y - 1)}
              >
                ◀
              </YearArrow>
              <span className="num min-w-16 rounded-md border border-line bg-surface px-2.5 py-1.5 text-center text-[13px]">
                {year}
              </span>
              <YearArrow
                label={t('Next year')}
                disabled={year >= 2100}
                onClick={() => setYear((y) => y + 1)}
              >
                ▶
              </YearArrow>
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={() => setImporting(true)}>{t('Import holidays')}</Button>
            <Button tone="primary" onClick={() => setCreating(true)}>
              {t('Add holiday')}
            </Button>
          </div>
        </div>
      </div>

      <HolidayAutoUpdate onUpdated={holidays.reload} />

      {holidays.loading && !holidays.data && <Loading />}
      {holidays.error && (
        <ErrorBox error={holidays.error} retry={holidays.reload} />
      )}

      {!holidays.loading && !holidays.error && rows.length === 0 && (
        <Empty
          title={t('No holidays are set for {{year}}', { year })}
          hint={t("With no holidays every day counts as a workday, which makes the month's pace look harsh for everyone. It is best to enter the public holidays at the start of the year.")}
          action={
            <div className="flex gap-2">
              {/* a whole year at once, from an official calendar file */}
              <Button onClick={() => setImporting(true)}>{t('Import holidays')}</Button>
              <Button tone="primary" onClick={() => setCreating(true)}>
                {t('Add holiday')}
              </Button>
            </div>
          }
        />
      )}

      {rows.length > 0 && (
        <Card padded={false} title={t('{{year}} · {{count}} Days', { year, count: rows.length })}>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(holiday) => String(holiday.id)}
          />
        </Card>
      )}

      {importing && (
        <HolidayImportModal onClose={() => setImporting(false)} onDone={holidays.reload} />
      )}

      {(creating || editing) && (
        <HolidayForm
          key={editing?.id ?? 'new'}
          holiday={editing}
          defaultYear={year}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            holidays.reload();
          }}
        />
      )}

      {removing && (
        <RemoveHolidayDialog
          holiday={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            holidays.reload();
          }}
        />
      )}
    </section>
  );
}

function YearArrow({
  children,
  label,
  onClick,
  disabled,
}: {
  children: string;
  label: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-ink-2 transition hover:border-brand hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function HolidayForm({
  holiday,
  defaultYear,
  onClose,
  onSaved,
}: {
  holiday: HolidayView | null;
  defaultYear: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [holidayDate, setHolidayDate] = useState(
    holiday?.holidayDate ?? `${defaultYear}-01-01`,
  );
  const [name, setName] = useState(holiday?.name ?? '');
  const [type, setType] = useState(holiday?.type ?? 'public');
  const t = useT();

  const { busy, error, run } = useMutation();

  // Careful: `weekdayOf()` returns `''` for an unrecognised date, so the hint is not
  //    rendered when empty; otherwise an empty line would hang under the heading.
  // Careful: nothing is appended to this; the weekday name alone is enough,
  //    and a suffix would make it "Mon<suffix>".
  const weekday = weekdayOf(holidayDate);

  return (
    <Modal
      title={holiday ? t('Edit holiday') : t('New holiday')}
      hint={weekday === '' ? undefined : weekday}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            tone="primary"
            disabled={busy || name.trim() === '' || holidayDate === ''}
            onClick={() =>
              run(async () => {
                if (holiday) {
                  await updateHoliday(holiday.id, {
                    holidayDate,
                    name: name.trim(),
                    type,
                  });
                } else {
                  await createHoliday({
                    holidayDate,
                    name: name.trim(),
                    type,
                  });
                }
                onSaved();
              })
            }
          >
            {busy ? t('Saving…') : t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormGrid>
          <TextField
            label={t('Date')}
            type="date"
            value={holidayDate}
            onChange={setHolidayDate}
            required
            mono
            hint={t('Future holidays can be entered too — entering the whole year up front is the norm')}
          />
          <SelectField
            label={t('Type')}
            value={type}
            onChange={setType}
            options={TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
          />
          <TextField
            label={t('Name')}
            value={name}
            onChange={setName}
            required
            autoFocus
            maxLength={120}
            placeholder={t('Victory Day')}
          />
        </FormGrid>

        <Notice>
          {t("Adding a holiday lowers the workday count for that month, so everyone's pace gets a little easier. The numbers move the moment you save it — without anyone working an extra minute.")}
        </Notice>

        <ServerError error={error} />
      </div>
    </Modal>
  );
}

function RemoveHolidayDialog({
  holiday,
  onClose,
  onDone,
}: {
  holiday: HolidayView;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const { busy, error, run } = useMutation();

  return (
    <ConfirmDialog
      title={t('Delete "{{name}}"?', { name: holiday.name })}
      intro={`${formatDate(holiday.holidayDate)} · ${weekdayOf(holiday.holidayDate)}`}
      warning={t('Deleting a holiday raises the workday count for that month — everyone falls behind on pace without working a minute less. If anyone has already read the monthly report, the numbers will no longer match.')}
      confirmLabel={t('Delete')}
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() =>
        run(async () => {
          await deleteHoliday(holiday.id);
          onDone();
        })
      }
    />
  );
}
