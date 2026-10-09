import { describe, expect, it } from 'vitest';

import { formatDay } from '../src/mail/mail-text';
import { statementMail } from '../src/hours-statement/statement-mail';
import { statementWorkbook } from '../src/hours-statement/statement-sheet';

const lines = [
  {
    fullName: 'Ana <Lima>',
    empCode: 'A1',
    toPostMin: 10_405,
    carryInSec: 3_600,
    leaveDays: 1,
    holidayDays: 0,
    noDataDays: 0,
  },
  {
    fullName: 'Bo',
    empCode: 'B2',
    toPostMin: -50,
    carryInSec: -3_600,
    leaveDays: 0,
    holidayDays: 1,
    noDataDays: 2,
  },
];

describe('formatDay', () => {
  it('day first in pt-BR and es', () => {
    expect(formatDay('2026-09-26', 'pt-BR')).toBe('26/09/2026');
    expect(formatDay('2026-09-26', 'es')).toBe('26/09/2026');
  });
});

describe('statementMail', () => {
  const mail = statementMail({
    lang: 'pt-BR',
    org: 'Acme',
    start: '2026-09-26',
    end: '2026-10-25',
    lines,
    link: 'https://app.example/hours?period=3',
  });

  it('subject names the company and the dates', () => {
    expect(mail.subject).toBe(
      'Acme — horas para lançar, de 26/09/2026 a 25/10/2026',
    );
  });

  it('one line per person in hours and minutes, carry and days off', () => {
    expect(mail.text).toContain('Ana <Lima> (A1): 173 h 25 min a lançar');
    expect(mail.text).toContain(
      'inclui 1 h 00 min de ajuste de períodos anteriores',
    );
    expect(mail.text).toContain('dias de folga: 1');
    expect(mail.text).toContain('https://app.example/hours?period=3');
  });

  it('warnings: no recorded time, negative result', () => {
    expect(mail.text).toContain('Bo: 2 dia(s) útil(eis) sem tempo registrado');
    expect(mail.text).toContain('Bo: resultado negativo');
  });

  it('the html escapes names and never mentions money', () => {
    expect(mail.html).toContain('Ana &lt;Lima&gt;');
    expect(mail.html).not.toContain('<Lima>');
    expect(`${mail.text}${mail.html}`).not.toMatch(/rate|salary|R\$|\$/i);
  });

  it('no link configured: no link line', () => {
    const plain = statementMail({
      lang: 'en',
      org: 'Acme',
      start: '2026-09-26',
      end: '2026-10-25',
      lines,
      link: null,
    });
    expect(plain.text).not.toContain('http');
  });
});

describe('statementWorkbook', () => {
  it('builds a file', async () => {
    const bytes = await statementWorkbook({
      start: '2026-09-26',
      end: '2026-10-25',
      lines: lines.map((l) => ({
        ...l,
        fromDate: '2026-09-26',
        toDate: '2026-10-25',
        measuredSec: 600_000,
      })),
      days: [
        {
          fullName: 'Ana',
          empCode: 'A1',
          date: '2026-09-28',
          arrived: '08:02',
          left: '17:01',
          presenceHours: 8,
          activeHours: 7.2,
          adjustmentHours: 0,
          creditedHours: 8,
        },
      ],
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
