import { useState } from 'react';
import { Trans } from 'react-i18next';

import type { TaskView } from '../../api/me';
import {
  completeTask,
  myTasks,
  skipTask,
  undoTask,
  type DropReason,
  type MyTask,
} from '../../api/tasks';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { useT } from '../../i18n';
import { formatAgo } from '../../lib/format';
import { blockedNotice, openInTabs } from '../../lib/popups';
import { DropReasonPicker } from './DropReason';
import { Chip, MiniButton, Notice, ServerError, useMutation } from '../../components/ui';

/**
 * **A person's own tasks**, on the `/me` page.
 *
 * Important: **why the "Complete" button exists.** The system can at best see
 * a task being **started** (start detection: a window whose title starts with
 * the task number, Settings → Tasks), never finished. So the work is split:
 * **the system says "started"**, and **the person says "finished"**. Each
 * reports only what it truly knows.
 *
 * Careful: this does not break oXeio's rule ([ADR-032](../../../../docs/history/05-Options-Decisions.md)):
 * the button **changes no measured number** — hours stay what the agent
 * counted. It is only an announcement of work.
 *
 * Careful: if someone has no tasks the card is not rendered at all; an empty
 * "no tasks" box on the page of someone who never receives tasks is pointless.
 */
export function MyTasks({ progress }: { progress?: TaskView | null }) {
  const t = useT();
  const { data, loading, error, reload } = useApi(myTasks, []);
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
   * **Two parts**: in hand, and finished today.
   *
   * Careful: pressing Complete used to make the row **vanish from the screen**,
   * so a mistaken press had no undo button, let alone the row itself.
   *
   * Careful: the server sends only **today's** finished rows, so there is no
   * need to count days here: having `completedAt` means "today, and still undoable".
   */
  const inHand = data.filter((task) => task.completedAt === null);
  const finished = data.filter((task) => task.completedAt !== null);

  /**
   * Links of the tasks in hand — only those that have one; a task may be
   * just a reference.
   *
   * Careful: **the ones in hand, not those finished today**: the "Finished
   * today" part below is a receipt, not a to-do.
   */
  const links = inHand.flatMap((task) => (task.link ? [task.link] : []));

  /**
   * **Every link in hand, in one press.**
   *
   * Careful: the browser will block most of them **the first time**; that is
   * not broken, it is the rule ([popups.ts](../lib/popups.ts)). So the count of
   * what happened goes into the message, and once permission is given all of
   * them open from the next day.
   */
  function openAll() {
    const { blocked } = openInTabs(links, (url) => window.open(url, '_blank'));
    setTabsNotice(blockedNotice(links.length, blocked));
  }

  /**
   * Start detection is visibly at work when any of today's tasks was seen
   * starting; only then is the "name it with the number" advice true for
   * this person. Otherwise it would promise something the system does not do.
   */
  const detected = data.some((task) => task.startedAt !== null);

  return (
    <Card
      title={t('Your Tasks')}
      hint={t('{{n}} in hand — oldest first', { n: inHand.length })}
      /*
        The button is at the top of the card, not on each row: the action is
           for the whole list, not one task. Careful: the number is in the
           text ("Open all 30"), because 30 open tabs are hard to undo; you
           need to know how many are coming before pressing.
      */
      actions={
        <span className="flex items-center gap-2">
          {progress && <TaskProgress view={progress} />}
          {links.length > 1 && (
            <MiniButton title={t('Opens the link of every task in hand, each in its own tab')} onClick={openAll}>
              {t('Open all {{n}} ↗', { n: links.length })}
            </MiniButton>
          )}
        </span>
      }
    >
      <div className="space-y-3 p-4">
        <Notice>
          <Trans
            i18nKey="Press <b>Complete</b> when a task is finished, or <b>Skip</b> with the reason if it cannot be done."
            components={{ b: <b /> }}
          />
          {detected && (
            <>
              {' '}
              <Trans
                i18nKey="Starting a file or document name with the task number — <n>1000042-Quarterly report</n> — lets the system see when you start."
                components={{ n: <span className="num" /> }}
              />
            </>
          )}
        </Notice>

        {/*
          Careful: the message must be shown here: when Undo is refused (someone
             has already checked the task, or the work is from yesterday) the
             server says **why**, and without showing it the person would think
             the button was broken.
        */}
        <ServerError error={skip.error} />

        {/*
          Careful: if the browser blocks the tabs it is said **here**: people
             never notice the small icon in the address bar, and then the button
             seems broken.
        */}
        {tabsNotice && <Notice tone="attention">{tabsNotice}</Notice>}

        {inHand.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            busy={skip.busy}
            onDone={() =>
              skip.run(async () => {
                await completeTask(task.id);
                reload();
              })
            }
            onSkip={(reason) =>
              skip.run(async () => {
                await skipTask(task.id, reason);
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
             the server sends here can be undone. If someone checks the task
             midway, the row will leave on the next refresh anyway, and pressing
             in the meantime makes the server refuse with a reason.
        */}
        {finished.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
              {t('Finished today · {{n}}', { n: finished.length })}
            </div>
            {finished.map((task) => (
              <FinishedRow
                key={task.id}
                task={task}
                busy={skip.busy}
                onUndo={() =>
                  skip.run(async () => {
                    await undoTask(task.id);
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

function TaskRow({
  task,
  busy,
  onDone,
  onSkip,
}: {
  task: MyTask;
  busy: boolean;
  onDone: () => void;
  onSkip: (reason: DropReason) => void;
}) {
  const t = useT();
  /**
   * **Skip does not drop at once: it first asks "why".**
   *
   * Careful: the reason buttons are themselves the **confirmation**; there is
   * no separate "Really skip". One press, yet more information than before.
   */
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-paper px-3 py-2.5">
      {/*
        The number is the biggest text: it is what the person types or copies
           into their work, and what start detection looks for.
      */}
      <span className="num min-w-[104px] text-[19px] font-semibold tracking-tight text-ink">
        {task.taskNumber ?? '—'}
      </span>

      <span className="min-w-0 flex-1">
        <span className="num block text-[13px] break-all text-ink">{task.reference}</span>
        {/*
          "Started": the system saw the task in a window title. Careful: this is
             information, not encouragement: the person sees which ones they have touched.
        */}
        <span className="block text-[11.5px] text-ink-3">
          {task.startedAt
            ? t('Started {{ago}}', { ago: formatAgo(task.startedAt) })
            : task.assignedAt
              ? formatAgo(task.assignedAt)
              : t('just now')}
        </span>
      </span>

      {task.link && (
        <a
          href={task.link}
          target="_blank"
          // Careful: `noopener`: otherwise the new tab could redirect this page
          //    through `window.opener` (tabnabbing)
          rel="noreferrer noopener"
          className="text-[12.5px] whitespace-nowrap text-data hover:underline"
        >
          {t('Open link ↗')}
        </a>
      )}

      {/*
        Copy: typing it by hand 25 times, one day a digit will go wrong.
        Careful: without `navigator.clipboard` (old browser, http) the button
           silently does nothing, so it is checked first.
      */}
      {task.taskNumber !== null && typeof navigator.clipboard !== 'undefined' && (
        <MiniButton onClick={() => void navigator.clipboard.writeText(String(task.taskNumber))}>
          {t('Copy')}
        </MiniButton>
      )}

      {/*
        **Complete**: the only way to say "finished". Careful: with no `tone` it
           looks like Skip; it was not made bigger, because it is pressed many
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
            {t('Complete')}
          </MiniButton>

          <MiniButton tone="danger" disabled={busy} onClick={() => setAsking(true)}>
            {t('Skip')}
          </MiniButton>
        </>
      )}
    </div>
  );
}

/**
 * **A row finished today**, with Undo beside it.
 *
 * Careful: this could have been merged into `TaskRow` above (with a `done`
 * prop), but then one component would hold two different sets of action
 * buttons and every condition would be written twice. Kept separate, both stay small.
 */
function FinishedRow({
  task,
  busy,
  onUndo,
}: {
  task: MyTask;
  busy: boolean;
  onUndo: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-line px-3 py-2">
      <span className="num min-w-[104px] text-[15px] font-semibold text-ink-2">
        {task.taskNumber ?? '—'}
      </span>

      <span className="min-w-0 flex-1">
        <span className="num block text-[12.5px] break-all text-ink-2">{task.reference}</span>
        <span className="block text-[11.5px] text-ink-3">
          {task.completedAt ? t('Done {{ago}}', { ago: formatAgo(task.completedAt) }) : t('Done')}
        </span>
      </span>

      {/*
        Careful: the name is **"Undo"**, not "Not done": what the person wants
           is to **take back** a mistake, not make a new announcement.
      */}
      <MiniButton disabled={busy} onClick={onUndo}>
        {t('Undo')}
      </MiniButton>
    </div>
  );
}

/**
 * Today's finished count, beside the card's title — `me.tasks`, the same
 * three states as the Live Board (`taskView`): with a target `24/25 today`,
 * without one just `3 done today`.
 */
export function TaskProgress({ view }: { view: TaskView }) {
  const t = useT();
  if (view.target === null) {
    return <Chip tone="muted">{t('{{n}} done today', { n: view.done })}</Chip>;
  }

  return (
    <Chip tone={view.met ? 'counted' : 'muted'}>
      {t('{{done}}/{{target}} today', { done: view.done, target: view.target })}
    </Chip>
  );
}
