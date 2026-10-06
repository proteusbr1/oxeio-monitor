import type { InputHTMLAttributes } from 'react';

import { useT } from '../i18n';
import { translateServerMessage } from '../i18n/server-messages';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export function Field({ label, hint, id, ...props }: FieldProps) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-1.5 block text-sm font-medium text-ink-2">
        {label}
      </span>
      <input
        id={id}
        {...props}
        className="w-full rounded-md border border-line bg-surface px-3 py-2 text-[15px] outline-none placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/25 disabled:opacity-60"
      />
      {hint && <span className="mt-1.5 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export function SubmitButton({
  children,
  busy,
  disabled,
}: {
  children: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="w-full rounded-md bg-ink px-4 py-2.5 text-[15px] font-medium text-on-ink transition hover:bg-ink-strong focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? t('Please wait…') : children}
    </button>
  );
}

/**
 * Error message: red, because it demands attention.
 *
 * Careful: not a solid fill, but a tint plus red text (`brand-bg` / `brand-ink`).
 * Errors can arrive one after another in a form; two solid red boxes in a row
 * would make the whole screen look like a crisis.
 */
export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-brand/30 bg-brand-bg px-3 py-2 text-sm text-brand-ink"
    >
      {typeof children === 'string' ? translateServerMessage(children) : children}
    </p>
  );
}
