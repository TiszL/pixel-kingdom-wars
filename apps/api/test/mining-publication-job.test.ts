/** MS-S orchestration contract. No DB, RPC, signer, service, or test key generation.
 * Existing custody/verification helpers are mocked; their integration gates remain separate. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { MINING_PROGRAM_ADDRESS, miningConfigPda } from '@shardkeep/chain/mining-program';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import type { Db } from '../src/db/client';
import type { PreparedMiningPublication } from '../src/mining/publicationEnvelope';
import type { MiningPublicationOutbox } from '../src/mining/publicationOutbox';
import type { MiningPublicationJobOptions } from '../src/mining/publicationJob';
import type { MiningPublicationPreparationOptions } from '../src/mining/publicationPreparation';
import type { FundedMiningAllocationSources } from '../src/mining/fundedMiningAllocation';

const h = vi.hoisted(() => ({
  enabled: true, prepare: vi.fn(), getPrepared: vi.fn(), getOutbox: vi.fn(), reserve: vi.fn(),
  accept: vi.fn(), reconcile: vi.fn(), project: vi.fn(), policy: vi.fn(), createPreparer: vi.fn(),
}));
vi.mock('../src/config', () => ({ phaseEMiningEnabled: () => h.enabled }));
vi.mock('../src/mining/fundedMiningAllocation', () => ({ createResourceMiningPublicationPreparer: h.createPreparer }));
vi.mock('../src/mining/publicationPreparation', () => ({ getPreparedMiningPublication: (...args: unknown[]) => h.getPrepared(...args) }));
vi.mock('../src/mining/publicationOutbox', () => ({ createMiningPublicationOutbox: () => ({
  get: h.getOutbox, reserveSigning: h.reserve, acceptSigned: h.accept,
}) }));
vi.mock('../src/mining/publicationReconcile', () => ({ createMiningPublicationReconciler: () => h.reconcile }));
vi.mock('../src/mining/claimEntitlement', () => ({ projectMiningClaimEntitlements: (...args: unknown[]) => h.project(...args) }));
vi.mock('../src/mining/resourceMiningPolicy', () => ({ readResourceMiningDayPolicy: (...args: unknown[]) => h.policy(...args) }));

const operator = new PublicKey('AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv');
const key = (n: number): PublicKey => n === 2 ? new PublicKey(MINING_PROGRAM_ADDRESS) : n === 6 ? miningConfigPda(key(2)) : new PublicKey(new Uint8Array(32).fill(n));
const epochId = '00000000-0000-4000-8000-000000000001';
const day = '2026-10-02', attemptKey = `resource-mining-job:${epochId}`;
const candidate = () => ({ epochId, epochKey: `resource-mining-v3:${day}`, day,
  policyVersion: 3, attemptKey: null as string | null, settled: false });
const prepared = (): PreparedMiningPublication => ({ status: 'prepared', epochId, attemptKey,
  manifestJson: JSON.stringify({ input: { epochId, day, policyVersion: 3 },
    funding: { source: { genesisHash: SOLANA_GENESIS_HASH.devnet, programId: key(2).toBase58(),
      reviewedDeploymentSlot: 1, reviewedProgramDataSha256: 'f'.repeat(64) }, config: { address: key(6).toBase58() } } }), sourceHash: 'a'.repeat(64),
  intentHex: 'aabbcc', intentSha256: 'b'.repeat(64), preparedAt: '2026-10-03T00:00:00.000Z',
  publicationFinalized: false, consumptionAuthorized: false,
  publication: { signer: operator.toBase58(), programId: key(2).toBase58(), keepMint: key(3).toBase58(),
    reserveOwner: key(4).toBase58(), sequence: '1', root: 'c'.repeat(64), total: '80', leafCount: 1,
    kind: 0, day: String(Date.parse(day) / (POLICY.daySec * 1000)), budgetGross: '100', freeGross: '100',
    deedGross: '0', playerNet: '80', recycle: '10', tax: '10', taxCommitment: 'd'.repeat(64),
    taxVersion: 1, splitStart: 0, splitEnd: 0, blockhash: key(5).toBase58(), lastValidBlockHeight: 100, blockhashContextSlot: 10 },
});
const reservation = (): MiningPublicationOutbox => ({ epochId, attemptKey, genesisHash: SOLANA_GENESIS_HASH.devnet,
  programId: key(2).toBase58(), configAddress: key(6).toBase58(), sequence: '1', signer: operator.toBase58(),
  intentHex: prepared().intentHex, intentSha256: prepared().intentSha256, backing: {},
  reservedAt: '2026-10-03T00:00:01.000Z', signingAuthorized: false, blockhashContextSlot: 10,
  lastValidBlockHeight: 100, signed: null });
const signed = (): MiningPublicationOutbox => ({ ...reservation(), signed: { signature: 's'.repeat(88),
  signedTransactionHex: '010203', wireSha256: 'e'.repeat(64), messageSha256: prepared().intentSha256,
  acceptedAt: '2026-10-03T00:00:02.000Z' } });
const jobs: { close(): Promise<void> }[] = [];
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

function setup() {
  const queries: string[] = [], rows = [candidate()]; let inFlight = false; let owner = true, foreignTable: string | null = null;
  const execute = vi.fn(async (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const text = new PgDialect().sqlToQuery(statement).sql.replace(/\s+/g, ' ').trim(); queries.push(text);
    if (text.includes('current_user')) return [{ allowed: owner && !(foreignTable && text.includes(foreignTable)) }];
    if (text.includes('originalsInFlight')) return [{ originalsInFlight: inFlight }];
    return rows;
  });
  const db = { execute } as unknown as Db;
  const ready = vi.fn(async (_signal: AbortSignal) => true);
  const signOriginal = vi.fn(async (_record: MiningPublicationOutbox, _signal: AbortSignal): Promise<Uint8Array> => Uint8Array.from([1, 2, 3]));
  const trust = { programId: key(2), keepMint: key(3), reserveOwner: key(4),
    expectedGenesisHash: reservation().genesisHash, reviewedDeploymentSlot: 1, reviewedProgramDataSha256: 'f'.repeat(64) };
  const options = { enabled: true, testerStack: true, cluster: 'devnet', operator, hotWallet: key(12),
    publisher: { publicKey: operator, ready, signOriginal },
    sources: { qualification: { source: {}, collection: key(7).toBase58(), expectedGenesisHash: trust.expectedGenesisHash },
      backing: { reader: {}, trust }, tax: { connect: vi.fn(), policy: {
        programId: key(2), config: key(8), round: 1n, mint: key(3), prizeOwner: key(4), prizeAta: key(10),
        genesisHash: new PublicKey(SOLANA_GENESIS_HASH.devnet), stateProvenance: 'fresh-reviewed-deployment',
        deployment: { programDataAddress: key(11).toBase58(), programDataSha256: 'f'.repeat(64), upgradeAuthority: null },
      } } },
    blockhashSource: vi.fn(), reconcile: { backing: { reader: {}, trust }, settlement: { reader: {}, trust }, transport: vi.fn() },
    intervalMs: 1000, timeoutMs: 100,
  } as unknown as MiningPublicationJobOptions;
  async function open(patch: Partial<MiningPublicationJobOptions> = {}) {
    // Dynamic load permits tests-only RED discovery before this new source exists.
    const { createMiningPublicationJob } = await import('../src/mining/publicationJob');
    const job = createMiningPublicationJob(db, { ...options, ...patch }); jobs.push(job); return job;
  }
  return { db, execute, queries, rows, blockOtherDomain: () => { inFlight = true; }, ready, signOriginal, options, open, denyOwner: () => { owner = false; },
    foreignOwner: (table: string) => { foreignTable = table; } };
}

beforeEach(() => {
  vi.clearAllMocks(); h.enabled = true;
  h.createPreparer.mockReturnValue(h.prepare);
  h.getPrepared.mockResolvedValue(null); h.getOutbox.mockResolvedValue(null);
  h.prepare.mockResolvedValue(prepared()); h.reserve.mockResolvedValue(reservation()); h.accept.mockResolvedValue(signed());
  h.policy.mockResolvedValue(3); h.project.mockResolvedValue({ sequence: '1' });
  h.reconcile.mockResolvedValue({ status: 'settled', epochId, signature: signed().signed!.signature, settlement: {} });
});
afterEach(async () => { await Promise.all(jobs.splice(0).map(job => job.close())); vi.useRealTimers(); });

describe('private tester publication job', () => {
  it('N2 never immediately repeats a planner that failed before any original exists', async () => {
    vi.useFakeTimers(); const f = setup(); h.prepare.mockRejectedValue(Error('BLOCKHASH_UNAVAILABLE'));
    const job = await f.open(); job.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(h.reserve).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999); expect(h.prepare).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.prepare).toHaveBeenCalledTimes(2);
  });

  it.each(['prepared', 'signed-unsent'] as const)('N3 keeps %s original retries at fixed cadence rather than backing off', async state => {
    vi.useFakeTimers(); const f = setup(); f.rows[0]!.attemptKey = attemptKey;
    h.getPrepared.mockResolvedValue(prepared());
    if (state === 'signed-unsent') {
      h.getOutbox.mockResolvedValue(signed()); h.reconcile.mockResolvedValue({ status: 'held', epochId, reason: 'SEND_UNCERTAIN' });
    } else f.signOriginal.mockRejectedValue(Error('transient signer unavailable'));
    const attempts = state === 'signed-unsent' ? h.reconcile : f.signOriginal;
    const job = await f.open(); job.start(); await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveBeenCalledTimes(2);
    for (let cycle = 1; cycle <= 4; cycle++) {
      await vi.advanceTimersByTimeAsync(999); expect(attempts).toHaveBeenCalledTimes(2 * cycle);
      await vi.advanceTimersByTimeAsync(1); expect(attempts).toHaveBeenCalledTimes(2 * (cycle + 1));
    }
    expect(h.prepare).not.toHaveBeenCalled();
    if (state === 'signed-unsent') expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it.each(['prepared', 'signed-unsent'] as const)('F1 caps %s original retries at 15 seconds with a 60-second interval', async state => {
    vi.useFakeTimers(); const f = setup(); f.rows[0]!.attemptKey = attemptKey;
    h.getPrepared.mockResolvedValue(prepared());
    if (state === 'signed-unsent') {
      h.getOutbox.mockResolvedValue(signed()); h.reconcile.mockResolvedValue({ status: 'held', epochId, reason: 'SEND_UNCERTAIN' });
    } else f.signOriginal.mockRejectedValue(Error('transient signer unavailable'));
    const attempts = state === 'signed-unsent' ? h.reconcile : f.signOriginal;
    const job = await f.open({ intervalMs: 60_000 }); job.start(); await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_999); expect(attempts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(attempts).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(14_999); expect(attempts).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1); expect(attempts).toHaveBeenCalledTimes(6);
    expect(h.prepare).not.toHaveBeenCalled();
    if (state === 'signed-unsent') expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it('M1 rejects colliding OPERATOR, RESERVE and hot identities before any I/O', async () => {
    const f = setup();
    await expect(f.open({ operator: key(4), publisher: { ...f.options.publisher, publicKey: key(4) } })).rejects.toThrow('distinct');
    await expect(f.open({ hotWallet: operator })).rejects.toThrow('distinct');
    await expect(f.open({ hotWallet: key(4) })).rejects.toThrow('distinct');
    await expect(f.open({ hotWallet: PublicKey.default })).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled();
  });

  it('M2 gives the immutable original a fresh critical budget after slow preparation', async () => {
    vi.useFakeTimers(); const f = setup(), planned = deferred<PreparedMiningPublication>(), signature = deferred<Uint8Array>();
    h.prepare.mockReturnValueOnce(planned.promise); f.signOriginal.mockReturnValueOnce(signature.promise);
    const job = await f.open(), result = job.runOnce();
    await vi.advanceTimersByTimeAsync(90); planned.resolve(prepared()); await vi.advanceTimersByTimeAsync(0);
    expect(f.signOriginal).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20); expect(f.signOriginal.mock.calls[0]![1].aborted).toBe(false);
    signature.resolve(Uint8Array.from([1,2,3])); await vi.advanceTimersByTimeAsync(0);
    expect(await result).toMatchObject({ status: 'projected' });
  });

  it('M2 immediately resumes the same unsigned original once the timed-out reservation drains', async () => {
    vi.useFakeTimers(); const f = setup(), pending = deferred<MiningPublicationOutbox>();
    h.reserve.mockReturnValueOnce(pending.promise); h.getPrepared.mockResolvedValueOnce(null).mockResolvedValue(prepared());
    const job = await f.open(); job.start(); await vi.advanceTimersByTimeAsync(101);
    expect(job.getLastResult()).toMatchObject({ reason: 'TIMEOUT' }); expect(h.reserve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500); expect(h.reserve).toHaveBeenCalledTimes(1);
    pending.resolve(reservation()); await vi.advanceTimersByTimeAsync(0);
    expect(h.reserve).toHaveBeenCalledTimes(2); expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(job.getLastResult()).toMatchObject({ status: 'projected' });
  });

  it('M2 retries a signed held original immediately only once and never re-prepares or signs', async () => {
    vi.useFakeTimers(); const f = setup(); f.rows[0]!.attemptKey = attemptKey;
    h.getPrepared.mockResolvedValue(prepared()); h.getOutbox.mockResolvedValue(signed());
    h.reconcile.mockResolvedValue({ status: 'held', epochId, reason: 'SEND_UNCERTAIN' });
    const job = await f.open(); job.start(); await vi.advanceTimersByTimeAsync(0);
    expect(h.reconcile).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(500);
    expect(h.reconcile).toHaveBeenCalledTimes(2); expect(h.prepare).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it('M3 holds fresh resource preparation behind any unsettled original in the same chain config', async () => {
    const f = setup(); f.blockOtherDomain(); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', epochId, reason: 'ORIGINAL_IN_FLIGHT' });
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled();
    const query = f.queries.find(q => q.includes('originalsInFlight'))!;
    expect(query).toContain('mining_publication_attempts'); expect(query).toContain('mining_publication_settlements');
    expect(query).toContain('genesisHash'); expect(query).toContain('programId'); expect(query).toContain('address');
    expect(query).not.toContain('resource-mining'); expect(query).not.toContain('contributions');
  });

  it('M3 permits read-only recovery of its existing original despite another domain fence', async () => {
    const f = setup(); f.blockOtherDomain(); f.rows[0]!.attemptKey = attemptKey;
    h.getPrepared.mockResolvedValue(prepared()); h.getOutbox.mockResolvedValue(signed());
    const job = await f.open(); expect(await job.runOnce()).toMatchObject({ status: 'projected' });
    expect(h.prepare).not.toHaveBeenCalled(); expect(f.queries.some(q => q.includes('originalsInFlight'))).toBe(false);
  });

  it('B1 publishes sanitized non-idle status with its day and retains an immutable private last result', async () => {
    vi.useFakeTimers(); const f = setup(), report = vi.fn();
    h.prepare.mockResolvedValue({ status: 'abort-proposed' });
    const job = await f.open({ report });
    expect(job.getLastResult()).toBeNull();
    await job.runOnce(); await job.runOnce();
    expect(job.getLastResult()).toMatchObject({ status: 'held', reason: 'ABORT_PROPOSED', epochId, day });
    expect(Object.isFrozen(job.getLastResult())).toBe(true); expect(report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000); await job.runOnce(); expect(report).toHaveBeenCalledTimes(2);
    h.prepare.mockRejectedValueOnce(Error('MINING_RESOURCE_DAY_OPEN'));
    await job.runOnce(); expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'MINING_RESOURCE_DAY_OPEN', day }));
    h.prepare.mockRejectedValueOnce(Error('https://private.example/credential'));
    await job.runOnce(); expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'SOURCE_UNAVAILABLE', day }));
    expect(JSON.stringify(report.mock.calls)).not.toContain('private.example');
  });

  it('B1 keeps the oldest no-award day visible and backs off repeated scheduled holds without preparing a later day', async () => {
    vi.useFakeTimers(); const f = setup(), report = vi.fn();
    f.rows.push({ ...candidate(), epochId: '00000000-0000-4000-8000-000000000002', day: '2026-10-03', epochKey: 'resource-mining-v3:2026-10-03' });
    h.prepare.mockResolvedValue({ status: 'abort-proposed' }); const job = await f.open({ report });
    job.start(); await vi.advanceTimersByTimeAsync(0); expect(h.prepare).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); expect(h.prepare).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); expect(h.prepare).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); expect(h.prepare).toHaveBeenCalledTimes(3);
    expect(h.prepare.mock.calls.every(([request]) => request.epochId === epochId)).toBe(true);
    expect(report).toHaveBeenCalledTimes(1); expect(job.getLastResult()).toMatchObject({ day, reason: 'ABORT_PROPOSED' });
  });

  it('B1 distinguishes on-chain publication admission refusal from an offline publisher', async () => {
    const f = setup(), report = vi.fn(); h.prepare.mockRejectedValueOnce({ code: 'PUBLISHER_UNAVAILABLE' });
    const job = await f.open({ report });
    expect(await job.runOnce()).toMatchObject({ reason: 'ONCHAIN_PUBLISHER_REFUSED' });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ day, reason: 'ONCHAIN_PUBLISHER_REFUSED' }));
  });

  it('does no construction I/O, remains dark by default, and cannot enable outside an explicit devnet tester stack', async () => {
    const f = setup(), dark = await f.open({ enabled: undefined });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled();
    expect(await dark.runOnce()).toMatchObject({ status: 'disabled' }); expect(f.execute).not.toHaveBeenCalled();
    await expect(f.open({ testerStack: false })).rejects.toThrow();
    await expect(f.open({ cluster: 'mainnet-beta' })).rejects.toThrow();
  });

  it('requires an explicit matching OPERATOR public identity before any source or database call', async () => {
    const f = setup();
    await expect(f.open({ publisher: { ...f.options.publisher, publicKey: key(9) } })).rejects.toThrow();
    await expect(f.open({ operator: PublicKey.default })).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled();
  });

  it('rejects a nonowner SQL role even when readers and a ready publisher exist', async () => {
    const f = setup(); f.denyOwner(); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'OWNER_REQUIRED' });
    expect(h.prepare).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled();
  });

  it.each(['mining_publication_attempts', 'mining_publication_manifests', 'mining_publication_signing_reservations',
    'mining_publication_signed_wires', 'mining_publication_settlements', 'mining_claim_entitlement_headers',
    'mining_claim_entitlement_leaves'])('checks private ownership of %s before entering any preparation or signer', async table => {
    const f = setup(); f.foreignOwner(table); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'OWNER_REQUIRED' });
    expect(f.ready).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); expect(h.project).not.toHaveBeenCalled();
  });

  it('copies the real public-only tax policy without stripping PublicKey methods or sharing mutable identity fields', async () => {
    const f = setup(), original = f.options.sources.tax!.policy, job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'projected' });
    const passed = h.createPreparer.mock.calls[0]![1] as MiningPublicationPreparationOptions & { sources: FundedMiningAllocationSources };
    const copied = passed.sources.tax!.policy;
    for (const name of ['programId', 'config', 'mint', 'prizeOwner', 'prizeAta', 'genesisHash'] as const) {
      expect(copied[name]).toBeInstanceOf(PublicKey); expect(copied[name]).not.toBe(original[name]);
      expect(copied[name].equals(original[name])).toBe(true); expect(copied[name].toBytes()).toEqual(original[name].toBytes());
    }
    expect(copied.deployment).toEqual(original.deployment); expect(copied.deployment).not.toBe(original.deployment);
    expect(copied.round).toBe(original.round);
  });

  it('supports frozen application-owned readers without violating Proxy method invariants', async () => {
    const f = setup(), getGenesisHash = vi.fn(async () => SOLANA_GENESIS_HASH.devnet);
    const frozen = Object.freeze({ getGenesisHash }) as unknown as NonNullable<FundedMiningAllocationSources['backing']>['reader'];
    h.prepare.mockImplementation(async () => {
      const passed = h.createPreparer.mock.calls[0]![1] as { sources: FundedMiningAllocationSources };
      expect(await passed.sources.backing!.reader.getGenesisHash()).toBe(SOLANA_GENESIS_HASH.devnet); return prepared();
    });
    const job = await f.open({ sources: { ...f.options.sources, backing: { ...f.options.sources.backing!, reader: frozen } } });
    expect(await job.runOnce()).toMatchObject({ status: 'projected' }); expect(getGenesisHash).toHaveBeenCalledTimes(1);
  });

  it('refuses an already-settled original from another genesis instead of projecting it through the devnet job', async () => {
    const f = setup(); f.rows[0]!.settled = true; f.rows[0]!.attemptKey = attemptKey;
    const p = prepared(), manifest = JSON.parse(p.manifestJson); manifest.funding.source.genesisHash = SOLANA_GENESIS_HASH['mainnet-beta'];
    h.getPrepared.mockResolvedValue({ ...p, manifestJson: JSON.stringify(manifest) });
    const job = await f.open(); expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'SOURCE_CONFLICT', epochId });
    expect(h.project).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it('discovers persisted closed resource days only and leaves absent days untouched', async () => {
    const f = setup(); f.rows.length = 0; const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'idle' });
    const query = f.queries.find(text => text.includes('mining_ingot_epochs'))!;
    expect(query).toContain('resource-mining-v'); expect(query).toContain('clock_timestamp()');
    expect(query).toContain('mining_ingot_aborts'); expect(query).toContain('mining_claim_entitlement_headers');
    expect(query.toLowerCase()).toContain('order by'); expect(query.toLowerCase()).toContain('limit');
    expect(h.prepare).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it('checks authoritative day policy and refuses a mismatched recorded epoch before publication', async () => {
    const f = setup(); h.policy.mockResolvedValue(2); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'SOURCE_CONFLICT', epochId });
    expect(h.policy).toHaveBeenCalledWith(expect.anything(), day);
    expect(h.prepare).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it('BH-1 never prepares an immutable blockhash-bearing original when publisher readiness is absent', async () => {
    const f = setup(); f.ready.mockResolvedValue(false); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'PUBLISHER_UNAVAILABLE', epochId });
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it('fails closed on publisher-readiness errors and unavailable historical allocation evidence', async () => {
    const f = setup(); f.ready.mockRejectedValueOnce(Error('offline')); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'PUBLISHER_UNAVAILABLE' });
    expect(h.prepare).not.toHaveBeenCalled();
    h.prepare.mockRejectedValueOnce(Object.assign(Error('archive absent'), { code: 'TAX_SOURCE_UNAVAILABLE' }));
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'TAX_SOURCE_UNAVAILABLE' });
    expect(f.signOriginal).not.toHaveBeenCalled(); expect(h.project).not.toHaveBeenCalled();
  });

  it('prepares the exact closed day, commits the signing reservation and exact signed bytes, then reconciles and projects', async () => {
    const f = setup(), events: string[] = [];
    f.ready.mockImplementation(async () => { events.push('ready'); return true; });
    h.prepare.mockImplementation(async () => { events.push('prepare'); return prepared(); });
    h.reserve.mockImplementation(async () => { events.push('reserve'); return reservation(); });
    f.signOriginal.mockImplementation(async () => { events.push('sign'); return Uint8Array.from([1, 2, 3]); });
    h.accept.mockImplementation(async () => { events.push('persist'); return signed(); });
    h.reconcile.mockImplementation(async () => { events.push('reconcile'); return { status: 'settled', epochId }; });
    h.project.mockImplementation(async () => { events.push('project'); return { sequence: '1' }; });
    const job = await f.open(); expect(await job.runOnce()).toMatchObject({ status: 'projected', epochId });
    expect(events[0]).toBe('ready'); expect(events.indexOf('prepare')).toBeLessThan(events.indexOf('reserve'));
    expect(events.indexOf('reserve')).toBeLessThan(events.indexOf('sign')); expect(events.indexOf('sign')).toBeLessThan(events.indexOf('persist'));
    expect(events.indexOf('persist')).toBeLessThan(events.indexOf('reconcile')); expect(events.indexOf('reconcile')).toBeLessThan(events.indexOf('project'));
    expect(h.prepare).toHaveBeenCalledWith({ epochId, day, policyVersion: 3, attemptKey });
    expect(f.signOriginal).toHaveBeenCalledWith(expect.objectContaining({ epochId, intentHex: 'aabbcc', intentSha256: 'b'.repeat(64) }), expect.any(AbortSignal));
    expect(h.accept).toHaveBeenCalledWith({ epochId, attemptKey, signedTransaction: Uint8Array.from([1, 2, 3]) });
    expect(h.project).toHaveBeenCalledWith(expect.anything(), { epochId });
  });

  it('holds a no-useful-award plan without signing, aborting, inventing amounts or projecting', async () => {
    const f = setup(); h.prepare.mockResolvedValue({ status: 'abort-proposed', plan: { projection: 'ABORT_NO_USEFUL_PLAYER_AWARD' } });
    const job = await f.open(); expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'ABORT_PROPOSED', epochId });
    expect(h.reserve).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled(); expect(h.project).not.toHaveBeenCalled();
  });

  it('recovers an existing signed original before fresh readiness or admission even while mining is paused', async () => {
    const f = setup(); f.rows[0]!.attemptKey = 'retained-attempt'; h.enabled = false;
    h.getPrepared.mockResolvedValue({ ...prepared(), attemptKey: 'retained-attempt' });
    h.getOutbox.mockResolvedValue({ ...signed(), attemptKey: 'retained-attempt' });
    const job = await f.open(); expect(await job.runOnce()).toMatchObject({ status: 'projected', epochId });
    expect(h.reconcile).toHaveBeenCalledWith({ epochId, attemptKey: 'retained-attempt' });
    expect(f.ready).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it('repairs settlement-before-projection crashes while paused without re-signing, re-sending or re-preparing', async () => {
    const f = setup(); f.rows[0]!.settled = true; f.rows[0]!.attemptKey = attemptKey; h.enabled = false;
    h.getPrepared.mockResolvedValue(prepared()); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'projected', epochId });
    expect(h.project).toHaveBeenCalledTimes(1); expect(h.reconcile).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
  });

  it.each(['SEND_UNCERTAIN', 'EXPIRED_UNRESOLVED', 'FINALIZED_ERROR', 'SETTLEMENT_HELD'])('retains %s originals without replacement or premature entitlement', async reason => {
    const f = setup(); f.rows[0]!.attemptKey = attemptKey; h.getPrepared.mockResolvedValue(prepared()); h.getOutbox.mockResolvedValue(signed());
    h.reconcile.mockResolvedValue({ status: 'held', epochId, reason }); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', epochId, reason });
    expect(await job.runOnce()).toMatchObject({ status: 'held', epochId, reason });
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled(); expect(f.signOriginal).not.toHaveBeenCalled(); expect(h.project).not.toHaveBeenCalled();
  });

  it('keeps a submitted acknowledgement separate from finalized projection', async () => {
    const f = setup(); h.reconcile.mockResolvedValue({ status: 'submitted', epochId, publicationFinalized: false });
    const job = await f.open(); expect(await job.runOnce()).toMatchObject({ status: 'submitted', epochId });
    expect(h.project).not.toHaveBeenCalled();
  });

  it('resumes the retained unsigned intent and attempt key, never preparing a replacement', async () => {
    const f = setup(); f.rows[0]!.attemptKey = 'old-original';
    h.getPrepared.mockResolvedValue({ ...prepared(), attemptKey: 'old-original' }); h.reserve.mockResolvedValue({ ...reservation(), attemptKey: 'old-original' });
    h.accept.mockResolvedValue({ ...signed(), attemptKey: 'old-original' }); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'projected', epochId });
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.reserve).toHaveBeenCalledWith({ epochId, attemptKey: 'old-original' });
    expect(f.signOriginal.mock.calls[0]![0]).toMatchObject({ attemptKey: 'old-original', intentHex: 'aabbcc' });
  });

  it('rechecks live pause after readiness and reservation before any fresh signing', async () => {
    const f = setup(); f.ready.mockImplementationOnce(async () => { h.enabled = false; return true; }); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'PAUSED' }); expect(h.prepare).not.toHaveBeenCalled();
    h.enabled = true; h.reserve.mockImplementationOnce(async () => { h.enabled = false; return reservation(); });
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'PAUSED' }); expect(f.signOriginal).not.toHaveBeenCalled();
  });

  it('rejects a changed signing reservation before passing any bytes to the publisher', async () => {
    const f = setup(); h.reserve.mockResolvedValue({ ...reservation(), intentHex: 'dddd' }); const job = await f.open();
    expect(await job.runOnce()).toMatchObject({ status: 'held', reason: 'SOURCE_CONFLICT' });
    expect(f.signOriginal).not.toHaveBeenCalled(); expect(h.accept).not.toHaveBeenCalled(); expect(h.project).not.toHaveBeenCalled();
  });

  it('coalesces concurrent passes and retains a timed-out raw operation until it drains; no late preparation', async () => {
    vi.useFakeTimers(); const f = setup(), pending = deferred<boolean>(); f.ready.mockReturnValue(pending.promise); const job = await f.open();
    const first = job.runOnce(), second = job.runOnce(); expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(101); expect(await first).toMatchObject({ status: 'held', reason: 'TIMEOUT' });
    expect(job.runOnce()).toBe(first); expect(f.ready).toHaveBeenCalledTimes(1);
    pending.resolve(true); await vi.advanceTimersByTimeAsync(0); expect(h.prepare).not.toHaveBeenCalled();
    f.ready.mockResolvedValue(true); expect(await job.runOnce()).toMatchObject({ status: 'projected' });
  });

  it('start is idempotent; close drains owned work, aborts the publisher, and prohibits later scans', async () => {
    vi.useFakeTimers(); const f = setup(), pending = deferred<boolean>(); f.ready.mockReturnValue(pending.promise); const job = await f.open();
    job.start(); job.start(); await vi.advanceTimersByTimeAsync(0); expect(f.ready).toHaveBeenCalledTimes(1);
    const closing = job.close(); expect(f.ready.mock.calls[0]![0].aborted).toBe(true);
    pending.resolve(true); await closing; await vi.advanceTimersByTimeAsync(10_000);
    expect(h.prepare).not.toHaveBeenCalled(); expect(f.ready).toHaveBeenCalledTimes(1);
    await expect(job.runOnce()).rejects.toThrow('closed');
  });
});
