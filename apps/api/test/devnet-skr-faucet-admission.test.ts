import { describe, expect, it } from 'vitest';
import { skrGrantRaw, treasuryAdmission, utcWindow } from '../src/devnet-only/skrFaucet';

describe('SKR faucet independent admission arithmetic', () => {
  it('changes the reservation day exactly at UTC midnight', () => {
    expect(utcWindow(new Date('2026-10-02T23:59:59.999Z'))).toEqual({ day: '2026-10-02', nextEligibleAt: '2026-10-03T00:00:00.000Z' });
    expect(utcWindow(new Date('2026-10-03T00:00:00.000Z'))).toEqual({ day: '2026-10-03', nextEligibleAt: '2026-10-04T00:00:00.000Z' });
    expect(() => utcWindow(new Date(NaN))).toThrow();
  });
  it.each([[0, 1000n], [6, 1_000_000_000n], [9, 1_000_000_000_000n], [16, 10_000_000_000_000_000_000n]])(
    'uses exact raw arithmetic for decimals %i', (decimals, raw) => expect(skrGrantRaw(Number(decimals))).toBe(raw),
  );
  it.each([-1, 1.5, 17, 20, NaN])('refuses invalid or overflowing decimals %s', (decimals) => {
    expect(() => skrGrantRaw(decimals)).toThrow();
  });
  const base = { decimals: 6, balanceRaw: 5_000_000_000n, reservedAllRaw: 1_000_000_000n, reservedDayRaw: 1_000_000_000n,
    sentTodayRaw: 0n, floorSkr: 3000, dailyBudgetSkr: 3000 };
  it('holds absent inventory values and accepts equality with the floor', () => {
    expect(treasuryAdmission({ ...base, floorSkr: null })).toBe('unconfigured');
    expect(treasuryAdmission({ ...base, dailyBudgetSkr: null })).toBe('unconfigured');
    expect(treasuryAdmission(base)).toBe('ok');
    expect(treasuryAdmission({ ...base, balanceRaw: base.balanceRaw - 1n })).toBe('treasury_low');
  });
  it('counts retained reservations and sent-today against the budget using bigint', () => {
    expect(treasuryAdmission({ ...base, sentTodayRaw: 1_000_000_000n })).toBe('ok');
    expect(treasuryAdmission({ ...base, sentTodayRaw: 1_000_000_001n })).toBe('daily_budget');
    expect(treasuryAdmission({ ...base, decimals: 16, balanceRaw: 50_000_000_000_000_000_000n,
      reservedAllRaw: 10_000_000_000_000_000_000n, reservedDayRaw: 10_000_000_000_000_000_000n, sentTodayRaw: 10_000_000_000_000_000_001n })).toBe('daily_budget');
  });
  it('refuses negative accounting and invalid inventory ceilings', () => {
    for (const bad of [{ reservedAllRaw: -1n }, { reservedDayRaw: -1n }, { reservedDayRaw: 2_000_000_000n }, { sentTodayRaw: -1n }, { balanceRaw: -1n },
      { floorSkr: -1 }, { dailyBudgetSkr: 999 }, { floorSkr: NaN }, { dailyBudgetSkr: 2.5 }]) {
      expect(() => treasuryAdmission({ ...base, ...bad })).toThrow();
    }
  });
});
