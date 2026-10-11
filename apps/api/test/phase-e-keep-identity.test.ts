/** Accepted KEEP-v4 consumer contract (review 68d06fbe).
 * Public synthetic mint fixtures only; no DB, RPC, signing or generated keys.
 * These tests do not establish ceremony, deployment or SQL-trigger acceptance. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { keepAta, SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { PgDialect } from 'drizzle-orm/pg-core';
import { loadConfig, type Config } from '../src/config';
import type { Db } from '../src/db/client';

const h = vi.hoisted(() => ({ claim: vi.fn(), tax: vi.fn(), backing: vi.fn() }));
vi.mock('@shardkeep/chain/mining-claim-snapshot', () => ({ createMiningClaimSnapshotReader: h.claim }));
vi.mock('@shardkeep/chain/mining-tax-quote', () => ({ createMiningTaxQuoteReader: h.tax }));
vi.mock('@shardkeep/chain/mining-backing', () => ({ createMiningBackingSnapshotReader: h.backing }));

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const roles = {
  economyProgram: '5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr',
  craftProgram: '4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59',
  treasury: '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q',
  reserveOwner: 'CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q',
  gemsReserveOwner: 'GV1DHT162yYFfFeZh7yXcPyCYamMj7bmDa77tNTupMXb',
  mintAuthority: 'A3MRaRRDw6qJfYu8Z8xZfHcSWNEZuMc91nQ2cCurQXEP',
  economyUpgradeAuthority: 'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8',
};
const legacy = { cluster: 'devnet' as const, keepMint: pk(1), coreProgram: pk(2), configPda: pk(3) };
const registry = () => ({ cluster: 'devnet' as const, keepMint: legacy.keepMint, keepMintV4: pk(4) });
const review = () => ({
  cluster: 'devnet' as const, genesisHash: SOLANA_GENESIS_HASH.devnet, keepMint: pk(4),
  economyProgram: roles.economyProgram, craftProgram: roles.craftProgram, treasury: roles.treasury,
  reserveOwner: roles.reserveOwner, reserveAta: keepAta(new PublicKey(roles.reserveOwner), new PublicKey(pk(4)), true).toBase58(),
  bindingReceiptSha256: 'a'.repeat(64),
  economyDeployment: { reviewedDeploymentSlot: 90, reviewedProgramDataSha256: 'b'.repeat(64),
    upgradeAuthority: roles.economyUpgradeAuthority },
});
const selection = () => ({ SOLANA_CLUSTER: 'devnet' as const, PHASE_E_KEEP_IDENTITY: 'keep-v4' as const,
  PHASE_E_KEEP_RESERVE_OWNER: roles.reserveOwner, HOT_WALLET_PUBKEY: pk(5) });
// Runtime consumers take parsed Config: exercise absent/default input through its real parser.
// Only the selector is copied; synthetic runtime pins and identity-refusal assertions stay intact.
const legacySelector = (selector?: 'disabled') => loadConfig({
  DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/identity_fixture',
  JWT_SECRET: 'test-only-phase-e-identity-jwt-secret', WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test',
  PHASE_E_KEEP_IDENTITY: selector,
}).PHASE_E_KEEP_IDENTITY;
const row = () => {
  const r = review();
  return { singleton: true, cluster: r.cluster, genesis_hash: r.genesisHash, keep_mint: r.keepMint,
    economy_program: r.economyProgram, craft_program: r.craftProgram, treasury: r.treasury,
    reserve_owner: r.reserveOwner, reserve_ata: r.reserveAta, binding_receipt_sha256: r.bindingReceiptSha256,
    bound_at: new Date('2026-10-03T00:00:00Z') };
};
function database(rows: unknown[] = [row()]) {
  const queries: string[] = [];
  const execute = vi.fn(async (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
    queries.push(new PgDialect().sqlToQuery(statement).sql.replace(/\s+/g, ' ').trim());
    return rows;
  });
  const insert = vi.fn(() => { throw Error('Serving must not bind'); });
  const transaction = vi.fn(() => { throw Error('Serving must only read'); });
  return { db: { execute, insert, transaction } as unknown as Db, execute, insert, transaction, queries };
}
const load = () => import('../src/money/phaseEKeepIdentity');
async function admitted() {
  const api = await load(), db = database();
  const selected = api.resolvePhaseEKeepIdentity(selection(), registry(), review());
  if (!selected) throw Error('fixture must select v4');
  return { api, db, identity: await api.assertPhaseEKeepIdentity(db.db, selected) };
}
const runtimeConfig = () => ({ ...selection(), NODE_ENV: 'test', SOLANA_RPC_URL: 'http://127.0.0.1:1',
  MINING_CLAIM_PROGRAM_ID: roles.economyProgram, MINING_CLAIM_DEPLOYMENT_SLOT: 90,
  MINING_CLAIM_PROGRAM_DATA_SHA256: 'b'.repeat(64), MINING_CLAIM_ORDERED_ENABLED: 'false',
  MINING_TRANSPARENCY_PROGRAM_ID: roles.economyProgram, MINING_TRANSPARENCY_DEPLOYMENT_SLOT: 90,
  MINING_TRANSPARENCY_PROGRAM_DATA_SHA256: 'b'.repeat(64),
  MINING_TAX_PROGRAM_ID: roles.economyProgram, MINING_TAX_DEPLOYMENT_SLOT: 90,
  MINING_TAX_PROGRAM_DATA_SHA256: 'b'.repeat(64), MINING_TAX_UPGRADE_AUTHORITY: roles.economyUpgradeAuthority,
  MINING_TAX_AUCTION_MINT: pk(9), MINING_TAX_PRIZE_OWNER: roles.treasury,
  MINING_TAX_STATE_PROVENANCE: 'fresh-reviewed-deployment',
} as unknown as Config & ReturnType<typeof selection>);

beforeEach(() => { vi.clearAllMocks(); h.claim.mockReturnValue(vi.fn()); h.tax.mockReturnValue(vi.fn()); });
afterEach(() => vi.unstubAllEnvs());

describe('explicit Phase E KEEP identity selection', () => {
  it('stays disabled without consulting a malformed or absent v4 manifest', async () => {
    const { resolvePhaseEKeepIdentity } = await load();
    expect(resolvePhaseEKeepIdentity({ SOLANA_CLUSTER: 'devnet' }, registry())).toBeNull();
    expect(resolvePhaseEKeepIdentity({ ...selection(), PHASE_E_KEEP_IDENTITY: 'disabled' },
      { ...registry(), keepMintV4: 'not-a-key' })).toBeNull();
  });
  it('selects only the named v4 public tuple, derives the RESERVE ATA without obsolete Gems fields, and ignores KEEP_MINT', async () => {
    const { resolvePhaseEKeepIdentity } = await load();
    vi.stubEnv('KEEP_MINT', roles.mintAuthority);
    const input = registry(), approved = review(), selected = resolvePhaseEKeepIdentity(selection(), input, approved)!;
    expect(selected).toMatchObject({ ...approved, kind: 'keep-v4' });
    expect(selected.keepMint).not.toBe(input.keepMint);
    expect(selected.reserveAta).toBe(keepAta(new PublicKey(roles.reserveOwner), new PublicKey(pk(4)), true).toBase58());
    expect(selected).not.toHaveProperty('gemsReserveOwner'); expect(selected).not.toHaveProperty('gemsReserveAta');
    input.keepMintV4 = pk(11); approved.keepMint = pk(12);
    expect(selected.keepMint).toBe(pk(4)); expect(Object.isFrozen(selected)).toBe(true);
    expect(legacy.keepMint).toBe(pk(1));
  });
  it.each([undefined, '', 'garbage', '11111111111111111111111111111111', legacy.keepMint, roles.mintAuthority,
    roles.reserveOwner, roles.gemsReserveOwner, roles.economyProgram])('refuses missing, malformed, old or role-key mint %s without fallback', async mint => {
    const { resolvePhaseEKeepIdentity } = await load();
    const input: { cluster: 'devnet'; keepMint: string; keepMintV4?: string } = { cluster: 'devnet', keepMint: legacy.keepMint };
    if (mint !== undefined) input.keepMintV4 = mint;
    expect(() => resolvePhaseEKeepIdentity(selection(), input, review())).toThrow();
  });
  it('requires the privately reviewed binding and rejects selection/registry cluster mismatches', async () => {
    const { resolvePhaseEKeepIdentity } = await load();
    expect(() => resolvePhaseEKeepIdentity(selection(), registry())).toThrow();
    expect(() => resolvePhaseEKeepIdentity({ ...selection(), SOLANA_CLUSTER: 'mainnet-beta' }, registry(), review())).toThrow();
    expect(() => resolvePhaseEKeepIdentity(selection(), { ...registry(), cluster: 'mainnet-beta' }, review())).toThrow();
    expect(() => resolvePhaseEKeepIdentity({ ...selection(), PHASE_E_KEEP_IDENTITY: 'v3' } as never, registry(), review())).toThrow();
  });
  it.each(['genesisHash', 'keepMint', 'economyProgram', 'craftProgram', 'treasury', 'reserveOwner', 'reserveAta', 'gemsReserveOwner', 'gemsReserveAta', 'bindingReceiptSha256'] as const)
    ('refuses a malformed or unreviewed %s', async field => {
      const { resolvePhaseEKeepIdentity } = await load();
      expect(() => resolvePhaseEKeepIdentity(selection(), registry(), { ...review(), [field]: pk(14) })).toThrow();
    });
  it('never substitutes the legacy Gems owner and refuses reserve/custody aliasing', async () => {
    const { resolvePhaseEKeepIdentity } = await load();
    expect(() => resolvePhaseEKeepIdentity({ SOLANA_CLUSTER: 'devnet', PHASE_E_KEEP_IDENTITY: 'keep-v4' }, registry(), review())).toThrow();
    expect(() => resolvePhaseEKeepIdentity({ ...selection(), PHASE_E_KEEP_RESERVE_OWNER: roles.gemsReserveOwner }, registry(), review())).toThrow();
    expect(() => resolvePhaseEKeepIdentity({ ...selection(), HOT_WALLET_PUBKEY: roles.reserveOwner }, registry(), review())).toThrow();
  });
  it('requires bounded reviewed deployment pins and copies their nested public snapshot', async () => {
    const { resolvePhaseEKeepIdentity } = await load();
    for (const economyDeployment of [undefined, { ...review().economyDeployment, reviewedDeploymentSlot: -1 },
      { ...review().economyDeployment, reviewedProgramDataSha256: 'bad' },
      { ...review().economyDeployment, upgradeAuthority: pk(14) }]) {
      expect(() => resolvePhaseEKeepIdentity(selection(), registry(), { ...review(), economyDeployment } as never)).toThrow();
    }
    const approved = review(), selected = resolvePhaseEKeepIdentity(selection(), registry(), approved)!;
    approved.economyDeployment.reviewedProgramDataSha256 = 'f'.repeat(64);
    expect(selected.economyDeployment.reviewedProgramDataSha256).toBe('b'.repeat(64));
    expect(Object.isFrozen(selected.economyDeployment)).toBe(true);
  });
});

describe('serving reads the immutable Phase E identity without binding it', () => {
  it('accepts only one exact row and performs no insert, update, lock or transaction', async () => {
    const { db, identity } = await admitted();
    expect(identity).toMatchObject(review()); expect(Object.isFrozen(identity)).toBe(true);
    expect(db.execute).toHaveBeenCalledTimes(1); expect(db.insert).not.toHaveBeenCalled(); expect(db.transaction).not.toHaveBeenCalled();
    expect(db.queries[0]).toMatch(/^select /i); expect(db.queries[0]).toContain('public.phase_e_chain_identity');
    expect(db.queries[0]).not.toMatch(/\b(insert|update|delete|lock|economy_chain_identity)\b/i);
  });
  it.each(['singleton', 'cluster', 'genesis_hash', 'keep_mint', 'economy_program', 'craft_program', 'treasury', 'reserve_owner', 'reserve_ata', 'gems_reserve_owner', 'gems_reserve_ata', 'binding_receipt_sha256'] as const)
    ('rejects a mismatched stored %s before an RPC connector can exist', async field => {
      const api = await load(), selected = api.resolvePhaseEKeepIdentity(selection(), registry(), review())!;
      const db = database([{ ...row(), [field]: field === 'singleton' ? false : 'wrong' }]);
      await expect(api.assertPhaseEKeepIdentity(db.db, selected)).rejects.toThrow(/identity/i);
      expect(db.insert).not.toHaveBeenCalled(); expect(db.transaction).not.toHaveBeenCalled();
    });
  it('refuses an empty/missing schema or duplicate singleton and never auto-heals', async () => {
    const api = await load(), selected = api.resolvePhaseEKeepIdentity(selection(), registry(), review())!;
    for (const records of [[], [row(), row()]]) {
      const db = database(records); await expect(api.assertPhaseEKeepIdentity(db.db, selected)).rejects.toThrow(/identity/i);
      expect(db.insert).not.toHaveBeenCalled();
    }
    const db = database(); db.execute.mockRejectedValueOnce(Error('relation does not exist'));
    await expect(api.assertPhaseEKeepIdentity(db.db, selected)).rejects.toThrow(); expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('only the selected Phase E runtime consumers move to v4', () => {
  it('keeps blank runtimes dark while refusing configured v4 consumers without admitted identity', async () => {
    const { createMiningClaimRuntime } = await import('../src/mining/claimRuntime');
    const { createMiningTaxRuntime } = await import('../src/mining/taxRuntime');
    const { createMiningTransparencyRuntime } = await import('../src/money/miningTransparencyRuntime');
    const blank = { SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'http://127.0.0.1:1' } as Config;
    expect(createMiningClaimRuntime(blank, legacy)).toBeNull();
    expect(createMiningTaxRuntime(blank, legacy)).toBeNull();
    expect(createMiningTransparencyRuntime(database().db, blank, legacy)).toBeNull();
    const config = runtimeConfig();
    expect(() => createMiningClaimRuntime(config, legacy)).toThrow(/identity/i);
    expect(() => createMiningTaxRuntime(config, legacy)).toThrow(/identity/i);
    expect(() => createMiningTransparencyRuntime(database().db, config, legacy)).toThrow(/identity/i);
    const { PHASE_E_KEEP_IDENTITY: _selector, PHASE_E_KEEP_RESERVE_OWNER: _reserve, ...unselected } = config;
    // review 3149a9f3 N1: an unselected v4 identity preserves explicit legacy recovery.
    const legacyConfig = { ...unselected, PHASE_E_KEEP_IDENTITY: legacySelector(),
      GEMS_RESERVE_OWNER: pk(6), GEMS_RESERVE_ATA: pk(7) } satisfies Config;
    const legacyClaim = createMiningClaimRuntime(legacyConfig, legacy)!, legacyTax = createMiningTaxRuntime(legacyConfig, legacy)!;
    const legacyTransparency = createMiningTransparencyRuntime(database().db, legacyConfig, legacy)!;
    try {
      expect(legacyClaim.provider.trust.keepMint.toBase58()).toBe(legacy.keepMint);
      expect(legacyTax.trust.mining.keepMint.toBase58()).toBe(legacy.keepMint);
      expect(legacyTransparency).not.toBeNull();
      expect(legacyClaim.provider.trust.reserveOwner.toBase58()).toBe(legacyConfig.GEMS_RESERVE_OWNER);
      expect(legacyTax.trust.mining.reserveOwner.toBase58()).toBe(legacyConfig.GEMS_RESERVE_OWNER);
    } finally { legacyClaim.close(); legacyTax.close(); legacyTransparency.close(); }
  });
  it('passes only the new mint and RESERVE to claims and tax without obsolete Gems fields', async () => {
    const { identity } = await admitted(), config = runtimeConfig();
    const { createMiningClaimRuntime } = await import('../src/mining/claimRuntime');
    const { createMiningTaxRuntime } = await import('../src/mining/taxRuntime');
    const claim = createMiningClaimRuntime(config, legacy, identity)!, tax = createMiningTaxRuntime(config, legacy, identity)!;
    try {
      for (const trust of [claim.provider.trust, tax.trust.mining]) {
        expect(trust.keepMint.toBase58()).toBe(identity.keepMint);
        expect(trust.reserveOwner.toBase58()).toBe(roles.reserveOwner);
        expect(trust.programId.toBase58()).toBe(roles.economyProgram);
        expect(trust.reviewedDeploymentSlot).toBe(90); expect(trust.reviewedProgramDataSha256).toBe('b'.repeat(64));
      }
      expect(config.GEMS_RESERVE_OWNER).toBeUndefined(); expect(identity).not.toHaveProperty('gemsReserveOwner'); expect(legacy.keepMint).toBe(pk(1));
    } finally { claim.close(); tax.close(); }
  });
  it('refuses partial transparency pins instead of quietly treating them as a disabled runtime', async () => {
    const { identity } = await admitted();
    const { createMiningTransparencyRuntime } = await import('../src/money/miningTransparencyRuntime');
    const { MINING_TRANSPARENCY_PROGRAM_ID: _program, ...partial } = runtimeConfig();
    expect(() => createMiningTransparencyRuntime(database().db, partial, legacy, identity)).toThrow(/identity|complete/i);
  });
  it('refuses different per-runtime program pins and missing or malformed deployment evidence', async () => {
    const { identity } = await admitted();
    const { createMiningClaimRuntime } = await import('../src/mining/claimRuntime');
    const { createMiningTaxRuntime } = await import('../src/mining/taxRuntime');
    const { createMiningTransparencyRuntime } = await import('../src/money/miningTransparencyRuntime');
    for (const program of [pk(15), roles.craftProgram]) {
      expect(() => createMiningClaimRuntime({ ...runtimeConfig(), MINING_CLAIM_PROGRAM_ID: program }, legacy, identity)).toThrow();
      expect(() => createMiningTaxRuntime({ ...runtimeConfig(), MINING_TAX_PROGRAM_ID: program }, legacy, identity)).toThrow();
      expect(() => createMiningTransparencyRuntime(database().db, { ...runtimeConfig(), MINING_TRANSPARENCY_PROGRAM_ID: program }, legacy, identity)).toThrow();
    }
    expect(() => createMiningClaimRuntime({ ...runtimeConfig(), MINING_CLAIM_PROGRAM_DATA_SHA256: 'bad' }, legacy, identity)).toThrow();
    expect(() => createMiningTaxRuntime({ ...runtimeConfig(), MINING_TAX_DEPLOYMENT_SLOT: -1 }, legacy, identity)).toThrow();
    expect(() => createMiningTransparencyRuntime(database().db, { ...runtimeConfig(), MINING_TRANSPARENCY_DEPLOYMENT_SLOT: -1 }, legacy, identity)).toThrow();
    expect(() => createMiningClaimRuntime({ ...runtimeConfig(), MINING_CLAIM_PROGRAM_DATA_SHA256: 'c'.repeat(64) }, legacy, identity)).toThrow();
    expect(() => createMiningTaxRuntime({ ...runtimeConfig(), MINING_TAX_UPGRADE_AUTHORITY: pk(8) }, legacy, identity)).toThrow();
    expect(() => createMiningTransparencyRuntime(database().db, { ...runtimeConfig(), MINING_TRANSPARENCY_DEPLOYMENT_SLOT: 91 }, legacy, identity)).toThrow();
  });
  it('transparency compares the separate Phase E row and cannot accept the legacy Gems identity as emission backing', async () => {
    const { identity } = await admitted(), config = runtimeConfig(), db = database();
    const { createMiningTransparencyRuntime } = await import('../src/money/miningTransparencyRuntime');
    const snapshot = { source: { genesisHash: SOLANA_GENESIS_HASH.devnet }, slot: 100, unixTimestamp: 1n,
      config: { keepMint: identity.keepMint, emissionReserveOwner: roles.reserveOwner, emissionReserveAta: identity.reserveAta,
        miningVault: pk(16), address: pk(17) },
      vaultAmount: 100n, reserveAmount: 80n, playerOutstanding: 20n, taxOutstanding: 10n, totalOutstanding: 30n, availableBudget: 70n };
    h.backing.mockReturnValue(vi.fn(async () => snapshot));
    const service = createMiningTransparencyRuntime(db.db, config, legacy, identity)!;
    try {
      expect(await service.read()).toMatchObject({ status: 'available', mint: identity.keepMint,
        emissionReserve: { owner: roles.reserveOwner, account: identity.reserveAta, countsAsMiningBacking: false }, custodialCoverageAffected: false });
      expect(db.queries.every(query => query.includes('public.phase_e_chain_identity'))).toBe(true);
      const suppliedTrust = h.backing.mock.calls[0]![1];
      expect(suppliedTrust.reserveOwner.toBase58()).toBe(roles.reserveOwner);
    } finally { service.close(); }
    const legacyDb = database([{ cluster: legacy.cluster, keep_mint: legacy.keepMint, core_program: legacy.coreProgram,
      config_pda: legacy.configPda, gems_reserve_owner: roles.reserveOwner, gems_reserve_ata: identity.reserveAta }]);
    const refused = createMiningTransparencyRuntime(legacyDb.db, config, legacy, identity)!;
    try { expect(await refused.read()).toEqual({ status: 'unavailable', reason: 'DATABASE_IDENTITY' }); }
    finally { refused.close(); }
  });
});

// N1 successor tests supplement the unchanged eight legacy runtime/CLI suites.
describe('MS-Sb N1 selected identity boundary', () => {
  it.each([undefined, 'disabled'] as const)('boots pinned v3 consumers when selector is %s', async selector => {
    const config = { ...runtimeConfig(), PHASE_E_KEEP_IDENTITY: legacySelector(selector),
      GEMS_RESERVE_OWNER: pk(6), GEMS_RESERVE_ATA: pk(7) } satisfies Config;
    const { createMiningClaimRuntime } = await import('../src/mining/claimRuntime');
    const { createMiningTaxRuntime } = await import('../src/mining/taxRuntime');
    const { createMiningTransparencyRuntime } = await import('../src/money/miningTransparencyRuntime');
    const claim = createMiningClaimRuntime(config, legacy)!, tax = createMiningTaxRuntime(config, legacy)!;
    const transparency = createMiningTransparencyRuntime(database().db, config, legacy)!;
    try {
      for (const trust of [claim.provider.trust, tax.trust.mining]) {
        expect(trust.keepMint.toBase58()).toBe(legacy.keepMint);
        expect(trust.reserveOwner.toBase58()).toBe(config.GEMS_RESERVE_OWNER);
        expect(trust.expectedGenesisHash).toBe(SOLANA_GENESIS_HASH.devnet);
      }
      expect(transparency).not.toBeNull();
    } finally { claim.close(); tax.close(); transparency.close(); }
  });
  it.each(['disabled', 'typo'] as const)('does not silently discard a supplied v4 binding under %s', async selector => {
    const { identity } = await admitted();
    const config = { ...runtimeConfig(), PHASE_E_KEEP_IDENTITY: selector } as never;
    const { createMiningClaimRuntime } = await import('../src/mining/claimRuntime');
    const { createMiningTaxRuntime } = await import('../src/mining/taxRuntime');
    const { createMiningTransparencyRuntime } = await import('../src/money/miningTransparencyRuntime');
    expect(() => createMiningClaimRuntime(config, legacy, identity)).toThrow(/identity/i);
    expect(() => createMiningTaxRuntime(config, legacy, identity)).toThrow(/identity/i);
    expect(() => createMiningTransparencyRuntime(database().db, config, legacy, identity)).toThrow(/identity/i);
  });
});

describe('MS-Sb reserve-only identity (f3619833; mint correction c7dcaa0d)', () => {
  it.each(['gemsReserveOwner', 'gemsReserveAta', 'gems_reserve_owner', 'gems_reserve_ata'] as const)
    ('refuses obsolete %s in registry, reviewed tuple, and stored identity even if empty', async field => {
      const api = await load();
      for (const value of [undefined, '', roles.gemsReserveOwner]) {
        expect(() => api.resolvePhaseEKeepIdentity(selection(), { ...registry(), [field]: value }, review())).toThrow('obsolete gems-reserve identity field');
        expect(() => api.resolvePhaseEKeepIdentity(selection(), registry(), { ...review(), [field]: value })).toThrow('obsolete gems-reserve identity field');
        const selected = api.resolvePhaseEKeepIdentity(selection(), registry(), review())!;
        await expect(api.assertPhaseEKeepIdentity(database([{ ...row(), [field]: value }]).db, selected)).rejects.toThrow('obsolete gems-reserve identity field');
      }
    });
  it.each(['PHASE_E_GEMS_RESERVE', 'PHASE_E_KEEP_GEMS_RESERVE_OWNER', 'PHASE_E_ANY_GEMS_RESERVE_ATA'])
    ('refuses obsolete environment/config variable %s before any missing-packet fallback', async field => {
      const api = await load();
      expect(() => api.resolvePhaseEKeepIdentity({ ...selection(), [field]: '' }, registry())).toThrow('obsolete gems-reserve identity field');
      vi.stubEnv(field, '');
      expect(() => api.resolvePhaseEKeepIdentity(selection(), registry())).toThrow('obsolete gems-reserve identity field');
      expect(api.resolvePhaseEKeepIdentity({ ...selection(), PHASE_E_KEEP_IDENTITY: 'disabled' }, registry())).toBeNull();
    });
  it.each(['GEMS_RESERVE_OWNER', 'GEMS_RESERVE_ATA', 'gemsReserveOwner', 'gemsReserveAta'])
    ('refuses obsolete %s on each v4 runtime configuration instead of ignoring it', async field => {
      const { identity } = await admitted();
      const config = { ...runtimeConfig(), [field]: pk(6) };
      const { createMiningClaimRuntime } = await import('../src/mining/claimRuntime');
      const { createMiningTaxRuntime } = await import('../src/mining/taxRuntime');
      const { createMiningTransparencyRuntime } = await import('../src/money/miningTransparencyRuntime');
      expect(() => createMiningClaimRuntime(config, legacy, identity)).toThrow('obsolete gems-reserve identity field');
      expect(() => createMiningTaxRuntime(config, legacy, identity)).toThrow('obsolete gems-reserve identity field');
      expect(() => createMiningTransparencyRuntime(database().db, config, legacy, identity)).toThrow('obsolete gems-reserve identity field');
    });
  it('never admits the KEEP-MINT authority itself as the mint, even in a matching fabricated packet', async () => {
    const api = await load(), mint = roles.mintAuthority;
    const fake = { ...review(), keepMint: mint, reserveAta: keepAta(new PublicKey(roles.reserveOwner), new PublicKey(mint), true).toBase58() };
    expect(() => api.resolvePhaseEKeepIdentity(selection(), { ...registry(), keepMintV4: mint }, fake)).toThrow(/identity/i);
  });
});
