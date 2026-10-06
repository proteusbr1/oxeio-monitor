import { Page } from '../../components/Page';
import { TaskList } from './TaskPoolPage';

/**
 * **Review**: the skipped and deleted tasks, under Task pool in the sidebar.
 *
 * Important: **a page of its own, because it is other people's work.** The
 * Task pool is the coordinator's daily page: the whole list and four queues.
 * Looking at dropped tasks is the owner's and manager's job, and not daily. On
 * one page the two jobs would mix on the same screen.
 *
 * Careful: the table is **not a copy**; it is `TaskPoolPage`'s `TaskList`,
 * only locked to the `to_review` queue (a rule learnt from the Worklog page).
 *
 * Careful: nobody except owner and manager sees this page: the sidebar, the
 * route and the server's `@Roles` are all the same.
 */
export function ReviewPage() {
  return (
    <Page title="Review" subtitle="Skipped and deleted tasks — and why">
      <TaskList lockedStage="to_review" />
    </Page>
  );
}
