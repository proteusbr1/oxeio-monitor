import type { LoggerService } from '@nestjs/common';

import type { ErrorReporter } from './error-reporter.service';

/**
 * Contexts whose errors are not forwarded: Nest's own handler logs every
 * unexpected 500, which `ReportErrorsFilter` has already reported (with its
 * route); and the reporter's own complaints would loop back into it.
 */
const NOT_FORWARDED = new Set(['ExceptionsHandler', 'ErrorReporter']);

/**
 * The app's logger, with errors also handed to Sentry when the owner ticked
 * "errors from the server log" (Settings → Error reporting). Everything is
 * still logged exactly as before — this only adds a copy.
 */
export class ReportingLogger implements LoggerService {
  constructor(
    private readonly inner: LoggerService,
    private readonly reporter: Pick<ErrorReporter, 'captureLog'>,
  ) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.inner.log(message, ...rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.inner.warn(message, ...rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.inner.debug?.(message, ...rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.inner.verbose?.(message, ...rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.inner.fatal?.(message, ...rest);
    this.forward(message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.inner.error(message, ...rest);
    this.forward(message, rest);
  }

  private forward(message: unknown, rest: unknown[]): void {
    try {
      const { text, stack, context } = errorArgs(message, rest);
      if (NOT_FORWARDED.has(context)) return;
      this.reporter.captureLog(text, context, stack);
    } catch {
      // reporting must never break logging
    }
  }
}

/**
 * Nest calls `error(message, context)` or `error(message, stack, context)`
 * (`new Logger('Ctx').error(msg)` arrives as the first; with a stack, the
 * second). An Error object as the message carries its own stack.
 */
export function errorArgs(
  message: unknown,
  rest: unknown[],
): { text: string; stack: string | undefined; context: string } {
  const strings = rest.filter((v): v is string => typeof v === 'string');
  const context = strings.length > 0 ? strings[strings.length - 1] : 'app';
  let stack = strings.length > 1 ? strings[0] : undefined;

  let text: string;
  if (message instanceof Error) {
    text = `${message.name}: ${message.message}`;
    stack ??= message.stack;
  } else if (typeof message === 'string') {
    text = message;
  } else {
    try {
      text = JSON.stringify(message);
    } catch {
      text = String(message);
    }
  }
  return { text, stack, context };
}
