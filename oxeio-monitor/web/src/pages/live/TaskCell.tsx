import type { LiveCard } from '../../api/dashboard';
import { taskView } from './roster';

/**
 * How many tasks were finished today.
 *
 * Careful: a separate file because two tables use it: the Worklog roster and the
 * Live Board's "Against Today's Target". Duplicating the markup would one day let
 * one change and not the other.
 *
 * Careful: only "finished" is counted, not starts. A start only says a window
 * whose title begins with the task number was opened, which cannot tell the
 * one who does the work from the one who looks at it.
 */
export function TaskCell({ card }: { card: LiveCard }) {
  const view = taskView(card);
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
      {view.target !== null && <span className="text-ink-3"> / {view.target}</span>}
    </span>
  );
}
