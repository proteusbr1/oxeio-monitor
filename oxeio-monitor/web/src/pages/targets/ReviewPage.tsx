import { Page } from '../../components/Page';
import { TargetList } from './AllTargetsPage';

/**
 * **Review.** The owner's instruction: add a page called Review in the
 * sidebar under Design Pool, showing the deleted and skipped designs.
 *
 * Important: **a page of its own, because it is other people's work.** Design
 * Pool is the researcher's daily page: 39,000 rows, four queues, the submission
 * box. Looking at dropped designs is the owner's and manager's job, and not
 * daily. On one page the two teams' work would mix on the same screen, and the
 * whole point of the August trimming was the opposite.
 *
 * Careful: the table is **not a copy**; it is `AllTargetsPage`'s `TargetList`,
 * only locked to the `to_review` queue (a rule learnt from the Worklog page).
 *
 * Careful: nobody except owner and manager sees this page: the sidebar, the
 * route and the server's `@Roles` are all the same.
 */
export function ReviewPage() {
  return (
    <Page
      title="Review"
      subtitle="Skipped and deleted designs — and why"
    >
      <TargetList lockedStage="to_review" />
    </Page>
  );
}
