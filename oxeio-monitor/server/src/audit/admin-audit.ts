/**
 * The single place that defines how each E10/E11 change is written to `audit_log`.
 *
 * Careful: `AuditService`'s `AuditAction` is a closed union with no separate
 * actions such as `create_employee` or `update_work_policy`. That was not
 * avoided on purpose; `src/audit/**` was outside the scope of this work.
 *
 * Fortunately the schema itself shows the way: the `audit_log.action` comment
 * reserves `change_setting` for owner config changes, and spec § 5 makes
 * "staff and device management" part of the Settings screen. So the detail
 * goes in `targetType` + `meta.op`, and the action stays `change_setting`.
 *
 * This gives a stable vocabulary to filter on: `?targetType=employee_salary`
 * brings every salary change into one place.
 */
export const ADMIN_TARGET = {
  employee: 'employee',
  /** Salary changes get their own targetType: the most sensitive write, searchable on its own */
  employeeSalary: 'employee_salary',
  device: 'device',
  workPolicy: 'work_policy',
  holiday: 'holiday',
} as const;

export type AdminTarget = (typeof ADMIN_TARGET)[keyof typeof ADMIN_TARGET];
