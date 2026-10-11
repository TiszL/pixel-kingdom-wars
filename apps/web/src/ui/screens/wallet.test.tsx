/**
 * WALLET tab client pins (M23). The per-mint aggregation moved SERVER-SIDE in
 * round-3 (its pins live in apps/api/test/wallet-balances.test.ts); what the
 * client still owns is the render contract for money-adjacent numbers:
 * pending/failed must never look like an empty wallet.
 */
import { describe, expect, it } from 'vitest';
import { fmtBalance } from './wallet';

describe('fmtBalance', () => {
  it('renders pending/failed (null) as … — a loading or unreachable balance must not look like 0', () => {
    expect(fmtBalance(null)).toBe('…');
  });

  it('keeps dust visible with 4 decimals and big numbers grouped', () => {
    expect(fmtBalance(0.00123)).toBe('0.0012');
    expect(fmtBalance(0)).toBe('0');
    expect(fmtBalance(1234.5678)).toBe('1,234.57');
  });
});
