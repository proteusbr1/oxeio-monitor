import { describe, expect, it } from 'vitest';

import {
  LINK_MAX,
  MAX_BULK_LINES,
  parseLine,
  previewBulk,
  REFERENCE_MAX,
} from '../src/pages/tasks/bulk';

/**
 * **What a pasted line means** — the three formats the Add tasks box explains.
 *
 * Careful: the preview must name the same outcome the server will; a box that
 * says "12 ready" and then adds 10 is worse than no preview at all.
 */
describe('parseLine — the three line formats', () => {
  it('a reference on its own makes a task with no link', () => {
    expect(parseLine('  INV-2041  ')).toEqual({ reference: 'INV-2041', link: null });
  });

  it('`reference | link` keeps both', () => {
    expect(parseLine('INV-2041 | https://example.com/inv/2041')).toEqual({
      reference: 'INV-2041',
      link: 'https://example.com/inv/2041',
    });
  });

  it('a bare URL is both the reference and the link', () => {
    expect(parseLine('https://example.com/t/88')).toEqual({
      reference: 'https://example.com/t/88',
      link: 'https://example.com/t/88',
    });
  });

  /** Careful: a `|` inside the link's query string must not cut it */
  it('only the first bar splits', () => {
    expect(parseLine('A-1 | https://example.com/?q=a|b')).toEqual({
      reference: 'A-1',
      link: 'https://example.com/?q=a|b',
    });
  });

  it('a link with no reference names the task itself; a reference with an empty link has none', () => {
    expect(parseLine('| https://example.com/x')).toEqual({
      reference: 'https://example.com/x',
      link: 'https://example.com/x',
    });
    expect(parseLine('A-1 |')).toEqual({ reference: 'A-1', link: null });
  });
});

describe('parseLine — what is turned away, and why', () => {
  /** Careful: the link becomes a clickable anchor on everyone's screen */
  it('anything but an http(s) link is a bad link', () => {
    expect(parseLine('A-1 | javascript:alert(1)')).toEqual({ reason: 'bad_link' });
    expect(parseLine('A-1 | example.com/x')).toEqual({ reason: 'bad_link' });
    expect(parseLine('A-1 | https://exa mple.com')).toEqual({ reason: 'bad_link' });
    expect(parseLine('|')).toEqual({ reason: 'bad_link' });
  });

  it('too long for the column', () => {
    expect(parseLine('x'.repeat(REFERENCE_MAX + 1))).toEqual({ reason: 'too_long' });
    expect(parseLine('x'.repeat(REFERENCE_MAX))).toEqual({
      reference: 'x'.repeat(REFERENCE_MAX),
      link: null,
    });
    const longLink = 'https://example.com/' + 'a'.repeat(LINK_MAX);
    expect(parseLine(`A-1 | ${longLink}`)).toEqual({ reason: 'too_long' });
  });
});

describe('previewBulk — the count before sending', () => {
  it('blank lines are skipped, repeats in the same paste are named', () => {
    const preview = previewBulk('A-1\n\n  \nA-2 | https://example.com/2\r\nA-1\nB | ftp://x');
    expect(preview.lines).toBe(4);
    expect(preview.ready).toBe(2);
    expect(preview.rejected).toEqual([
      { line: 5, text: 'A-1', reason: 'duplicate_in_paste' },
      { line: 6, text: 'B | ftp://x', reason: 'bad_link' },
    ]);
    expect(preview.overLimit).toBe(false);
  });

  it(`more than ${MAX_BULK_LINES} lines is over the limit`, () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `T-${i}`).join('\n');
    expect(previewBulk(lines(MAX_BULK_LINES)).overLimit).toBe(false);
    expect(previewBulk(lines(MAX_BULK_LINES + 1)).overLimit).toBe(true);
  });

  it('an empty box has nothing to add', () => {
    expect(previewBulk('  \n ')).toEqual({ lines: 0, ready: 0, rejected: [], overLimit: false });
  });
});
