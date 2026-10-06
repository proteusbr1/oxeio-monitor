import { useState } from 'react';
import { Trans } from 'react-i18next';

import { getHourly, type HourlyChart as HourlyData } from '../../api/dashboard';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Duration } from '../../components/Duration';
import { SectionHead } from '../../components/Page';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { useT } from '../../i18n';
import { formatDuration, workTimeZoneLabel } from '../../lib/format';

/**
 * E05 — 24 columns: how many minutes of work in each hour.
 *
 * Hand-drawn SVG, no chart library: pulling in a 200 KB dependency for one bar
 * chart makes no sense, and the brand's colour rule (solid `ink` = counted
 * work) would fight the library's default palette.
 * Careful: `ink` does not mean "black"; in the Midnight theme it is almost
 * white (#e8ecf1).
 *
 * Careful: the server only counts `countsAsWork` segments; idle and locked are
 * not in this chart. So the sum here is smaller than the timeline's total, and
 * that is correct.
 */

const PAD_X = 8;
const PAD_TOP = 14;
/** Width per column: 24 x 30 = 720, scrolls on mobile (E12) */
const COL = 30;
const BODY = 104;
const LABELS = 20;

const W = PAD_X * 2 + 24 * COL;
const H = PAD_TOP + BODY + LABELS;
const BASE = PAD_TOP + BODY;
const FULL_HOUR_SEC = 3600;

export function HourlyChart({
  employeeId,
  date,
  nonce,
}: {
  employeeId: number;
  date: string;
  nonce: number;
}) {
  const t = useT();
  const { data, error, loading, reload } = useApi(
    (signal) => getHourly(employeeId, date, signal),
    [employeeId, date, nonce],
  );

  return (
    <section>
      <SectionHead
        title={t('Work by hour')}
        hint={t('Counted time only · 24 hours on the {{zone}} clock', { zone: workTimeZoneLabel() })}
      />

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : !data || data.buckets.length === 0 || data.totalActiveSec === 0 ? (
        <Empty
          title={t('No counted work on this day')}
          hint={t("Idle and locked time never reaches this chart. Grey bands in the timeline above mean the PC was on, but the work wasn't counted.")}
        />
      ) : (
        <Body data={data} />
      )}
    </section>
  );
}

function Body({ data }: { data: HourlyData }) {
  const t = useT();
  const peak = Math.max(...data.buckets.map((b) => b.activeSec));
  /**
   * Important: the scale ceiling is **never below 60 minutes**. Scaling by
   * `peak` alone would make a bar touch the sky on a day whose maximum is 12
   * minutes, making it look like the hour was fully worked. In an hourly chart
   * the hour is the natural ceiling.
   *
   * Careful: `peak` can still exceed 60 minutes: when one person's two PCs run
   * at once, more than 60 seconds per hour accumulate (a sum, not a UNION). The
   * ceiling must grow then, or the bar would leave the frame.
   */
  const ceiling = Math.max(FULL_HOUR_SEC, peak);
  const overFull = peak > FULL_HOUR_SEC;
  const refY = BASE - (FULL_HOUR_SEC / ceiling) * BODY;

  /**
   * Important: the picked hour is **the only way to read a value on a phone**.
   *
   * Each hour's value used to live only in the SVG `<title>`, i.e. in the hover
   * tooltip. A touch screen **never shows it**, so on a phone the chart was 24
   * unnamed bars. `DayPulse` and "Last 7 days" had the same problem and got the
   * same fix: a fixed readout line plus a hit target spanning the whole column.
   * The `<title>` is **kept**: the desktop tooltip and the screen-reader name
   * both come from it.
   */
  const [pick, setPick] = useState<number | null>(null);
  const shown = pick === null ? null : data.buckets.find((b) => b.hour === pick);

  return (
    <>
      <Card padded={false}>
        {/*
          The readout line sits **outside** the scroll frame; inside it, the
             number would move away as the chart is scrolled, yet it is what you read then.
        */}
        <p className="px-4 pt-3 text-xs text-ink-3">
          {shown ? (
            <span className="text-ink-2">
              <span className="num font-semibold text-ink">
                {pad2(shown.hour)}:00–{pad2(shown.hour + 1)}:00
              </span>{' '}
              · <span className="num">{formatDuration(shown.activeSec)}</span>
            </span>
          ) : (
            <Trans
              i18nKey="Counted <b>{{total}}</b> in total"
              values={{ total: formatDuration(data.totalActiveSec) }}
              components={{ b: <span className="num font-semibold text-ink" /> }}
            />
          )}
        </p>

        {/* Careful: the wide chart scrolls **in its own frame**, not the whole page (E12) */}
        <div className="overflow-x-auto px-4 pt-2 pb-4">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full min-w-[620px]"
            role="img"
            aria-label={t('Work by hour — {{total}} in total', { total: formatDuration(data.totalActiveSec) })}
            // When the mouse leaves the chart the readout returns to its default.
            // Phones never fire this event, so the last tapped hour stays shown
            // there, which is desired; otherwise the number would vanish as the finger lifts.
            onMouseLeave={() => setPick(null)}
          >
            {/* One-hour reference line: what the bars are long compared to */}
            <line
              x1={PAD_X}
              x2={W - PAD_X}
              y1={refY}
              y2={refY}
              strokeDasharray="3 4"
              className="stroke-line"
            />
            <text
              x={W - PAD_X}
              y={refY - 4}
              textAnchor="end"
              fontSize={9}
              className="num fill-ink-3"
            >
              60m
            </text>

            {data.buckets.map((b) => {
              const raw = (b.activeSec / ceiling) * BODY;
              // An empty hour still gets a 2px grey mark; drawing nothing would make
              // "no work done" and "no data arrived" look the same
              const barH = b.activeSec > 0 ? Math.max(2, raw) : 2;
              const x = PAD_X + b.hour * COL + 3;
              const w = COL - 6;

              return (
                <g key={b.hour}>
                  <title>
                    {`${pad2(b.hour)}:00–${pad2(b.hour + 1)}:00 · ${formatDuration(b.activeSec)}`}
                  </title>
                  <rect
                    x={x}
                    y={BASE - barH}
                    width={w}
                    height={barH}
                    rx={2}
                    className={b.activeSec > 0 ? 'fill-ink' : 'fill-line'}
                    // When one is picked the others dim, so it is visible which
                    // hour the number above belongs to.
                    opacity={pick === null || pick === b.hour ? 1 : 0.4}
                  />
                  {/*
                    Important: **transparent hit target spanning the full column
                       height.** The real bar can be only 2px tall (an hour with almost
                       no work), which is impossible to aim a finger at. This rectangle
                       is invisible but 30px wide and full height for touch.
                    Careful: the `<title>` stays in the earlier `<g>`, so the tooltip is intact.
                  */}
                  <rect
                    x={PAD_X + b.hour * COL}
                    y={PAD_TOP}
                    width={COL}
                    height={BODY}
                    fill="transparent"
                    style={{ cursor: 'default' }}
                    onMouseEnter={() => setPick(b.hour)}
                    onClick={() => setPick(b.hour)}
                  />
                  <text
                    x={x + w / 2}
                    y={BASE + 14}
                    textAnchor="middle"
                    fontSize={9.5}
                    className="num fill-ink-3"
                  >
                    {b.hour}
                  </text>
                </g>
              );
            })}

            <line
              x1={PAD_X}
              x2={W - PAD_X}
              y1={BASE}
              y2={BASE}
              className="stroke-line"
            />
          </svg>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-[11.5px] text-ink-3">
          <span>{t('Numbers below = hour of the {{zone}} day (0–23)', { zone: workTimeZoneLabel() })}</span>
          <span>
            {t('Counted work this day')}{' '}
            <Duration seconds={data.totalActiveSec} className="text-ink-2" />
          </span>
        </div>
      </Card>

      {overFull && (
        <Caveat>
          <Trans
            i18nKey="Some hours hold <b>more than 60 minutes</b> — one person had two PCs running then, and that time is counted twice."
            components={{ b: <b /> }}
          />
        </Caveat>
      )}
    </>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
