import { describe, expect, it } from 'vitest';

import {
  checkDisplayLocale,
  DISPLAY_LOCALE,
} from '../src/common/display-locale';

/** DISPLAY_LOCALE — empty by default, a wrong value stops the server */
describe('checkDisplayLocale', () => {
  it('unset → null: the dashboard keeps its formats', () => {
    expect(DISPLAY_LOCALE).toBeNull();
    expect(checkDisplayLocale(undefined)).toBeNull();
    expect(checkDisplayLocale('  ')).toBeNull();
  });

  it('canonical tag', () => {
    expect(checkDisplayLocale('pt-br')).toBe('pt-BR');
    expect(checkDisplayLocale('en-GB')).toBe('en-GB');
  });

  it('a malformed tag stops the server', () => {
    expect(() => checkDisplayLocale('pt_BR!!')).toThrow(/DISPLAY_LOCALE/);
  });
});
