/** Dedicated publication transport only: mocked RPC, no DB/network/key/signing. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { Config } from '../src/config';
import type { PhaseEKeepIdentity, PhaseEKeepSelection } from '../src/money/phaseEKeepIdentity';
const h = vi.hoisted(() => ({ gate: vi.fn(), connections: [] as { endpoint: string; options: Record<string, unknown> }[],
  genesis: vi.fn(), slot: vi.fn(), transaction: vi.fn(), accounts: vi.fn() }));
vi.mock('../src/money/phaseEKeepIdentity', () => ({ requirePhaseEKeepRuntimeIdentity: h.gate }));
vi.mock('@solana/web3.js', async importOriginal => {
  const original = await importOriginal<typeof import('@solana/web3.js')>();
  return { ...original, Connection: class {
    constructor(endpoint: string, options: Record<string, unknown>) { h.connections.push({ endpoint, options }); }
    getGenesisHash = h.genesis; getSlot = h.slot; getTransaction = h.transaction; getMultipleAccountsInfoAndContext = h.accounts;
  } };
});
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const identity = { kind: 'keep-v4', cluster: 'devnet', genesisHash: key(1).toBase58(), keepMint: key(2).toBase58(),
  economyProgram: key(3).toBase58(), reserveOwner: key(4).toBase58(), economyDeployment: {
    reviewedDeploymentSlot: 42, reviewedProgramDataSha256: 'a'.repeat(64), upgradeAuthority: key(5).toBase58() } } as PhaseEKeepIdentity;
const config = (extra = {}) => ({ SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://rpc.invalid',
  MINING_PUBLICATION_RECOVERY_ENABLED: 'true', MINING_PUBLICATION_TESTER_STACK: 'true',
  PHASE_E_KEEP_IDENTITY: 'keep-v4', PHASE_E_KEEP_RESERVE_OWNER: identity.reserveOwner, ...extra } as unknown as Config & PhaseEKeepSelection);
const load = () => import('../src/mining/publicationReceiptRuntime');
beforeEach(() => { vi.resetAllMocks(); h.connections.length = 0; h.gate.mockReturnValue(identity); });

describe('independent publication receipt runtime', () => {
  it('defaults dark without consulting identity or constructing a connection', async () => {
    const { createMiningPublicationReceiptRuntime } = await load();
    expect(createMiningPublicationReceiptRuntime(config({ MINING_PUBLICATION_RECOVERY_ENABLED: 'false' }))).toBeNull();
    expect(h.gate).not.toHaveBeenCalled(); expect(h.connections).toHaveLength(0);
  });
  it('requires explicit tester devnet and an admitted Phase E identity before any transport', async () => {
    const { createMiningPublicationReceiptRuntime: create } = await load();
    expect(() => create(config({ MINING_PUBLICATION_TESTER_STACK: 'false' }), identity)).toThrow();
    expect(() => create(config({ SOLANA_CLUSTER: 'mainnet-beta' }), identity)).toThrow();
    h.gate.mockImplementation(() => { throw Error('identity refused'); });
    expect(() => create(config(), identity)).toThrow('identity refused'); expect(h.connections).toHaveLength(0);
  });
  it('builds publication trust from the admitted binding independently of claims and legacy Gems', async () => {
    const { createMiningPublicationReceiptRuntime: create } = await load();
    const runtime = create(config({ GEMS_RESERVE_OWNER: key(10).toBase58() }), identity)!;
    expect(h.connections).toHaveLength(0); expect(h.gate).toHaveBeenCalledWith(expect.anything(), identity,
      { programId: identity.economyProgram, slot: 42, sha256: 'a'.repeat(64) });
    expect(runtime.trust.reserveOwner.toBase58()).toBe(identity.reserveOwner);
    expect(runtime.trust.keepMint.toBase58()).toBe(identity.keepMint); expect(Object.isFrozen(runtime.trust)).toBe(true);
    expect(Object.keys(runtime).sort()).toEqual(['close', 'receiptSource', 'trust']); runtime.close();
  });
  it('provides exactly the read-only publication methods with account addresses preserved', async () => {
    const { createMiningPublicationReceiptRuntime: create } = await load();
    const runtime = create(config(), identity)!, reader = runtime.receiptSource(new AbortController().signal);
    expect(Object.keys(reader).sort()).toEqual(['getGenesisHash', 'getMultipleAccountsInfoAndContext', 'getSlot', 'getTransaction']);
    h.genesis.mockResolvedValue('genesis'); h.slot.mockResolvedValue(99); h.transaction.mockResolvedValue(null);
    h.accounts.mockResolvedValue({ context: { slot: 99 }, value: [{ owner: key(3), executable: false, data: Buffer.from([1]) }, null] });
    expect(await reader.getGenesisHash()).toBe('genesis'); expect(await reader.getSlot('finalized')).toBe(99);
    expect(await reader.getTransaction('signature', { commitment: 'finalized', maxSupportedTransactionVersion: 0 })).toBeNull();
    const result = await reader.getMultipleAccountsInfoAndContext([key(7), key(8)], { commitment: 'finalized', minContextSlot: 80 });
    expect(result.value[0]?.address.equals(key(7))).toBe(true); expect(result.value[1]).toBeNull(); runtime.close();
  });
  it('rejects every read after close or cancellation without invoking RPC', async () => {
    const { createMiningPublicationReceiptRuntime: create } = await load();
    const runtime = create(config(), identity)!, signal = new AbortController(), reader = runtime.receiptSource(signal.signal);
    signal.abort(); await expect(reader.getGenesisHash()).rejects.toThrow(); expect(h.genesis).not.toHaveBeenCalled();
    runtime.close(); expect(() => runtime.receiptSource(new AbortController().signal)).toThrow();
  });
  it('bounds HTTP work, refuses redirects, and aborts pending fetch when closed', async () => {
    const { createMiningPublicationReceiptRuntime: create } = await load();
    const runtime = create(config(), identity)!; runtime.receiptSource(new AbortController().signal);
    const boundedFetch = h.connections[0]!.options.fetch as typeof fetch;
    const original = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      runtime.close(); expect(init?.signal?.aborted).toBe(true);
      return new Response('{}');
    });
    vi.stubGlobal('fetch', original);
    try { await expect(boundedFetch('https://rpc.invalid')).rejects.toThrow(); expect(original).toHaveBeenCalledTimes(1); }
    finally { vi.unstubAllGlobals(); }
  });
});
