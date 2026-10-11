import { existsSync, readFileSync } from 'node:fs';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAddresses, resolvePhaseEKeepV4Identity, type ChainAddresses } from './bootstrap';
import * as constants from '@shardkeep/shared';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(), readFileSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn(),
}));

// Synthetic public bytes only: no keypair generation, private files, RPC or signing.
const address = (tag: number): string => new PublicKey(new Uint8Array(32).fill(tag)).toBase58();
const reserve = 'CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q';
const operator = 'AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv';
const authority = 'A3MRaRRDw6qJfYu8Z8xZfHcSWNEZuMc91nQ2cCurQXEP';
const registry = (): ChainAddresses => ({
  cluster: 'devnet', coreProgram: address(1), keepMint: address(2),
  keepMintBranded: address(2), keepMintV4: address(3), config: address(4),
  treasuries: { liquidity: address(5), dev: address(6), ops: address(7) },
  updatedAt: '2026-10-03T00:00:00Z',
});
const selection = () => ({
  SOLANA_CLUSTER: 'devnet', PHASE_E_KEEP_IDENTITY: 'keep-v4', PHASE_E_KEEP_RESERVE_OWNER: reserve,
});
const load = (value: unknown) => {
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(value));
  return loadAddresses('/synthetic-public-registry');
};

describe('Phase E KEEP v4 producer boundary (D153.331)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('keeps legacy registries valid without inserting a future mint', () => {
    const { keepMintV4: _unused, ...legacy } = registry();
    expect(load(legacy)).toEqual(legacy);
    expect(load(legacy)).not.toHaveProperty('keepMintV4');
  });
  it('assigns the D153.331 genesis only to RESERVE from the existing play pool constant', () => {
    expect(constants.PHASE_E_KEEP_V4_GENESIS).toEqual({ reserve: constants.TOKEN.allocation.playPool });
  });
  it('accepts a distinct canonical public mint without changing any legacy field', () => {
    expect(load(registry())).toEqual(registry());
  });
  it.each([null, '', 'not-base58', 123, address(3) + ' ', '1'.repeat(33)])(
    'refuses a present malformed optional mint (%s)', (keepMintV4) => {
      expect(() => load({ ...registry(), keepMintV4 })).toThrow(/keepMintV4/);
    },
  );
  it.each(['keepMint', 'keepMintBranded', 'coreProgram', 'config'] as const)(
    'refuses aliasing the v4 mint to registry %s', (field) => {
      const value = registry();
      expect(() => load({ ...value, keepMintV4: value[field] })).toThrow(/distinct/);
    },
  );
  it('refuses collisions with nested or future registry keys', () => {
    expect(() => load({ ...registry(), future: { owner: address(3) } })).toThrow(/distinct/);
    expect(() => load({ ...registry(), keepMintV4: registry().treasuries.ops })).toThrow(/distinct/);
  });
  it.each([
    authority, reserve, operator, '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
    'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8',
    '5cYNJabvsfTUAZBK31yp6ZknKiv9dRdJoBKjggWpDWLV',
    'GV1DHT162yYFfFeZh7yXcPyCYamMj7bmDa77tNTupMXb',
    'AKssxaa5uy51qRirVcTWjoVxnjufvS9Fzw3HCDNCpfhm',
  ])(
    'refuses a role authority as the mint account (%s)', (keepMintV4) => {
      expect(() => load({ ...registry(), keepMintV4 })).toThrow(/role|authority/);
    },
  );
  it('refuses the real legacy mint even when the registry names a different synthetic v3 mint', () => {
    expect(() => load({ ...registry(), keepMintV4: '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC' }))
      .toThrow(/legacy mint/);
  });
  it.each([SystemProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58()])(
    'refuses known program address %s as the mint account', (keepMintV4) => {
      expect(() => load({ ...registry(), keepMintV4 })).toThrow(/program/);
    },
  );
  it('defaults disabled and preserves legacy Gems config without selecting v3', () => {
    expect(resolvePhaseEKeepV4Identity(null, {}, undefined)).toBeNull();
    expect(resolvePhaseEKeepV4Identity(registry(), {
      PHASE_E_KEEP_IDENTITY: 'disabled', GEMS_RESERVE_OWNER: address(8),
    }, undefined)).toBeNull();
  });
  it.each(['', 'v3', 'KEEP-V4', ' keep-v4', 'keep-v4 '])('refuses unknown selector %s', (value) => {
    expect(() => resolvePhaseEKeepV4Identity(registry(), {
      ...selection(), PHASE_E_KEEP_IDENTITY: value,
    }, operator)).toThrow(/PHASE_E_KEEP_IDENTITY/);
  });
  it('selected v4 refuses missing registry or mint even if KEEP_MINT supplies a value', () => {
    expect(() => resolvePhaseEKeepV4Identity(null, selection(), operator)).toThrow(/registry/);
    const { keepMintV4: _unused, ...legacy } = registry();
    expect(() => resolvePhaseEKeepV4Identity(legacy, {
      ...selection(), KEEP_MINT: address(3),
    }, operator)).toThrow(/keepMintV4/);
  });
  it('selected v4 refuses a mainnet registry', () => {
    expect(() => resolvePhaseEKeepV4Identity({ ...registry(), cluster: 'mainnet-beta' },
      selection(), operator)).toThrow(/devnet/);
  });
  it.each([undefined, '', 'mainnet-beta'])('refuses absent or conflicting configured cluster %s', (SOLANA_CLUSTER) => {
    expect(() => resolvePhaseEKeepV4Identity(registry(), {
      ...selection(), SOLANA_CLUSTER,
    }, operator)).toThrow(/SOLANA_CLUSTER/);
  });
  it.each([undefined, '', address(8), 'invalid', reserve + ' '])(
    'requires the exact reviewed RESERVE owner (%s)', (PHASE_E_KEEP_RESERVE_OWNER) => {
      expect(() => resolvePhaseEKeepV4Identity(registry(), {
        ...selection(), PHASE_E_KEEP_RESERVE_OWNER,
      }, operator)).toThrow(/PHASE_E_KEEP_RESERVE_OWNER/);
    },
  );
  it.each([undefined, reserve, '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q', address(8)])(
    'refuses absent or wrong operator %s', (value) => {
      expect(() => resolvePhaseEKeepV4Identity(registry(), selection(), value)).toThrow(/operator/);
    },
  );
  it.each(['PHASE_E_GEMS_RESERVE_OWNER', 'PHASE_E_KEEP_GEMS_RESERVE_ATA', 'gemsReserveOwner', 'gems_reserve_ata'])(
    'refuses obsolete v4 config even if blank: %s', (key) => {
      expect(() => resolvePhaseEKeepV4Identity(registry(), { ...selection(), [key]: '' }, operator))
        .toThrow(/obsolete gems-reserve identity field/);
    },
  );
  it('refuses obsolete v4 registry fields, including nested fields', () => {
    const value = { ...registry(), phaseE: { gemsReserveAta: address(9) } };
    expect(() => resolvePhaseEKeepV4Identity(value, selection(), operator))
      .toThrow(/obsolete gems-reserve identity field/);
  });
  it.each(['gemsReserve', 'GEMS_RESERVE_OWNER', 'gems-reserve-ata', 'gems__reserveOwner'])(
    'refuses any normalized obsolete registry key: %s', (key) => {
      expect(() => resolvePhaseEKeepV4Identity({ ...registry(), [key]: '' }, selection(), operator))
        .toThrow(/obsolete gems-reserve identity field/);
    },
  );
  it('normalizes nested registry keys with suffixes and follows arrays', () => {
    // A variable, not an inline literal: the obsolete key is the input under test, and an inline
    // literal with a key the registry type does not declare is a compile error (TS2353).
    const treasuries = { ...registry().treasuries, gemsReserveAta2: '' };
    expect(() => resolvePhaseEKeepV4Identity({
      ...registry(), treasuries,
    }, selection(), operator)).toThrow(/obsolete gems-reserve identity field/);
    const value = { ...registry(), future: [{ deeper: { 'GeMs---reserveOWNER': null } }] };
    expect(() => resolvePhaseEKeepV4Identity(value, selection(), operator))
      .toThrow(/obsolete gems-reserve identity field/);
  });
  it.each(['PHASE_E_gEmS-reserve-ata', 'PHASE_E_GEMS__RESERVE_OWNER'])(
    'normalizes obsolete Phase E env spelling while preserving legacy env: %s', (key) => {
      expect(() => resolvePhaseEKeepV4Identity(registry(), { ...selection(), [key]: '' }, operator))
        .toThrow(/obsolete gems-reserve identity field/);
      expect(resolvePhaseEKeepV4Identity(registry(), {
        ...selection(), GEMS_RESERVE_OWNER: address(8), GEMS_RESERVE_ATA: address(9),
      }, operator)).not.toBeNull();
    },
  );
  it('produces only reserve recovery trust and the operator; ignores KEEP_MINT', () => {
    const value = registry();
    const before = structuredClone(value);
    expect(resolvePhaseEKeepV4Identity(value, {
      ...selection(), KEEP_MINT: address(9), GEMS_RESERVE_OWNER: address(8),
    }, operator)).toEqual({
      keepMintV4: address(3), reserveOwner: reserve,
      reserveAta: getAssociatedTokenAddressSync(new PublicKey(address(3)), new PublicKey(reserve)).toBase58(),
      operator,
    });
    expect(value).toEqual(before);
  });
});
