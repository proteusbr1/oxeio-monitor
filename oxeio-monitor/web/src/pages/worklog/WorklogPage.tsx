import { ApiError } from '../../api/client';
import { getLiveBoard } from '../../api/dashboard';
import { usePolling } from '../../api/useApi';
import { useAuth } from '../../auth/AuthContext';
import { Page } from '../../components/Page';
import { ErrorBox, Loading } from '../../components/States';
import { dayDuty } from '../live/roster';
import { TeamRoster } from '../live/TeamRoster';

/**
 * **Worklog: who is working right now, and who is not.**
 *
 * The cards used to be at the **very bottom** of the Live Board, past six
 * tiles and four charts, yet *"who is working now?"* is the most frequently
 * asked question. At the owner's request they moved to a page of their own,
 * one click away.
 *
 * Careful: **moved off the Live Board, not copied.** With both places, one
 * day one would change and not the other. The board now keeps the summary
 * (tiles, charts and the team table); the cards are here.
 *
 * Careful: the refresh rhythm is **15 seconds**, the same as the board (equal to
 * `BOARD_REFRESH_MS`). If they differed, two pages could show two numbers at
 * the same moment, with no way to say which is fresher.
 */

/** Careful: keep in step with `BOARD_REFRESH_MS` in `LiveBoardPage` */
const REFRESH_MS = 15_000;

export function WorklogPage() {
  const { user } = useAuth();

  /**
   * Careful: owner and manager: exactly the same as `@Roles` on the `/live`
   *    controller. If the page opened for an employee, their browser would
   *    collect a 403 every 15 seconds for no benefit.
   */
  const canView = user?.role === 'owner' || user?.role === 'manager';

  const board = usePolling(
    (signal) => (canView ? getLiveBoard(signal) : Promise.resolve(null)),
    REFRESH_MS,
    [canView],
  );

  if (!canView) {
    return (
      <Page title="Worklog">
        <ErrorBox error={new ApiError(403, "You don't have access")} />
      </Page>
    );
  }

  const data = board.data;

  return (
    <Page
      title="Worklog"
      subtitle="Who is working right now, and who is not"
    >
      {/*
        Careful: a refresh does not put the whole screen into loading:
           `usePolling` keeps the old data. Otherwise the cards would flicker
           every 15 seconds and nobody could finish reading even one.
      */}
      {board.loading && !data ? (
        <Loading label="Loading the team…" />
      ) : !data ? (
        <ErrorBox error={board.error} retry={board.reload} />
      ) : (
        <TeamRoster
          cards={data.cards}
          canView={canView}
          // Careful: no-target staff work today too (`'none'`), so they count here
          withTarget={
            data.cards.filter((c) => dayDuty(c) !== 'off').length
          }
        />
      )}
    </Page>
  );
}
