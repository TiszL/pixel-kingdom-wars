import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { buildBuySinkTx, buildKeepDepositTx, SINK_KIND } from './chain';

describe('generic SOL sink', () => {
  it('encodes the server-priced builder kind and exact u64 lamports', () => {
    const wallet = new PublicKey('11111111111111111111111111111111');
    const reference = new PublicKey('Vote111111111111111111111111111111111111111');
    const amount = 3_000_000_000n;
    const [ix] = buildBuySinkTx(wallet, reference, 'builder', amount).instructions;

    expect(SINK_KIND.builder).toBe(8);
    expect(ix).toBeDefined();
    expect(ix!.keys).toHaveLength(7); // buy_sink intentionally has no legacy Player PDA.
    expect([...ix!.data.slice(0, 9)]).toEqual([
      220, 121, 168, 150, 121, 25, 213, 14, 8,
    ]);
    expect(ix!.data.readBigUInt64LE(9)).toBe(amount);
  });

  it('keeps repeatable Land Deed purchases separate from one-time pay_entry', () => {
    const wallet = new PublicKey('11111111111111111111111111111111');
    const reference = new PublicKey('Vote111111111111111111111111111111111111111');
    const [ix] = buildBuySinkTx(wallet, reference, 'deed', 200_000_000n).instructions;
    expect(SINK_KIND.deed).toBe(9);
    expect(ix!.data[8]).toBe(9);
    expect(ix!.data.readBigUInt64LE(9)).toBe(200_000_000n);
  });
});

describe('KEEP deposit transfer', () => {
  const account = new PublicKey('11111111111111111111111111111111');
  const reference = new PublicKey('Vote111111111111111111111111111111111111111');

  it('encodes a directly-entered 100,000 KEEP amount exactly as SPL base units', () => {
    const amount = 100_000n * 10n ** 9n;
    const [ix] = buildKeepDepositTx({
      source: account, mint: reference, destination: account, owner: reference,
      reference, amountBaseUnits: amount, decimals: 9,
    }).instructions;
    expect(ix).toBeDefined();
    expect(ix!.data[0]).toBe(12); // SPL Token TransferChecked
    expect(ix!.data.readBigUInt64LE(1)).toBe(amount);
    expect(ix!.data[9]).toBe(9);
    expect(ix!.keys).toHaveLength(5); // source, mint, custody ATA, signer, reference
  });

  it('refuses values that would otherwise silently wrap the u64 wire amount', () => {
    const build = (amountBaseUnits: bigint) => buildKeepDepositTx({
      source: account, mint: reference, destination: account, owner: reference,
      reference, amountBaseUnits, decimals: 9,
    });
    expect(() => build(1n << 64n)).toThrow(/unsigned 64-bit/i);
    expect(() => build(-1n)).toThrow(/unsigned 64-bit/i);
  });
});
