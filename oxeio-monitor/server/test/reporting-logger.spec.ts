import { describe, expect, it, vi } from 'vitest';

import { errorArgs, ReportingLogger } from '../src/error-reporting/reporting-logger';

describe('errorArgs — how Nest calls error()', () => {
  it('error(message, context)', () => {
    expect(errorArgs('Backup failed', ['BackupJob'])).toEqual({
      text: 'Backup failed',
      stack: undefined,
      context: 'BackupJob',
    });
  });

  it('error(message, stack, context)', () => {
    expect(errorArgs('boom', ['Error: boom\n at x', 'DigestService'])).toEqual({
      text: 'boom',
      stack: 'Error: boom\n at x',
      context: 'DigestService',
    });
  });

  it('an Error object brings its own stack', () => {
    const err = new TypeError('bad');
    const out = errorArgs(err, ['Ctx']);
    expect(out.text).toBe('TypeError: bad');
    expect(out.stack).toContain('TypeError: bad');
  });

  it('no context → app; objects become JSON', () => {
    expect(errorArgs({ a: 1 }, [])).toEqual({ text: '{"a":1}', stack: undefined, context: 'app' });
  });
});

describe('ReportingLogger', () => {
  const setup = () => {
    const inner = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
    const reporter = { captureLog: vi.fn() };
    return { inner, reporter, logger: new ReportingLogger(inner, reporter) };
  };

  it('logs exactly as before, and copies errors to the reporter', () => {
    const { inner, reporter, logger } = setup();
    logger.log('hello', 'Ctx');
    logger.warn('careful', 'Ctx');
    logger.error('Telegram failed', 'TelegramChannel');

    expect(inner.log).toHaveBeenCalledWith('hello', 'Ctx');
    expect(inner.warn).toHaveBeenCalledWith('careful', 'Ctx');
    expect(inner.error).toHaveBeenCalledWith('Telegram failed', 'TelegramChannel');
    expect(reporter.captureLog).toHaveBeenCalledOnce();
    expect(reporter.captureLog).toHaveBeenCalledWith('Telegram failed', 'TelegramChannel', undefined);
  });

  it('500s are not counted twice, and the reporter does not report itself', () => {
    const { reporter, logger } = setup();
    logger.error('Internal error', 'Error: x\n at y', 'ExceptionsHandler');
    logger.error('Error reporting not started', 'ErrorReporter');
    expect(reporter.captureLog).not.toHaveBeenCalled();
  });

  it('a reporter that throws never breaks logging', () => {
    const { inner, reporter, logger } = setup();
    reporter.captureLog.mockImplementation(() => {
      throw new Error('sentry down');
    });
    expect(() => logger.error('x', 'Ctx')).not.toThrow();
    expect(inner.error).toHaveBeenCalled();
  });
});
