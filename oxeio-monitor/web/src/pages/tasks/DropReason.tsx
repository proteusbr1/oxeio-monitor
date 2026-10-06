import {
  DROP_REASONS,
  DROP_REASON_LABEL,
  type DropReason,
} from '../../api/tasks';
import { Chip, MiniButton } from '../../components/ui';

/**
 * **"Why did you drop it?" and the button itself is the answer.**
 *
 * Important: **there is no separate confirm button, and that is the design.**
 * Pressing Delete used to bring up "Really delete / Cancel", a question whose
 * answer carries no information. Now the reasons sit in that very place:
 * the button pressed both **confirms** and **gives the reason**. One press,
 * twice the data. `Other` is there so nobody is forced to pick a wrong one.
 *
 * Careful: there is no way out without a reason: Cancel exists, but "delete
 * without a reason" does not. If optional, everyone would leave it blank, just
 * as an optional reason field always ends up empty.
 *
 * Careful: the same component is used in **two places**: Delete in the Task
 * pool and Skip on the assignee's own list. With two lists, one day a new reason
 * would be added to one and not the other, and counting would become impossible.
 */
export function DropReasonPicker({
  busy,
  onPick,
  onCancel,
}: {
  busy: boolean;
  onPick: (reason: DropReason) => void;
  onCancel: () => void;
}) {
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      {/* Careful: the question stays visible; otherwise it would be unclear why a row of red buttons appeared */}
      <span className="text-[11.5px] whitespace-nowrap text-ink-3">Why?</span>
      {DROP_REASONS.map((reason) => (
        <MiniButton
          key={reason}
          tone="danger"
          disabled={busy}
          onClick={() => onPick(reason)}
        >
          {DROP_REASON_LABEL[reason]}
        </MiniButton>
      ))}
      <MiniButton disabled={busy} onClick={onCancel}>
        Cancel
      </MiniButton>
    </span>
  );
}

/**
 * Shows the reason in the list, small, beside the chip.
 *
 * Careful: old rows have `null` (no reason was asked for then), and nothing is
 * rendered; a "—" would suggest someone left it blank on purpose.
 */
export function DropReasonTag({ reason }: { reason: DropReason | null }) {
  if (reason === null) return null;

  return <Chip tone="muted">{DROP_REASON_LABEL[reason]}</Chip>;
}
