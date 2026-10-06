import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { ApiError } from '../api/client';
import { Button } from './Page';

/**
 * Small tools specific to the Settings screen: modal, form fields, confirmation,
 * and the "shown only once" secret-code box.
 *
 * They were deliberately not moved to `src/components/`: in the whole product,
 * this is the only screen with write forms (staff get no buttons at all, a hard
 * rule of the product). Putting them in the shared library would make the other
 * six pages carry components they will never use.
 */

const INPUT =
  'w-full rounded-md border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/25 disabled:opacity-60';

// ── Messages ────────────────────────────────────────────────────────────────

/**
 * Careful: the server's messages are written in Bengali (`dto.ts`,
 * `*.service.ts`), so they are shown verbatim, not translated into our own
 * wording. A message like "salary must be given in the form '13000'" is a
 * thousand times more useful than "could not save", and it is what lets the owner
 * fix the mistake.
 *
 * Exception: for 403, the server's Nest-generated message is in English
 * ("Forbidden resource"), so we write that one ourselves.
 */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "You don't have access";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

/**
 * Small message box.
 *
 * Color rule: `attention` (solid red text + red background) only for errors or
 * danger. Conditions or explanations use `info`, thin and grey, because if
 * everything is red, red loses its meaning.
 */
export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'attention';
  children: ReactNode;
}) {
  const style =
    tone === 'attention'
      ? 'border-brand/30 bg-brand-bg text-brand-ink'
      : 'border-line bg-paper text-ink-2';

  return (
    <p className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${style}`}>
      {children}
    </p>
  );
}

/** Shows the server's message when a mutation fails. Nothing if `null`. */
export function ServerError({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div role="alert">
      <Notice tone="attention">{messageOf(error)}</Notice>
    </div>
  );
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export interface Mutation {
  busy: boolean;
  error: Error | null;
  /** Runs the action; on failure keeps the server's message in `error`. */
  run: (task: () => Promise<void>) => void;
  reset: () => void;
}

/**
 * The three states of a write action in one place: running, failed, done.
 *
 * Careful: on failure the modal does not close; everything the user typed is
 * kept. If it closed, after seeing "empCode accepts letters only" they would have
 * to fill in the whole form again.
 */
export function useMutation(): Mutation {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = useCallback((task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void task().then(
      () => {
        // On success the modal usually closes (unmounts), so touch state only after
        // checking it is still alive
        if (aliveRef.current) setBusy(false);
      },
      (err: unknown) => {
        if (!aliveRef.current) return;
        setBusy(false);
        setError(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { busy, error, run, reset };
}

/**
 * Returns the value only once it has settled after typing stops.
 *
 * Careful: unavoidable. Passing the search box's value straight into `useApi`'s
 * deps would send one request per character, and because `data` is cleared when
 * deps change, the table would flicker on every character.
 */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

// ── Modal ───────────────────────────────────────────────────────────────────

/**
 * Modal.
 *
 * Careful: with `dismissible={false}`, Escape or an outside click does not close
 * it. This is for things shown only once, like the enrollment code: pressing
 * Escape by mistake there would lose the code forever, and the only way out would
 * be generating a new one.
 *
 * Careful: E12: on a phone the modal rises from the bottom (`items-end`) and is
 * full width; if centred, when the keyboard comes up on a small screen it would
 * cover half the form.
 */
export function Modal({
  title,
  hint,
  onClose,
  children,
  footer,
  dismissible = true,
}: {
  title: ReactNode;
  hint?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  dismissible?: boolean;
}) {
  const titleId = useId();

  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismissible, onClose]);

  // Stop the page behind from scrolling; otherwise on a phone, dragging the
  // modal moves the list behind it
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-ink/40 sm:items-center sm:p-4"
      onClick={dismissible ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-t-xl border border-line bg-surface shadow-lg sm:rounded-xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[14px] font-semibold tracking-tight">
              {title}
            </h2>
            {hint && <p className="mt-0.5 text-xs text-ink-3">{hint}</p>}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close"
              className="rounded-md border border-line px-2 py-1 text-[13px] text-ink-2 transition hover:border-brand hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
            >
              ✕
            </button>
          )}
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

// ── Form fields ─────────────────────────────────────────────────────────────

function FieldShell({
  label,
  hint,
  htmlFor,
  required,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[12px] font-medium text-ink-2"
      >
        {label}
        {required && (
          <span aria-hidden className="ml-1 text-brand">
            *
          </span>
        )}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">{hint}</p>
      )}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = 'text',
  required,
  disabled,
  mono,
  min,
  max,
  step,
  maxLength,
  autoFocus,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  placeholder?: string;
  /**
   * Careful: `'month'` was added for the deposit's start month. The question is
   * "which month", so asking for a day would force the owner into a decision that
   * has no meaning. The browser itself gives `YYYY-MM`, so there is no risk of
   * matching the pattern by hand.
   */
  /**
   * Careful: `password`: the browser hides the text, and that is needed here: when
   * the owner sets a staff member's password, someone may be standing beside them.
   */
  type?: 'text' | 'email' | 'date' | 'number' | 'time' | 'month' | 'password';
  required?: boolean;
  disabled?: boolean;
  /** Pattern, code, number: easier to read in fixed-width characters. */
  mono?: boolean;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  maxLength?: number;
  /** Put the cursor in the first field when the modal opens; saves an extra click. */
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <FieldShell label={label} hint={hint} htmlFor={id} required={required}>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} ${mono ? 'num' : ''}`}
      />
    </FieldShell>
  );
}

/**
 * A yes/no field, for rights or switches.
 *
 * Careful: `FieldShell` is deliberately not used. A checkbox's text sits beside
 * the box, not above it; placed above, it is hard to tell at a glance whose text
 * it is when two checkboxes sit side by side.
 */
export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-brand"
      />
      <span>
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[11.5px] text-ink-3">{hint}</span>
        )}
      </span>
    </label>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  rows = 3,
  required,
  maxLength,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: ReactNode;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <FieldShell label={label} hint={hint} htmlFor={id} required={required}>
      <textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      />
    </FieldShell>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  required,
  disabled,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  hint?: ReactNode;
  required?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <FieldShell label={label} hint={hint} htmlFor={id} required={required}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

/** Grid for form fields. E12: one column on a phone, two on a large screen. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3.5 sm:grid-cols-2">{children}</div>;
}

/** A field spanning the full width (inside the grid). */
export function FullWidth({ children }: { children: ReactNode }) {
  return <div className="sm:col-span-2">{children}</div>;
}

// ── Small table buttons and chips ───────────────────────────────────────────

/**
 * A small button suited to a table row.
 *
 * Careful: not solid red; only the text is red (`danger`). Solid red means "needs
 * attention", and one solid red button in every row would make the whole table
 * look like an emergency.
 */
export function MiniButton({
  children,
  onClick,
  tone = 'default',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'default' | 'danger' | 'good';
  disabled?: boolean;
  title?: string;
}) {
  /**
   * Color follows the action, not the importance (the owner's request): green =
   * work finished, red = drop/delete.
   *
   * Careful: only the border and text are colored, not filled: in the targets list
   * four buttons sit on one row, and if all were filled it would be unclear where
   * to look. Careful: color is not the only signal: the text itself ("Complete" /
   * "Skip") says it too, so nothing is lost for someone colour-blind.
   */
  const style =
    tone === 'danger'
      ? 'border-brand/50 text-brand-ink hover:border-brand hover:bg-brand-bg'
      : tone === 'good'
        ? 'border-ok/50 text-ok-ink hover:border-ok hover:bg-ok-bg'
        : 'border-line text-ink-2 hover:border-brand hover:text-ink';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      /*
       * Careful: `tap` matters most here: these buttons were the smallest (about 28px)
       * and sit side by side in `RowActions`, so the chance of pressing the wrong one
       * is the highest. A wrong press in Settings means a wrong action is carried out.
       */
      className={`tap rounded-md border bg-surface px-2 py-1 text-[12px] whitespace-nowrap transition focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
    >
      {children}
    </button>
  );
}

/** A row's actions together; on a phone they drop below. */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-1.5">{children}</div>;
}

/**
 * Status chip. Careful: solid red only for a real problem (a revoked device); an
 * inactive employee is not a problem, so it is grey.
 */
export function Chip({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'counted' | 'muted' | 'attention' | 'pending';
}) {
  /**
   * Careful: `pending` is amber and `attention` is red; the difference is
   * intentional. Red means "something is broken"; amber means "a task is left". A
   * missing signature is no failure, but it should be noticed before rollout; the
   * same reasoning gives amber for "behind" in the tray window.
   */
  const style =
    tone === 'attention'
      ? 'border-brand/40 bg-brand-bg text-brand-ink'
      : tone === 'pending'
        ? 'border-idle/40 text-idle-ink'
        : tone === 'counted'
          ? 'border-line bg-paper text-ink'
          : 'border-line bg-surface text-ink-3';

  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${style}`}
    >
      {children}
    </span>
  );
}

/** A removable filter chip, e.g. "User: Rima x" in the audit log. */
export function FilterChip({
  children,
  onClear,
}: {
  children: ReactNode;
  onClear: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-bg px-2.5 py-1 text-[11.5px] text-brand-ink">
      {children}
      <button
        type="button"
        onClick={onClear}
        aria-label="Remove filter"
        className="rounded-full px-1 leading-none transition hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand/30"
      >
        ✕
      </button>
    </span>
  );
}

// ── Confirmation ────────────────────────────────────────────────────────────

/**
 * Confirmation before a dangerous action.
 *
 * With `withReason`, a reason is required (the server also wants 3 characters):
 * stopping someone's machine remotely or deactivating someone is an action whose
 * explanation may be needed even six months later, when nobody will remember.
 */
export function ConfirmDialog({
  title,
  intro,
  warning,
  confirmLabel,
  tone = 'danger',
  withReason = false,
  reasonLabel = 'Reason',
  reasonHint = 'At least 3 characters — this is what the audit log will keep',
  extra,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  intro?: ReactNode;
  /** The plain consequence of what will happen; it must not be hidden. */
  warning?: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  withReason?: boolean;
  reasonLabel?: string;
  reasonHint?: ReactNode;
  /** Extra fields, e.g. a "last workday" date. */
  extra?: ReactNode;
  busy: boolean;
  error: Error | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const tooShort = withReason && reason.trim().length < 3;

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone={tone}
            disabled={busy || tooShort}
            onClick={() => onConfirm(reason.trim())}
            title={tooShort ? 'Write a reason (at least 3 characters)' : undefined}
          >
            {busy ? 'Please wait…' : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {intro && <p className="text-[13px] text-ink-2">{intro}</p>}
        {warning && <Notice tone="attention">{warning}</Notice>}
        {extra}
        {withReason && (
          <TextAreaField
            label={reasonLabel}
            hint={reasonHint}
            value={reason}
            onChange={setReason}
            required
            maxLength={500}
            rows={2}
          />
        )}
        <ServerError error={error} />
      </div>
    </Modal>
  );
}

// ── Shown only once ─────────────────────────────────────────────────────────

/**
 * Enrollment code and temporary password: the server stores only a hash, so they
 * can be seen this one time only.
 *
 * So three safeguards together:
 *   1. The modal is `dismissible={false}`: Escape or an outside click does not close it
 *   2. The close button stays disabled until the "I have saved it" box is ticked
 *   3. The code is shown large, in fixed-width characters, so copying it by hand
 *      does not go wrong
 */
export function SecretModal({
  title,
  label,
  secret,
  note,
  meta,
  onClose,
}: {
  title: ReactNode;
  label: string;
  secret: string;
  /** Until when it is valid and for whom; small, under the code. */
  note?: ReactNode;
  meta?: ReactNode;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'failed'>('idle');

  const copy = (): void => {
    // Careful: `navigator.clipboard` exists only on secure origins (HTTPS or
    // localhost). Over http it is `undefined`; the button would then silently do
    // nothing and the user would think the copy had happened.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setCopyState('failed');
      return;
    }

    void clipboard.writeText(secret).then(
      () => {
        setCopyState('ok');
        // When copied, the tick is set too; still, the button stays one step away, so
        // the eye falls on the code once before pressing "close"
        setSaved(true);
      },
      () => setCopyState('failed'),
    );
  };

  return (
    <Modal
      title={title}
      dismissible={false}
      onClose={onClose}
      footer={
        <Button tone="primary" disabled={!saved} onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-3">
        <Notice tone="attention">
          This {label} will not be shown again — the server keeps only its
          hash. Copy it now.
        </Notice>

        <div className="rounded-lg border border-line bg-paper px-4 py-4 text-center">
          <div className="num text-xl font-semibold break-all text-ink select-all sm:text-2xl">
            {secret}
          </div>
          {note && <div className="mt-1.5 text-[11.5px] text-ink-3">{note}</div>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={copy}>Copy</Button>
          {copyState === 'ok' && (
            <span className="text-xs text-ink-3">Copied</span>
          )}
          {copyState === 'failed' && (
            <span className="text-xs text-brand-ink">
              Could not copy — select the text and copy it by hand
            </span>
          )}
        </div>

        {meta && <div className="text-xs text-ink-3">{meta}</div>}

        <label className="flex items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-ink-2">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 accent-brand"
          />
          <span>I have copied or written down the {label}</span>
        </label>
      </div>
    </Modal>
  );
}

// ── Small helpers ───────────────────────────────────────────────────────────

/**
 * Empty input box to `undefined` (in a POST: "do not send the field").
 * Careful: sending `''` would break `@IsEmail`/`@Matches` and give a 400.
 */
export function orUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Empty input box to `null` (in a PATCH: "delete the value").
 * Careful: the server tells `undefined` (leave it) from `null` (delete it).
 */
export function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
