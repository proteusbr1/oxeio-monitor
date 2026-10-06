import { useMemo, useState } from 'react';

import {
  getTimeline,
  type SegmentState,
  type Timeline,
  type TimelineSegment,
} from '../../api/dashboard';
import { useApi } from '../../api/useApi';
import { Card, Stat, StatRow } from '../../components/Card';
import { Duration } from '../../components/Duration';
import { SectionHead } from '../../components/Page';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import {
  formatCount,
  formatDuration,
  formatTime,
  parseWorkDate,
  workOffsetMs,
} from '../../lib/format';

/**
 * E04 — one person's timeline bar for one day.
 *
 * Important: **a separate row per device.** When one person's two PCs run,
 * their segments **overlap** in time (`dashboard.service.ts` deliberately keeps
 * the sum, not a UNION). Drawing them all in one bar would stack one segment on
 * another, making the bar unreadable and hiding that two machines were running.
 * Hence the rows are split by `deviceId`.
 *
 * Colour rule: **solid `ink` = counted work, grey = not counted**. There is no
 * solid red here: being idle is not wrong, it just is not counted.
 *
 * Careful: the on-screen text no longer says "black". In the Midnight theme
 * `--color-ink` is almost white (#e8ecf1), so "Black = counted work" would
 * flatly lie in the dark theme and nobody could tell the text was left over
 * from the old theme. So the text says "Solid / grey", not a colour name.
 */

/** Careful: Asia/Dhaka = UTC+06:00, no DST; the same constant as in `lib/format.ts` */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Minimum width of the bar, in minutes.
 *
 * Careful: if someone worked 20 minutes and the window were 20 minutes, that
 * sliver of time would spread across the whole screen and look like a full
 * day's work. A six-hour minimum window prevents that illusion.
 */
const MIN_WINDOW_MIN = 6 * 60;

const SEG_LABEL: Record<SegmentState, string> = {
  active: 'Working',
  idle: 'Idle',
  locked: 'Screen locked',
};

/**
 * Careful: the three states need three **distinguishable** looks. Idle and
 * locked are both "not counted" but for different reasons: in one a person was
 * there, in the other not. Two similar greys would hide the difference, so
 * locked gets a thin border.
 */
const SEG_CLASS: Record<SegmentState, string> = {
  active: 'bg-ink',
  idle: 'bg-ink-3/45',
  locked: 'border border-ink-3/40 bg-ink-3/15',
};

interface Span {
  seg: TimelineSegment;
  /** Minutes from 00:00 of that day in Dhaka; negative or 1440+ past midnight */
  fromMin: number;
  toMin: number;
  /** Which row it goes in, starting from 1 */
  device: number;
}

interface DeviceRow {
  deviceId: number;
  label: number;
  spans: Span[];
}

interface View {
  rows: DeviceRow[];
  winFrom: number;
  winTo: number;
  ticks: number[];
  /** A segment ran outside this day; this must be said */
  clipped: boolean;
  multiDevice: boolean;
  /** Minute of the "now" line if it falls inside the window, otherwise `null` */
  nowMin: number | null;
}

export function TimelineBar({
  employeeId,
  date,
  nonce,
}: {
  employeeId: number;
  date: string;
  /** Increments when the page's refresh button is pressed */
  nonce: number;
}) {
  const { data, error, loading, reload } = useApi(
    (signal) => getTimeline(employeeId, date, signal),
    [employeeId, date, nonce],
  );

  return (
    <section>
      <SectionHead
        title="Day timeline"
        hint="Hour scale · hover a segment for its times and length"
      />

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : !data || data.segments.length === 0 ? (
        <Empty
          title="No segments on this day"
          hint="The PC was off, it was a day off, or the agent wasn't running — this screen alone can't tell you which. Try another date, or check when that day's last heartbeat arrived."
        />
      ) : (
        <TimelineBody
          // Careful: without a key, after a date change a segment still held by hover
          // would stay in the line below: the previous day's time under the new day.
          key={`${data.employeeId}:${data.date}`}
          timeline={data}
        />
      )}
    </section>
  );
}

function TimelineBody({ timeline }: { timeline: Timeline }) {
  const [hover, setHover] = useState<Span | null>(null);
  const view = useMemo(() => buildView(timeline), [timeline]);

  const span = view.winTo - view.winFrom;
  const clamp = (m: number): number =>
    Math.min(view.winTo, Math.max(view.winFrom, m));
  const leftPct = (m: number): number => ((clamp(m) - view.winFrom) / span) * 100;
  // Careful: a 30-second segment would vanish at zero width. A minimum width
  // makes it look slightly larger, but **that beats being invisible**: an
  // empty bar would make people think no data arrived.
  const widthPct = (s: Span): number =>
    Math.max(0.4, ((clamp(s.toMin) - clamp(s.fromMin)) / span) * 100);

  const { totals, segments } = timeline;

  return (
    <>
      <StatRow>
        <Stat
          label="Counted work"
          value={<Duration seconds={totals.activeSec} />}
        />
        <Stat
          label="Idle"
          value={<Duration seconds={totals.idleSec} tone="muted" />}
          tone="muted"
        />
        <Stat
          label="Screen locked"
          value={<Duration seconds={totals.lockedSec} tone="muted" />}
          tone="muted"
        />
        {/*
          Careful: the device count is not passed as `unit` here: "7" and "2"
             side by side would read "7 2". With several devices the message is
             spelled out in a full sentence in the warning below.
        */}
        <Stat
          label={view.multiDevice ? 'Devices' : 'Segments'}
          value={formatCount(
            view.multiDevice ? view.rows.length : segments.length,
          )}
          tone="muted"
        />
      </StatRow>

      <div className="mt-3">
        <Card padded={false}>
          <div className="p-4">
            <div className="space-y-2">
              {view.rows.map((row) => (
                <div key={row.deviceId} className="flex items-center gap-2">
                  {/*
                    Careful: E12 — on a phone the word "Device" is dropped, only the
                       number remains. On a 360px screen a 64px label column would shrink
                       the bar to 190px and the segments could no longer be told apart.
                  */}
                  {view.multiDevice && (
                    <span
                      className="w-8 flex-none truncate text-[11px] text-ink-3 sm:w-16"
                      title={`Device ID ${row.deviceId}`}
                    >
                      <span className="hidden sm:inline">Device </span>
                      <span className="num">{row.label}</span>
                    </span>
                  )}

                  <div className="relative h-9 min-w-0 flex-1 overflow-hidden rounded-md border border-line bg-paper">
                    {view.ticks.map((m) => (
                      <div
                        key={m}
                        aria-hidden
                        className="absolute top-0 bottom-0 w-px bg-line"
                        style={{ left: `${leftPct(m)}%` }}
                      />
                    ))}

                    {row.spans.map((s) => {
                      const text = describe(s, view.multiDevice);
                      return (
                        <button
                          key={s.seg.id}
                          type="button"
                          title={text}
                          aria-label={text}
                          onMouseEnter={() => setHover(s)}
                          onMouseLeave={() => setHover(null)}
                          onFocus={() => setHover(s)}
                          onBlur={() => setHover(null)}
                          /*
                           * Careful: this is for phones. The fixed line below was
                           *    deliberately used instead of a floating tooltip so it
                           *    can be read by touch, but it was filled only from
                           *    `mouseenter`/`focus`, and Safari does not focus a
                           *    button when tapped. So tapping a segment on a phone
                           *    showed nothing, and the `title` tooltip never appears on
                           *    a touch screen either: the day's detail was completely
                           *    invisible on phones.
                           */
                          onClick={() => setHover(s)}
                          className={`absolute top-0 bottom-0 focus:outline-2 focus:outline-brand focus:[outline-offset:-2px] ${SEG_CLASS[s.seg.state]}`}
                          style={{
                            left: `${leftPct(s.fromMin)}%`,
                            width: `${widthPct(s)}%`,
                          }}
                        />
                      );
                    })}

                    {view.nowMin !== null && (
                      <div
                        aria-hidden
                        title="Now"
                        className="absolute top-0 bottom-0 w-0.5 bg-ink/45"
                        style={{ left: `${leftPct(view.nowMin)}%` }}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Hour axis: same gap as the label column to line up with the track */}
            <div className={view.multiDevice ? 'ml-10 sm:ml-18' : ''}>
              <div className="relative mt-1.5 h-4">
                {view.ticks.map((m, i) => (
                  <span
                    key={m}
                    className="num absolute top-0 text-[10px] whitespace-nowrap text-ink-3"
                    style={{
                      left: `${leftPct(m)}%`,
                      transform:
                        i === 0
                          ? 'none'
                          : i === view.ticks.length - 1
                            ? 'translateX(-100%)'
                            : 'translateX(-50%)',
                    }}
                  >
                    {clockOf(m)}
                  </span>
                ))}
              </div>
            </div>

            {/*
              The hover information sits in a **fixed line**, not a floating
                 tooltip. A floating tooltip cannot be touched on a phone (E12), and
                 over a narrow segment it would go off-screen. The line's height is
                 reserved, otherwise moving the mouse would make everything below jump.
            */}
            <div className="mt-3 min-h-5 text-[12px] text-ink-2">
              {hover ? (
                <span className="num">{describe(hover, view.multiDevice)}</span>
              ) : (
                <span className="text-ink-3">
                  Hover or tap a segment — its start, end and length appear
                  here
                </span>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-ink-3">
              {(['active', 'idle', 'locked'] as SegmentState[]).map((state) => (
                <span key={state} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={`size-2.5 flex-none rounded-[2px] ${SEG_CLASS[state]}`}
                  />
                  {SEG_LABEL[state]}
                </span>
              ))}
              {/* Not a colour name: in Midnight `ink` is almost white (see file header) */}
              <span>Solid = counted work · grey = not counted</span>
            </div>
          </div>
        </Card>
      </div>

      {view.multiDevice && (
        <Caveat>
          <span className="num">{view.rows.length}</span> devices were running
          on this day, so each one gets its own row. Where two rows are filled
          at the same moment, that time is counted <b>twice</b> in the totals
          above.
        </Caveat>
      )}

      {view.clipped && (
        <Caveat>
          A segment crossed midnight. The bar draws only the part that falls on{' '}
          <span className="num">{timeline.date}</span> — the totals above still
          cover the whole segment.
        </Caveat>
      )}
    </>
  );
}

/**
 * Builds a drawable picture from the segments.
 *
 * Careful: the whole function is pure (it lives in `useMemo`); apart from
 *    `new Date()` it has no side effects.
 */
function buildView(t: Timeline): View {
  // Careful: `parseWorkDate` gives UTC midnight; moving back 6 hours gives 00:00 in Dhaka
  const parsed = parseWorkDate(t.date);
  const dayStartMs = (parsed?.getTime() ?? 0) - workOffsetMs();
  const minuteOf = (iso: string): number =>
    (new Date(iso).getTime() - dayStartMs) / 60000;

  const byDevice = new Map<number, Span[]>();
  let clipped = false;

  for (const seg of t.segments) {
    const fromMin = minuteOf(seg.startedAt);
    // Careful: if the clock goes backwards, `endedAt < startedAt` can happen (the
    //    server allows for it too); drawing a negative width would spread the bar backwards
    const toMin = Math.max(fromMin, minuteOf(seg.endedAt));

    if (fromMin < 0 || toMin > MINUTES_PER_DAY) clipped = true;

    const span: Span = { seg, fromMin, toMin, device: 0 };
    const list = byDevice.get(seg.deviceId);
    if (list) list.push(span);
    else byDevice.set(seg.deviceId, [span]);
  }

  const rows: DeviceRow[] = [...byDevice.keys()]
    .sort((a, b) => a - b)
    .map((deviceId, index) => {
      const spans = byDevice.get(deviceId) ?? [];
      for (const s of spans) s.device = index + 1;
      return { deviceId, label: index + 1, spans };
    });

  let lo = MINUTES_PER_DAY;
  let hi = 0;
  for (const row of rows) {
    for (const s of row.spans) {
      lo = Math.min(lo, s.fromMin);
      hi = Math.max(hi, s.toMin);
    }
  }

  // Careful: the window is kept inside the day; spilling outside would put "-01:00"
  //    on the axis, which nobody could read. The part outside is reported via `clipped`.
  let winFrom = clampTo(Math.floor(lo / 60) * 60);
  let winTo = clampTo(Math.ceil(hi / 60) * 60);

  if (winTo - winFrom < MIN_WINDOW_MIN) {
    winTo = Math.min(MINUTES_PER_DAY, winFrom + MIN_WINDOW_MIN);
    winFrom = Math.max(0, winTo - MIN_WINDOW_MIN);
  }

  const hours = (winTo - winFrom) / 60;
  const step = hours <= 8 ? 1 : hours <= 16 ? 2 : 3;
  const ticks: number[] = [];
  for (let m = winFrom; m < winTo; m += step * 60) ticks.push(m);

  // Careful: the last tick is always at the window's right edge (`winTo`). Just
  //    pushing would put 21:00 and 22:00 side by side, one written over the other,
  //    so if less than half a step remains the last tick is **replaced**.
  const last = ticks[ticks.length - 1];
  if (winTo - last < step * 60) ticks[ticks.length - 1] = winTo;
  else ticks.push(winTo);

  const nowMin = (Date.now() - dayStartMs) / 60000;

  return {
    rows,
    winFrom,
    winTo,
    ticks,
    clipped,
    multiDevice: rows.length > 1,
    nowMin: nowMin >= winFrom && nowMin <= winTo ? nowMin : null,
  };
}

function clampTo(minutes: number): number {
  return Math.min(MINUTES_PER_DAY, Math.max(0, minutes));
}

/** Minutes to `'14:00'`. 1440 becomes `'24:00'` (the mockup's axis does the same). */
function clockOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function describe(s: Span, multiDevice: boolean): string {
  const parts = [
    `${formatTime(s.seg.startedAt)}–${formatTime(s.seg.endedAt)}`,
    SEG_LABEL[s.seg.state],
    formatDuration(s.seg.durationSec),
  ];
  if (multiDevice) parts.push(`Device ${s.device}`);
  return parts.join(' · ');
}
