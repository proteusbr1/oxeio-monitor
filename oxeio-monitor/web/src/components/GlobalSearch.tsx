import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { listEmployees, type EmployeeView } from '../api/staff';
import { useApi } from '../api/useApi';
import { useAuth } from '../auth/AuthContext';
import {
  compareNames,
  formatDate,
  isValidWorkDate,
  shiftWorkDate,
  todayInWorkZone,
  weekdayOf,
} from '../lib/format';
import { seesEveryone } from '../api/auth';

/**
 * E14: the header's global search. Pressing `/` focuses it.
 *
 * The server is called once per session, not on every keystroke. A list of
 * fifteen people is so small that fetching it once and filtering on the client is
 * faster; a request per typed character would return results out of order (a
 * race without debounce) and fill the audit/access log for no reason.
 *
 * The list is fetched the first time the box gets focus, not on mount. The header
 * sits on every page; fetching on mount would send one `GET /employees` per page
 * load even for someone who never searches.
 *
 * Careful: for `role = employee` the box does not exist at all (`return null`).
 * There is nobody else for them to look at, and `GET /employees` gives them a 403;
 * showing the box would make them type and get a failed request every time. (The
 * same reasoning as J05, as with the staff filter hidden in the gallery.)
 */
export function GlobalSearch() {
  const { user } = useAuth();
  // Careful: the condition is an allow-list. Writing `!== 'employee'` would give
  // coordinators a search box over the whole team's names too.
  if (!seesEveryone(user?.role)) return null;
  return <SearchBox />;
}

// ── Pure part (no I/O; this much can be tested without the DB or DOM) ────────

export interface ParsedQuery {
  /** `YYYY-MM-DD`, or `null` if no date was found. */
  date: string | null;
  /** What remains after removing the date: the name/code part of the search. */
  text: string;
  /** A date was found, but it is after today in the work zone. */
  future: boolean;
}

/**
 * Splits the text into "one date + the rest".
 *
 * Both can be written together: "Alex 2026-08-01" means "Alex's day on 1
 * August". This is the most useful form, because a manager usually knows whose
 * day they want to see.
 *
 * Careful: although the screen language is English, names stay as written in
 * the DB, in whatever script, so the search text may be in that script too.
 * That is why the NFC normalization in `fold()` below stays.
 */
export function parseSearchQuery(raw: string, today: string): ParsedQuery {
  const tokens = raw.trim().split(/\s+/).filter((t) => t !== '');

  let date: string | null = null;
  const rest: string[] = [];

  for (const token of tokens) {
    /**
     * Careful: only the first date is taken; the second is searched as a name and
     * matches nothing. Intentional: there is no date range here, and if
     * `2026-08-01 2026-08-05` quietly opened the first day, it would look as if the
     * range worked. Ranges belong to the reports page.
     */
    if (date !== null) {
      rest.push(token);
      continue;
    }

    const asDate = parseDateToken(token, today);
    if (asDate !== null) date = asDate;
    else rest.push(token);
  }

  return {
    date,
    text: rest.join(' '),
    future: date !== null && date > today,
  };
}

/**
 * Whether a word is a date.
 *
 * The screen language is English, so `today` / `yesterday` are recognised.
 *
 * Careful: words that are ambiguous between days are not accepted (some
 * languages use one word for both yesterday and tomorrow). Not recognising a
 * word beats opening the timeline of the wrong day: if it is not recognised the
 * user will type the date, and nobody would ever notice the wrong day. For the
 * same reason there is no "tomorrow": a future day has nothing to look at here.
 */
function parseDateToken(token: string, today: string): string | null {
  // Careful: `toLowerCase()` so that "Today" at the start of a sentence is recognised too
  const word = token.toLowerCase();
  if (word === 'today') return today;
  if (word === 'yesterday') return shiftWorkDate(today, -1);

  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(token);
  if (m === null) return null;

  /**
   * The four-digit part is the year, so both `2026-08-01` (ISO) and `01/08/2026`
   * (day first) work, with no guessing about which is day and which is month.
   * Careful: two-digit years (`01/08/26`) are not accepted: with three numbers it
   * is no longer certain which one is the year, and a wrong guess would open another
   * day's timeline, one that looks perfect and is merely the wrong day.
   */
  let year: string;
  let month: string;
  let day: string;
  if (m[1].length === 4) [year, month, day] = [m[1], m[2], m[3]];
  else if (m[3].length === 4) [year, month, day] = [m[3], m[2], m[1]];
  else return null;

  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  // Careful: `2026-02-31` is stopped here: `parseWorkDate` checks it on the way
  // back; otherwise `new Date()` would quietly turn it into 3 March
  return isValidWorkDate(iso) ? iso : null;
}

/**
 * Careful: NFC normalization is applied because names may be in any script.
 * Many characters (accented Latin letters, some Indic vowel signs) can be
 * written in Unicode in two ways: as one code point, or as two combined.
 * Keyboards produce either. Without normalizing,
 * typing a name would fail to find that very name, while the two texts look
 * identical on screen, a mistake nobody could ever catch.
 */
function fold(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/**
 * How good the match is: smaller means higher up. `null` if no match.
 *
 * Careful: staff who have left are in the list too (their old days must be
 * viewable), but always below the active ones. Otherwise a departed employee with
 * the same name would sit on top and pressing Enter would land on the wrong
 * person's page.
 */
function rankOf(emp: EmployeeView, needle: string): number | null {
  const code = fold(emp.empCode);
  const name = fold(emp.fullName);
  const email = emp.email === null ? '' : fold(emp.email);

  const words = name.split(/\s+/);

  let rank: number;
  if (code === needle) rank = 0;
  else if (code.startsWith(needle)) rank = 1;
  /**
   * Careful: given name first, family name after. Typing "Alex" puts "Alexandra
   * Silva" on top and "Maria Alex" below it: both are there, but the order is
   * predictable. With both at the same level the tie would break alphabetically,
   * and whose page Enter lands on would depend on name spelling, which looks
   * random to the user.
   */
  else if (words[0].startsWith(needle)) rank = 2;
  else if (words.some((word) => word.startsWith(needle))) rank = 3;
  else if (name.includes(needle)) rank = 4;
  else if (code.includes(needle)) rank = 5;
  else if (email !== '' && email.includes(needle)) rank = 6;
  else return null;

  return emp.status === 'inactive' ? rank + 10 : rank;
}

/** Empty `query` = everyone (for a date-only search: "whose day do you want to see?"). */
export function matchEmployees(
  rows: EmployeeView[],
  query: string,
  limit: number,
): EmployeeView[] {
  const needle = fold(query.trim());

  return rows
    .map((emp) => ({
      emp,
      rank:
        needle === '' ? (emp.status === 'inactive' ? 10 : 0) : rankOf(emp, needle),
    }))
    .filter((row): row is { emp: EmployeeView; rank: number } => row.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank || compareNames(a.emp.fullName, b.emp.fullName),
    )
    .slice(0, limit)
    .map((row) => row.emp);
}

// ── The box ─────────────────────────────────────────────────────────────────

/**
 * Careful: a module-level constant; a new array on every render would make
 * `useMemo` pointless.
 */
const NO_ROWS: EmployeeView[] = [];
const NOT_FETCHED = { rows: NO_ROWS, total: 0 };

function SearchBox() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  /** Focus has happened once; until then the network is not touched. */
  const [armed, setArmed] = useState(false);
  const [active, setActive] = useState(0);

  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data, error, loading } = useApi(
    (signal) =>
      armed ? listEmployees({ status: 'all' }, signal) : Promise.resolve(NOT_FETCHED),
    [armed],
  );

  // Careful: counted afresh on every render, not in `useMemo`: if a tab stays
  // open all night, "today" changes at midnight and a memo would never know
  const today = todayInWorkZone();
  const parsed = useMemo(() => parseSearchQuery(query, today), [query, today]);

  const rows = data?.rows;
  const people = useMemo(() => {
    if (parsed.future) return NO_ROWS;
    if (parsed.text === '' && parsed.date === null) return NO_ROWS;
    // For a date-only search everyone is shown: "whose day do you want to see?"
    return matchEmployees(rows ?? NO_ROWS, parsed.text, parsed.text === '' ? 20 : 8);
  }, [rows, parsed]);

  // When results change, the selection returns to the top; otherwise, if row 5
  // was selected and the new list has two results, Enter would do nothing
  useEffect(() => setActive(0), [query]);

  const go = useCallback(
    (emp: EmployeeView) => {
      /**
       * The date goes in the URL (`/staff/3?date=2026-08-01`). `EmployeeDetailPage`
       * reads the date from there, so a link sent to someone opens exactly that day.
       */
      navigate(
        parsed.date !== null && !parsed.future
          ? `/staff/${emp.id}?date=${parsed.date}`
          : `/staff/${emp.id}`,
      );
      setOpen(false);
      setQuery('');
      inputRef.current?.blur();
    },
    [navigate, parsed],
  );

  /**
   * `/` focuses the box from anywhere.
   *
   * Careful: if someone is typing in another field, their `/` is not taken away;
   * otherwise typing a path in settings would make focus jump to the header every time.
   * Careful: without `preventDefault()`, Firefox's quick-find bar would open too.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;

      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable ||
          el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT')
      ) {
        return;
      }

      e.preventDefault();
      inputRef.current?.focus();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Close on outside click. Careful: `mousedown`, not `click`, so that clicking
  // a result does not make the panel move out from under the finger.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Careful: otherwise the caret would jump to the start/end of the text
      e.preventDefault();
      setOpen(true);
      if (people.length === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : people.length - 1;
      setActive((i) => (i + step) % people.length);
      return;
    }
    if (e.key === 'Enter' && active < people.length) {
      e.preventDefault();
      go(people[active]);
    }
  };

  const activeId =
    active < people.length ? `gs-opt-${people[active].id}` : undefined;

  return (
    <div ref={boxRef} className="relative order-last w-full sm:order-none sm:w-64">
      {/*
        Careful: on a phone the box drops to the header's lower row (`order-last
           w-full`). Forcing it onto the same row would squeeze the logo, name and
           logout together at 375px and make them all unreadable (E12).
      */}
      <input
        ref={inputRef}
        type="search"
        value={query}
        role="combobox"
        aria-expanded={open}
        aria-controls="gs-list"
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label="Search staff or a date"
        placeholder="Name, code or date  ( / )"
        onFocus={() => {
          setArmed(true);
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-white/20 bg-white/10 px-2.5 py-1.5 text-[13px] text-white placeholder:text-white/45 focus:border-brand focus:ring-2 focus:ring-brand/40 focus:outline-none"
      />

      {open && (
        <div className="absolute top-full right-0 left-0 z-40 mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          <Panel
            parsed={parsed}
            people={people}
            active={active}
            loading={loading && rows === undefined}
            error={error}
            onHover={setActive}
            onPick={go}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Three states here too: loading, error, and nothing found. Without the last one,
 * typing and seeing an empty box would look as if the search itself were broken.
 */
function Panel({
  parsed,
  people,
  active,
  loading,
  error,
  onHover,
  onPick,
}: {
  parsed: ParsedQuery;
  people: EmployeeView[];
  active: number;
  loading: boolean;
  error: Error | null;
  onHover: (index: number) => void;
  onPick: (emp: EmployeeView) => void;
}) {
  if (loading) return <Note>Loading the staff list…</Note>;

  if (error !== null) {
    return (
      <Note tone="brand">
        Couldn't load the staff list — try again in a moment.
      </Note>
    );
  }

  if (parsed.future) {
    return (
      <Note>
        <b>{formatDate(parsed.date ?? '')}</b> hasn't happened yet. Try today or
        any earlier day.
      </Note>
    );
  }

  if (parsed.text === '' && parsed.date === null) {
    return (
      <Note>
        Type a staff <b>name</b> or <b>code</b>. Add a date (
        <span className="num">2026-08-01</span>, <span className="num">01/08/2026</span>,{' '}
        <b>yesterday</b>) to open that day's timeline.
      </Note>
    );
  }

  if (people.length === 0) {
    return (
      <Note>
        Nothing matched. Try part of a name, an empCode or a date — people who
        have left show up here too.
      </Note>
    );
  }

  return (
    <>
      {parsed.date !== null && (
        <p className="border-b border-line px-3 py-2 text-[11.5px] text-ink-3">
          {/*
            Careful: `weekdayOf()` returns `Mon`, complete by itself; no word
               for "day" is appended after it.
          */}
          {formatDate(parsed.date)} · {weekdayOf(parsed.date)} —{' '}
          {parsed.text === '' ? 'whose day?' : "that day's timeline"}
        </p>
      )}

      <ul id="gs-list" role="listbox" className="max-h-80 overflow-y-auto py-1">
        {people.map((emp, i) => (
          <li
            key={emp.id}
            id={`gs-opt-${emp.id}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(emp)}
            className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-[13px] ${
              i === active ? 'bg-brand-bg text-ink' : 'text-ink-2'
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{emp.fullName}</span>
            {emp.status === 'inactive' && (
              <span className="flex-none text-[11px] text-ink-3">Inactive</span>
            )}
            <span className="num flex-none text-[11.5px] text-ink-3">
              {emp.empCode}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Note({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'brand';
}) {
  return (
    <p
      className={`px-3 py-2.5 text-xs ${
        tone === 'brand' ? 'text-brand-ink' : 'text-ink-3'
      }`}
    >
      {children}
    </p>
  );
}
