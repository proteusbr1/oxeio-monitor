import { useState } from 'react';
import { Trans } from 'react-i18next';

import { correctDepositInstalment, depositMonths, listDeposits, setDepositStart, settleDeposit, updateDepositPolicy, type DepositBalance } from '../../api/payroll';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import {
  FormGrid,
  FullWidth,
  MiniButton,
  Modal,
  Notice,
  RowActions,
  SelectField,
  ServerError,
  TextField,
  orUndefined,
  useMutation,
} from '../../components/ui';
import { useT } from '../../i18n';

/**
 * **Security deposit.**
 *
 * The owner's rule, as first set up: "500.00 is withheld from salary each month, and anyone who leaves
 * giving 30 days' notice gets the whole deposit back."
 *
 * Careful: this screen is **owner-only**, not even managers: the deposit is a direct
 * part of pay (ADR-023, ADR-027).
 *
 * Important: employees see their own deposit on their own page (`/me`), so they
 * need not come to the owner to learn "how much has been saved"; that is the
 * whole point of the feature.
 */
export function DepositsTab() {
  const t = useT();
  const { data, error, loading, reload } = useApi(
    (signal) => listDeposits(signal),
    [],
  );
  const mutation = useMutation();

  const [editingRule, setEditingRule] = useState(false);
  const [settling, setSettling] = useState<DepositBalance | null>(null);
  const [startFor, setStartFor] = useState<DepositBalance | null>(null);
  /** Opens the month-by-month ledger and the wrong-amount correction screen */
  const [monthsFor, setMonthsFor] = useState<DepositBalance | null>(null);

  const rows = data?.rows ?? [];
  const open = rows.filter((r) => !r.settlement);

  /**
   * Careful: the total is summed **from minor units**, not by parsing the `balance`
   *    string: `Number("500.00")` works, but adding floating-point decimals across
   *    twelve rows would end a cent off, and the owner would notice.
   */
  const heldMinor = open.reduce((sum, r) => sum + r.balanceMinor, 0);

  return (
    <>
      <ServerError error={mutation.error} />

      <Card
        title={t('Security Deposit')}
        hint={
          data
            ? t("{{amount}} a month · refundable with {{days}} days' notice", {
                amount: data.policy.amount,
                days: data.policy.noticeDays,
              })
            : t('Held from salary each month, refunded when someone leaves')
        }
        padded={false}
        actions={
          <RowActions>
            <MiniButton disabled={!data} onClick={() => setEditingRule(true)}>
              {t('Edit rule')}
            </MiniButton>
          </RowActions>
        }
      >
        {loading && !data ? (
          <Loading label={t('Loading deposits…')} />
        ) : !data ? (
          <ErrorBox error={error} retry={reload} />
        ) : rows.length === 0 ? (
          <Empty title={t('No staff yet')} />
        ) : (
          <>
            {/*
              Important: the total is at the top, once. The owner's first question is
                 "how much money of mine is being held in all"; nobody would ever work
                 that out by counting rows and adding.
              Careful: settled employees are excluded: that money is no longer held;
                 it has been returned (or forfeited).
            */}
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
              <span className="num text-[19px] font-semibold">
                {amountOf(heldMinor)}
              </span>
              <span className="text-[12px] text-ink-2">
                {t('held from {{count}} people', { count: open.length })}
              </span>
            </div>

            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li
                  key={row.employeeId}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
                >
                  <span className="min-w-0 flex-1 text-[13px]">
                    <span className="font-medium">{row.fullName}</span>
                    <span className="num ml-2 text-[12px] text-ink-3">
                      {row.empCode}
                    </span>

                    {row.settlement ? (
                      <span className="block text-[12px] text-ink-2">
                        {row.settlement.outcome === 'refunded'
                          ? t('Refunded {{amount}}', { amount: row.settlement.amount })
                          : t('Forfeited {{amount}}', { amount: row.settlement.amount })}
                        {' · '}
                        {row.settlement.noticeDaysGiven === null
                          ? t('notice dates were not recorded')
                          : t("{{given}} days' notice, rule is {{rule}}", {
                              given: row.settlement.noticeDaysGiven,
                              rule: row.settlement.noticeDaysRule,
                            })}
                        {row.settlement.note && ` · ${row.settlement.note}`}
                      </span>
                    ) : (
                      <span className="block text-[12px] text-ink-3">
                        {t('{{count}} months held', { count: row.months })}
                        {/*
                          Important: **which month deductions start from**; without
                             this the owner would have to work it out, and a mistake
                             would go unnoticed.
                          Careful: if the owner picked it, that is stated separately,
                             otherwise "by rule"; showing both alike would hide who set
                             which.
                        */}
                        {row.effectiveStart && (
                          <>
                            {' · '}
                            <Trans
                              i18nKey="from <n>{{month}}</n>"
                              values={{ month: row.effectiveStart }}
                              components={{ n: <span className="num" /> }}
                            />
                            {row.startYearMonth === null && ` ${t('(by rule)')}`}
                          </>
                        )}
                      </span>
                    )}
                  </span>

                  <span
                    className={`num text-[13px] font-semibold ${
                      row.settlement ? 'text-ink-3 line-through' : ''
                    }`}
                  >
                    {row.balance}
                  </span>

                  <RowActions>
                    {/*
                      Careful: once settled, the button **does not exist**: the server
                         returns 409 on a second attempt, so a button would only lead to
                         an error box.
                    */}
                    {/*
                      Careful: once settled the ledger is closed: the server returns
                         409, so the button is gone too.
                    */}
                    {/*
                      Important: **the door to view the months.** The owner used to see
                         only the total (*"2 months held · 500.00"*): both true, together
                         meaningless. Careful: it is viewable even after settlement: a
                         closed ledger means it cannot be changed, not that it cannot
                         be read.
                    */}
                    <MiniButton onClick={() => setMonthsFor(row)}>
                      {t('Months')}
                    </MiniButton>
                    {!row.settlement && (
                      <MiniButton onClick={() => setStartFor(row)}>
                        {t('Start month')}
                      </MiniButton>
                    )}
                    {!row.settlement && row.balanceMinor > 0 && (
                      <MiniButton onClick={() => setSettling(row)}>
                        {t('Settle')}
                      </MiniButton>
                    )}
                  </RowActions>
                </li>
              ))}
            </ul>
          </>
        )}

        <Caveat>
          {t(
            'The instalment is written into the ledger month by month, so changing the amount later never rewrites what was already held. The payroll sheet shows it as its own line: the salary earned stays the same, and only the amount handed over that month goes down.',
          )}
        </Caveat>
      </Card>

      {monthsFor && (
        <MonthsDialog
          row={monthsFor}
          onClose={() => setMonthsFor(null)}
          onSaved={reload}
        />
      )}

      {startFor && (
        <StartMonthDialog
          row={startFor}
          busy={mutation.busy}
          onClose={() => setStartFor(null)}
          onSubmit={(yearMonth) =>
            mutation.run(async () => {
              const result = await setDepositStart(startFor.employeeId, yearMonth);
              setStartFor(null);
              reload();

              /**
               * Careful: it **says how many instalments were deleted**; rows must not
               * vanish silently. If the owner picked the wrong month, this one line
               * tells them at once what happened.
               */
              if (result.removed > 0 || result.added > 0) {
                window.alert(
                  t('Ledger updated — {{removed}} instalment(s) removed, {{added}} added.', {
                    removed: result.removed,
                    added: result.added,
                  }),
                );
              }
            })
          }
        />
      )}

      {editingRule && data && (
        <EditRule
          policy={data.policy}
          busy={mutation.busy}
          onClose={() => setEditingRule(false)}
          onSubmit={(body) =>
            mutation.run(async () => {
              await updateDepositPolicy(body);
              setEditingRule(false);
              reload();
            })
          }
        />
      )}

      {settling && (
        <SettleDialog
          row={settling}
          noticeDays={data?.policy.noticeDays ?? 30}
          busy={mutation.busy}
          onClose={() => setSettling(null)}
          onSubmit={(body) =>
            mutation.run(async () => {
              await settleDeposit(settling.employeeId, body);
              setSettling(null);
              reload();
            })
          }
        />
      )}
    </>
  );
}

/** Minor units to a two-decimal number without the currency symbol, the same as the server's `minorToAmount` */
function amountOf(minor: number): string {
  return (minor / 100).toFixed(2);
}

function EditRule({
  policy,
  busy,
  onClose,
  onSubmit,
}: {
  policy: {
    amount: string;
    startYearMonth: string;
    noticeDays: number;
    active: boolean;
  };
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: {
    amountMinor?: number;
    startYearMonth?: string;
    noticeDays?: number;
    active?: boolean;
  }) => void;
}) {
  const t = useT();
  const [amount, setAmount] = useState(policy.amount);
  const [startYearMonth, setStart] = useState(policy.startYearMonth);
  const [noticeDays, setNotice] = useState(String(policy.noticeDays));
  const [active, setActive] = useState(policy.active ? 'yes' : 'no');

  /**
   * Careful: the button is disabled for an empty or non-numeric field: the server
   *    would return 400 anyway, but showing it is better than sending people into a
   *    wall. Careful: `Number('')` is zero, so the empty field needs a separate check.
   */
  const badAmount = amount.trim() === '' || !(Number(amount) > 0);
  const badNotice =
    noticeDays.trim() === '' || !Number.isInteger(Number(noticeDays));

  return (
    <Modal
      title={t('Security deposit rule')}
      onClose={onClose}
      footer={
        <RowActions>
          <MiniButton onClick={onClose}>{t('Cancel')}</MiniButton>
          <MiniButton
            disabled={busy || badAmount || badNotice}
            onClick={() =>
              onSubmit({
                // The screen takes whole currency units, the API minor units (hundredths); the conversion is in this one place
                amountMinor: Math.round(Number(amount) * 100),
                startYearMonth: orUndefined(startYearMonth),
                noticeDays: Number(noticeDays),
                active: active === 'yes',
              })
            }
          >
            {t('Save')}
          </MiniButton>
        </RowActions>
      }
    >
      <FormGrid>
        <TextField label={t('Amount a month')} value={amount} onChange={setAmount} />
        <TextField
          label={t('Notice required (days)')}
          value={noticeDays}
          onChange={setNotice}
        />
        <TextField
          label={t('Collect from')}
          value={startYearMonth}
          onChange={setStart}
          placeholder="2026-08"
        />
        <SelectField
          label={t('Collecting')}
          value={active}
          onChange={setActive}
          options={[
            { value: 'yes', label: t('Yes — add an instalment each month') },
            { value: 'no', label: t('No — stop adding new instalments') },
          ]}
        />

        <FullWidth>
          <Notice>
            {t(
              "Changing the amount only affects months that have not been recorded yet. Everything already held keeps the amount it was held at, so nobody's balance moves because a rule changed today. Turning collection off leaves every balance untouched.",
            )}
          </Notice>
        </FullWidth>
      </FormGrid>
    </Modal>
  );
}

/**
 * Settlement modal: **the decision is the owner's, the arithmetic is the screen's.**
 *
 * Careful: once both dates are entered, the screen says at once how many days of
 * notice were given and what the rule says, but neither button is ever hidden.
 * Exceptions always exist (hospital, family reasons), and automating it would force
 * the owner to **break** the rule when there would be no way to break it.
 */
function SettleDialog({
  row,
  noticeDays,
  busy,
  onClose,
  onSubmit,
}: {
  row: DepositBalance;
  noticeDays: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: {
    outcome: 'refunded' | 'forfeited';
    noticeGivenOn?: string;
    lastWorkingDay?: string;
    note?: string;
  }) => void;
}) {
  const t = useT();
  const [noticeGivenOn, setNoticeGiven] = useState('');
  const [lastWorkingDay, setLastDay] = useState('');
  const [outcome, setOutcome] = useState<'refunded' | 'forfeited'>('refunded');
  const [note, setNote] = useState('');

  /** Days between the two dates if both are set, end day included, like the server's `daysBetween` */
  const daysGiven =
    noticeGivenOn && lastWorkingDay
      ? Math.round(
          (new Date(lastWorkingDay).getTime() -
            new Date(noticeGivenOn).getTime()) /
            86_400_000,
        )
      : null;

  return (
    <Modal
      title={t("Settle {{name}}'s deposit", { name: row.fullName })}
      onClose={onClose}
      footer={
        <RowActions>
          <MiniButton onClick={onClose}>{t('Cancel')}</MiniButton>
          <MiniButton
            tone={outcome === 'forfeited' ? 'danger' : undefined}
            disabled={busy}
            onClick={() =>
              onSubmit({
                outcome,
                noticeGivenOn: orUndefined(noticeGivenOn),
                lastWorkingDay: orUndefined(lastWorkingDay),
                note: orUndefined(note),
              })
            }
          >
            {outcome === 'refunded' ? t('Refund') : t('Forfeit')}
          </MiniButton>
        </RowActions>
      }
    >
      <FormGrid>
        <FullWidth>
          <Notice>
            {t(
              '{{balance}} held over {{count}} months. This closes the ledger — no further instalments are added, and it cannot be settled twice.',
              { balance: row.balance, count: row.months },
            )}
          </Notice>
        </FullWidth>

        <TextField
          label={t('Notice given on')}
          value={noticeGivenOn}
          onChange={setNoticeGiven}
          type="date"
        />
        <TextField
          label={t('Last working day')}
          value={lastWorkingDay}
          onChange={setLastDay}
          type="date"
        />

        <SelectField
          label={t('Outcome')}
          value={outcome}
          onChange={(v) => setOutcome(v as 'refunded' | 'forfeited')}
          options={[
            { value: 'refunded', label: t('Refund the full amount') },
            { value: 'forfeited', label: t('Forfeit — notice was too short') },
          ]}
        />
        <TextField label={t('Note')} value={note} onChange={setNote} />

        {/*
          Important: the calculation is shown but the buttons are not changed: the
             owner decides knowing the rule; the rule does not decide for them.
          Careful: with no date nothing is claimed: "not known" and "condition not
             met" are not the same thing.
        */}
        <FullWidth>
          {daysGiven === null ? (
            <Notice>
              {t(
                'Without both dates the notice period is not recorded — the settlement still goes through, and the ledger simply says the dates were not known.',
              )}
            </Notice>
          ) : (
            <Notice>
              {t("{{given}} days' notice · the rule asks for {{rule}}.", { given: daysGiven, rule: noticeDays })}{' '}
              {daysGiven >= noticeDays
                ? t('This meets the rule.')
                : t('This is short of the rule — refunding anyway is your call, and the note is a good place to say why.')}
            </Notice>
          )}
        </FullWidth>
      </FormGrid>
    </Modal>
  );
}

/**
 * **From which month this employee's deposit starts being deducted.**
 *
 * Careful: moving the month **forward** deletes the earlier instalments from the
 * ledger; that is this window's real purpose (fixing a mistake), so it is said
 * **before** saving, not after.
 *
 * Important: it uses a `month` input, not a date: the question is "which month",
 * and asking for a day would force the owner into a decision that means nothing.
 */
function StartMonthDialog({
  row,
  busy,
  onClose,
  onSubmit,
}: {
  row: DepositBalance;
  busy: boolean;
  onClose: () => void;
  onSubmit: (yearMonth: string | null) => void;
}) {
  const t = useT();
  const [month, setMonth] = useState(row.startYearMonth ?? row.effectiveStart ?? '');

  return (
    <Modal
      title={t('{{name}} — deposit start', { name: row.fullName })}
      hint={t("From which month this person's deposit started being held")}
      onClose={onClose}
      footer={
        <>
          <MiniButton onClick={onClose}>{t('Cancel')}</MiniButton>
          {/*
            Careful: "back to rule" is a separate button; if you cleared the field and
               saved, it could not be told whether that meant "I said nothing" or
               "return to the rule".
          */}
          {row.startYearMonth !== null && (
            <MiniButton disabled={busy} onClick={() => onSubmit(null)}>
              {t('Use the rule')}
            </MiniButton>
          )}
          <MiniButton
            disabled={busy || month === '' || month === row.startYearMonth}
            onClick={() => onSubmit(month)}
          >
            {busy ? t('Saving…') : t('Save')}
          </MiniButton>
        </>
      }
    >
      <div className="space-y-3.5">
        <Notice>
          <Trans
            i18nKey="Moving this <b>later</b> deletes the instalments before it, and moving it <b>earlier</b> adds the missing ones. The ledger is rebuilt to match the month you choose."
            components={{ b: <b /> }}
          />
        </Notice>

        <TextField
          label={t('Deposit starts from')}
          type="month"
          value={month}
          onChange={setMonth}
          required
          autoFocus
          hint={
            row.startYearMonth === null
              ? t('Currently following the rule ({{month}})', { month: row.effectiveStart ?? '—' })
              : t('Set by you — "Use the rule" puts it back')
          }
        />
      </div>
    </Modal>
  );
}

/**
 * **One person's month-by-month ledger, and correcting a wrong amount.**
 *
 * Careful — why this was needed: the owner's page had only the total, *"2 months
 * held · 500.00"*. Both true, together meaningless, and in the field exactly that
 * question came up: why does OX-10 show 2 months with 500? The cause was one month
 * sitting at 0.00, but **there was no way to see the months** on the owner's screen
 * (only on the employee's own `/me/deposit`).
 *
 * Careful: and even when visible there was **no way to correct**: `ensureLedger()`
 * never updates an existing row (deliberate: if the rule's amount changes, past
 * months are not rewritten). It was finally fixed by a trick that only works on
 * **early** months and was not written down anywhere.
 */
function MonthsDialog({
  row,
  onClose,
  onSaved,
}: {
  row: DepositBalance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const months = useApi(
    (signal) => depositMonths(row.employeeId, signal),
    [row.employeeId],
  );

  const [editing, setEditing] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const mutation = useMutation();

  /**
   * Careful: whole units to minor units happens here, with `Math.round`. Sending a floating-point
   *    product (`500.10 * 100 = 50009.999...`) directly would make the server's
   *    `@IsInt()` return 400, and the owner would not understand what they did wrong.
   */
  const minor = Math.round(Number(amount) * 100);
  const ready =
    Number.isFinite(minor) && minor > 0 && reason.trim().length > 0;

  return (
    <Modal
      title={t('{{name}} — month by month', { name: row.fullName })}
      onClose={onClose}
    >
      {months.loading && <Loading />}
      {months.error && <ErrorBox error={months.error} />}

      {months.data && months.data.months.length === 0 && (
        <Empty
          title={t('No instalments yet')}
          hint={t('The ledger fills month by month once the rule starts.')}
        />
      )}

      {months.data && months.data.months.length > 0 && (
        <ul className="divide-y divide-line">
          {months.data.months.map((m) => (
            <li key={m.yearMonth} className="flex items-center gap-3 py-2">
              <span className="num flex-1 text-[13px]">{m.yearMonth}</span>
              <span className="num text-[13px] font-semibold">{m.amount}</span>
              <MiniButton
                onClick={() => {
                  setEditing(m.yearMonth);
                  setAmount(m.amount);
                  setReason('');
                }}
              >
                {t('Correct')}
              </MiniButton>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <FormGrid>
          <TextField
            label={t('New amount for {{month}}', { month: editing })}
            value={amount}
            onChange={setAmount}
            /*
              Careful: zero cannot be entered, and the reason is written right here:
                 the server and the database both block it, but without the reason on
                 screen the owner would keep trying.
            */
            hint={t('More than zero. To skip the early months use Start month instead.')}
          />
          <TextField
            label={t('Why')}
            value={reason}
            onChange={setReason}
            hint={t('Six months from now this line is the only answer')}
          />
          <FullWidth>
            <ServerError error={mutation.error} />
            <RowActions>
              <MiniButton onClick={() => setEditing(null)}>{t('Cancel')}</MiniButton>
              <MiniButton
                disabled={!ready || mutation.busy}
                onClick={() =>
                  mutation.run(async () => {
                    await correctDepositInstalment(
                      row.employeeId,
                      editing,
                      minor,
                      reason.trim(),
                    );
                    setEditing(null);
                    // Both: the inner list and the outer total, or the screen would
                    //   show two numbers saying two things
                    months.reload();
                    onSaved();
                  })
                }
              >
                {t('Save')}
              </MiniButton>
            </RowActions>
          </FullWidth>
        </FormGrid>
      )}

      <Caveat>
        {t(
          'Correcting a month changes the ledger, not the rule — the amount for every other month stays as it was written. A closed month cannot be corrected; reopen it first.',
        )}
      </Caveat>
    </Modal>
  );
}
