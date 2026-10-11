import { describe, expect, it } from 'vitest';
import { assertGameCurrency, chooseGameCurrency } from './gameCurrency';
const funds = (gems: string, keep: string) => ({ gems, keep, features: {
  gameCurrency: { version: 1, exactSpendCurrency: 1 }, gems: { version: 1, receipts: 1 },
} });
describe('reviewed whole-price currency', () => {
  it('selects Gems when funded, otherwise whole KEEP; never pools balances', () => {
    expect(chooseGameCurrency('10', funds('10', '20'))).toBe('GEMS');
    expect(chooseGameCurrency('10', funds('9', '10'))).toBe('KEEP');
    expect(() => chooseGameCurrency('10', funds('9', '9'))).toThrow('Neither');
  });
  it('exact KEEP is available while Gems is paused, but missing/unknown enforcement never becomes consent', () => {
    const paused = { keep: '10', features: { gameCurrency: { version: 1, exactSpendCurrency: 1 } } };
    expect(chooseGameCurrency('10', paused)).toBe('KEEP');
    expect(() => chooseGameCurrency('10', { keep: '10' })).toThrow('cannot enforce');
    expect(() => chooseGameCurrency('10', { ...funds('10', '10'), features: { gameCurrency: { version: 2, exactSpendCurrency: 1 } } })).toThrow();
    expect(() => assertGameCurrency('GEMS', '10', paused)).toThrow('paused');
  });
  it('rechecking cannot silently switch currencies or accept malformed money', () => {
    expect(() => assertGameCurrency('GEMS', '10', funds('0', '100'))).toThrow('reviewed GEMS');
    for (const value of ['-1', '1e3', '01', '9223372036854775808']) {
      expect(() => chooseGameCurrency('10', funds(value, '100'))).toThrow('balances');
    }
  });
});
