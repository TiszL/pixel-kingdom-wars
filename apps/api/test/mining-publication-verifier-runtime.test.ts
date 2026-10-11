/** No DB/transport is opened by this suite. Actual SQL/receipt proof is queued separately. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { MINING_PROGRAM_ADDRESS } from '@shardkeep/chain/mining-program';
import { PgDialect } from 'drizzle-orm/pg-core';
const mock = vi.hoisted(() => ({
  createDb: vi.fn(), execute: vi.fn(), end: vi.fn(), resources: vi.fn(), ingots: vi.fn(), project: vi.fn(),
  readers: [] as { getGenesisHash(): Promise<string> }[],
}));
vi.mock('../src/db/client', () => ({ createDb: mock.createDb }));
vi.mock('../src/mining/publicationSettlement', () => ({
  createResourceMiningPublicationSettlement: (_db: unknown, input: { reader: { getGenesisHash(): Promise<string> } }) => {
    mock.readers.push(input.reader); return mock.resources;
  },
  createMiningPublicationSettlement: () => mock.ingots,
}));
vi.mock('../src/mining/claimEntitlement', () => ({ projectMiningClaimEntitlements: mock.project }));
import { createMiningPublicationVerifierRuntime } from '../src/mining/publicationVerifierRuntime';

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const trust = { programId: new PublicKey(MINING_PROGRAM_ADDRESS), keepMint: key(2), reserveOwner: key(3),
  expectedGenesisHash: SOLANA_GENESIS_HASH.devnet, reviewedDeploymentSlot: 10,
  reviewedProgramDataSha256: 'a'.repeat(64) };
const source = vi.fn(() => ({ getGenesisHash: vi.fn(async () => trust.expectedGenesisHash) }));
const sources = () => ({ trust, receiptSource: source } as never);
const url = 'postgres://private_owner@localhost:65432/shardkeep_test';
const enabled = { enabled: true, cluster: 'devnet' as const };
const epoch = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n = 1, resource = true) => ({ epochId: epoch(n), sequence: String(n),
  attemptKey: `original-${n}`, signature: 's'.repeat(64), wireHex: 'abcd', resource });
let queries: { sql: string; params: unknown[] }[];
let pages: ReturnType<typeof row>[][];
beforeEach(() => {
  vi.resetAllMocks(); queries = []; pages = []; mock.readers.length = 0;
  mock.end.mockResolvedValue(undefined);
  mock.createDb.mockReturnValue({ db: { execute: mock.execute }, sql: { end: mock.end } });
  mock.execute.mockImplementation(async query => {
    const compiled = new PgDialect().sqlToQuery(query); queries.push(compiled);
    return compiled.sql.includes('pg_class') ? [{ allowed: true }] : pages.shift() ?? [];
  });
  mock.resources.mockResolvedValue({ epochId: epoch(1) });
  mock.ingots.mockResolvedValue({ epochId: epoch(1) });
  mock.project.mockResolvedValue({ epochId: epoch(1), claimabilityVerified: false });
  source.mockImplementation(() => ({ getGenesisHash: vi.fn(async () => trust.expectedGenesisHash) }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('private publication finality recovery', () => {
  it('is dark by default and never opens a pool without explicit enablement', async () => {
    expect(await createMiningPublicationVerifierRuntime(undefined, undefined)).toBeNull();
    expect(await createMiningPublicationVerifierRuntime(url, sources())).toBeNull();
    expect(mock.createDb).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled();
  });
  it('rejects missing sources and non-devnet admission before any connection', async () => {
    await expect(createMiningPublicationVerifierRuntime(url, undefined, enabled)).rejects.toThrow('complete reviewed');
    await expect(createMiningPublicationVerifierRuntime(url, sources(), { ...enabled, cluster: 'mainnet-beta' } as never)).rejects.toThrow('devnet');
    await expect(createMiningPublicationVerifierRuntime(url, { ...sources() as object, trust: { ...trust, expectedGenesisHash: 'wrong' } } as never, enabled)).rejects.toThrow('devnet');
    expect(mock.createDb).not.toHaveBeenCalled();
  });
  it('requires the actual owner and closes its dedicated pool on refusal', async () => {
    mock.execute.mockResolvedValue([{ allowed: false }]);
    await expect(createMiningPublicationVerifierRuntime(url, sources(), enabled)).rejects.toThrow('private publication owner');
    expect(mock.end).toHaveBeenCalledOnce(); expect(source).not.toHaveBeenCalled();
  });
  it('checks each actual custody and projection owner before scanning', async () => {
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    try {
      for (const table of ['mining_publication_attempts', 'mining_publication_manifests',
        'mining_publication_settlements', 'mining_publication_signing_reservations', 'mining_publication_signed_wires',
        'mining_claim_entitlement_headers', 'mining_claim_entitlement_leaves']) {
        expect(queries[0]!.sql).toContain(`'public.${table}'::regclass`);
      }
      expect(source).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });
  it('passes exact original resource bytes to settlement before projection even while admission is paused', async () => {
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); pages = [[row()]];
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    try {
      expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 1, projected: 1, held: 0 });
      expect(mock.resources).toHaveBeenCalledWith({ epochId: epoch(1), attemptKey: 'original-1', signature: 's'.repeat(64), signedTransaction: Buffer.from('abcd', 'hex') });
      expect(mock.ingots).not.toHaveBeenCalled();
      expect(mock.resources.mock.invocationCallOrder[0]).toBeLessThan(mock.project.mock.invocationCallOrder[0]!);
      expect(mock.project).toHaveBeenCalledWith(expect.anything(), { epochId: epoch(1) });
      expect(queries[1]!.sql).toContain('order by r.sequence,r.epoch_id');
      expect(queries[1]!.sql).toContain('not exists');
      expect(queries[1]!.params).toContain(trust.programId.toBase58());
      expect(queries[1]!.params).toContain(trust.expectedGenesisHash);
    } finally { await runtime.close(); }
  });
  it('preserves the ingot settlement factory for historical originals', async () => {
    pages = [[row(1, false)]];
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    try { await runtime.runOnce(); expect(mock.ingots).toHaveBeenCalledOnce(); expect(mock.resources).not.toHaveBeenCalled(); }
    finally { await runtime.close(); }
  });
  it('never projects an unavailable or conflicting settlement', async () => {
    pages = [[row()]]; mock.resources.mockRejectedValue({ code: 'RECEIPT_UNAVAILABLE' });
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    try { expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, projected: 0, held: 1 }); expect(mock.project).not.toHaveBeenCalled(); }
    finally { await runtime.close(); }
  });
  it('retries projection after a settled original and never invents claimable state', async () => {
    pages = [[row()], [row()], []]; mock.project.mockRejectedValueOnce({ code: 'BUSY' });
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    try {
      expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 1, projected: 0, held: 1 });
      expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 1, projected: 1, held: 0 });
      expect(await runtime.runOnce()).toEqual({ examined: 0, settled: 0, projected: 0, held: 0 });
      expect(mock.project).toHaveBeenCalledTimes(2);
    } finally { await runtime.close(); }
  });
  it('advances a bounded keyset past held work then wraps without starving later originals', async () => {
    pages = [[row(1), row(2)], [row(2)], [row(1)]];
    mock.resources.mockRejectedValueOnce({ code: 'RECEIPT_UNAVAILABLE' });
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), { ...enabled, batchSize: 1 }))!;
    try {
      expect((await runtime.runOnce()).held).toBe(1);
      expect((await runtime.runOnce()).projected).toBe(1);
      expect((await runtime.runOnce()).projected).toBe(1);
      expect(queries[2]!.sql).toContain('(r.sequence,r.epoch_id)>');
      expect(queries[2]!.params).toContain(epoch(1));
      expect(queries[3]!.sql).not.toContain('(r.sequence,r.epoch_id)>');
    } finally { await runtime.close(); }
  });
  it('holds malformed originals without calling a terminal writer', async () => {
    pages = [[{ ...row(), wireHex: 'xyz' }]];
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    try { expect((await runtime.runOnce()).held).toBe(1); expect(mock.resources).not.toHaveBeenCalled(); expect(mock.project).not.toHaveBeenCalled(); }
    finally { await runtime.close(); }
  });
  it('coalesces scans and shutdown prevents a late projection', async () => {
    pages = [[row()]]; let release!: () => void;
    mock.resources.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    const first = runtime.runOnce(); expect(runtime.runOnce()).toBe(first);
    await vi.waitFor(() => expect(mock.resources).toHaveBeenCalledOnce());
    const closing = runtime.close(); expect(mock.end).not.toHaveBeenCalled(); release(); await closing;
    expect((await first).projected).toBe(0); expect(mock.project).not.toHaveBeenCalled();
    await expect(runtime.runOnce()).rejects.toThrow('closed'); await runtime.close(); expect(mock.end).toHaveBeenCalledOnce();
  });
  it('starts once, schedules only after a scan completes, and closes its timer', async () => {
    vi.useFakeTimers(); const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    runtime.start(); runtime.start(); await vi.advanceTimersByTimeAsync(0);
    expect(queries).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15000); expect(queries).toHaveLength(3);
    await runtime.close(); await vi.advanceTimersByTimeAsync(60000); expect(queries).toHaveLength(3);
  });
  it('retains an uncooperative reader until it drains and rejects late evidence after the deadline', async () => {
    vi.useFakeTimers(); pages = [[row()]]; let release!: (value: string) => void;
    const raw = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    source.mockImplementation(() => ({ getGenesisHash: raw }));
    mock.resources.mockImplementation(async () => { await mock.readers[0]!.getGenesisHash(); });
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), { ...enabled, timeoutMs: 5 }))!;
    const first = runtime.runOnce(); await vi.advanceTimersByTimeAsync(0); expect(raw).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6); expect(runtime.runOnce()).toBe(first);
    expect(mock.project).not.toHaveBeenCalled(); release(trust.expectedGenesisHash);
    expect(await first).toEqual({ examined: 1, settled: 0, projected: 0, held: 1 });
    expect(mock.project).not.toHaveBeenCalled(); await runtime.close();
  });
  it('supports immutable application-owned receipt readers without violating Proxy invariants', async () => {
    pages = [[row()]];
    source.mockImplementation(() => Object.freeze({ getGenesisHash: vi.fn(async () => trust.expectedGenesisHash) }));
    mock.resources.mockImplementation(async () => {
      expect(await mock.readers[0]!.getGenesisHash()).toBe(trust.expectedGenesisHash);
    });
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), enabled))!;
    try { expect((await runtime.runOnce()).projected).toBe(1); }
    finally { await runtime.close(); }
  });
  it('B1 reports held counts and bounded codes without exposing provider errors', async () => {
    pages = [[row()], [row()]]; const report = vi.fn();
    mock.resources.mockRejectedValueOnce({ code: 'RECEIPT_UNAVAILABLE' }).mockRejectedValueOnce(Error('https://private.example/key'));
    const runtime = (await createMiningPublicationVerifierRuntime(url, sources(), { ...enabled, report }))!;
    try {
      await runtime.runOnce(); await runtime.runOnce();
      expect(report).toHaveBeenNthCalledWith(1, expect.objectContaining({ held: 1, heldReasons: { RECEIPT_UNAVAILABLE: 1 } }));
      expect(report).toHaveBeenNthCalledWith(2, expect.objectContaining({ held: 1, heldReasons: { SOURCE_UNAVAILABLE: 1 } }));
      expect(JSON.stringify(report.mock.calls)).not.toContain('private.example');
    } finally { await runtime.close(); }
  });
});
