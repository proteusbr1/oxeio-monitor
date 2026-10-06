import { shiftWorkDate, todayInWorkZone } from '../lib/format';

/**
 * Date picking: a single day, and a from-to range.
 *
 * Careful: the value of `<input type="date">` is exactly `YYYY-MM-DD`, which is
 * what the server wants. No round trip through `new Date(...)` is needed, and
 * doing one leads into the timezone trap (`toISOString()` gives UTC, which after
 * midnight in Dhaka is the previous date).
 *
 * Careful: `max` defaults to today in Dhaka. Picking a future date is pointless,
 * and the empty screen would make it look as if data was lost.
 */
export function DatePicker({
  value,
  onChange,
  label = 'Date',
  max = todayInWorkZone(),
  min,
  /** Previous/next day with the arrows; very useful on the timeline page. */
  withArrows = false,
}: {
  value: string;
  onChange: (date: string) => void;
  label?: string;
  max?: string;
  min?: string;
  withArrows?: boolean;
}) {
  const atMax = max !== undefined && value >= max;

  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-ink-3">{label}</span>
      <span className="flex items-center gap-1">
        {withArrows && (
          <ArrowButton
            label="Previous day"
            onClick={() => onChange(shiftWorkDate(value, -1))}
            disabled={min !== undefined && value <= min}
          >
            ◀
          </ArrowButton>
        )}

        <input
          type="date"
          value={value}
          max={max}
          min={min}
          onChange={(e) => {
            // Careful: when the user clears it by hand `''` arrives; sending that to the
            // server would give a 400, so empty values are ignored.
            if (e.target.value) onChange(e.target.value);
          }}
          className="num rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
        />

        {withArrows && (
          <ArrowButton
            label="Next day"
            onClick={() => onChange(shiftWorkDate(value, 1))}
            disabled={atMax}
          >
            ▶
          </ArrowButton>
        )}
      </span>
    </label>
  );
}

/**
 * from-to range.
 *
 * Careful: the server gives a 400 when `from > to`. So it is prevented here: if
 * one end is moved past the other, the other moves along with it, and the
 * problem is settled before the user sees an error.
 *
 * Careful: the maximum range length on the server is 370 days (reports) / 366
 * days (activity). Asking for more than a year gives a 400; `<ErrorBox>` shows
 * the message by itself.
 */
export function DateRange({
  from,
  to,
  onChange,
  max = todayInWorkZone(),
}: {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  max?: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <DatePicker
        label="From"
        value={from}
        max={max}
        onChange={(next) => onChange({ from: next, to: next > to ? next : to })}
      />
      <DatePicker
        label="To"
        value={to}
        min={from}
        max={max}
        onChange={(next) =>
          onChange({ from: next < from ? next : from, to: next })
        }
      />
    </div>
  );
}

/**
 * Month picking: for payroll (`YYYY-MM`) and monthly progress.
 * Careful: the value of `<input type="month">` is exactly `YYYY-MM`, what the server wants.
 */
export function MonthPicker({
  value,
  onChange,
  label = 'Month',
  max = todayInWorkZone().slice(0, 7),
}: {
  value: string;
  onChange: (month: string) => void;
  label?: string;
  max?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-ink-3">{label}</span>
      <input
        type="month"
        value={value}
        max={max}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
        className="num rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
      />
    </label>
  );
}

function ArrowButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      /*
       * Careful: `tap`: the date arrows are among the most used buttons on a phone
       * (viewing the previous day) yet were about 30px. `min-w-11` is also set: each
       * holds a single narrow character, so raising only the height would leave a
       * target that is tall but narrow.
       */
      className="tap min-w-11 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-ink-2 transition hover:border-brand hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-40 sm:min-w-0"
    >
      {children}
    </button>
  );
}
