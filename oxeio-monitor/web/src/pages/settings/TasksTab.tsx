import { useState } from 'react';

import { getTaskSettings, saveTaskSettings } from '../../api/tasks';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { ErrorBox, Loading } from '../../components/States';
import { useFeatures } from '../../features/FeaturesContext';
import { Chip, MiniButton, Notice, ServerError, useMutation } from '../../components/ui';
import { addStartApp, sameApps, START_APPS_MAX } from './startApps';

/**
 * Settings → Tasks: the choices *inside* the Tasks module. Owner only, and
 * only while the module is on (the server answers 404 otherwise;
 * `sections.ts` hides the tab).
 *
 * Today that is start detection: which apps' window titles are read for a
 * leading task number. Empty — the default — means off: no title is read,
 * nothing is marked "started", and the Task pool has no "On screen" column.
 *
 * Careful: detection reads window titles, which come from the Apps & websites
 * module. While that module is off the list is kept but nothing is read, and
 * the page says so — a list that silently does nothing is the worst outcome.
 */
export function TasksTab() {
  const view = useApi(getTaskSettings, []);
  const { features } = useFeatures();
  const save = useMutation();

  /** `null` = untouched, showing what is saved */
  const [draft, setDraft] = useState<string[] | null>(null);
  const [typed, setTyped] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const current = view.data;
  if (view.loading && !current) return <Loading />;
  if (view.error && !current) return <ErrorBox error={view.error} retry={view.reload} />;
  if (!current) return null;

  const savedApps = current.startDetection.apps;
  const apps = draft ?? savedApps;
  const changed = !sameApps(apps, savedApps);

  const edit = (next: string[]) => {
    setDraft(next);
    setSaved(false);
    save.reset();
  };

  const add = () => {
    const result = addStartApp(apps, typed);
    if ('error' in result) {
      setAddError(result.error);
      return;
    }
    setAddError(null);
    setTyped('');
    edit(result.apps);
  };

  const submit = (): void =>
    save.run(async () => {
      await saveTaskSettings({ startDetection: { apps } });
      setDraft(null);
      setSaved(true);
      view.reload();
    });

  /**
   * What is true **now**, from the saved list: the server's `active` while
   * nothing is being edited; once edited, the unsaved list is not running yet,
   * so the chip keeps describing what is saved.
   */
  const state = current.active
    ? { tone: 'counted' as const, text: 'On' }
    : savedApps.length > 0
      ? { tone: 'attention' as const, text: 'Resting' }
      : { tone: 'muted' as const, text: 'Off' };

  return (
    <div className="space-y-3">
      <Card
        title="Start detection"
        hint="Which apps show that a task was started"
        actions={<Chip tone={state.tone}>{state.text}</Chip>}
      >
        <div className="space-y-4 p-4">
          <p className="text-[13px] text-ink-2">
            When a window whose title starts with a task&rsquo;s number is in
            front in one of these apps, the task is marked started and its
            on-screen time shown. Leave empty to turn this off. Needs the Apps
            &amp; websites module.
          </p>

          {/*
            The list itself: one pill per app, each with its own ×. Careful:
               removing does not save — the Save button below does, so a slip of
               the mouse can still be undone by not saving.
          */}
          {apps.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Apps read for start detection">
              {apps.map((app) => (
                <li
                  key={app.toLowerCase()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper py-0.5 pr-1 pl-3 text-[12.5px] text-ink"
                >
                  <span className="num">{app}</span>
                  <button
                    type="button"
                    onClick={() => edit(apps.filter((a) => a !== app))}
                    aria-label={`Remove ${app}`}
                    className="tap rounded-full px-1.5 text-ink-3 hover:text-ink"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-3">
              No apps — start detection is off. Tasks are only marked done, by
              hand.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                // Enter adds, as it does in every tag box; it must not submit anything else
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              aria-label="Program name to add"
              placeholder="e.g. WINWORD.EXE"
              maxLength={100}
              spellCheck={false}
              className="num w-full max-w-[260px] rounded-md border border-line bg-paper px-2.5 py-1.5 text-[12.5px] text-ink"
            />
            <MiniButton
              onClick={add}
              disabled={typed.trim() === '' || apps.length >= START_APPS_MAX}
            >
              Add
            </MiniButton>
            <span className="text-[11.5px] text-ink-3">
              The program&rsquo;s file name, as Task Manager shows it — capitals
              do not matter.
            </span>
          </div>
          {addError && (
            <p role="alert" className="text-[12px] text-idle-ink">
              {addError}
            </p>
          )}

          {/*
            Careful: apps listed but no window titles coming in. Without this
               notice the owner would fill the list, see nothing marked
               "started", and conclude the feature is broken.
          */}
          {apps.length > 0 && !features.appTracking && (
            <Notice tone="attention">
              Apps &amp; websites is off, so no window titles are read and
              start detection rests — the list is kept. Turn Apps &amp;
              websites on in Settings › Modules to use it.
            </Notice>
          )}

          <ServerError error={save.error} />
          <div className="flex items-center justify-end gap-3">
            {saved && !changed && (
              <span role="status" className="text-xs text-ink-2">
                Saved
              </span>
            )}
            {changed && (
              <MiniButton
                disabled={save.busy}
                onClick={() => {
                  setDraft(null);
                  setAddError(null);
                }}
              >
                Undo changes
              </MiniButton>
            )}
            <MiniButton disabled={!changed || save.busy} onClick={submit}>
              {save.busy ? 'Saving…' : 'Save'}
            </MiniButton>
          </div>
        </div>
      </Card>
    </div>
  );
}
