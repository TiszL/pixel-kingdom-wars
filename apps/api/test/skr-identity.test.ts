import { Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { SKR_FAUCET } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { assertSkrMintPinsAgree, resolveSkrMint, type SkrRegistry } from '../src/money/skrIdentity';

const mint = Keypair.fromSeed(new Uint8Array(32).fill(71)).publicKey.toBase58();
const other = Keypair.fromSeed(new Uint8Array(32).fill(72)).publicKey.toBase58();
const registry = { cluster: 'devnet', skrMint: mint, skrDecimals: 6 } as const;

describe('registry SKR identity (R0)', () => {
  it('asserts registry auction pins after loading addresses and before any DB connection', () => {
    const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const loaded = source.indexOf('loadAddresses(repoRoot, config.SOLANA_CLUSTER)');
    const assertion = source.indexOf('assertSkrMintPinsAgree(addresses, config)');
    const database = source.indexOf('createDb(config.DATABASE_URL)');
    expect(loaded).toBeGreaterThan(0); expect(assertion).toBeGreaterThan(loaded);
    expect(database).toBeGreaterThan(assertion);
  });
  it('keeps an absent registry or absent pair unconfigured without reading env mint aliases', () => {
    expect(resolveSkrMint(null)).toBeNull();
    expect(resolveSkrMint({ cluster: 'devnet' })).toBeNull();
    expect(() => assertSkrMintPinsAgree({ cluster: 'devnet' }, {
      SOLANA_CLUSTER: 'devnet', MINING_TAX_AUCTION_MINT: other,
    })).not.toThrow();
  });
  it('resolves the registry pair, including zero decimals', () => {
    expect(resolveSkrMint(registry)).toEqual({ mint, decimals: 6 });
    expect(resolveSkrMint({ ...registry, skrDecimals: 0 })).toEqual({ mint, decimals: 0 });
  });
  it('rejects malformed pairs even when a caller bypasses the file loader', () => {
    for (const value of [
      { cluster: 'devnet', skrMint: mint }, { cluster: 'devnet', skrDecimals: 6 },
      { ...registry, skrMint: 'invalid' }, { ...registry, skrMint: null },
      ...[-1, 1.5, 20, NaN, Infinity, null, '6'].map((skrDecimals) => ({ ...registry, skrDecimals })),
    ]) expect(() => resolveSkrMint(value as SkrRegistry)).toThrow();
  });
  it('compares both existing auction pins with the registry and refuses cluster drift', () => {
    expect(() => assertSkrMintPinsAgree(registry, {
      SOLANA_CLUSTER: 'devnet', MINING_TAX_AUCTION_MINT: mint, SEEKER_REALM_SALE_AUCTION_MINT: mint,
    })).not.toThrow();
    for (const key of ['MINING_TAX_AUCTION_MINT', 'SEEKER_REALM_SALE_AUCTION_MINT']) {
      expect(() => assertSkrMintPinsAgree(registry, { SOLANA_CLUSTER: 'devnet', [key]: other })).toThrow(/pin/);
    }
    expect(() => assertSkrMintPinsAgree(registry, { SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(/cluster/);
  });
  it('refuses both real SKR identities on devnet through the resolver itself', () => {
    for (const skrMint of SKR_FAUCET.devnet.refusedMints) {
      expect(() => resolveSkrMint({ ...registry, skrMint })).toThrow(/refused/);
      expect(resolveSkrMint({ ...registry, cluster: 'mainnet-beta', skrMint })).toEqual({ mint: skrMint, decimals: 6 });
    }
  });
});
