import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, type Connection } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  legacyBootstrapBucketKey, loadAddresses, runBootstrap, type DevnetAddresses,
} from './bootstrap';

describe('legacy devnet bootstrap safety', () => {
  const roots: string[] = [];
  const address = (): string => Keypair.generate().publicKey.toBase58();

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('preserves the historical fifth-bucket key identity after terminology changes', () => {
    expect(legacyBootstrapBucketKey('unallocated')).toBe('questBucket');
    expect(legacyBootstrapBucketKey('playPool')).toBe('playPool');
  });

  it('types and loads the current address manifest without retired allocation buckets', () => {
    const root = mkdtempSync(join(tmpdir(), 'shardkeep-addresses-'));
    roots.push(root);
    mkdirSync(join(root, 'infra'));
    const current = {
      cluster: 'devnet',
      coreProgram: address(),
      distributorProgram: address(),
      keepMint: address(),
      keepMintBranded: address(),
      treasuries: { liquidity: address(), dev: address(), ops: address() },
      config: address(),
      deedCollection: address(),
      updatedAt: '2026-08-18T00:00:00.000Z',
    } satisfies DevnetAddresses;
    writeFileSync(join(root, 'infra', 'devnet.addresses.json'), JSON.stringify(current));

    expect(loadAddresses(root)).toEqual(current);
    expect(loadAddresses(root)).not.toHaveProperty('buckets');
  });

  it('selects the requested cluster registry and rejects a mislabeled file', () => {
    const root = mkdtempSync(join(tmpdir(), 'shardkeep-addresses-'));
    roots.push(root);
    mkdirSync(join(root, 'infra'));
    const mainnet = {
      cluster: 'mainnet-beta',
      coreProgram: address(), keepMint: address(),
      treasuries: { liquidity: address(), dev: address(), ops: address() },
      config: address(),
      programDeployments: {
        core: {
          programDataAddress: address(), programDataSha256: 'a'.repeat(64),
          upgradeAuthority: null,
        },
      },
      updatedAt: '2026-08-18T00:00:00.000Z',
    } satisfies DevnetAddresses;
    writeFileSync(join(root, 'infra', 'mainnet.addresses.json'), JSON.stringify(mainnet));
    expect(loadAddresses(root, 'mainnet-beta')).toEqual(mainnet);
    expect(loadAddresses(root, 'devnet')).toBeNull();

    writeFileSync(join(root, 'infra', 'devnet.addresses.json'), JSON.stringify(mainnet));
    expect(() => loadAddresses(root, 'devnet')).toThrow(/declares mainnet-beta, expected devnet/);
  });

  it('fails before chain or keypair work once token:mint established a branded mint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shardkeep-bootstrap-'));
    roots.push(root);
    mkdirSync(join(root, 'infra'));
    writeFileSync(
      join(root, 'infra', 'devnet.addresses.json'),
      JSON.stringify({
        cluster: 'devnet',
        coreProgram: address(),
        distributorProgram: address(),
        keepMint: address(),
        keepMintBranded: address(),
        treasuries: { liquidity: address(), dev: address(), ops: address() },
        config: address(),
        updatedAt: '2026-08-18T00:00:00.000Z',
      }),
    );

    await expect(
      runBootstrap({
        connection: {} as Connection,
        admin: Keypair.generate(),
        paths: { root },
        now: '2026-08-18T00:00:00.000Z',
      }),
    ).rejects.toThrow('legacy bootstrap refuses to run after token:mint established branded KEEP mint');

    expect(existsSync(join(root, 'infra', 'keys'))).toBe(false);
  });

  it('requires the optional SKR mint and decimals together, including decimals zero', () => {
    const root = mkdtempSync(join(tmpdir(), 'shardkeep-skr-addresses-'));
    roots.push(root);
    mkdirSync(join(root, 'infra'));
    const registry = {
      cluster: 'devnet', coreProgram: address(), keepMint: address(), config: address(),
      treasuries: { liquidity: address(), dev: address(), ops: address() },
      updatedAt: '2026-10-02T00:00:00.000Z',
    };
    const write = (extra: Record<string, unknown>) => writeFileSync(
      join(root, 'infra', 'devnet.addresses.json'), JSON.stringify({ ...registry, ...extra }),
    );
    write({});
    expect(loadAddresses(root)).not.toHaveProperty('skrMint');
    for (const skrDecimals of [0, 6, 19]) {
      const skrMint = address();
      write({ skrMint, skrDecimals });
      expect(loadAddresses(root)).toMatchObject({ skrMint, skrDecimals });
    }
    for (const bad of [
      { skrMint: address() }, { skrDecimals: 6 }, { skrMint: null, skrDecimals: 6 },
      { skrMint: '', skrDecimals: 6 }, { skrMint: 'not a public key', skrDecimals: 6 },
      ...[-1, 1.5, 20, '6', null].map((skrDecimals) => ({ skrMint: address(), skrDecimals })),
    ]) {
      write(bad);
      expect(() => loadAddresses(root), JSON.stringify(bad)).toThrow();
    }
  });
});
