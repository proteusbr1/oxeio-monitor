import type { StatementLine } from '../../api/hoursStatement';
import type { Column } from '../../components/Table';
import { hm } from './hours.format';

/**
 * A line's three figures — hours measured, carried over, to post — with
 * their rounding and the negative "to post" in red. Shared by the Hours
 * statement page and the Live Board's card so the two never disagree; each
 * passes its own headers. Keys: `measured`, `carry`, `toPost`.
 */
export function figureColumns(headers: {
  measured: string;
  carry: string;
  toPost: string;
}): Column<StatementLine>[] {
  return [
    {
      key: 'measured',
      header: headers.measured,
      align: 'right',
      render: (l) => (
        <span className="num">{hm(Math.floor(l.measuredSec / 60))}</span>
      ),
    },
    {
      key: 'carry',
      header: headers.carry,
      align: 'right',
      render: (l) =>
        l.carryInSec === 0 ? (
          <span className="num text-ink-3">—</span>
        ) : (
          <span className="num">{hm(Math.trunc(l.carryInSec / 60))}</span>
        ),
    },
    {
      key: 'toPost',
      header: headers.toPost,
      align: 'right',
      render: (l) => (
        <span
          className={`num font-semibold ${l.toPostMin < 0 ? 'text-brand-ink' : ''}`}
        >
          {hm(l.toPostMin)}
        </span>
      ),
    },
  ];
}
