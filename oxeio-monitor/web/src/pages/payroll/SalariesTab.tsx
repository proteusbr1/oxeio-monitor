import { useState } from 'react';

import { listEmployees, updateEmployee, type EmployeeView, type PayBasis } from '../../api/staff';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Button } from '../../components/Page';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table, type Column } from '../../components/Table';
import { useT } from '../../i18n';
import { formatDate } from '../../lib/format';
import { Chip, MiniButton, Modal, ServerError, useMutation } from '../../components/ui';
import { PayFields, payText, validAmount } from './pay';

/**
 * Everyone's monthly salary in one list — what the pay sheet starts from.
 * (The same field is also in Staff → edit, with the rest of the person.)
 */
export function SalariesTab() {
  const t = useT();
  const staff = useApi((signal) => listEmployees({ status: 'active' }, signal), []);
  const [editing, setEditing] = useState<EmployeeView | null>(null);

  if (staff.loading && !staff.data) return <Loading label={t('Loading salaries…')} />;
  if (!staff.data) return <ErrorBox error={staff.error} retry={staff.reload} />;

  const rows = staff.data.rows;
  const missing = rows.filter((e) => payText(e) === null).length;

  if (rows.length === 0) {
    return <Empty title={t('No active staff yet')} hint={t('Add people in Staff first.')} />;
  }

  const columns: Column<EmployeeView>[] = [
    {
      key: 'person',
      header: t('Staff'),
      render: (e) => <PersonCell fullName={e.fullName} empCode={e.empCode} />,
    },
    {
      key: 'title',
      header: t('Job title'),
      render: (e) => e.designation ?? '—',
    },
    {
      key: 'joined',
      header: t('Joined'),
      render: (e) => (e.joinedOn ? formatDate(e.joinedOn) : '—'),
    },
    {
      key: 'salary',
      header: t('Pay'),
      align: 'right',
      render: (e) => {
        const text = payText(e);
        return text ? <span className="num">{text}</span> : <Chip tone="pending">{t('Not set')}</Chip>;
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (e) => <MiniButton onClick={() => setEditing(e)}>{t('Edit')}</MiniButton>,
    },
  ];

  return (
    <>
      <Card
        title={t('Pay')}
        hint={
          missing > 0
            ? t('{{count}} without a salary — they are left out of the pay sheet until one is set', { count: missing })
            : t('Everyone active has a salary')
        }
        padded={false}
      >
        <Table columns={columns} rows={rows} rowKey={(e) => String(e.id)} />
        <Caveat>
          {t(
            'New pay terms count from this month (from next month if this month is already closed). Months before keep the terms they had, so a pay sheet already reviewed does not change.',
          )}
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
  const t = useT();
  const [basis, setBasis] = useState<PayBasis>(employee.payBasis ?? 'monthly');
  const [salary, setSalary] = useState(employee.monthlySalary ?? '');
  const [rate, setRate] = useState(employee.hourlyRate ?? '');
  const { busy, error, run } = useMutation();
  const valid = validAmount(salary) && validAmount(rate);
  const changed =
    basis !== (employee.payBasis ?? 'monthly') ||
    salary.trim() !== (employee.monthlySalary ?? '') ||
    rate.trim() !== (employee.hourlyRate ?? '');

  return (
    <Modal
      title={t('Pay · {{name}}', { name: employee.fullName })}
      hint={employee.empCode}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            tone="primary"
            disabled={busy || !valid || !changed}
            onClick={() =>
              run(async () => {
                // the three go together, so the server keeps one history slice
                await updateEmployee(employee.id, {
                  payBasis: basis,
                  monthlySalary: basis === 'monthly' && salary.trim() !== '' ? salary.trim() : null,
                  hourlyRate: basis === 'hourly' && rate.trim() !== '' ? rate.trim() : null,
                });
                onSaved();
              })
            }
          >
            {busy ? t('Saving…') : t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <PayFields
          basis={basis}
          salary={salary}
          rate={rate}
          onBasis={setBasis}
          onSalary={setSalary}
          onRate={setRate}
        />
        <ServerError error={error} />
      </div>
    </Modal>
  );
}
