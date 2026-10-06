import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { getEmployee } from '../../api/staff';
import { useApi } from '../../api/useApi';
import { DatePicker } from '../../components/DatePicker';
import { Button, Page } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import {
  formatDate,
  isValidWorkDate,
  todayInDhaka,
  weekdayOf,
} from '../../lib/format';
import { Adjustments } from './Adjustments';
import { HourlyChart } from './HourlyChart';
import { DayShots } from './DayShots';
import { ScoreCard } from './ScoreCard';
import { TimelineBar } from './TimelineBar';
import { TopUsage } from './TopUsage';

/**
 * E04 · E05 · D07 · D08 — one employee's single day (`/staff/:id`).
 *
 * The date lives **in the URL** (`/staff/3?date=2026-08-09`), so when a manager
 * sends the link, the recipient sees exactly that day and nobody has to ask
 * "which date do you mean?". It uses `replace: true`, otherwise pressing the
 * previous/next arrows five times would take five Back clicks to undo.
 *
 * The four sections fetch their data **separately**. If one endpoint fails or
 * returns 403, the other three still show; one big try/catch would blank the
 * whole page on a single failure.
 *
 * Careful: all four endpoints are owner + manager (`role = employee` gets 403,
 * and `<ErrorBox>` then shows "You don't have access"). Nothing on this page is
 * owner-only: pay is never shown here and never requested.
 *
 * The time-adjustments list (J08) is here now. The three routes
 * (`GET /employees/:id/time-adjustments` and friends) exist on the server; the
 * table used to have no read or write API at all (G35).
 *
 * Careful: the adjustments section is **not tied to the date**, while the rest
 * of the page is one day. This is intentional: adjustments are rare, and
 * answering "was anything granted last month?" day by day would never happen.
 */
export function EmployeeDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  /** Refresh button: asks all four sections to fetch again */
  const [nonce, setNonce] = useState(0);

  const employeeId = Number(id);
  const validId = Number.isInteger(employeeId) && employeeId > 0;

  const today = todayInDhaka();
  const raw = params.get('date');
  // Careful: whatever the URL says, an invalid or future date is never sent to
  // the server. Quietly falling back to today beats showing a 400.
  const date = raw && isValidWorkDate(raw) && raw <= today ? raw : today;

  const {
    data: employee,
    error,
    loading,
    reload,
  } = useApi(
    (signal) =>
      validId
        ? getEmployee(employeeId, signal)
        : // NaN would get a 400 from the ParseIntPipe, so never go to the network
          Promise.reject(new Error("That staff link isn't valid")),
    [employeeId, validId, nonce],
  );

  const setDate = (next: string): void => {
    setParams({ date: next }, { replace: true });
  };

  if (!validId) {
    return (
      <Page title="Staff member">
        <Empty
          title="That link isn't valid"
          hint="This page's address should look like `/staff/3`. Open it by clicking someone's card on the Live Board."
        />
      </Page>
    );
  }

  // If the employee itself is not found, the four sections below would show the
  // same 404/403 four times; one error box is enough.
  if (loading && !employee) {
    return (
      <Page title="Staff member">
        <Loading />
      </Page>
    );
  }

  if (error || !employee) {
    return (
      <Page title="Staff member">
        <ErrorBox error={error} retry={reload} />
      </Page>
    );
  }

  return (
    <Page
      title={employee.fullName}
      subtitle={
        <>
          <span className="num">{employee.empCode}</span>
          {employee.designation ? ` · ${employee.designation}` : ''}
          {employee.department ? ` · ${employee.department}` : ''}
          {' — '}
          <span className="num">{formatDate(date)}</span>, {weekdayOf(date)}
          {date === today ? ' (Today)' : ''}
          {/*
            Careful: this says "Inactive", not "Idle". The dictionary maps
               inactive to Idle, but that is the live board's **current state**.
               The `status` here means whether the employee record is active; a
               person who left the company would read "Idle" and a manager would
               think they were sitting there right now.
          */}
          {employee.status === 'inactive' ? ' · Inactive staff' : ''}
        </>
      }
      actions={
        <>
          {/*
            Careful: `label` is passed explicitly. The default label of `<DatePicker>`
               lives in another file; this keeps the page fully English even before that changes.
          */}
          <DatePicker
            value={date}
            onChange={setDate}
            label="Date"
            max={today}
            withArrows
          />
          <Button
            onClick={() => setNonce((n) => n + 1)}
            title="Reloads every section on this page"
          >
            Refresh
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <TimelineBar employeeId={employeeId} date={date} nonce={nonce} />
        <HourlyChart employeeId={employeeId} date={date} nonce={nonce} />
        <ScoreCard employeeId={employeeId} date={date} nonce={nonce} />
        <TopUsage employeeId={employeeId} date={date} nonce={nonce} />

        {/* The hours-adjustment section goes **before** the pictures: it explains the
            numbers, and right after reading the numbers above the question "was the
            agent off that day?" comes up. */}
        <Adjustments employeeId={employeeId} nonce={nonce} />

        {/* The pictures come last, on purpose. The numbers (how many hours, which
            hour, which site) should be read first; with pictures earlier the eye
            would stick to them, and this system's decisions rest on the numbers,
            not the pictures. Pictures are evidence, not the main measure. */}
        <DayShots employeeId={employeeId} date={date} nonce={nonce} />
      </div>
    </Page>
  );
}
