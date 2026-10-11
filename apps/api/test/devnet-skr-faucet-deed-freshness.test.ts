import { describe, expect, it } from 'vitest';
import { skrObservationIsFresh } from '../src/devnet-only/skrFaucetStore';
const now = new Date('2026-10-02T14:00:00.000Z');
const row = { owner: 'wallet', status: 'owned', slot: 123n, checkedAt: now };
describe('faucet explicit finalized deed observation freshness', () => {
  it('accepts a current observation of the authenticated wallet', () => {
    expect(skrObservationIsFresh(row, 'wallet', now)).toBe(true);
  });
  it('refuses future, stale and invalid receive times', () => {
    for (const offset of [-11_000, 1_000, NaN]) {
      expect(skrObservationIsFresh({ ...row, checkedAt: new Date(now.getTime() + offset) }, 'wallet', now)).toBe(false);
    }
    expect(skrObservationIsFresh(row, 'wallet', new Date(NaN))).toBe(false);
  });
  it('refuses missing/unsafe context slots, changed owners and non-owned status', () => {
    for (const changed of [{ slot: null }, { slot: -1n }, { slot: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      { owner: null }, { owner: 'other' }, { status: 'unavailable' }]) {
      expect(skrObservationIsFresh({ ...row, ...changed }, 'wallet', now)).toBe(false);
    }
  });
});
