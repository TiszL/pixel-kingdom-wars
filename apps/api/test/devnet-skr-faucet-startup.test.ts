import { Keypair } from '@solana/web3.js';
import { SKR_FAUCET } from '@shardkeep/shared';
import type { SkrFaucetRpc } from '@shardkeep/chain/devnet-skr-faucet-transfer';
import type { SkrReconcileContext } from '../src/devnet-only/skrFaucetReconciliation';
import type { FastifyInstance } from 'fastify';
import type { DevnetOnlyOptions } from '../src/devnetOnlyLoader';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  keys: new Map<string, string>(), opened: new Map<number, string>(),
  queueCount: 0, workerCount: 0, authority: '',
  process: vi.fn(async (_policy: unknown, _store: unknown, _rpc: unknown, _signer: unknown, _id: string, _now?: () => Date, _context?: SkrReconcileContext) => {}),
  pending: vi.fn(async (_limit: number, _cursor?: { id: string; requestedAt: Date }): Promise<Array<{ id: string; requestedAt: Date }>> => []),
  callbacks: [] as Array<(job: { name: string; data: { grantId?: string } }) => Promise<void>>,
  closeQueue: vi.fn(async () => {}), closeWorker: vi.fn(async () => {}),
  add: vi.fn(async (_name: string, _data: { grantId: string }, _options: { jobId: string }) => {}), concurrency: vi.fn(async () => {}), schedule: vi.fn(async () => {}),
  serviceOptions: undefined as undefined | { enqueue(grantId: string, attemptId: string): Promise<void>;
    eligibility(wallet: string, baseId: string | undefined, at: Date): Promise<unknown>; refreshDeed(wallet: string, baseId: string): Promise<unknown> },
  storeOptions: [] as unknown[],
  prime: vi.fn(async () => {}), routes: vi.fn(), open: vi.fn(),
}));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(),
  openSync: (path: string) => {
    state.open(path); if (!state.keys.has(path)) throw new Error('fixture missing key');
    const fd = state.opened.size + 100; state.opened.set(fd, path); return fd;
  },
  fstatSync: () => ({ isFile: () => true, size: 256 }),
  readFileSync: (fd: number) => state.keys.get(state.opened.get(fd)!)!, closeSync: (fd: number) => { state.opened.delete(fd); },
}));
vi.mock('bullmq', () => ({
  Queue: class { constructor() { state.queueCount++; } add = state.add; close = state.closeQueue; setGlobalConcurrency = state.concurrency; upsertJobScheduler = state.schedule; },
  Worker: class {
    constructor(_name: string, callback: (job: { name: string; data: { grantId?: string } }) => Promise<void>) { state.workerCount++; state.callbacks.push(callback); }
    on() { return this; } close = state.closeWorker;
  },
}));
vi.mock('@shardkeep/shared', async (original) => {
  const actual = await original<typeof import('@shardkeep/shared')>();
  return { ...actual, SKR_FAUCET: { ...actual.SKR_FAUCET, devnet: { ...actual.SKR_FAUCET.devnet, treasuryFloorSkr: 1000, dailyBudgetSkr: 100000 } } };
});
vi.mock('../src/devnet-only/skrFaucetStore', () => ({
  makeSkrFaucetStore: (_db: unknown, storeOptions?: unknown) => { state.storeOptions.push(storeOptions); return { pending: state.pending }; },
  readSkrDeedEligibility: vi.fn(), refreshSkrClaimDeed: vi.fn() }));
vi.mock('../src/devnet-only/skrFaucet', () => ({
  makeSkrFaucetService: (_policy: unknown, _store: unknown, _rpc: unknown, options: typeof state.serviceOptions) => {
    state.serviceOptions = options; return { prime: state.prime };
  }, processSkrFaucetGrant: state.process,
}));
vi.mock('../src/devnet-only/routes-skr-faucet', () => ({ registerSkrFaucetRoutes: state.routes }));
import { registerDevnetOnly, registerDevnetOnlyJobs, SKR_FAUCET_OPERATIONAL } from '../src/devnet-only';
import { readSkrDeedEligibility, refreshSkrClaimDeed } from '../src/devnet-only/skrFaucetStore';
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
function options(): DevnetOnlyOptions {
  const signer = key(110); state.authority = signer.publicKey.toBase58();
  state.keys.set('/fixture/skr.json', JSON.stringify([...signer.secretKey]));
  return { config: { SOLANA_CLUSTER: 'devnet', DEVNET_SKR_FAUCET_ENABLED: 'true', DEVNET_SKR_FAUCET_AUTHORITY: state.authority,
    DEVNET_SKR_FAUCET_KEYPAIR_PATH: '/fixture/skr.json', HOT_WALLET_PUBKEY: key(113).publicKey.toBase58(),
    DEVNET_SKR_FAUCET_ADMIN_PUBKEY: key(114).publicKey.toBase58(), DEVNET_SKR_FAUCET_SOL_FAUCET_PUBKEY: key(115).publicKey.toBase58(),
    DEVNET_SKR_FAUCET_DEED_OPERATIONS_PUBKEY: key(116).publicKey.toBase58(), SOLANA_RPC_URL: 'https://rpc.invalid', REDIS_URL: 'redis://redis.invalid' } as DevnetOnlyOptions['config'],
    db: {} as DevnetOnlyOptions['db'], addresses: { cluster: 'devnet', skrMint: key(111).publicKey.toBase58(), skrDecimals: 6, treasuries: { liquidity: key(117).publicKey.toBase58(), dev: key(118).publicKey.toBase58(), ops: key(119).publicKey.toBase58() } } as DevnetOnlyOptions['addresses'] };
}
beforeEach(() => {
  vi.clearAllMocks(); state.keys.clear(); state.opened.clear(); state.callbacks.length = 0; state.queueCount = 0; state.workerCount = 0;
  state.serviceOptions = undefined; state.storeOptions.length = 0; state.pending.mockResolvedValue([]); state.process.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('SKR isolated worker lifecycle', () => {
  it('does not read a key or create queues/workers when disabled or on mainnet', async () => {
    for (const override of [{ DEVNET_SKR_FAUCET_ENABLED: 'false' as const }, { SOLANA_CLUSTER: 'mainnet-beta' as const }]) {
      const opt = options(); Object.assign(opt.config, override);
      expect(await registerDevnetOnlyJobs(opt)).toBeNull();
      await registerDevnetOnly({} as FastifyInstance, opt);
    }
    expect(state.open).not.toHaveBeenCalled(); expect(state.queueCount).toBe(0); expect(state.workerCount).toBe(0);
  });
  it('refuses a configured authority mismatch or shared admin/hot/SOL authority before starting a worker', async () => {
    const mismatch = options(); mismatch.config.DEVNET_SKR_FAUCET_AUTHORITY = key(112).publicKey.toBase58();
    expect(await registerDevnetOnlyJobs(mismatch)).toBeNull();
    for (const field of ['DEVNET_SKR_FAUCET_ADMIN_PUBKEY', 'HOT_WALLET_PUBKEY', 'DEVNET_SKR_FAUCET_SOL_FAUCET_PUBKEY'] as const) {
      const opt = options(); opt.config[field] = state.authority; opt.config.ADMIN_KEYPAIR_PATH = '/fixture/must-not-open.json';
      expect(await registerDevnetOnlyJobs(opt)).toBeNull();
    }
    expect(state.queueCount).toBe(0); expect(state.workerCount).toBe(0); expect(state.opened.size).toBe(0);
  });
  it('registers API producers without opening any key and queues distinct attempts on the same grant separately', async () => {
    const opt = options(), addHook = vi.fn();
    await registerDevnetOnly({ addHook } as unknown as FastifyInstance, opt);
    expect(state.open).not.toHaveBeenCalled(); expect(state.routes).toHaveBeenCalledOnce(); expect(state.prime).toHaveBeenCalledOnce();
    await state.serviceOptions!.enqueue('grant-one', 'attempt-one'); await state.serviceOptions!.enqueue('grant-one', 'attempt-two');
    expect(state.add.mock.calls.map((call) => call[2])).toEqual([{ jobId: 'attempt-attempt-one' }, { jobId: 'attempt-attempt-two' }]);
    expect(state.workerCount).toBe(0); expect(addHook).toHaveBeenCalledWith('onClose', expect.any(Function));
  });
  it('advances/wraps sweep cursors even when an old unknown transfer throws, and closes owned resources', async () => {
    const first = { id: '00000000-0000-0000-0000-000000000001', requestedAt: new Date('2026-10-02T12:00:00Z') };
    const second = { ...first, id: '00000000-0000-0000-0000-000000000002' };
    state.pending.mockImplementation(async (_limit, cursor) => !cursor ? [first] : cursor.id === first.id ? [second] : []);
    state.process.mockImplementation(async (_p, _s, _r, _k, id) => { if (id === first.id) throw new Error('private upstream'); });
    const worker = await registerDevnetOnlyJobs(options()); expect(worker).not.toBeNull();
    const callback = state.callbacks[0]!; await callback({ name: 'sweep', data: {} }); await callback({ name: 'sweep', data: {} });
    await callback({ name: 'sweep', data: {} });
    expect(state.process.mock.calls.map((row) => row[4])).toEqual([first.id, second.id, first.id]);
    expect(state.concurrency).toHaveBeenCalledWith(1); expect(state.workerCount).toBe(1);
    await worker!.close(); expect(state.closeWorker).toHaveBeenCalledOnce(); expect(state.closeQueue).toHaveBeenCalledOnce();
  });
  it('closes queue and worker if scheduler setup fails instead of leaking partially started resources', async () => {
    state.schedule.mockRejectedValueOnce(new Error('fixture scheduler failure'));
    await expect(registerDevnetOnlyJobs(options())).rejects.toThrow('fixture scheduler failure');
    expect(state.closeWorker).toHaveBeenCalledOnce(); expect(state.closeQueue).toHaveBeenCalledOnce();
  });
  it('still closes the owned queue when worker close rejects during scheduler failure cleanup', async () => {
    const workerClose = new Error('fixture worker close failure');
    state.schedule.mockRejectedValueOnce(new Error('fixture scheduler failure'));
    state.closeWorker.mockRejectedValueOnce(workerClose);
    await expect(registerDevnetOnlyJobs(options())).rejects.toBe(workerClose);
    expect(state.closeWorker).toHaveBeenCalledOnce(); expect(state.closeQueue).toHaveBeenCalledOnce();
    expect(state.closeWorker.mock.invocationCallOrder[0]).toBeLessThan(state.closeQueue.mock.invocationCallOrder[0]!);
  });
  it('still closes the owned queue when normal worker close rejects and preserves the rejection', async () => {
    const worker = await registerDevnetOnlyJobs(options()); expect(worker).not.toBeNull();
    const workerClose = new Error('fixture worker close failure'); state.closeWorker.mockRejectedValueOnce(workerClose);
    await expect(worker!.close()).rejects.toBe(workerClose);
    expect(state.closeWorker).toHaveBeenCalledOnce(); expect(state.closeQueue).toHaveBeenCalledOnce();
    expect(state.closeWorker.mock.invocationCallOrder[0]).toBeLessThan(state.closeQueue.mock.invocationCallOrder[0]!);
  });
});


describe('P5 M1 one shared worker sweep budget', () => {
  it('stops at the exhausted row and resumes the next grant with a fresh budget', async () => {
    const first = { id: '00000000-0000-0000-0000-000000000001', requestedAt: new Date('2026-10-02T12:00:00Z') };
    const second = { ...first, id: '00000000-0000-0000-0000-000000000002' };
    state.pending.mockImplementation(async (_limit, cursor) => !cursor ? [first, second] : cursor.id === first.id ? [second] : []);
    const contexts: SkrReconcileContext[] = [];
    state.process.mockImplementation(async (_p, _s, _r, _k, _id, _now, context) => {
      if (!context) throw new Error('missing retained worker context'); contexts.push(context);
      const rpc = context.budget.wrap({ getGenesisHash: async () => 'test-only' } as SkrFaucetRpc);
      for (let n = 0; n < SKR_FAUCET.devnet.reconcileSweepRpcBudget; n++) await rpc.getGenesisHash();
    });
    const worker = await registerDevnetOnlyJobs(options());
    await state.callbacks[0]!({ name: 'sweep', data: {} });
    expect(state.process.mock.calls.map((row) => row[4])).toEqual([first.id]);
    await state.callbacks[0]!({ name: 'sweep', data: {} });
    expect(state.process.mock.calls.map((row) => row[4])).toEqual([first.id, second.id]);
    expect(contexts[0]?.gate).toBe(contexts[1]?.gate); expect(contexts[0]?.budget).not.toBe(contexts[1]?.budget);
    await worker!.close();
  });
});


describe('P5 r12 public-only startup exclusions', () => {
  it('treats empty unrelated paths as unset and opens only its own worker key', async () => {
    const opt = options(); opt.config.HOT_WALLET_KEYPAIR_PATH = ''; opt.config.ADMIN_KEYPAIR_PATH = ''; opt.config.DEVNET_FAUCET_KEYPAIR_PATH = '';
    const worker = await registerDevnetOnlyJobs(opt); expect(worker).not.toBeNull();
    expect(state.open.mock.calls).toEqual([['/fixture/skr.json']]); await worker!.close();
  });
  it.each(['liquidity', 'dev', 'ops'] as const)('refuses the %s registry treasury without opening another key', async (role) => {
    const opt = options(); opt.addresses!.treasuries[role] = state.authority;
    expect(await registerDevnetOnlyJobs(opt)).toBeNull(); expect(state.open).not.toHaveBeenCalled();
    expect(state.queueCount).toBe(0); expect(state.workerCount).toBe(0);
  });
  it('refuses absent public exclusion identities without trying private paths', async () => {
    const opt = options(); delete opt.config.DEVNET_SKR_FAUCET_DEED_OPERATIONS_PUBKEY;
    expect(await registerDevnetOnlyJobs(opt)).toBeNull(); expect(state.open).not.toHaveBeenCalled();
  });
  it.each(['Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8', 'AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv',
    '9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q'])('refuses D153.364 identity %s before key loading', async (authority) => {
    const opt = options(); opt.config.DEVNET_SKR_FAUCET_AUTHORITY = authority;
    expect(await registerDevnetOnlyJobs(opt)).toBeNull(); expect(state.open).not.toHaveBeenCalled();
  });
  it('refuses the deed-operations identity and the configured test mint as signer', async () => {
    for (const useMint of [false, true]) {
      const opt = options();
      if (useMint) opt.addresses!.skrMint = state.authority; else opt.config.DEVNET_SKR_FAUCET_DEED_OPERATIONS_PUBKEY = state.authority;
      expect(await registerDevnetOnlyJobs(opt)).toBeNull();
    }
    expect(state.open).not.toHaveBeenCalled();
  });
  it('pins local age plus limit retention and RPC timeout without importing jobs', () => {
    expect(SKR_FAUCET_OPERATIONAL).toEqual({ rpcTimeoutMs: 6000,
      retention: { removeOnComplete: { age: 21600, limit: 50 }, removeOnFail: { age: 86400, limit: 25 } } });
    for (const value of Object.values(SKR_FAUCET_OPERATIONAL.retention)) expect(value).not.toHaveProperty('count');
  });
});


// Owner N-045 (6 Oct 2026): deedless claims on the QA chain lane only; D153.290 ("a deedless player cannot claim") stays the
// default everywhere. Why this pin matters: only a configured DEVNET_SKR_FAUCET_DEEDLESS_OK=true (which loadConfig refuses
// under NODE_ENV=production) may relax the deed gate, and it must reach the status read, the pre-lock refresh AND the locked
// reservation alike, or those three would disagree about one claim.
describe('N-045 deedless-claim switch wiring', () => {
  it('passes deedlessOk=false unless the config says exactly true, to the store and both deed reads', async () => {
    for (const [value, expected] of [[undefined, false], ['false', false], ['true', true]] as const) {
      state.storeOptions.length = 0; vi.mocked(readSkrDeedEligibility).mockClear(); vi.mocked(refreshSkrClaimDeed).mockClear();
      const opt = options(); if (value !== undefined) opt.config.DEVNET_SKR_FAUCET_DEEDLESS_OK = value;
      await registerDevnetOnly({ addHook: vi.fn() } as unknown as FastifyInstance, opt);
      expect(state.storeOptions, String(value)).toEqual([{ deedlessOk: expected }]);
      await state.serviceOptions!.eligibility('wallet', 'base', new Date('2026-10-06T12:00:00Z'));
      await state.serviceOptions!.refreshDeed('wallet', 'base');
      expect(vi.mocked(readSkrDeedEligibility).mock.calls.map((call) => call[4]), String(value)).toEqual([expected]);
      expect(vi.mocked(refreshSkrClaimDeed).mock.calls.map((call) => call[6]), String(value)).toEqual([expected]);
    }
    // The worker admits no claim, so it never receives the switch.
    state.storeOptions.length = 0; const opt = options(); opt.config.DEVNET_SKR_FAUCET_DEEDLESS_OK = 'true';
    const worker = await registerDevnetOnlyJobs(opt); expect(state.storeOptions).toEqual([undefined]); await worker!.close();
  });
});
