import type { LiveStatus } from '../api/dashboard';
import { useT } from '../i18n';

/**
 * E01: the card's three states: working, paused, absent.
 *
 * Careful: there used to be a fourth state here, `agent_down`, solid red. It was
 * removed because the board could never say for certain whether the agent had
 * died or the PC was off. Even after the rule was changed twice, the mistake
 * remained, and both times an employee who had gone home was shown in red.
 *
 * Now all three speak about the employee, not the machine. Machine news goes to
 * alerts, where a one-line explanation fits, which a color cannot hold.
 *
 * `active` is green (`ok`), not black. It used to be black ("counted work"), but
 * in the Midnight theme it blended into the background and the dot was almost
 * invisible. Green, yellow, grey: three really different colors.
 *
 * Careful: the three colors come from the `index.css` tokens (`ok`, `idle`,
 * `offline`); do not write hex here. Use `text-ok`/`text-idle` for text and
 * `bg-ok`/`bg-idle` for fills/dots: the bridge in index.css maps the two `text-*`
 * tokens to a pair dark enough to read.
 *
 * Careful: "Idle" is not "Inactive". This is the current moment's state (keyboard
 * and mouse quiet), not having left the job; that is "Inactive" in `EmployeePicker`.
 */
export const STATUS_LABEL: Record<LiveStatus, string> = {
  active: 'Working',
  idle: 'Idle',
  offline: 'Offline',
};

/** In the tooltip, "why this color", so the user does not have to guess. */
const STATUS_HINT: Record<LiveStatus, string> = {
  active: 'Was active in the last segment',
  idle: 'Agent is running, but nothing recent',
  offline: 'No response for over 90 seconds — PC off, asleep, or no internet',
};

const DOT_CLASS: Record<LiveStatus, string> = {
  active: 'bg-ok',
  idle: 'bg-idle',
  offline: 'bg-offline',
};

export function StatusDot({
  status,
  className = '',
}: {
  status: LiveStatus;
  className?: string;
}) {
  const t = useT();
  return (
    <span
      className={`inline-block size-2 flex-none rounded-full ${DOT_CLASS[status]} ${className}`}
      role="img"
      aria-label={t(STATUS_LABEL[status])}
      title={t('{{status}} — {{hint}}', { status: t(STATUS_LABEL[status]), hint: t(STATUS_HINT[status]) })}
    />
  );
}

/**
 * Careful: all three are outline chips, none is filled. `agent_down` used to be
 * solid red so it stood out; with that gone all three have equal weight, and that
 * is right, since all three are equally normal events.
 */
const CHIP_CLASS: Record<LiveStatus, string> = {
  active: 'border-ok/45 bg-ok/10 text-ok',
  idle: 'border-idle/45 bg-idle/10 text-idle',
  offline: 'border-line bg-surface text-ink-3',
};

/** Chip with the name: at the head of a card or in a table column. */
export function StatusChip({ status }: { status: LiveStatus }) {
  const t = useT();
  return (
    <span
      title={t(STATUS_HINT[status])}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${CHIP_CLASS[status]}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${DOT_CLASS[status]}`} />
      {t(STATUS_LABEL[status])}
    </span>
  );
}

/**
 * Color legend below the board.
 * Careful: do not drop it. Nobody can guess what the dot colors mean, and a wrong
 * guess leads to a wrong accusation.
 */
export function StatusLegend() {
  const t = useT();
  const all: LiveStatus[] = ['active', 'idle', 'offline'];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11.5px] text-ink-3">
      {all.map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <StatusDot status={status} />
          {t(STATUS_LABEL[status])}
        </span>
      ))}
    </div>
  );
}
