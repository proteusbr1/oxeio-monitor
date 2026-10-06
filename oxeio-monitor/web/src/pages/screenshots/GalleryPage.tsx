import { useCallback, useMemo, useState } from 'react';

import { getGallery, type GalleryQuery } from '../../api/screenshots';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { DatePicker } from '../../components/DatePicker';
import { EmployeePicker } from '../../components/EmployeePicker';
import { Button, Page } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { useAuth } from '../../auth/AuthContext';
import { formatCount, formatDate, todayInWorkZone } from '../../lib/format';
import { Lightbox } from './Lightbox';
import { ShotGrid } from './ShotGrid';
import { useFreshUrls } from './useFreshUrls';
import { seesEveryone } from '../../api/auth';

/**
 * Screenshot gallery (`/screenshots`).
 *
 * Important: this page has no `@Roles`; owner, manager and staff all come here. The
 * difference is in the **scope**: for staff the server sets `employeeId` from the
 * session, so the staff filter is **not shown at all**. Showing it would do two
 * kinds of harm: leak the list of colleagues' names (`GET /employees` returns 403
 * for them), and let them pick someone else's ID and get a 403 from a control that
 * was offered to them.
 *
 * Important: the page carries a **permanent** note that viewing a screenshot is
 * recorded in the audit log. It is not something to hide; it is part of the
 * transparency promise: staff know they are being watched, and who looked is
 * recorded too.
 */
export function GalleryPage() {
  const { user } = useAuth();
  // Staff only get their own shots; nothing to pick
  /**
   * Careful: the name `isEmployee` **stays**, but the logic is inverted: the question
   * is now *"does this person not see the whole team?"*. It used to be
   * `role === 'employee'`, so a researcher role would get **everyone's shots** and the
   * picker too: the server would block it, the screen would not.
   */
  const isEmployee = !seesEveryone(user?.role);

  const [date, setDate] = useState(() => todayInWorkZone());
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  /** `null` = lightbox closed */
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  /**
   * Careful: the query is in `useMemo`; it is both the `useApi` dep **and** the
   *    reset signal for `useFreshUrls`. A new object each render would make both run
   *    forever.
   *
   * Careful: for staff `employeeId` is never sent. Sending their own ID would work,
   *    but that trusts the ID from `/auth/me`. The server takes it from the session,
   *    which is the only source of truth.
   */
  const query = useMemo<GalleryQuery>(
    () => ({
      date,
      page,
      employeeId: isEmployee ? undefined : (employeeId ?? undefined),
    }),
    [date, page, employeeId, isEmployee],
  );

  const { data, error, loading, reload } = useApi(
    (signal) => getGallery(query, signal),
    [query],
  );
  const urls = useFreshUrls(query);

  const items = data?.items ?? [];

  /** Back to page 1 when a filter changes, or "Page 3" would show empty */
  const changeDate = useCallback((next: string) => {
    setDate(next);
    setPage(1);
    setOpenIndex(null);
  }, []);

  const changeEmployee = useCallback((next: number | null) => {
    setEmployeeId(next);
    setPage(1);
    setOpenIndex(null);
  }, []);

  const changePage = useCallback((next: number) => {
    setPage(next);
    setOpenIndex(null);
    // Careful: if the page changes while scroll stays at the bottom, nothing seems to happen
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <Page
      title="Screenshots"
      subtitle={
        data
          ? `${formatDate(data.date)} · ${formatCount(data.total)} ${
              data.total === 1 ? 'image' : 'images'
            }`
          : formatDate(date)
      }
      actions={
        <>
          {!isEmployee && (
            <EmployeePicker
              value={employeeId}
              onChange={changeEmployee}
              // Careful: `label`/`allLabel` are explicit because the component's two
              //    defaults are still Bengali, and they live in another owner's file
              label="Staff"
              allowAll
              allLabel="Everyone"
              // Careful: a departed employee's old days must stay viewable, or their
              //    name could not be picked even though their screenshots exist
              includeInactive
            />
          )}
          <DatePicker
            label="Date"
            value={date}
            onChange={changeDate}
            withArrows
          />
        </>
      }
    >
      <AuditNote isEmployee={isEmployee} />

      {loading && !data ? (
        <Loading label="Loading screenshots…" />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : items.length === 0 && data?.screenshotsOff ? (
        <Empty
          title="Screenshots are off for this person"
          hint={
            <>
              Their work policy does not take screenshots (Settings → Policies).
              Hours, idle time and the jiggler check are counted as usual.
            </>
          }
        />
      ) : items.length === 0 ? (
        <Empty
          title="No screenshots on this day"
          hint={
            <>
              Screenshots are taken only while someone is <b>working</b> — if
              a person stayed idle all day, or the agent was down, the day
              stays empty. On a weekly off or a holiday that is exactly what
              you should see. Try another date.
            </>
          }
        />
      ) : (
        <>
          <ShotGrid
            items={items}
            urls={urls}
            // Careful: when "Everyone" is shown, shots are unidentifiable without a name
            showName={!isEmployee && employeeId === null}
            onOpen={setOpenIndex}
          />

          {data && data.totalPages > 1 && (
            <div className="mt-3">
              <Pager
                page={data.page}
                totalPages={data.totalPages}
                onChange={changePage}
              />
            </div>
          )}
        </>
      )}

      {/*
        Mounted conditionally: open means created, closed means gone. So scroll-lock
        and focus-restore bookkeeping is settled in the `useEffect` cleanup.
        Careful: `openIndex` can fall outside the list (if a refresh shrinks the
           gallery), so the item is checked to really exist.
      */}
      {openIndex !== null && items[openIndex] && (
        <Lightbox
          items={items}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          urls={urls}
        />
      )}
    </Page>
  );
}

/**
 * Transparency note. Careful: this is not a `<Caveat>`: a caveat means "read the
 * number carefully", and this is a **promise**. So a thin brand line, not a warning ⚠.
 */
function AuditNote({ isEmployee }: { isEmployee: boolean }) {
  return (
    <p className="mb-3 rounded-lg border border-brand/30 bg-brand-bg px-3.5 py-2.5 text-xs text-ink-2">
      {/* Careful: the sentence must be exactly this: "Opening a screenshot is recorded
          in the audit log." The <b> only emphasises; it does not break the text */}
      Opening a screenshot is <b>recorded in the audit log</b> — who opened
      it, when, and whose screen it was.{' '}
      {isEmployee
        ? 'You can only see your own screenshots.'
        : 'Even opening this page writes a row.'}
    </p>
  );
}

function Pager({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (next: number) => void;
}) {
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <Button onClick={() => onChange(page - 1)} disabled={page <= 1}>
          ◀ Previous
        </Button>
        <Button
          onClick={() => onChange(page + 1)}
          disabled={page >= totalPages}
        >
          Next ▶
        </Button>
        {/* Careful: `.num` goes only on the numbers, not the words; it brings
            tabular-nums, and a whole sentence in the mono font would look clumsy */}
        <span className="ml-auto text-xs text-ink-3">
          Page <span className="num">{formatCount(page)}</span> /{' '}
          <span className="num">{formatCount(totalPages)}</span>
        </span>
      </div>
    </Card>
  );
}
