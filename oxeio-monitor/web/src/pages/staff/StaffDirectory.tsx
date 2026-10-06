import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { STAFF_TYPE_LABEL, type StaffType } from '../../api/staff';
import { createEmployee, changeLoginEmail, changeUserRole, createPortalAccount, nextEmployeeCode, resetUserPassword, deactivateEmployee, listEmployees, reactivateEmployee, turnAgentOn, updateEmployee, type AssignableRole, type Role, type CreateEmployeeBody, type EmployeeStatus, type EmployeeView, type UpdateEmployeeBody, type PayBasis } from '../../api/staff';
import { listWorkPolicies } from '../../api/calendar';
import { useApi } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { useFeatures } from '../../features/FeaturesContext';
import { PayFields, payText } from '../payroll/pay';
import { Card } from '../../components/Card';
import { Button } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { PersonCell, Table, type Column } from '../../components/Table';
import { formatDate, todayInWorkZone } from '../../lib/format';
import {
  Chip,
  ConfirmDialog,
  FormGrid,
  FullWidth,
  Modal,
  MiniButton,
  Notice,
  RowActions,
  SecretModal,
  SelectField,
  ServerError,
  TextField,
  orNull,
  orUndefined,
  useDebounced,
  useMutation,
} from '../../components/ui';

/**
 * Staff: `CRUD /employees`.
 *
 * Careful: **there is no delete, only deactivate.** The server has no `@Delete` route
 * (`employees.controller.ts`), because deleting the row would orphan that
 * employee's monthly figures, screenshots and audit trail. So the UI never says
 * "delete" anywhere; it says "deactivate", and it can be reversed.
 *
 * Important: the salary field **is not rendered at all** unless `user.role ===
 * 'owner'`. A manager's response has no `monthlySalary` key (redact.ts), so writing
 * `?? '—'` would put an empty salary column on a manager's screen, and that would
 * look as if no salary had been set.
 */

/**
 * Careful: an employee's `inactive` means **has left or been switched off**, not the
 *    live board's "inactive" (Idle, keyboard quiet). So this says "Inactive", not
 *    "Idle"; merging them into one word would make someone on leave and someone who
 *    left look the same.
 */
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'all', label: 'Everyone' },
] as const;

type StatusFilter = EmployeeStatus | 'all';

export function StaffDirectory() {
  const { user } = useAuth();
  /**
   * Important: two different questions, so two different names, even though today
   * both are answered by `role === 'owner'`.
   *
   * Careful: with a single variable, if the salary rule changed tomorrow (or managers
   * could deactivate), two things would move together and nobody would notice.
   */
  const { features } = useFeatures();
  // payroll switched off in Settings → Modules: the salary stays saved, unseen
  const canSeeSalary = user?.role === 'owner' && features.payroll;
  /** portal account, password reset, deactivate: owner-only on the server */
  const isOwner = user?.role === 'owner';

  const [status, setStatus] = useState<StatusFilter>('active');
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText);

  const staff = useApi(
    (signal) => listEmployees({ status, search }, signal),
    [status, search],
  );

  // For showing the policy's name; an id is no use, nobody remembers it
  const policies = useApi((signal) => listWorkPolicies(signal), []);
  const policyName = (id: number | null): string => {
    if (id === null) return '—';
    const found = policies.data?.rows.find((p) => p.id === id);
    return found ? found.name : `#${id}`;
  };

  const [editing, setEditing] = useState<EmployeeView | null>(null);
  const [creating, setCreating] = useState(false);
  const [deactivating, setDeactivating] = useState<EmployeeView | null>(null);
  const [reactivating, setReactivating] = useState<EmployeeView | null>(null);
  const [portalFor, setPortalFor] = useState<EmployeeView | null>(null);
  const [tempPassword, setTempPassword] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const rows = staff.data?.rows ?? [];

  /**
   * Switching a stopped agent back on, **with confirmation**.
   *
   * Careful: revoke does not erase `token_hash`, it only closes the door. When
   * reversed, **the old token wakes up again**, so this must not be done for a lost
   * laptop: whoever holds it comes back too. Not something to happen in one click.
   */
  const onTurnAgentOn = (emp: EmployeeView) => {
    const ok = window.confirm(
      `Turn ${emp.fullName}'s agent back on?\n\n`
        + 'Their PC starts sending hours and screenshots again, using the login it already has.\n\n'
        + '⚠️ Do NOT do this if that PC was lost or stolen — whoever holds it gets back in too. '
        + 'In that case leave it off and sign in fresh on the new machine.',
    );
    if (!ok) return;

    void turnAgentOn(emp.id)
      .then(() => staff.reload())
      .catch((e: unknown) => window.alert((e as Error).message));
  };

  const columns: Column<EmployeeView>[] = [
    {
      key: 'name',
      header: 'Name',
      /**
       * The manager's name is **bold and green**, so in a list of 15 you need not open
       *    each row's `Login` window to learn who has which role.
       *
       * Careful: owner is deliberately not included. An owner is normally not in the
       *    staff list at all, and even if so there is no need to point them out: the
       *    person looking is the owner.
       */
      render: (emp) => (
        // the name opens the person's own page (hours, screenshots, corrections)
        <Link to={`/staff/${emp.id}`} className="hover:underline">
        <PersonCell
          fullName={emp.fullName}
          empCode={emp.empCode}
          /*
            Careful: the type comes **before** the designation: rules attach to it, so
               scanning the list you should spot "whose type is not set" (in the field
               two were empty, and one of them was actually a designer).
          */
          /* Careful: the designation is no longer shown; the type is in the next column */
          accent={emp.portalRole === 'manager'}
          accentTitle="Manager — sees everyone's Live Board and reports"
        />
        </Link>
      ),
    },
    {
      key: 'department',
      header: 'Type',
      /* Careful: **red** when the type is not set. In the field two were empty, and one
         of them was actually a designer (133 designs). The gap must be visible,
         because without a type the target calculation skips that employee. */
      render: (emp) =>
        emp.staffType ? (
          STAFF_TYPE_LABEL[emp.staffType]
        ) : (
          <span className="text-brand" title="No target rules apply until this is set">
            Not set
          </span>
        ),
    },
    {
      key: 'policy',
      header: 'Work policy',
      render: (emp) => policyName(emp.policyId),
    },
    {
      key: 'joined',
      header: 'Joined',
      render: (emp) => (
        <span className="num">
          {emp.joinedOn ? formatDate(emp.joinedOn) : '—'}
        </span>
      ),
    },
    // The column is left out of the list entirely: not hidden, just never rendered
    ...(canSeeSalary
      ? [
          {
            key: 'salary',
            header: 'Pay',
            align: 'right' as const,
            render: (emp: EmployeeView) => (
              <span className="num">{payText(emp) ?? '—'}</span>
            ),
          },
        ]
      : []),
    /**
     * **The rollout's one condition**: no PC gets the agent without a signature
     * (see the rollout section in `docs/01-Planning.md`).
     *
     * Careful: the column is inside the list, not on a separate page: on rollout day
     * the question is "is this one signed off?", and the answer should be on that row.
     * Careful: the "not yet" state is **amber**, not red: it is not a system failure,
     * just outstanding work.
     */
    /**
     * **"Can this person's agent be installed?", at a glance.**
     *
     * Careful: this answer used to be **nowhere on screen**. The only way to learn
     * whose portal account was open was to press "Portal account" on 15 rows one by
     * one. So if someone was missed on rollout day, it was found **standing at that
     * PC**, when the staff member could not sign in.
     */
    {
      key: 'setup',
      header: 'Setup',
      render: (emp) => {
        if (emp.status !== 'active') return <span className="text-ink3">—</span>;

        // Careful: the order is the order of work: first login, then MSI, then they sign in
        if (!emp.hasPortalAccount) {
          return (
            <span className="text-brand" title="Create a portal account first — the agent asks for this login">
              Needs login
            </span>
          );
        }
        /**
         * Careful: **this must be checked before "Ready to install".** In both states
         * `hasDevice` is false, but what to do is completely different: in one you go to
         * the PC and install the MSI, in the other it is one click in the row. In the
         * wrong order the owner would go to reinstall for an agent that was just switched
         * off.
         *
         * Important: this happens because deactivating an employee revokes their
         * device, and reactivating does not bring it back: deliberate, but silent.
         */
        if (emp.agentSwitchedOff) {
          return (
            <button
              type="button"
              className="text-brand underline underline-offset-2"
              title="Their agent was switched off (this happens when someone is made inactive). Turn it back on — no need to reinstall."
              onClick={() => onTurnAgentOn(emp)}
            >
              Turn agent on
            </button>
          );
        }
        if (!emp.hasDevice) {
          return (
            <span className="text-idle" title="Login ready — now install the agent on their PC">
              Ready to install
            </span>
          );
        }
        return (
          <span className="text-ok" title="Signed in from their PC — tracking">
            Running
          </span>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (emp) =>
        emp.status === 'active' ? (
          <Chip tone="counted">Active</Chip>
        ) : (
          <Chip>Inactive{emp.leftOn ? ` · ${formatDate(emp.leftOn)}` : ''}</Chip>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      /**
       * Careful: managers get **only Edit**. Portal account, password reset and
       * deactivate/reactivate are owner-only on the server, so the buttons are not
       * shown; showing them would give a 403 on press.
       */
      render: (emp) => (
        <RowActions>
          <MiniButton onClick={() => setEditing(emp)}>Edit</MiniButton>
          {!isOwner ? null : emp.status === 'active' ? (
            <>
              <MiniButton
                onClick={() => setPortalFor(emp)}
                title={
                  emp.hasPortalAccount
                    ? `Login: ${emp.portalEmail ?? ''} — change it or reset the password`
                    : 'Gives them a login to see their own hours'
                }
              >
                {/* Important: the text changes when an account exists; otherwise there would
                    be no hint what pressing "Portal account" does, and the owner would
                    think a new account would be created again. */}
                {emp.hasPortalAccount ? 'Login' : 'Portal account'}
              </MiniButton>
              <MiniButton tone="danger" onClick={() => setDeactivating(emp)}>
                Deactivate
              </MiniButton>
            </>
          ) : (
            <MiniButton onClick={() => setReactivating(emp)}>
              Reactivate
            </MiniButton>
          )}
        </RowActions>
      ),
    },
  ];

  /**
   * The rollout's one number: how many still have work to do.
   *
   * Careful: only `active` staff are counted; for someone who has left, having no
   * portal account is not outstanding work.
   */
  const activeStaff = rows.filter((e) => e.status === 'active');
  const needLogin = activeStaff.filter((e) => !e.hasPortalAccount).length;
  const needAgent = activeStaff.filter(
    (e) => e.hasPortalAccount && !e.hasDevice && !e.agentSwitchedOff,
  ).length;

  // Careful: counted separately: "needs installing" and "needs switching on" are not
  //    the same, and the second is a one-click job. Counted together, the owner would
  //    think every one needs a trip to the PC.
  const switchedOff = activeStaff.filter((e) => e.agentSwitchedOff).length;

  const setupHint =
    needLogin === 0 && needAgent === 0 && switchedOff === 0
      ? undefined
      : [
          needLogin > 0 ? `${needLogin} still need a portal account` : null,
          needAgent > 0 ? `${needAgent} ready for the agent` : null,
          switchedOff > 0 ? `${switchedOff} agent switched off` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div className="space-y-3">
      {/*
        Careful: the filter bar is **outside** the three states; otherwise the search box
           would unmount on every request and lose the cursor while typing.
      */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-ink-3">Search</span>
            <input
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Name, code or email"
              className="w-56 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/25"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11.5px] text-ink-3">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/25"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Button tone="primary" onClick={() => setCreating(true)}>
          Add staff
        </Button>
      </div>

      {staff.loading && !staff.data && <Loading />}
      {staff.error && <ErrorBox error={staff.error} retry={staff.reload} />}

      {!staff.loading && !staff.error && rows.length === 0 && (
        <Empty
          title={search ? 'No one matches that search' : 'No staff yet'}
          hint={
            search
              ? 'Try part of a name, code or email — or change "Status" to include inactive people.'
              : 'Add someone first and give them a portal account — the agent on their PC asks for that same email and password the first time it runs.'
          }
          action={
            <Button tone="primary" onClick={() => setCreating(true)}>
              Add staff
            </Button>
          }
        />
      )}

      {rows.length > 0 && (
        <Card
          padded={false}
          title={`Staff · ${staff.data?.total ?? rows.length}`}
          /**
           * **The rollout's one number.** One line saying "how many are left", and
           * what is left, instead of reading 15 rows.
           *
           * Careful: shown only **while work remains**. When all is done the line
           * vanishes; otherwise it would become permanent decoration nobody reads.
           */
          hint={setupHint ?? (
            canSeeSalary
              ? 'Viewing or changing salary is recorded in the audit log.'
              : undefined
          )}
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey={(emp) => String(emp.id)}
            rowMuted={(emp) => emp.status === 'inactive'}
          />
        </Card>
      )}

      {(creating || editing) && (
        <EmployeeForm
          // Careful: `key`, or opening one person's form without closing another's
          //    would make React reuse the same component and the previous person's typed
          //    values would stay
          key={editing?.id ?? 'new'}
          employee={editing}
          canSeeSalary={canSeeSalary}
          policies={policies.data?.rows.map((p) => ({
            value: String(p.id),
            label: p.isActive ? p.name : `${p.name} (closed)`,
          }))}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            staff.reload();
          }}
        />
      )}

      {deactivating && (
        <DeactivateDialog
          employee={deactivating}
          onClose={() => setDeactivating(null)}
          onDone={() => {
            setDeactivating(null);
            staff.reload();
          }}
        />
      )}

      {reactivating && (
        <ReactivateDialog
          employee={reactivating}
          onClose={() => setReactivating(null)}
          onDone={() => {
            setReactivating(null);
            staff.reload();
          }}
        />
      )}

      {portalFor && (
        <PortalAccountForm
          employee={portalFor}
          onClose={() => setPortalFor(null)}
          onCreated={(email, password) => {
            setPortalFor(null);
            setTempPassword({ email, password });
            // Careful: a reset refreshes the list too; when a new account is opened
            //    the "Setup" column must change at once
            staff.reload();
          }}
          onSaved={() => {
            setPortalFor(null);
            staff.reload();
          }}
        />
      )}

      {tempPassword && (
        <SecretModal
          title="Temporary password"
          label="password"
          secret={tempPassword.password}
          note={tempPassword.email}
          meta="They must change this password at their first sign-in."
          onClose={() => setTempPassword(null)}
        />
      )}
    </div>
  );
}

// ── Add and edit ────────────────────────────────────────────────────────────

interface StaffForm {
  empCode: string;
  fullName: string;
  email: string;
  /** Careful: empty string = "not set"; `StaffType | ''` */
  staffType: string;
  /** Careful: empty string = "not set", so the policy's 25 applies; `'0'` = off */
  dailyDesignTarget: string;
  policyId: string;
  joinedOn: string;
  monthlySalary: string;
  payBasis: PayBasis;
  hourlyRate: string;
}

function formOf(employee: EmployeeView | null): StaffForm {
  return {
    empCode: employee?.empCode ?? '',
    fullName: employee?.fullName ?? '',
    email: employee?.email ?? '',
    staffType: employee?.staffType ?? '',
    dailyDesignTarget:
      employee?.dailyDesignTarget === null ||
      employee?.dailyDesignTarget === undefined
        ? ''
        : String(employee.dailyDesignTarget),
    policyId:
      employee?.policyId === null || employee?.policyId === undefined
        ? ''
        : String(employee.policyId),
    joinedOn: employee?.joinedOn ?? '',
    monthlySalary: employee?.monthlySalary ?? '',
    payBasis: employee?.payBasis ?? 'monthly',
    hourlyRate: employee?.hourlyRate ?? '',
  };
}

/**
 * Careful: the PATCH sends **only what changed**.
 *
 * Sending the whole form would do two kinds of harm: (1) an `employee_salary` audit
 * row would be written every time even if salary was untouched, burying the real
 * salary changes under them; (2) with two people editing at once, one would erase
 * the other's change.
 */
function patchOf(
  before: StaffForm,
  after: StaffForm,
  canSeeSalary: boolean,
): UpdateEmployeeBody {
  const patch: UpdateEmployeeBody = {};

  // Careful: `empCode` is not compared at all; the field is read-only and the server ignores it too
  if (after.fullName.trim() !== before.fullName) {
    patch.fullName = after.fullName.trim();
  }
  // Careful: an empty field means `null` ("delete it"), not `''`; sending `''` would
  //    trip `@IsEmail`/`@Matches` and give a 400
  if (after.email.trim() !== before.email) patch.email = orNull(after.email);
  // Careful: empty means `null` ("remove the type"); the server accepts `null`
  if (after.staffType !== before.staffType) {
    patch.staffType = after.staffType === '' ? null : (after.staffType as StaffType);
  }
  // Careful: empty means `null` ("clear their own number, go back to the policy"),
  //    not `0`; sending `0` would **switch the target off**, which is a different thing
  if (after.dailyDesignTarget.trim() !== before.dailyDesignTarget) {
    patch.dailyDesignTarget =
      after.dailyDesignTarget.trim() === ''
        ? null
        : Number(after.dailyDesignTarget);
  }
  if (after.joinedOn !== before.joinedOn) {
    patch.joinedOn = orNull(after.joinedOn);
  }
  if (after.policyId !== before.policyId) {
    patch.policyId = after.policyId === '' ? null : Number(after.policyId);
  }
  // pay terms go together: a change of basis, salary or rate sends all three,
  // so the server keeps one consistent history slice
  if (
    canSeeSalary &&
    (after.monthlySalary.trim() !== before.monthlySalary ||
      after.hourlyRate.trim() !== before.hourlyRate ||
      after.payBasis !== before.payBasis)
  ) {
    patch.payBasis = after.payBasis;
    patch.monthlySalary = after.payBasis === 'monthly' ? orNull(after.monthlySalary) : null;
    patch.hourlyRate = after.payBasis === 'hourly' ? orNull(after.hourlyRate) : null;
  }

  return patch;
}

function EmployeeForm({
  employee,
  canSeeSalary,
  policies,
  onClose,
  onSaved,
}: {
  employee: EmployeeView | null;
  canSeeSalary: boolean;
  policies?: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = formOf(employee);
  const [form, setForm] = useState<StaffForm>(initial);
  const { features } = useFeatures();
  const { busy, error, run } = useMutation();

  /**
   * On a new employee's form the code is **shown in advance** (`OX-13`), but only
   * for display, not for sending. The real code is assigned on the server, at the
   * moment of saving.
   *
   * Careful: so the text says neither "next" nor "your code will be": if two owners
   * add at once, one gets the next one, and the screen would have been lying.
   *
   * Careful: **not called when editing**; there the code belongs to the employee.
   *
   * Careful: failure is silent, on purpose: it is mere information, and showing a red
   * message across the whole form for it is pointless; the code will be assigned on
   * save anyway.
   */
  useEffect(() => {
    if (employee) return;

    const ac = new AbortController();
    nextEmployeeCode(ac.signal)
      .then(({ code }) => setForm((prev) => ({ ...prev, empCode: code })))
      .catch(() => {
        /* If it does not arrive the field shows "Assigned on save" */
      });

    return () => ac.abort();
  }, [employee]);

  const set = (key: keyof StaffForm) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));


  const submit = (): void => {
    run(async () => {
      if (employee) {
        const patch = patchOf(initial, form, canSeeSalary);
        // Nothing changed: quietly closing is more honest than going to the server to
        // get a 400 "no field was supplied"
        if (Object.keys(patch).length > 0) {
          await updateEmployee(employee.id, patch);
        }
      } else {
        // Careful: `empCode` is not sent; the server assigns it, and sending it gives a 400
        const body: CreateEmployeeBody = {
          fullName: form.fullName.trim(),
          ...(orUndefined(form.email) ? { email: form.email.trim() } : {}),
          ...(form.staffType === ''
            ? {}
            : { staffType: form.staffType as StaffType }),
          ...(form.dailyDesignTarget.trim() === ''
            ? {}
            : { dailyDesignTarget: Number(form.dailyDesignTarget) }),
          ...(form.policyId ? { policyId: Number(form.policyId) } : {}),
          ...(form.joinedOn ? { joinedOn: form.joinedOn } : {}),
          ...(canSeeSalary ? { payBasis: form.payBasis } : {}),
          ...(canSeeSalary && form.payBasis === 'monthly' && orUndefined(form.monthlySalary)
            ? { monthlySalary: form.monthlySalary.trim() }
            : {}),
          ...(canSeeSalary && form.payBasis === 'hourly' && orUndefined(form.hourlyRate)
            ? { hourlyRate: form.hourlyRate.trim() }
            : {}),
        };
        await createEmployee(body);
      }
      onSaved();
    });
  };

  // Careful: not code and conditions; that is the server's job. Only the name is needed.
  const incomplete = form.fullName.trim() === '';

  return (
    <Modal
      title={employee ? `${employee.fullName} — edit` : 'New staff member'}
      hint={
        employee ? `Code ${employee.empCode}` : 'Only the name is required'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={submit}
            disabled={busy || incomplete}
            title={incomplete ? 'The name is required' : undefined}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormGrid>
          {/*
            Important: the code is **to look at, not to write**: the server assigns it
            and nobody can change it. The field is still kept (not hidden), because on
            rollout day the question "what is their code?" comes up in this very form.

            Careful: `disabled` is not mere screen politeness: the field does not exist
            on the server either (`CreateEmployeeDto`/`UpdateEmployeeDto`), so even
            cleverness through DevTools gets a 400. Without blocking both sides, one
            would one day drift.
          */}
          <TextField
            label="Employee code"
            value={form.empCode}
            onChange={() => {
              /* cannot be changed */
            }}
            disabled
            mono
            hint={
              employee
                ? 'Assigned by the system — this never changes'
                : form.empCode === ''
                  ? 'Assigned automatically when you save'
                  : 'Assigned automatically — this is the next one in line'
            }
          />
          {/* Careful: the code field is now disabled, so the cursor starts here when the modal opens */}
          <TextField
            label="Full name"
            value={form.fullName}
            onChange={set('fullName')}
            required
            maxLength={120}
            autoFocus={!employee}
          />
          <TextField
            label="Email"
            type="email"
            value={form.email}
            onChange={set('email')}
            hint="Needed to create a portal account"
          />
          {/*
            **Staff type**, the owner's request: the only field that **rules** attach to
               (the designer's daily target).

            Careful: the free-text "Designation" below stays, deliberately: it is a job
               title ("Senior Graphic Designer"), this is a class. Merged, adding
               "Senior" to the title would silently stop the target rule applying to
               that employee.
          */}
          <SelectField
            label="Staff type"
            value={form.staffType}
            onChange={set('staffType')}
            options={[
              { value: '', label: 'Not set' },
              { value: 'designer', label: 'Designer' },
              { value: 'researcher', label: 'Researcher' },
              { value: 'manager', label: 'Manager' },
            ]}
            hint="Designers get a daily design target; the others do not"
          />
          {/*
            **This field appears only for designers**: the server's
               `hasDesignTarget()` checks exactly this same condition. Showing it for
               others would let it be filled while changing nothing on any screen; a
               field that does nothing is more confusing than a wrong number.

            Careful: changing the type away from "Designer" hides the field but does
               **not erase** the saved value; making them a designer again brings the
               number back.
          */}
          {features.designTargets && form.staffType === 'designer' && (
            <TextField
              label="Daily design target"
              value={form.dailyDesignTarget}
              onChange={set('dailyDesignTarget')}
              placeholder="25"
              hint="Leave empty to use the shared target from the work policy. 0 turns the target off — the count still shows, but nobody is marked behind."
            />
          )}
          {/*
            **Two fields, one name, and that is the only trap here.**

            The owner's decision: researcher and designer do not do the same work, so
            their access should not be the same. So researcher is now a portal **role**
            (`UserRole.researcher`), and rights come from there.

            Careful: this field (**Staff type**) does **not** grant rights: it is the
               name of the work, and it is what opens the designer's target field. The
               role is set in a separate window (the row's "Login" button).

            Important: so when the two disagree, the message below appears. The role
               could have been set quietly, but then the owner would never know what
               happened, and in this project **invisible magic** has repeatedly caused
               wrong numbers. A visible warning, not a hidden correction.
          */}
          {employee &&
            features.designTargets &&
            form.staffType === 'researcher' &&
            employee.portalRole !== null &&
            employee.portalRole !== 'researcher' && (
              <FullWidth>
                <Notice tone="attention">
                  Their work type is Researcher, but their portal role is{' '}
                  <b>{ROLE_WORD[employee.portalRole]}</b> — so they will not see
                  the Design Pool or the spelling queue. Open <b>Login</b> on
                  their row and set the role to <b>Researcher</b>.
                </Notice>
              </FullWidth>
            )}
          {employee &&
            form.staffType !== 'researcher' &&
            employee.portalRole === 'researcher' && (
              <FullWidth>
                <Notice tone="attention">
                  Their portal role is Researcher, so they can still open the
                  Design Pool — even though their work type is not Researcher.
                  Change the role on their <b>Login</b> if that is not intended.
                </Notice>
              </FullWidth>
            )}
          {/*
            Careful: **the "Designation" and "Department" fields were removed**
               (the owner's decision).

            Important: **Staff type** above is now the only classification, and
               writing the same thing in three fields means three spellings
               ("Designer", "Graphic Designer", "Design") that no rule can attach to.

            Careful: the two database columns were **not dropped**: old rows hold
               values, and deleting them would lose history. They are just no longer
               edited or shown.
          */}
          <TextField
            label="Joined on"
            type="date"
            value={form.joinedOn}
            onChange={set('joinedOn')}
            max={todayInWorkZone()}
          />
          <SelectField
            label="Work policy"
            value={form.policyId}
            onChange={set('policyId')}
            options={[
              { value: '', label: '— Default —' },
              ...(policies ?? []),
            ]}
            hint="The monthly target, screenshot window and idle threshold all come from here"
          />

          {/*
            The salary field is **not rendered at all** for anyone but the owner.
               Careful: the note beside it is deliberate: whoever is looking should know
                  their looking is recorded (the server writes a `payroll_view` row).
          */}
          {canSeeSalary && (
            <FullWidth>
              <div className="grid gap-3.5 sm:grid-cols-2">
                <PayFields
                  basis={form.payBasis}
                  salary={form.monthlySalary}
                  rate={form.hourlyRate}
                  onBasis={(basis) => setForm((prev) => ({ ...prev, payBasis: basis }))}
                  onSalary={set('monthlySalary')}
                  onRate={set('hourlyRate')}
                />
              </div>
              <p className="mt-1.5 text-[11.5px] text-ink-3">
                Pay is the owner's alone; viewing or changing it is recorded in the audit log.
              </p>
            </FullWidth>
          )}
        </FormGrid>

        <ServerError error={error} />
      </div>
    </Modal>
  );
}

// ── Deactivate and reactivate ───────────────────────────────────────────────


function DeactivateDialog({
  employee,
  onClose,
  onDone,
}: {
  employee: EmployeeView;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, error, run } = useMutation();
  const [leftOn, setLeftOn] = useState(todayInWorkZone());

  return (
    <ConfirmDialog
      title={`Deactivate ${employee.fullName}?`}
      intro="Their past hours, screenshots and reports all stay — nothing is deleted. You can reactivate them later."
      warning="All their devices will be revoked at the same time, any unused enrolment code is cancelled, and their portal account is closed. No new data will arrive from those PCs."
      confirmLabel="Deactivate"
      withReason
      extra={
        <div className="max-w-xs">
          <TextField
            label="Last workday"
            type="date"
            value={leftOn}
            onChange={setLeftOn}
            max={todayInWorkZone()}
            hint="Defaults to today — the month is counted only up to this date"
          />
        </div>
      }
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={(reason) =>
        run(async () => {
          await deactivateEmployee(employee.id, reason, leftOn);
          onDone();
        })
      }
    />
  );
}

function ReactivateDialog({
  employee,
  onClose,
  onDone,
}: {
  employee: EmployeeView;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, error, run } = useMutation();

  return (
    <ConfirmDialog
      title={`Reactivate ${employee.fullName}?`}
      intro="They come back to the active list and count towards the monthly target again."
      warning="Their PC does not come back on its own — their agent was switched off when they were made inactive. Use “Turn agent on” in their row afterwards, otherwise it stays silent."
      confirmLabel="Reactivate"
      tone="primary"
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() =>
        run(async () => {
          await reactivateEmployee(employee.id);
          onDone();
        })
      }
    />
  );
}

// ── Portal account ──────────────────────────────────────────────────────────

/**
 * Important: the type is `AssignableRole`, not `Role`, so if someone adds
 * `{ value: 'owner' }` by mistake **the compiler stops them**. ADR-011d's rule is
 * then bound in the screen's code, not only in the server's DTO.
 */
/**
 * Careful: the role's **human-readable name**, not the server value. Writing
 * `employee` in a message would make the owner think it was some technical signal.
 *
 * Careful: `Record<Role, string>`: a **complete** map, deliberately. If something
 * new is added to `UserRole`, a compile error appears here, and no blank cell shows
 * on screen. When `researcher` was added, only **two** places in the whole
 * codebase were caught this way.
 */
const ROLE_WORD: Record<Role, string> = {
  owner: 'Owner',
  manager: 'Manager',
  researcher: 'Researcher',
  employee: 'Staff',
};

/**
 * **Which role shows what in the dropdown**: a complete map.
 *
 * Careful: `owner` is not `'employee'`; it **never reaches** here: the owner's
 * dropdown is not shown at all (`ownerAccount`). The entry is kept anyway, because
 * without a complete `Record<Role, ...>` the compiler would not guard this.
 */
const ASSIGNABLE_OF: Record<Role, AssignableRole> = {
  owner: 'employee',
  manager: 'manager',
  researcher: 'researcher',
  employee: 'employee',
};

const PORTAL_ROLES: { value: AssignableRole; label: string }[] = [
  { value: 'employee', label: 'Staff — their own hours only' },
  /**
   * The owner's decision: researcher and designer do not do the same work, so their
   * access should not be the same.
   *
   * Careful: the text says **what they will get**, not the word "Researcher" alone.
   * The adjacent field (Staff type) has exactly the same word yet grants no rights;
   * if the two could not be told apart, the owner would look in the wrong field.
   */
  {
    value: 'researcher',
    label: 'Researcher — Design Pool and the spelling queue',
  },
  { value: 'manager', label: "Manager — everyone's Live Board and reports" },
];

/**
 * The account for signing in to the employee's own screen.
 *
 * Careful: the `owner` role cannot be given from here, deliberately. Owner means
 *    the key to pay, the audit log and settings; that is not something to hand out
 *    with one click on a dropdown.
 */
function PortalAccountForm({
  employee,
  onClose,
  onCreated,
  onSaved,
}: {
  employee: EmployeeView;
  onClose: () => void;
  /** The new temporary password: for both open and reset */
  onCreated: (email: string, password: string) => void;
  /** After an email change: no password to show, just refresh the list */
  onSaved: () => void;
}) {
  /**
   * One modal does two jobs: **opening** an account and **fixing** it.
   *
   * Careful: two separate modals would need two buttons on the row, and the owner
   * would have to remember which has been opened and which not, though the system
   * itself knows.
   */
  const existing = employee.hasPortalAccount && employee.portalUserId !== null;

  const [email, setEmail] = useState(
    existing ? (employee.portalEmail ?? '') : (employee.email ?? ''),
  );
  /**
   * Careful: the dropdown opens showing the **current** role. Starting from
   * `'employee'` would mean that someone fixing an email typo and pressing save
   * silently turned a manager into staff, and nothing would show it anywhere.
   */
  /**
   * The type is `AssignableRole`, not `Role`, because the initializer narrows the
   * value to those two, and the owner's dropdown is never shown (below).
   *
   * Careful: with `Role` written, the compiler assumed the value could also be
   * `'owner'`, which `changeUserRole` does not accept: **the web build broke on
   * exactly that** (TS2345). The narrow type now guards the rule itself, with no
   * runtime guard.
   */
  /**
   * Careful: **the bug came back a third time, on this one line.**
   *
   * It used to read `portalRole === 'manager' ? 'manager' : 'employee'`, meaning
   * *"if not a manager, staff"*. After the `researcher` role arrived, that showed a
   * researcher as **"Staff" in the dropdown**, and an owner who opened the window just
   * to fix an email typo and pressed save would **silently turn them from researcher
   * into ordinary staff**, losing the Design Pool and the spelling queue.
   *
   * Careful: this is the same bug the note above describes for managers. It was then
   * fixed with `? :`, and that fix itself became a trap for the new role. Important:
   * so it is now a **complete map**: `Record<Role, ...>`; if the enum grows, the
   * compiler stops it instead of guessing.
   */
  const [role, setRole] = useState<AssignableRole>(
    () => ASSIGNABLE_OF[employee.portalRole ?? 'employee'],
  );

  /**
   * Careful: an owner's account cannot be touched from here. The role field is not
   * shown at all, because a disabled dropdown would look like something was broken,
   * when this is deliberate (ADR-011d). The server also blocks it separately.
   */
  /**
   * **A password chosen by the owner.**
   *
   * Careful: left empty, **the old behaviour is unchanged**: the system generates 14
   * random characters and asks for a change at first login. Important: when the field
   * is filled, that is what is set, and the "Change your password" screen no longer
   * appears: the owner knows the password, and chose it **knowingly**.
   */
  const [password, setPassword] = useState('');

  const ownerAccount = employee.portalRole === 'owner';

  const emailChanged = email.trim() !== (employee.portalEmail ?? '');
  const roleChanged = !ownerAccount && role !== employee.portalRole;
  const hasChanges = emailChanged || roleChanged;
  const { busy, error, run } = useMutation();

  return (
    <Modal
      title={`${employee.fullName} — ${existing ? 'login' : 'portal account'}`}
      hint={
        existing
          ? 'Change the sign-in email or role, or give them a new password'
          : 'They will be able to see their own hours and progress'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {existing ? (
            <>
              {/* Careful: password reset and email change are **two separate buttons**.
                  Combined into one, fixing an email typo would needlessly change
                  someone's password and they could not sign in the next day. */}
              <Button
                onClick={() =>
                  run(async () => {
                    const result = await resetUserPassword(
                      employee.portalUserId!,
                      password.trim() || undefined,
                    );
                    onCreated(result.email, result.tempPassword);
                  })
                }
                disabled={busy}
              >
                {busy ? 'Working…' : 'Reset password'}
              </Button>
              <Button
                tone="primary"
                onClick={() =>
                  run(async () => {
                    /**
                     * Careful: email and role: **only what really changed** is sent.
                     * Always sending both would pile up "changes" in the audit log where
                     * nothing changed, and later finding "who became manager and when"
                     * would be hard.
                     */
                    if (emailChanged) {
                      await changeLoginEmail(employee.portalUserId!, email.trim());
                    }
                    if (roleChanged) {
                      await changeUserRole(employee.portalUserId!, role);
                    }
                    onSaved();
                  })
                }
                disabled={busy || email.trim() === '' || !hasChanges}
              >
                {busy ? 'Saving…' : 'Save changes'}
              </Button>
            </>
          ) : (
            <Button
              tone="primary"
              onClick={() =>
                run(async () => {
                  const result = await createPortalAccount(
                    employee.id,
                    email.trim(),
                    role,
                    password.trim() || undefined,
                  );
                  onCreated(result.email, result.tempPassword);
                })
              }
              disabled={busy || email.trim() === ''}
            >
              {busy ? 'Creating…' : 'Create account'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3.5">
        <Notice>
          {existing
            ? 'Change the email or the role, then Save. Resetting gives them a new password — shown only once, and it does not change anything else.'
            : 'Set a password below, or leave it empty and one will be generated for you. Either way they can sign in straight away.'}
        </Notice>

        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoFocus
          hint="This is the email they will sign in with"
        />

        {/*
          Careful: **after** the email and before the role: that is the order of work:
             who gets in, with what, and then what they see.
        */}
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          hint="At least 10 characters. Leave it empty and one will be generated."
        />

        {!ownerAccount && (
          <SelectField
            label="Role"
            value={role}
            onChange={(value) => setRole(value as AssignableRole)}
            options={PORTAL_ROLES}
            hint="A staff screen has no buttons — they can only look at their own hours"
          />
        )}

        <ServerError error={error} />
      </div>
    </Modal>
  );
}
