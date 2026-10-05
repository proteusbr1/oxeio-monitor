import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';

import { ErrorReporter } from './error-reporter.service';

/**
 * Reports the errors nobody planned for — anything that is not an
 * `HttpException`, and HttpExceptions of 500 and up — then answers exactly
 * as Nest always did. A 404 or a refused login is not a bug; reporting them
 * would bury the real ones.
 */
@Catch()
export class ReportErrorsFilter extends BaseExceptionFilter {
  constructor(private readonly reporter: ErrorReporter) {
    super();
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const unexpected =
      !(exception instanceof HttpException) || exception.getStatus() >= 500;

    if (unexpected && host.getType() === 'http') {
      const req = host.switchToHttp().getRequest<Request>();
      // the route pattern (/employees/:id), never the URL with its values
      const route = (req.route as { path?: string } | undefined)?.path ?? 'unknown';
      this.reporter.capture(exception, { method: req.method, route });
    } else if (unexpected) {
      this.reporter.capture(exception);
    }

    super.catch(exception, host);
  }
}
