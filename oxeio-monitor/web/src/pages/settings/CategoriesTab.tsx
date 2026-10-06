import { useState } from 'react';
import { Trans } from 'react-i18next';

import {
  createCategory,
  deleteCategory,
  listCategories,
  recategorize,
  updateCategory,
  type CategoryRuleView,
  type CreateCategoryBody,
  type MatchType,
  type Productivity,
} from '../../api/activity';
import { useApi } from '../../api/useApi';
import { Card } from '../../components/Card';
import { Button } from '../../components/Page';
import { Empty, ErrorBox, Loading } from '../../components/States';
import { Table, type Column } from '../../components/Table';
import { formatCount } from '../../lib/format';
import { useT } from '../../i18n';
import {
  Chip,
  ConfirmDialog,
  FormGrid,
  FullWidth,
  MiniButton,
  Modal,
  Notice,
  RowActions,
  SelectField,
  ServerError,
  TextField,
  useMutation,
} from '../../components/ui';

/**
 * Category rules (owner-only).
 *
 * Important: if these two points go unsaid, everyone loses:
 *
 *   1. **Lower priority wins first.** Entering 200 does not mean "more important",
 *      it effectively means last of all. In the seed the browser rule is 200 and the
 *      others 100, so a domain rule beats the browser rule.
 *
 *   2. **The category is assigned at ingest time, not at read time.** When a rule
 *      changes, old rows keep the old decision, so the recategorize button
 *      exists, and unless it is run, reports stay on the old rules for weeks.
 */

const MATCH_LABEL: Record<MatchType, string> = {
  process: 'Process',
  domain: 'Domain',
  title_regex: 'Title regex',
};

const MATCH_OPTIONS = [
  { value: 'process', label: 'Process — code.exe' },
  { value: 'domain', label: 'Domain — youtube.com' },
  { value: 'title_regex', label: 'Title regex' },
];

/** Important: the mockup's wording is kept; the report legend uses the same three words */
const CATEGORY_OPTIONS = [
  { value: 'productive', label: 'Productive' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'unproductive', label: 'Unproductive' },
];

const PATTERN_HINT: Record<MatchType, string> = {
  process:
    'The file name only — never a full path (for example code.exe). The agent sends nothing but the name.',
  domain:
    'The domain only, never a full URL (for example youtube.com). Full URLs are never stored, so a rule with a "/" in it would never match anything.',
  title_regex:
    'A JavaScript regex, case-insensitive. Matched against the window title.',
};

export function CategoriesTab() {
  const t = useT();
  const rules = useApi((signal) => listCategories(signal), []);

  const [editing, setEditing] = useState<CategoryRuleView | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<CategoryRuleView | null>(null);
  const [rerunning, setRerunning] = useState(false);
  /** Result of the last job: what happened after a delete or recategorize */
  const [outcome, setOutcome] = useState<string | null>(null);

  const rows = rules.data ?? [];

  const columns: Column<CategoryRuleView>[] = [
    {
      key: 'priority',
      header: t('Priority'),
      align: 'right',
      render: (rule) => <span className="num">{rule.priority}</span>,
    },
    {
      key: 'matchType',
      header: t('Type'),
      render: (rule) => <Chip>{t(MATCH_LABEL[rule.matchType])}</Chip>,
    },
    {
      key: 'pattern',
      header: t('Pattern'),
      render: (rule) => <span className="num">{rule.pattern}</span>,
    },
    {
      key: 'displayName',
      header: t('Shown as'),
      render: (rule) => rule.displayName,
    },
    {
      key: 'category',
      header: t('Category'),
      // Important: the brand rule applies exactly here: solid `ink` = counted work,
      //    grey = not counted. No red is used: being unproductive is not an error,
      //    just a class.
      render: (rule) => (
        <Chip tone={rule.category === 'productive' ? 'counted' : 'muted'}>
          {t(rule.category)}
        </Chip>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (rule) => (
        <RowActions>
          <MiniButton onClick={() => setEditing(rule)}>{t('Edit')}</MiniButton>
          <MiniButton tone="danger" onClick={() => setRemoving(rule)}>
            {t('Delete')}
          </MiniButton>
        </RowActions>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <Notice>
        <Trans
          i18nKey={'<b>Lower number wins</b> — the first rule that matches is the one that sticks, and the list below is in exactly that order, so a rule higher up beats one lower down. Setting 200 does not mean "more important"; it puts the rule practically last.'}
          components={{ b: <strong /> }}
        />
      </Notice>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button onClick={() => setRerunning(true)}>
          {t('Apply rules to past rows')}
        </Button>
        <Button tone="primary" onClick={() => setCreating(true)}>
          {t('New rule')}
        </Button>
      </div>

      {outcome && (
        <div role="status">
          <Notice>{outcome}</Notice>
        </div>
      )}

      {rules.loading && !rules.data && <Loading />}
      {rules.error && <ErrorBox error={rules.error} retry={rules.reload} />}

      {!rules.loading && !rules.error && rows.length === 0 && (
        <Empty
          title={t('No category rules at all')}
          hint={t("Without rules every app and site stays 'unknown' and no productivity score is ever produced. The seed normally installs 80+ rules — having none is not normal.")}
          action={
            <Button tone="primary" onClick={() => setCreating(true)}>
              {t('New rule')}
            </Button>
          }
        />
      )}

      {rows.length > 0 && (
        <Card
          padded={false}
          title={t('Rules · {{n}}', { n: rows.length })}
          hint={t('Matched in exactly the order shown below')}
        >
          <Table
            columns={columns}
            rows={rows}
            rowKey={(rule) => String(rule.id)}
          />
        </Card>
      )}

      {(creating || editing) && (
        <RuleForm
          key={editing?.id ?? 'new'}
          rule={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(message) => {
            setCreating(false);
            setEditing(null);
            setOutcome(message);
            rules.reload();
          }}
        />
      )}

      {removing && (
        <RemoveDialog
          rule={removing}
          onClose={() => setRemoving(null)}
          onDone={(message) => {
            setRemoving(null);
            setOutcome(message);
            rules.reload();
          }}
        />
      )}

      {rerunning && (
        <RecategorizeDialog
          onClose={() => setRerunning(false)}
          onDone={(message) => {
            setRerunning(false);
            setOutcome(message);
          }}
        />
      )}
    </div>
  );
}

// ── Add and edit rule ───────────────────────────────────────────────────────

function RuleForm({
  rule,
  onClose,
  onSaved,
}: {
  rule: CategoryRuleView | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [matchType, setMatchType] = useState<MatchType>(
    rule?.matchType ?? 'domain',
  );
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [displayName, setDisplayName] = useState(rule?.displayName ?? '');
  const [category, setCategory] = useState<Productivity>(
    rule?.category ?? 'neutral',
  );
  const [priority, setPriority] = useState(String(rule?.priority ?? 100));
  const t = useT();

  const { busy, error, run } = useMutation();

  const incomplete = pattern.trim() === '' || displayName.trim() === '';

  const submit = (): void => {
    run(async () => {
      const body: CreateCategoryBody = {
        matchType,
        pattern: pattern.trim(),
        displayName: displayName.trim(),
        category,
        priority: Number(priority),
      };

      if (rule) {
        await updateCategory(rule.id, body);
        // Careful: after **changing** a rule, `onlyUnmatched: false` is needed;
        //    otherwise rows carrying the old decision would stay old
        onSaved(
          t('Rule changed. Rows already stored still carry the old decision — run "Apply rules to past rows" and choose "All rows".'),
        );
      } else {
        await createCategory(body);
        onSaved(
          t('New rule added. It applies to data arriving from now on; to apply it to old unknown rows as well, run "Apply rules to past rows".'),
        );
      }
    });
  };

  return (
    <Modal
      title={rule ? t('Edit rule') : t('New category rule')}
      hint={t('Which category an app or site falls into')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button tone="primary" onClick={submit} disabled={busy || incomplete}>
            {busy ? t('Saving…') : t('Save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <FormGrid>
          <SelectField
            label={t('Match on')}
            value={matchType}
            onChange={(value) => setMatchType(value as MatchType)}
            options={MATCH_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
          />
          <SelectField
            label={t('Category')}
            value={category}
            onChange={(value) => setCategory(value as Productivity)}
            options={CATEGORY_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
          />

          <FullWidth>
            <TextField
              label={t('Pattern')}
              value={pattern}
              onChange={setPattern}
              required
              mono
              autoFocus
              maxLength={260}
              hint={t(PATTERN_HINT[matchType])}
            />
          </FullWidth>

          <TextField
            label={t('Shown as')}
            value={displayName}
            onChange={setDisplayName}
            required
            maxLength={100}
            hint={t('This is the name reports will use')}
          />

          <TextField
            label={t('Priority')}
            type="number"
            value={priority}
            onChange={setPriority}
            mono
            min={1}
            max={1000}
            hint={t('Lower number wins. Default is 100; the general browser rules sit at 200, so a rule for a specific domain beats them.')}
          />
        </FormGrid>

        <ServerError error={error} />
      </div>
    </Modal>
  );
}

// ── Delete ──────────────────────────────────────────────────────────────────

function RemoveDialog({
  rule,
  onClose,
  onDone,
}: {
  rule: CategoryRuleView;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const t = useT();
  const { busy, error, run } = useMutation();

  return (
    <ConfirmDialog
      title={t('Delete the rule "{{pattern}}"?', { pattern: rule.pattern })}
      intro={`${t(MATCH_LABEL[rule.matchType])} · ${rule.displayName} · ${t(rule.category)}`}
      warning={t("Every row this rule had categorised turns 'unknown' right away — that time drops out of the productivity score. You will be told how many rows once it is done.")}
      confirmLabel={t('Delete')}
      busy={busy}
      error={error}
      onClose={onClose}
      onConfirm={() =>
        run(async () => {
          const result = await deleteCategory(rule.id);
          // The server's `hint` is shown verbatim; it says what to do next
          onDone(
            result.orphanedRows === 0
              ? t('Rule deleted. {{hint}}', { hint: result.hint })
              : t('Rule deleted — {{rows}} rows are now unknown. {{hint}}', {
                  count: result.orphanedRows,
                  rows: formatCount(result.orphanedRows),
                  hint: result.hint,
                }),
          );
        })
      }
    />
  );
}

// ── Applying rules to old rows ──────────────────────────────────────────────

/**
 * Careful: the job is **synchronous**: over about a hundred thousand rows in a month
 *    it can take several seconds, and the browser waits. So the button shows
 *    "please wait..."; otherwise people would think the click did not register and
 *    press it again and again.
 */
function RecategorizeDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);
  const t = useT();
  const { busy, error, run } = useMutation();

  return (
    <Modal
      title={t('Apply rules to past rows')}
      hint={t('Categories are decided when data arrives, not when it is read')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button
            tone="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const result = await recategorize(onlyUnmatched);
                onDone(
                  t('{{scanned}} rows examined, {{changed}} changed category.', {
                    count: result.scanned,
                    scanned: formatCount(result.scanned),
                    changed: formatCount(result.changed),
                  }),
                );
              })
            }
          >
            {busy ? t('Please wait…') : t('Run')}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Notice>
          <Trans
            i18nKey="When a rule changes, <b>old rows keep the old decision</b> — the category is stamped on at the moment the data is stored. Skip this and reports will show the new rules while the numbers still follow the old ones."
            components={{ b: <strong /> }}
          />
        </Notice>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-[12px] font-medium text-ink-2">
            {t('Which rows to apply to')}
          </legend>

          <Choice
            checked={onlyUnmatched}
            onChange={() => setOnlyUnmatched(true)}
            title={t('Unknown rows only')}
            body={t('Fast. This is enough after adding a new rule.')}
          />
          <Choice
            checked={!onlyUnmatched}
            onChange={() => setOnlyUnmatched(false)}
            title={t('All rows')}
            body={t('Slower, and the browser waits a few seconds. This is what you need after changing or deleting a rule — otherwise the old decisions stay.')}
          />
        </fieldset>

        <ServerError error={error} />
      </div>
    </Modal>
  );
}

function Choice({
  checked,
  onChange,
  title,
  body,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  body: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 transition ${
        checked ? 'border-brand bg-brand-bg/40' : 'border-line bg-surface'
      }`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 accent-brand"
      />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-3">
          {body}
        </span>
      </span>
    </label>
  );
}
