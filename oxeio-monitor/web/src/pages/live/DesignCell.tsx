import type { LiveCard } from '../../api/dashboard';
import { designView } from './roster';

/**
 * How many designs were finished today.
 *
 * Careful: a separate file because two tables use it: the Worklog roster and the
 * Live Board's "Against Today's Target". Duplicating the markup would one day let
 * one change and not the other.
 *
 * Careful: only "finished" is counted (the owner's decision), not file opens. In
 * the field a manager showed "16" while having merely opened 19 files for a total
 * of 44 minutes to look at them. A count of opens cannot tell the one who makes
 * the work from the one who looks at it.
 */
export function DesignCell({ card }: { card: LiveCard }) {
  const view = designView(card);
  if (view === null) return <span className="text-ink-3">—</span>;

  return (
    <span className="num whitespace-nowrap">
      {/* Green only when the target is met; otherwise the number is neutral */}
      <span className={view.met ? 'font-semibold text-ok' : 'font-medium text-ink'}>
        {view.done}
      </span>

      {/*
        Careful: with no target there is no "/ 25" either: that employee has no
           target at all, so writing the fraction would make a claim that is not true.
      */}
      {view.target !== null && (
        <span className="text-ink-3"> / {view.target}</span>
      )}
    </span>
  );
}
