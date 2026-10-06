import type { EmployeeView, PayBasis } from '../../api/staff';
import { SelectField, TextField } from '../../components/ui';
import { currencySymbol, formatTaka } from '../../lib/format';

/**
 * How someone is paid — the same words and fields on the Staff form and on
 * Payroll → Pay. Monthly salary, hourly rate, or not paid through oXeio
 * (hours only); the server keeps the old terms as history, so a change never
 * rewrites a month already paid.
 */
export const PAY_BASIS_OPTIONS: { value: PayBasis; label: string }[] = [
  { value: 'monthly', label: 'Monthly salary' },
  { value: 'hourly', label: 'Hourly rate' },
  { value: 'none', label: 'Not paid here (hours only)' },
];

/** "R$ 5,000.00 / month", "R$ 30.00 / hour", "Not paid here", or null when not set */
export function payText(emp: Pick<EmployeeView, 'payBasis' | 'monthlySalary' | 'hourlyRate'>): string | null {
  const basis = emp.payBasis ?? 'monthly';
  if (basis === 'none') return 'Not paid here';
  if (basis === 'hourly') return emp.hourlyRate ? `${formatTaka(emp.hourlyRate)} / hour` : null;
  return emp.monthlySalary ? `${formatTaka(emp.monthlySalary)} / month` : null;
}

/** A pay amount as typed: digits with at most two decimals, or empty */
export function validAmount(value: string): boolean {
  const v = value.trim();
  return v === '' || /^\d+(\.\d{1,2})?$/.test(v);
}

export function PayFields({
  basis,
  salary,
  rate,
  onBasis,
  onSalary,
  onRate,
}: {
  basis: PayBasis;
  salary: string;
  rate: string;
  onBasis: (basis: PayBasis) => void;
  onSalary: (value: string) => void;
  onRate: (value: string) => void;
}) {
  return (
    <>
      <SelectField label="Paid by" value={basis} onChange={(v) => onBasis(v as PayBasis)} options={PAY_BASIS_OPTIONS} />
      {basis === 'monthly' && (
        <TextField
          label={`Monthly salary (${currencySymbol()})`}
          value={salary}
          onChange={onSalary}
          mono
          placeholder="5000"
          hint={validAmount(salary) ? 'Numbers only — e.g. 5000 or 5000.50. Leave empty to clear it.' : 'Numbers only, at most two decimals.'}
        />
      )}
      {basis === 'hourly' && (
        <TextField
          label={`Rate per hour (${currencySymbol()})`}
          value={rate}
          onChange={onRate}
          mono
          placeholder="30"
          hint={
            validAmount(rate)
              ? 'Hours counted × rate, plus paid leave. Overtime follows the work policy.'
              : 'Numbers only, at most two decimals.'
          }
        />
      )}
    </>
  );
}
