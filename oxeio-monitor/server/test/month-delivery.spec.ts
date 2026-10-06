import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelegramChannel } from '../src/alerts/telegram.channel';
import {
  monthCaption,
  monthRange,
  monthReportName,
} from '../src/reports/month-delivery.rules';
import {
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_DOCUMENT_MAX_BYTES,
} from '../src/ops/ops.constants';

/**
 * **R26 — when a month is closed, the accounts file goes out by itself.**
 *
 * Two layers are tested separately: the pure rules (range, caption, name),
 * and the real request that uploads the file to Telegram (with `fetch` stubbed).
 */

describe('monthRange — first and last day of a month', () => {
  it('a 31-day month', () => {
    expect(monthRange('2026-07')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('a 30-day month', () => {
    expect(monthRange('2026-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  /** Assuming 30/31 would silently drop two days' hours in February */
  it('February — ordinary and leap', () => {
    expect(monthRange('2026-02').to).toBe('2026-02-28');
    expect(monthRange('2028-02').to).toBe('2028-02-29');
  });

  it('December does not cross the year', () => {
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('stops on a wrong month', () => {
    expect(() => monthRange('2026-13')).toThrow(RangeError);
    expect(() => monthRange('2026-1')).toThrow(RangeError);
    expect(() => monthRange('not-a-month')).toThrow(RangeError);
  });
});

describe('monthCaption — what can be written on Telegram', () => {
  const caption = monthCaption({
    orgName: 'oXeio',
    yearMonth: '2026-07',
    people: 12,
    totalHours: 2416.7,
  });

  it('has the month, head count and total hours', () => {
    expect(caption).toContain('2026-07');
    expect(caption).toContain('12 staff');
    expect(caption).toContain('2417 hours');
  });

  /**
   * The most important guard — the caption has no one's name. The message
   * stays on Telegram's servers; the per-name accounts are in the attached file.
   */
  it('no staff name goes out', () => {
    const c = monthCaption({
      orgName: 'oXeio',
      yearMonth: '2026-07',
      people: 3,
      totalHours: 100,
    });
    expect(c).not.toMatch(/[A-Z][a-z]+ [A-Z][a-z]+/); // like "Alex Silva"
  });

  it('the caption is within Telegram\'s limit', () => {
    expect(caption.length).toBeLessThan(TELEGRAM_CAPTION_MAX);
  });
});

describe('monthReportName', () => {
  it('ASCII name with the date', () => {
    expect(monthReportName('2026-07', 'xlsx')).toBe(
      'oxeio-summary-2026-07-01_2026-07-31.xlsx',
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TelegramChannel.sendDocument — the real request
// ════════════════════════════════════════════════════════════════════════════

/**
 * Nobody stubbed `fetch` in this suite before — the channels stopped at
 * `not_configured` in tests, so it was not needed. The shape of the file
 * upload is the real thing here, so it is stubbed here.
 */
function channelWith(settings: { botToken: string; chatId: string } | null) {
  const channel = Object.create(TelegramChannel.prototype) as TelegramChannel;
  Object.assign(channel, {
    logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
  });
  vi.spyOn(channel, 'resolve').mockResolvedValue(settings);
  return channel;
}

const ok = () => new Response('{"ok":true}', { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TelegramChannel.sendDocument', () => {
  it('goes as multipart, with exactly the right name and caption', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    const channel = channelWith({ botToken: 'TOKEN', chatId: '42' });
    const outcome = await channel.sendDocument(
      {
        bytes: Buffer.from('hello'),
        filename: 'oxeio-summary-2026-07-01_2026-07-31.xlsx',
        contentType: 'application/vnd.ms-excel',
      },
      'July is closed',
    );

    expect(outcome).toBe('sent');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sendDocument');

    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('chat_id')).toBe('42');
    expect(body.get('caption')).toBe('July is closed');

    const file = body.get('document') as File;
    expect(file.name).toBe('oxeio-summary-2026-07-01_2026-07-31.xlsx');
    expect(file.size).toBe(5);
  });

  /**
   * The most valuable test. Setting `content-type` by hand loses the
   * `boundary` that `fetch` generates and Telegram answers 400 every time —
   * which looks like a token problem. The neighbouring `send()` has the
   * header, so the mistake is very easy to bring back by copy-paste.
   */
  it('no headers are set (so the boundary is not lost)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    const channel = channelWith({ botToken: 'TOKEN', chatId: '42' });
    await channel.sendDocument({ bytes: Buffer.from('x'), filename: 'a.xlsx' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeUndefined();
  });

  it('nothing is sent when it is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const channel = channelWith(null);
    const outcome = await channel.sendDocument({
      bytes: Buffer.from('x'),
      filename: 'a.xlsx',
    });

    expect(outcome).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Measure first, then send — otherwise the whole upload would be spent before finding out */
  it('over 50 MB it is not even attempted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const channel = channelWith({ botToken: 'TOKEN', chatId: '42' });
    const big = {
      bytes: Buffer.alloc(TELEGRAM_DOCUMENT_MAX_BYTES + 1),
      filename: 'huge.xlsx',
    };

    expect(await channel.sendDocument(big)).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a long caption is truncated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    const channel = channelWith({ botToken: 'TOKEN', chatId: '42' });
    await channel.sendDocument(
      { bytes: Buffer.from('x'), filename: 'a.xlsx' },
      '漢'.repeat(TELEGRAM_CAPTION_MAX + 500),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const caption = (init.body as FormData).get('caption') as string;
    expect(caption.length).toBe(TELEGRAM_CAPTION_MAX);
  });

  /** An empty caption is not sent at all — Telegram gives 400 on an empty string */
  it('with no caption the field is not set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    const channel = channelWith({ botToken: 'TOKEN', chatId: '42' });
    await channel.sendDocument({ bytes: Buffer.from('x'), filename: 'a.xlsx' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get('caption')).toBeNull();
  });

  /** Quotes/newlines would break the multipart header itself */
  it('the file name is sanitised', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    const channel = channelWith({ botToken: 'TOKEN', chatId: '42' });
    await channel.sendDocument({
      bytes: Buffer.from('x'),
      filename: '給料 "2026".xlsx\n',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const file = (init.body as FormData).get('document') as File;
    expect(file.name).toBe('2026.xlsx');
  });

  it('failed when the server rejects it, but no throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 400 })),
    );

    const channel = channelWith({ botToken: 'TOKEN', chatId: '42' });
    expect(
      await channel.sendDocument({ bytes: Buffer.from('x'), filename: 'a.xlsx' }),
    ).toBe('failed');
  });

  it('no throw even if the network breaks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    const channel = channelWith({ botToken: 'TOKEN', chatId: '42' });
    expect(
      await channel.sendDocument({ bytes: Buffer.from('x'), filename: 'a.xlsx' }),
    ).toBe('failed');
  });
});
