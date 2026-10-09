/**
 * The hours to post for one person in one statement — a running ledger.
 *
 *   carry-in = (credited time, as it stands now, over every earlier statement
 *               line of this person) − (minutes posted for those lines × 60)
 *   to post  = (measured in this period + carry-in), whole minutes, rounded down
 *
 * So a correction to any earlier day, the seconds dropped by rounding, and a
 * posted value different from the proposal all surface exactly once, in the
 * next statement. "Posted" is the value recorded on the screen, or the
 * proposal when nothing different was recorded.
 */
export function statementLine(input: {
  measuredSec: number;
  earlierRealSec: number;
  earlierPostedMin: number;
}): { carryInSec: number; toPostMin: number } {
  const carryInSec = input.earlierRealSec - input.earlierPostedMin * 60;
  return {
    carryInSec,
    toPostMin: Math.floor((input.measuredSec + carryInSec) / 60),
  };
}
