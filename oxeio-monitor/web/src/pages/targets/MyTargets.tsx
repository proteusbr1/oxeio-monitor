import { useState } from 'react';

import {
  completeTarget,
  myTargets,
  skipTarget,
  undoTarget,
  type DropReason,
  type MyTarget,
} from '../../api/targets';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { formatAgo } from '../../lib/format';
import { blockedNotice, openInTabs } from '../../lib/popups';
import { DropReasonPicker } from './DropReason';
import { Chip, MiniButton, Notice, ServerError, useMutation } from '../../components/ui';

/**
 * **A designer's own targets**, on the `/me` page.
 *
 * Important: **why the "Complete" button was needed** (the owner asked).
 * First it was assumed the system would detect completion by itself, but the
 * agent sees the number in the window title at the moment the file is
 * **opened**, not finished. So a target would close as soon as it was opened.
 *
 * Now the work is split: **the system says "started"**, and **the designer
 * says "finished"**. Each reports only what it truly knows.
 *
 * Careful: this still does not break oXeio's rule ([ADR-032](../../../../docs/05-Options-Decisions.md)):
 * the button **changes no measured number**: not hours, and not the design
 * count (that comes from the file name). It is only an announcement of work.
 *
 * Careful: if someone has no targets the card is not rendered at all; an empty
 * "no targets" box on a researcher's or manager's page is pointless.
 */
export function MyTargets() {
  const { data, loading, error, reload } = useApi(myTargets, []);
  const skip = useMutation();

  /**
   * Careful: the popup-blocked message is not mixed with `skip.error`: that is
   *    the server's refusal and this is the browser's. In one slot one would
   *    erase the other, yet the causes are different.
   */
  const [tabsNotice, setTabsNotice] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} retry={reload} />;
  if (!data || data.length === 0) return null;

  /**
   * **Two parts.** Reported by the owner.
   *
   * Careful: pressing Complete used to make the row **vanish from the screen**,
   * because the server sent only `assigned`. So if it was pressed by mistake
   * there was no undo button, let alone the row itself.
   *
   * Careful: the server sends only **today's** finished rows, so there is no
   * need to count days here: having `completedAt` means "today, and still undoable".
   */
  const inHand = data.filter((t) => t.completedAt === null);
  const finished = data.filter((t) => t.completedAt !== null);

  /**
   * **All the Amazon pages in hand, in one press.** The owner asked for a
   * button to open 30 designs at once.
   *
   * Careful: **it opens the ones in hand, not those finished today**: the
   * "Finished today" part below is a receipt, not a to-do. Opening those too
   * would open 60 tabs a day instead of 30, half with nothing left to do.
   *
   * Careful: the browser will block most of them **the first time**; that is
   * not broken, it is the rule ([popups.ts](../lib/popups.ts)). So the count of what
   * happened goes into the message, and once permission is given all 30 open from the next day.
   */
  function openAll() {
    const { blocked } = openInTabs(
      inHand.map((t) => t.url),
      (url) => window.open(url, '_blank'),
    );
    setTabsNotice(blockedNotice(inHand.length, blocked));
  }

  return (
    <Card
      title="Your Design Targets"
      hint={`${inHand.length} in hand — oldest first`}
      /*
        The button is at the top of the card, not on each row: the action is
           for the whole list, not one target. Careful: the number is in the
           text ("Open all 30"), because 30 open tabs are hard to undo; you
           need to know how many are coming before pressing.
      */
      actions={
        inHand.length > 0 ? (
          <MiniButton
            title="Opens every target in hand in its own tab"
            onClick={openAll}
          >
            Open all {inHand.length} ↗
          </MiniButton>
        ) : null
      }
    >
      <div className="space-y-3 p-4">
        {/*
          This one line is the reason for the whole card. The designer's only
             job is to put the number in the file name; without knowing that,
             no target would ever close and everyone would think the system was broken.
        */}
        <Notice>
          Start the file name with the number —{' '}
          <span className="num">1000042-Funny Cat T-Shirt.ai</span>, then press{' '}
          <b>Complete</b> when the design is finished.
        </Notice>

        {/*
          Careful: the message must be shown here: when Undo is refused (someone
             has already checked the spelling, or the work is from yesterday) the
             server says **why**, and without showing it the designer would think
             the button was broken.
        */}
        <ServerError error={skip.error} />

        {/*
          Careful: if the browser blocks the tabs it is said **here**: people
             never notice the small icon in the address bar, and then the button
             seems broken.
        */}
        {tabsNotice && <Notice tone="attention">{tabsNotice}</Notice>}

        {inHand.map((t) => (
          <TargetRow
            key={t.id}
            target={t}
            busy={skip.busy}
            onDone={() =>
              skip.run(async () => {
                await completeTarget(t.id);
                reload();
              })
            }
            onSkip={(reason) =>
              skip.run(async () => {
                await skipTarget(t.id, reason);
                reload();
              })
            }
          />
        ))}

        {/*
          **What you finished today**: the only window for correcting mistakes.

          Careful: this part is **deliberately quiet**: light text, little
             colour. It is a receipt, not a work list; the eye should not stick here.

          Careful: the Undo button appears on **every row**, because everything
             the server sends here can be undone. If someone checks the spelling
             midway, the row will leave on the next refresh anyway, and pressing
             in the meantime makes the server refuse with a reason.
        */}
        {finished.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
              Finished today · {finished.length}
            </div>
            {finished.map((t) => (
              <FinishedRow
                key={t.id}
                target={t}
                busy={skip.busy}
                onUndo={() =>
                  skip.run(async () => {
                    await undoTarget(t.id);
                    reload();
                  })
                }
              />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function TargetRow({
  target,
  busy,
  onDone,
  onSkip,
}: {
  target: MyTarget;
  busy: boolean;
  onDone: () => void;
  onSkip: (reason: DropReason) => void;
}) {
  /**
   * **Skip does not drop at once: it first asks "why".** Requested by the
   * owner.
   *
   * Careful: the three reason buttons are themselves the **confirmation**;
   * there is no separate "Really skip". One press, yet more information than before.
   */
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-paper px-3 py-2.5">
      {/*
        The number is the biggest text, not the ASIN: the ASIN is of no use to
           the designer, the link is; and without the number the work never finishes.
      */}
      <span className="num min-w-[104px] text-[19px] font-semibold tracking-tight text-ink">
        {target.jobNumber ?? '—'}
      </span>

      <span className="min-w-0 flex-1">
        <span className="num block text-[13px] text-ink">{target.asin}</span>
        {/*
          "In progress": the system saw the file being opened. Careful: this is
             information, not encouragement: the designer sees which ones they have touched.
        */}
        <span className="block text-[11.5px] text-ink-3">
          {target.startedAt
            ? `Started ${formatAgo(target.startedAt)}`
            : target.assignedAt
              ? formatAgo(target.assignedAt)
              : 'just now'}
        </span>
      </span>

      <a
        href={target.url}
        target="_blank"
        // Careful: `noopener`: otherwise the new tab could redirect this page
        //    through `window.opener` (tabnabbing)
        rel="noreferrer noopener"
        className="text-[12.5px] whitespace-nowrap text-data hover:underline"
      >
        Open on Amazon ↗
      </a>

      {/*
        Copy: typing it by hand 25 times, one day a digit will go wrong, and
           then the target would stay open forever and nobody would know why.
        Careful: without `navigator.clipboard` (old browser, http) the button
           silently does nothing, so it is checked first.
      */}
      {target.jobNumber !== null && typeof navigator.clipboard !== 'undefined' && (
        <MiniButton
          onClick={() => void navigator.clipboard.writeText(String(target.jobNumber))}
        >
          Copy
        </MiniButton>
      )}

      {/*
        **Complete**: the only way to say "finished". Careful: with no `tone` it
           looks like Skip; it was not made bigger, because it is pressed 25
           times a day and anything eye-catching would be tiring.

        Careful: while the reason is being asked, Complete also goes away:
           another action's button in the middle of answering a question would invite a wrong press.
      */}
      {asking ? (
        <DropReasonPicker
          busy={busy}
          onPick={(reason) => {
            setAsking(false);
            onSkip(reason);
          }}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <>
          <MiniButton tone="good" disabled={busy} onClick={onDone}>
            Complete
          </MiniButton>

          <MiniButton tone="danger" disabled={busy} onClick={() => setAsking(true)}>
            Skip
          </MiniButton>
        </>
      )}
    </div>
  );
}

/**
 * **A row finished today**, with Undo beside it.
 *
 * Careful: this could have been merged into `TargetRow` above (with a `done`
 * prop), but then one component would hold two different sets of action
 * buttons and every condition would be written twice. Kept separate, both stay small.
 */
function FinishedRow({
  target,
  busy,
  onUndo,
}: {
  target: MyTarget;
  busy: boolean;
  onUndo: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-line px-3 py-2">
      <span className="num min-w-[104px] text-[15px] font-semibold text-ink-2">
        {target.jobNumber ?? '—'}
      </span>

      <span className="min-w-0 flex-1">
        <span className="num block text-[12.5px] text-ink-2">{target.asin}</span>
        <span className="block text-[11.5px] text-ink-3">
          {target.completedAt ? `Done ${formatAgo(target.completedAt)}` : 'Done'}
        </span>
      </span>

      {/*
        Careful: the name is **"Undo"**, not "Not done": what the designer wants
           is to **take back** a mistake, not make a new announcement. The word says the action.
      */}
      <MiniButton disabled={busy} onClick={onUndo}>
        Undo
      </MiniButton>
    </div>
  );
}

/** Today's progress, to sit beside the card's title */
export function TargetProgress({
  done,
  target,
}: {
  done: number;
  target: number;
}) {
  return (
    <Chip tone={done >= target ? 'counted' : 'muted'}>
      {done}/{target} today
    </Chip>
  );
}
