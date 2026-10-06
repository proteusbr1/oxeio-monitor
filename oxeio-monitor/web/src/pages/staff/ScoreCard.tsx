import type { CSSProperties } from 'react';
import { Trans } from 'react-i18next';

import { getDailyProductivity, type ProductivityScore } from '../../api/activity';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Duration } from '../../components/Duration';
import { SectionHead } from '../../components/Page';
import { Caveat, Empty, ErrorBox, Loading } from '../../components/States';
import { useT } from '../../i18n';
import { formatPct, pctOf } from '../../lib/format';

/**
 * D07 — one day's productivity score.
 *
 * Important: **next to the score, "what percent of time is unrecognised" is
 * always shown** (on the English screen, "… % uncategorised"). If 90% of the
 * time is unrecognised, an 80% score is practically meaningless, yet a big
 * bare "80%" would be taken as the verdict on the day and people would be
 * lectured over it. Without both numbers side by side this screen lies.
 *
 * Careful: the whole dashboard uses one word, **uncategorised** (not
 * uncategorized, unknown or unmatched). The D07 tile, the breakdown segments
 * and the D08 category label all match; otherwise readers would think they
 * were three different things.
 *
 * `scorePct === null` means **no data**, not zero. `formatPct()` shows it as
 * `'—'`; there is no `?? 0` anywhere.
 */

/**
 * Careful: the "uncategorised" segment is striped, not solid. With four grey
 * shades side by side, "neutral" and "uncategorised" could not be told apart,
 * yet they mean completely different things: one is "known, and neutral", the
 * other "not known at all". Both colours are brand tokens.
 */
const UNKNOWN_STRIPES: CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, var(--color-paper) 0 3px, var(--color-line) 3px 6px)',
};

interface Slice {
  key: string;
  label: string;
  hint: string;
  seconds: number;
  className: string;
  style?: CSSProperties;
}

export function ScoreCard({
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
    // One day means `from === to`. Parameters are camelCase, otherwise 400.
    (signal) =>
      getDailyProductivity({ employeeId, from: date, to: date }, signal),
    [employeeId, date, nonce],
  );

  // With employeeId the server returns exactly one employee (404 if absent)
  const score = data?.employees[0]?.total;

  return (
    <section>
      <SectionHead
        title={t('Productivity score')}
        hint={t('From the category rules · this number never touches pay')}
      />

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} retry={reload} />
      ) : !score || score.totalSec === 0 ? (
        <Empty
          title={t('No app or site records on this day')}
          hint={t('The score comes from app-usage rows. With no rows there is nothing to score — and zero is not shown, because zero would claim that none of the day was work.')}
        />
      ) : (
        <>
          <Card>
            <Numbers score={score} />
            <Explain score={score} />
            <Breakdown score={score} />
          </Card>
          {data && <Caveat>{data.caveat}</Caveat>}
        </>
      )}
    </section>
  );
}

/** The two numbers always go together: neither can be read without the other */
function Numbers({ score }: { score: ProductivityScore }) {
  // Careful: when the unrecognised share is large it is the real news of the day,
  // so it gets the attention colour. This card has at most one red tile.
  const t = useT();
  const alarming = score.unknownPct >= 50;

  return (
    <div className="flex flex-wrap gap-x-10 gap-y-4">
      <div>
        <div className="text-[11.5px] text-ink-3">{t('Score')}</div>
        <div className="num mt-0.5 text-3xl leading-none font-semibold text-ink">
          {formatPct(score.scorePct)}
        </div>
        <div className="mt-1 text-[11px] text-ink-3">
          {score.scorePct === null
            ? t('No known time to score')
            : t('Share of known time spent on work')}
        </div>
      </div>

      <div>
        <div className="text-[11.5px] text-ink-3">{t('Uncategorised')}</div>
        <div
          className={`num mt-0.5 text-3xl leading-none font-semibold ${
            alarming ? 'text-brand-ink' : 'text-ink-3'
          }`}
        >
          {formatPct(score.unknownPct)}
        </div>
        <div className="mt-1 text-[11px] text-ink-3">
          {t('of the day matched no rule — left out of the score')}
        </div>
      </div>
    </div>
  );
}

function Explain({ score }: { score: ProductivityScore }) {
  /*
    Careful: when unrecognised time is zero, `categorizedSec` and `totalSec` are
       **equal**, so the "not on the full …" comparison would compare a value
       with itself and the screen would read "the 3h 20m of known time …, not on
       the full 3h 20m". The numbers were right, the sentence was meaningless. So
       the comparison part is conditional.
    But the "…% uncategorised" below **stays unconditional**, on purpose; the
       reason is explained below.
  */
  const t = useT();
  const hasUnknown = score.categorizedSec < score.totalSec;

  return (
    <p className="mt-4 rounded-md border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-ink-3">
      {hasUnknown ? (
        <Trans
          i18nKey="The score sits on the <known/> of <b>known</b> time in this day, not on the full <total/> — <b>{{pct}} uncategorised</b>."
          values={{ pct: formatPct(score.unknownPct) }}
          components={{
            known: (
              <Duration
                seconds={score.categorizedSec}
                className="font-semibold text-ink-2"
              />
            ),
            total: (
              <Duration
                seconds={score.totalSec}
                className="font-semibold text-ink-2"
              />
            ),
            b: <b />,
          }}
        />
      ) : (
        <Trans
          i18nKey="The score sits on all <total/> of tracked time in this day — <b>{{pct}} uncategorised</b>."
          values={{ pct: formatPct(score.unknownPct) }}
          components={{
            total: (
              <Duration
                seconds={score.totalSec}
                className="font-semibold text-ink-2"
              />
            ),
            b: <b />,
          }}
        />
      )}
      {/*
        Important: the "…% uncategorised" sentence is **unconditional**, right
           under the score. It used to show only at 30%+, so with 29%
           unrecognised the number was written nowhere on screen, although nearly
           a third of the day was still unknown. The tile is above, but there the
           label comes first and the number after; only this line reads the whole
           thing in one go.
      */}
      {score.unknownPct >= 30 && (
        <>
          {' '}
          {t('With that much of the day unmatched, the number cannot stand as a verdict on anyone. Adding category rules will change it.')}
        </>
      )}
    </p>
  );
}

function Breakdown({ score }: { score: ProductivityScore }) {
  const t = useT();
  const slices: Slice[] = [
    {
      key: 'productive',
      label: t('Productive'),
      hint: t('Marked productive by a rule'),
      seconds: score.productiveSec,
      className: 'bg-ink',
    },
    {
      key: 'neutral',
      label: t('Neutral'),
      hint: t('Known, but neither way'),
      seconds: score.neutralSec,
      className: 'bg-ink-3/45',
    },
    {
      key: 'unproductive',
      label: t('Unproductive'),
      hint: t('Marked unproductive by a rule — hours are still never cut'),
      seconds: score.unproductiveSec,
      className: 'bg-brand-ink',
    },
    {
      key: 'unknown',
      label: t('Uncategorised'),
      hint: t('Matched no rule'),
      seconds: score.unknownSec,
      className: 'bg-paper',
      style: UNKNOWN_STRIPES,
    },
  ];

  return (
    <>
      <div className="mt-4 flex h-3 overflow-hidden rounded-full border border-line">
        {slices
          .filter((s) => s.seconds > 0)
          .map((s) => (
            <div
              key={s.key}
              title={`${s.label} · ${formatPct(pctOf(s.seconds, score.totalSec))}`}
              className={s.className}
              style={{
                width: `${pctOf(s.seconds, score.totalSec)}%`,
                ...s.style,
              }}
            />
          ))}
      </div>

      <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {slices.map((s) => (
          <div
            key={s.key}
            title={s.hint}
            className="flex items-center gap-2 text-[12.5px]"
          >
            <span
              aria-hidden
              className={`size-2.5 flex-none rounded-[2px] border border-line ${s.className}`}
              style={s.style}
            />
            <span className="min-w-0 truncate text-ink-2">{s.label}</span>
            <span className="ml-auto flex items-baseline gap-2">
              <Duration
                seconds={s.seconds}
                tone={s.key === 'productive' ? 'counted' : 'muted'}
              />
              <span className="num w-10 text-right text-[11px] text-ink-3">
                {formatPct(pctOf(s.seconds, score.totalSec))}
              </span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
