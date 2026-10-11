/**
 * Warzone-shield two-leg payment verification (#49). Encodes the WHY: the 10 SOL
 * must arrive as 50% STRAIGHT to liquidity + 50% via buy_sink (40/35/25), and the
 * verifier must REJECT a lopsided pay (e.g. 9 SOL to one leg) even though the total
 * is right — otherwise the "50% liquidity" routing guarantee is meaningless. The
 * liquidity wallet's on-chain delta = the direct leg + 40% of the split leg, so the
 * direct leg is reconstructed by subtracting that 40%.
 */
import { WARZONE } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { verifyWarzoneSplit } from '../src/money/depositWatcher';

const SOL = 1_000_000_000n;

describe('verifyWarzoneSplit — the 50/50 two-leg check', () => {
  it('the shield cost is 10 SOL split into two 5-SOL halves', () => {
    expect(BigInt(WARZONE.shieldCostSolLamports)).toBe(10n * SOL);
    expect(WARZONE.shieldLiquidityDirectBps).toBe(5_000);
  });

  it('accepts an exact 50/50 pay (5 SOL direct + 5 SOL buy_sink → 7 SOL liquidity delta)', () => {
    // liquidity delta = 5 (direct) + 40% of the 5-SOL split leg (=2) = 7 SOL
    const r = verifyWarzoneSplit(7n * SOL, 5n * SOL);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(10n * SOL);
  });

  it('rejects an underpaid direct leg (2 direct + 5 split → direct reconstructs to 2 < 5)', () => {
    expect(verifyWarzoneSplit(4n * SOL, 5n * SOL).ok).toBe(false);
  });

  it('rejects a LOPSIDED pay (9 direct + 1 buy_sink) — split leg is under its half', () => {
    // liquidity delta = 9 + 0.4 = 9.4 SOL; the split leg (1 SOL) is < its 5-SOL half.
    expect(verifyWarzoneSplit((94n * SOL) / 10n, 1n * SOL).ok).toBe(false);
  });

  it('accepts an overpay of both legs (6 + 6)', () => {
    const liqDelta = 6n * SOL + (6n * SOL * 4000n) / 10000n; // 6 direct + 40% of 6-SOL split
    expect(verifyWarzoneSplit(liqDelta, 6n * SOL).ok).toBe(true);
  });
});
