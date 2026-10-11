/**
 * errorForStorage — the ONLY thing standing between an RPC failure string and a
 * live credential parked in withdrawals.lastError / outbox.lastError. WHY each
 * case: every URL style an operator can plausibly put in SOLANA_RPC_URL must
 * come out host-only (verification 2026-07-26 found basic-auth userinfo
 * surviving the original strip).
 */
import { describe, expect, it } from 'vitest';
import { errorForStorage } from '../src/lib/errors';

describe('errorForStorage', () => {
  it('strips a Helius-style query api-key', () => {
    expect(errorForStorage('fetch failed: https://mainnet.helius-rpc.com/?api-key=11111111-aaaa-bbbb-cccc-222222222222 (503)'))
      .toBe('fetch failed: https://mainnet.helius-rpc.com (503)');
  });

  it('strips a QuickNode-style path token', () => {
    expect(errorForStorage('Error: request to https://weathered-cool.solana-mainnet.quiknode.pro/abcdef0123456789/ failed'))
      .toBe('Error: request to https://weathered-cool.solana-mainnet.quiknode.pro failed');
  });

  it('strips basic-auth userinfo (user:pass@host)', () => {
    expect(errorForStorage('conn refused https://user:secretpass@rpc.example.com/some/path?x=1'))
      .toBe('conn refused https://rpc.example.com');
  });

  it('leaves non-URL text intact and truncates at max', () => {
    expect(errorForStorage('plain database error: duplicate key')).toBe('plain database error: duplicate key');
    expect(errorForStorage('x'.repeat(600), 500)).toHaveLength(500);
  });
});
