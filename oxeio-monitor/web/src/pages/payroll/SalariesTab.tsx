import { useState } from 'react';

import { listEmployees, STAFF_TYPE_LABEL, updateEmployee, type EmployeeView } from '../../api/staff';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Button } from '../../components/Page';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table, type Column } from '../../components/Table';
import { formatDate, formatTaka } from '../../lib/format';
import {
  Chip,
  MiniButton,
  Modal,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';

/**
 * Everyone's monthly salary in one list — what the pay sheet starts from.
 * (The same field is also in Staff → edit, with the rest of the person.)
 */
export function SalariesTab() {
  const staff = useApi((signal) => listEmployees({ status: 'active' }, signal), []);
  const [editing, setEditing] = useState<EmployeeView | null>(null);

  if (staff.loading && !staff.data) return <Loading label="Loading salaries…" />;
  if (!staff.data) return <ErrorBox error={staff.error} retry={staff.reload} />;

  const rows = staff.data.rows;
  const missing = rows.filter((e) => !e.monthlySalary).length;

  if (rows.length === 0) {
    return <Empty title="No active staff yet" hint="Add people in Staff first." />;
  }

  const columns: Column<EmployeeView>[] = [
    {
      key: 'person',
      header: 'Staff',
      render: (e) => <PersonCell fullName={e.fullName} empCode={e.empCode} />,
    },
    {
      key: 'type',
      header: 'Work type',
      render: (e) => (e.staffType ? STAFF_TYPE_LABEL[e.staffType] : '—'),
    },
    {
      key: 'joined',
      header: 'Joined',
      render: (e) => (e.joinedOn ? formatDate(e.joinedOn) : '—'),
    },
    {
      key: 'salary',
      header: 'Monthly salary',
      align: 'right',
      render: (e) =>
        e.monthlySalary ? (
          <span className="num">{formatTaka(e.monthlySalary)}</span>
        ) : (
          <Chip tone="pending">Not set</Chip>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (e) => <MiniButton onClick={() => setEditing(e)}>Edit</MiniButton>,
    },
  ];

  return (
    <>
      <Card
        title="Salaries"
        hint={
          missing > 0
            ? `${missing} without a salary — they are left out of the pay sheet until one is set`
            : 'Everyone active has a salary'
        }
        padded={false}
      >
        <Table columns={columns} rows={rows} rowKey={(e) => String(e.id)} />
        <Caveat>
          A new salary counts from this month (from next month if this month is
          already closed). Months before keep the salary they had, so a pay
          sheet already reviewed does not change.
        </Caveat>
      </Card>

      {editing && (
        <SalaryForm
          employee={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            staff.reload();
          }}
        />
      )}
    </>
  );
}

function SalaryForm({
  employee,
  onClose,
  onSaved,
}: {
  employee: EmployeeView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [salary, setSalary] = useState(employee.monthlySalary ?? '');
  const { busy, error, run } = useMutation();
  const value = salary.trim();
  const valid = value === '' || /^\d+(\.\d{1,2})?$/.test(value);

  return (
    <Modal
      title={`Salary · ${employee.fullName}`}
      hint={employee.empCode}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy || !valid || value === (employee.monthlySalary ?? '')}
            onClick={() =>
              run(async () => {
                await updateEmployee(employee.id, {
                  monthlySalary: value === '' ? null : value,
                });
                onSaved();
              })
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField
          label="Monthly salary"
          value={salary}
          onChange={setSalary}
          mono
          autoFocus
          placeholder="25000"
          hint={
            valid
              ? 'Numbers only. Leave empty to remove it — the person then drops off the pay sheet.'
              : 'Numbers only, with at most two decimals (e.g. 25000 or 25000.50).'
          }
        />
        <ServerError error={error} />
      </div>
    </Modal>
  );
}
