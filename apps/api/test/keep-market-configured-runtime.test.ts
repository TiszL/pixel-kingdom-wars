/** Normal startup must never manufacture fee consent or provider independence. */
import { PublicKey } from '@solana/web3.js';
import { keepAta, SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config';
import { createConfiguredKeepMarketRuntime } from '../src/game/keepMarketConfiguredRuntime';

const env = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: 'test-secret-test-secret-test-secret!',
  WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
const settings = { SOLANA_RPC_URL: 'https://one.example.com', SOLANA_RPC_URL_2: 'https://two.example.com',
  SOLANA_RPC_PROVIDER: 'SourceA', SOLANA_RPC_PROVIDER_2: 'SourceB', KEEP_MARKET_MIN_CONTEXT_SLOT: '10',
  KEEP_MARKET_TRANSACTION_VERSION: 'legacy', KEEP_MARKET_MAX_FEE_LAMPORTS: '5000',
  KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS: '0', KEEP_MARKET_MAX_COMPUTE_UNIT_LIMIT: '200000' };
const economy = { cluster: 'devnet' as const, keepMint: new PublicKey(new Uint8Array(32).fill(1)).toBase58() };

it('requires a whole explicit source/limit group; optional relay never enables an unconfigured market', () => {
  expect(createConfiguredKeepMarketRuntime(loadConfig(env), economy)).toBeNull();
  for (const key of Object.keys(settings).filter(key => key !== 'SOLANA_RPC_URL')) {
    const missing = { ...settings, [key]: undefined };
    expect(() => loadConfig({ ...env, ...missing }), key).toThrow();
  }
  expect(() => loadConfig({ ...env, KEEP_MARKET_BROADCAST_RPC_URL: 'https://relay.example.com' })).toThrow();
  for (const overrides of [
    { KEEP_MARKET_MAX_FEE_LAMPORTS: '18446744073709551616' },
    { KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS: '5001' },
    { KEEP_MARKET_MAX_COMPUTE_UNIT_LIMIT: '1400001' },
    { KEEP_MARKET_MIN_CONTEXT_SLOT: '-1' },
    { KEEP_MARKET_TRANSACTION_VERSION: 'v0' },
    { SOLANA_RPC_PROVIDER_2: 'sourcea' },
    { KEEP_MARKET_BROADCAST_RPC_URL: 'file:///tmp/rpc' },
  ]) expect(() => loadConfig({ ...env, ...settings, ...overrides })).toThrow();
});

it('uses the selected economy mint/genesis and only explicit original-wire relay; rejects endpoint aliases', () => {
  const config = loadConfig({ ...env, ...settings }), runtime = createConfiguredKeepMarketRuntime(config, economy)!;
  try {
    expect(runtime.sources.payments.trust).toMatchObject({ expectedKeepMint: economy.keepMint,
      expectedGenesisHash: SOLANA_GENESIS_HASH.devnet, providerIds: ['sourcea', 'sourceb'],
      transactionVersion: 'legacy', maxFeeLamports: 5000n, maxPriorityFeeLamports: 0n });
    expect(runtime.sources.payments.broadcastConnect).toBeUndefined();
    expect(() => createConfiguredKeepMarketRuntime(config, { ...economy, cluster: 'mainnet-beta' })).toThrow();
    expect(() => createConfiguredKeepMarketRuntime({ ...config, SOLANA_RPC_URL_2: 'https://one.example.com./different' }, economy)).toThrow();
    const relay = createConfiguredKeepMarketRuntime(loadConfig({ ...env, ...settings,
      KEEP_MARKET_TRANSACTION_VERSION: '0', KEEP_MARKET_BROADCAST_RPC_URL: 'https://relay.example.com' }), economy)!;
    try {
      expect(relay.sources.payments.trust?.transactionVersion).toBe(0);
      expect(typeof relay.sources.payments.broadcastConnect).toBe('function');
    } finally { relay.close(); }
  } finally { runtime.close(); }
});

// MS-Sb: synthetic public addresses and mocked DB/transport only. Resolver and
// admission gates are real. No fixture is a ceremony/deployment attestation.
import type { Db } from '../src/db/client';
import * as transport from '../src/game/keepEquipmentRuntime';
import { assertPhaseEKeepIdentity, resolvePhaseEKeepIdentity } from '../src/money/phaseEKeepIdentity';
const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const reserve = 'CVKo5i8ax2kiKe9nSB4LfCpBEbyfaLcq8S8bWXsvKo1Q';
const registry = { ...economy, keepMintV4: pk(4) };
const review = {
  cluster: 'devnet' as const, genesisHash: SOLANA_GENESIS_HASH.devnet, keepMint: registry.keepMintV4,
  economyProgram: '5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr',
  craftProgram: '4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59',
  treasury: '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q', reserveOwner: reserve,
  reserveAta: keepAta(new PublicKey(reserve), new PublicKey(registry.keepMintV4), true).toBase58(),
  bindingReceiptSha256: 'a'.repeat(64), economyDeployment: { reviewedDeploymentSlot: 90,
    reviewedProgramDataSha256: 'b'.repeat(64), upgradeAuthority: 'Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8' },
};
const selectedConfig = () => ({ ...loadConfig({ ...env, ...settings }),
  PHASE_E_KEEP_IDENTITY: 'keep-v4' as const, PHASE_E_KEEP_RESERVE_OWNER: reserve, HOT_WALLET_PUBKEY: pk(5) });
async function marketIdentity() {
  const row = { singleton: true, cluster: review.cluster, genesis_hash: review.genesisHash,
    keep_mint: review.keepMint, economy_program: review.economyProgram, craft_program: review.craftProgram,
    treasury: review.treasury, reserve_owner: reserve, reserve_ata: review.reserveAta,
    binding_receipt_sha256: review.bindingReceiptSha256, bound_at: new Date('2026-10-03T00:00:00Z') };
  const execute = vi.fn(async () => [row]);
  const resolved = resolvePhaseEKeepIdentity(selectedConfig(), registry, review)!;
  const identity = await assertPhaseEKeepIdentity({ execute } as unknown as Db, resolved);
  expect(execute).toHaveBeenCalledOnce();
  return identity;
}
describe('MS-Sb KEEP market identity selection', () => {
  const sentinel = { close: vi.fn() } as unknown as ReturnType<typeof transport.createKeepEquipmentRuntime>;
  beforeEach(() => { vi.spyOn(transport, 'createKeepEquipmentRuntime').mockReturnValue(sentinel); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it.each([undefined, 'disabled'] as const)('preserves explicit legacy/default v3 selection %s', selector => {
    const config = loadConfig({ ...env, ...settings, PHASE_E_KEEP_IDENTITY: selector }) satisfies Config;
    expect(createConfiguredKeepMarketRuntime(config, registry)).toBe(sentinel);
    expect(transport.createKeepEquipmentRuntime).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      trust: expect.objectContaining({ expectedKeepMint: economy.keepMint, expectedGenesisHash: SOLANA_GENESIS_HASH.devnet }) }));
  });
  it('uses only the admitted v4 mint/genesis while preserving reviewed provider and fee limits', async () => {
    const identity = await marketIdentity(), input = { ...registry };
    vi.stubEnv('KEEP_MINT', economy.keepMint);
    expect(createConfiguredKeepMarketRuntime(selectedConfig(), input, identity)).toBe(sentinel);
    expect(transport.createKeepEquipmentRuntime).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      readRpcUrls: ['https://one.example.com', 'https://two.example.com'], readProviders: ['sourcea', 'sourceb'],
      trust: { expectedKeepMint: registry.keepMintV4, expectedGenesisHash: review.genesisHash,
        providerIds: ['sourcea', 'sourceb'], minContextSlot: 10, deadlineMs: 30000, transactionVersion: 'legacy',
        maxFeeLamports: 5000n, maxPriorityFeeLamports: 0n, maxComputeUnitLimit: 200000 } }));
    expect(input).toEqual(registry); expect(input.keepMint).toBe(economy.keepMint);
  });
  it('refuses selected v4 with no admitted identity even while the market is dark', () => {
    expect(() => createConfiguredKeepMarketRuntime(selectedConfig(), registry)).toThrow(/identity/i);
    expect(() => createConfiguredKeepMarketRuntime({ ...loadConfig(env), PHASE_E_KEEP_IDENTITY: 'keep-v4' }, registry)).toThrow(/identity/i);
    expect(transport.createKeepEquipmentRuntime).not.toHaveBeenCalled();
  });
  it('refuses reviewed-but-unadmitted packets and copies of admitted identities', async () => {
    const unadmitted = resolvePhaseEKeepIdentity(selectedConfig(), registry, review)!;
    expect(() => createConfiguredKeepMarketRuntime(selectedConfig(), registry, unadmitted)).toThrow(/identity/i);
    const identity = await marketIdentity();
    expect(() => createConfiguredKeepMarketRuntime(selectedConfig(), registry, { ...identity })).toThrow(/identity/i);
    expect(transport.createKeepEquipmentRuntime).not.toHaveBeenCalled();
  });
  it.each([undefined, 'disabled', 'KEEP-V4'] as const)('refuses v4 identity under selector %s', async selector => {
    const identity = await marketIdentity();
    expect(() => createConfiguredKeepMarketRuntime({ ...selectedConfig(), PHASE_E_KEEP_IDENTITY: selector } as never,
      registry, identity)).toThrow(/identity/i);
    expect(transport.createKeepEquipmentRuntime).not.toHaveBeenCalled();
  });
  it.each([undefined, pk(8), economy.keepMint])('refuses missing or mismatched registry v4 mint %s', async mint => {
    const identity = await marketIdentity();
    expect(() => createConfiguredKeepMarketRuntime(selectedConfig(), { ...registry, keepMintV4: mint }, identity)).toThrow(/identity/i);
    expect(transport.createKeepEquipmentRuntime).not.toHaveBeenCalled();
  });
  it('refuses a v4 mint substituted into the legacy slot or a different registry cluster', async () => {
    const identity = await marketIdentity();
    expect(() => createConfiguredKeepMarketRuntime(selectedConfig(), { ...registry, keepMint: registry.keepMintV4 }, identity)).toThrow(/identity/i);
    expect(() => createConfiguredKeepMarketRuntime(selectedConfig(), { ...registry, cluster: 'mainnet-beta' }, identity)).toThrow(/identity/i);
    expect(() => createConfiguredKeepMarketRuntime(loadConfig({ ...env, ...settings }),
      { ...registry, keepMint: registry.keepMintV4 })).toThrow(/identity/i);
    expect(transport.createKeepEquipmentRuntime).not.toHaveBeenCalled();
  });
  it('rejects obsolete v4 config before constructing a transport', async () => {
    const identity = await marketIdentity();
    expect(() => createConfiguredKeepMarketRuntime({ ...selectedConfig(), GEMS_RESERVE_OWNER: pk(7) }, registry, identity))
      .toThrow('obsolete gems-reserve identity field');
    expect(transport.createKeepEquipmentRuntime).not.toHaveBeenCalled();
  });
});
