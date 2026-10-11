import { MARKETPLACE } from '@shardkeep/shared';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./useGameWallet', () => ({ useGameWallet: vi.fn() }));
import { marketConfirmationWithinWindow } from './useMarketRecovery';
describe('bounded explicit marketplace confirmation', () => {
  const start = { elapsed: 100, wall: 1000000 };
  const window = MARKETPLACE.itemMarket.settleTimeoutSec * 1000;
  it('does not start automatic paid/settle on mount without explicit intent', () => {
    expect(marketConfirmationWithinWindow(null, start)).toBe(false);
  });
  it('ends at the canonical bound even if a sleeping browser monotonic clock stalls', () => {
    expect(marketConfirmationWithinWindow(start, { elapsed: 100, wall: start.wall + window })).toBe(false);
    expect(marketConfirmationWithinWindow(start, { elapsed: start.elapsed + window, wall: start.wall })).toBe(false);
    expect(marketConfirmationWithinWindow(start, { elapsed: start.elapsed + window - 1, wall: start.wall + window - 1 })).toBe(true);
  });
  it('rejects either clock moving backward instead of extending mutation polling', () => {
    expect(marketConfirmationWithinWindow(start, { ...start, elapsed: 99 })).toBe(false);
    expect(marketConfirmationWithinWindow(start, { ...start, wall: 999999 })).toBe(false);
  });
});
