import { listEmployees, type EmployeeView } from '../api/staff';
import { useApi } from '../api/useApi';
import { useT } from '../i18n';

/**
 * Staff picker: needed on the timeline, screenshot and report pages alike.
 *
 * It fetches the list itself (`GET /employees`), so pages do not each have to
 * write a separate call. `GET /employees` is open to both owner and manager:
 * without the name list, the live view and reports would be meaningless.
 *
 * Careful: `role = employee` gets a 403 here. Do not put this picker on a staff
 * member's own screen: there is only one person, nothing to pick, and showing the
 * list would reveal colleagues' names.
 *
 * Careful: by default only active staff. To see the old days of someone who has
 * left, use `includeInactive`; "(Inactive)" then appears beside the name,
 * otherwise nobody would understand why their hours today are zero.
 *
 * Careful: "Inactive" is not "Idle". Some languages use one word for both; in
 * English they are not the same. This one is employment status (has left), while the
 * "Idle" of `StatusDot` means keyboard and mouse are quiet right now. Mixing
 * them up could make someone read a working person as "has left".
 */
export function EmployeePicker({
  value,
  onChange,
  label,
  allowAll = false,
  allLabel,
  includeInactive = false,
  className = '',
}: {
  /** `null` = nobody picked / everyone. */
  value: number | null;
  onChange: (employeeId: number | null) => void;
  label?: string;
  /** Whether the "everyone" option is offered. */
  allowAll?: boolean;
  allLabel?: string;
  includeInactive?: boolean;
  className?: string;
}) {
  const t = useT();
  const { data, error, loading } = useApi(
    (signal) =>
      listEmployees({ status: includeInactive ? 'all' : 'active' }, signal),
    [includeInactive],
  );

  const rows: EmployeeView[] = data?.rows ?? [];

  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[11.5px] text-ink-3">{label ?? t('Staff')}</span>
      <select
        value={value === null ? '' : String(value)}
        disabled={loading || error !== null}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="min-w-44 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25 disabled:opacity-60"
      >
        {/*
          Careful: all three states must be shown here; otherwise, with an empty list,
             a blank dropdown would look like the control itself is broken.
        */}
        {loading && <option value="">{t('Loading…')}</option>}
        {error && <option value="">{t("Couldn't load the list")}</option>}

        {!loading && !error && (
          <>
            {allowAll && <option value="">{allLabel ?? t('Everyone')}</option>}
            {!allowAll && value === null && (
              <option value="">{t('— Choose —')}</option>
            )}
            {rows.length === 0 && <option value="">{t('No staff yet')}</option>}
            {rows.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.fullName} · {emp.empCode}
                {emp.status === 'inactive' ? ` ${t('(Inactive)')}` : ''}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}
