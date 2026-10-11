/** B1 private operator orchestration only. No actual database, authorization service or abort executes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Db } from '../src/db/client';
import type { MiningPublicationJobObservation, MiningPublicationJobResult } from '../src/mining/publicationJob';
const h = vi.hoisted(() => ({ abort: vi.fn() }));
vi.mock('../src/game/miningContributions', () => ({ abortMiningContributions: h.abort }));
import { createMiningPublicationOperator } from '../src/mining/publicationOperator';

const operator = new PublicKey('AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv');
const epochId = '00000000-0000-4000-8000-000000000001', day = '2026-10-02';
const request = { epochId, day, decisionKey: 'owner-review-no-award-1', reason: 'reviewed-no-useful-funded-award' };
const proposed = () => ({ status: 'held', reason: 'ABORT_PROPOSED', epochId, day } as const);
// The operator consumes observed day metadata; bare results remain negative fixtures.
type OperatorJobResult = MiningPublicationJobResult & Partial<Pick<MiningPublicationJobObservation, 'day'>>;
function fixture() {
  let last: OperatorJobResult | null = proposed();
  const execute = vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const compiled = new PgDialect().sqlToQuery(query);
    return compiled.sql.includes('current_user') ? [{ allowed: true }] : [{ epochKey: `resource-mining-v3:${day}`, attempted: false }];
  });
  const db = { execute } as unknown as Db;
  const getLastResult = vi.fn(() => last), authorizeAbort = vi.fn(async (_command: Readonly<typeof request & { operator: string }>) => true);
  const options = { enabled: true, testerStack: true, cluster: 'devnet' as const, operator,
    job: { getLastResult }, authorizeAbort };
  const create = (patch: Partial<typeof options> = {}) => createMiningPublicationOperator(db, { ...options, ...patch });
  return { db, execute, options, create, getLastResult, authorizeAbort, setLast: (value: OperatorJobResult | null) => { last = value; } };
}
beforeEach(() => { vi.resetAllMocks(); h.abort.mockResolvedValue(undefined); });

describe('explicit private mining publication operator', () => {
  it('exposes a copied last result without invoking authorization or touching custody', () => {
    const f = fixture(), service = f.create({ enabled: false }), view = service.read();
    expect(view).toEqual({ operator: operator.toBase58(), lastResult: proposed() });
    expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(view.lastResult)).toBe(true);
    expect(view.lastResult).not.toBe(f.getLastResult.mock.results[0]!.value);
    f.setLast(null); expect(service.read().lastResult).toBeNull();
    expect(f.authorizeAbort).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(h.abort).not.toHaveBeenCalled();
  });
  it('defaults abort admission off without granting authority from the public key', async () => {
    const f = fixture(), { enabled: _enabled, ...options } = f.options;
    const service = createMiningPublicationOperator(f.db, options);
    await expect(service.abortProposed(request)).rejects.toThrow('DISABLED');
    expect(f.authorizeAbort).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(h.abort).not.toHaveBeenCalled();
  });
  it('requires explicit devnet tester admission and an application-owned authorization capability', () => {
    const f = fixture();
    expect(() => f.create({ testerStack: false })).toThrow('devnet tester');
    expect(() => createMiningPublicationOperator(f.db, { ...f.options, cluster: 'mainnet-beta' })).toThrow('devnet tester');
    expect(() => createMiningPublicationOperator(f.db, { ...f.options, authorizeAbort: undefined } as never)).toThrow('authorization capability');
    expect(() => f.create({ operator: PublicKey.default })).toThrow('public identity');
    expect(f.execute).not.toHaveBeenCalled(); expect(h.abort).not.toHaveBeenCalled();
  });
  it('rejects malformed or extra command fields before authorization, including a supplied operator key', async () => {
    const f = fixture(), service = f.create();
    for (const value of [{ ...request, epochId: 'wrong' }, { ...request, day: '2026-02-30' },
      { ...request, reason: 'short' }, { ...request, decisionKey: ' padded-key ' },
      { ...request, operator: operator.toBase58() }, { ...request, authorized: true }]) {
      await expect(service.abortProposed(value as never)).rejects.toThrow('INVALID_INPUT');
    }
    expect(f.authorizeAbort).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it('holds every status other than the exact latest ABORT_PROPOSED epoch and day', async () => {
    const f = fixture(), service = f.create();
    for (const value of [null, { status: 'idle' }, { status: 'submitted', epochId, day },
      { ...proposed(), reason: 'EXPIRED_UNRESOLVED' }, { ...proposed(), reason: 'FINALIZED_ERROR' },
      { ...proposed(), epochId: '00000000-0000-4000-8000-000000000002' }, { ...proposed(), day: '2026-10-01' }]) {
      f.setLast(value as MiningPublicationJobResult | null);
      await expect(service.abortProposed(request)).rejects.toThrow('NOT_ABORT_PROPOSED');
    }
    expect(f.authorizeAbort).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(h.abort).not.toHaveBeenCalled();
  });
  it('fails closed on a denied or failed authorization capability', async () => {
    const f = fixture(), service = f.create();
    f.authorizeAbort.mockResolvedValueOnce(false);
    await expect(service.abortProposed(request)).rejects.toThrow('AUTHORIZATION_DENIED');
    f.authorizeAbort.mockRejectedValueOnce(Error('provider detail must not escape'));
    await expect(service.abortProposed(request)).rejects.toThrow('AUTHORIZATION_DENIED');
    expect(f.execute).not.toHaveBeenCalled(); expect(h.abort).not.toHaveBeenCalled();
  });
  it('captures the authorization function and operator identity at composition time', async () => {
    const f = fixture(); f.authorizeAbort.mockResolvedValue(false);
    const service = createMiningPublicationOperator(f.db, f.options);
    f.options.authorizeAbort = vi.fn(async () => true); f.options.operator = new PublicKey(new Uint8Array(32).fill(9));
    await expect(service.abortProposed(request)).rejects.toThrow('AUTHORIZATION_DENIED');
    expect(f.authorizeAbort).toHaveBeenCalledWith(Object.freeze({ ...request, operator: operator.toBase58() }));
    expect(f.options.authorizeAbort).not.toHaveBeenCalled(); expect(service.read().operator).toBe(operator.toBase58());
    expect(h.abort).not.toHaveBeenCalled();
  });
  it('rechecks the proposed state after authorization before entering any database call', async () => {
    const f = fixture(); f.authorizeAbort.mockImplementation(async () => { f.setLast({ status: 'submitted', epochId, day }); return true; });
    await expect(f.create().abortProposed(request)).rejects.toThrow('NOT_ABORT_PROPOSED');
    expect(f.execute).not.toHaveBeenCalled(); expect(h.abort).not.toHaveBeenCalled();
  });
  it('requires the actual private owner before reading or returning original baskets', async () => {
    const f = fixture(); f.execute.mockResolvedValueOnce([{ allowed: false }]);
    await expect(f.create().abortProposed(request)).rejects.toThrow('OWNER_REQUIRED');
    expect(f.execute).toHaveBeenCalledOnce(); expect(h.abort).not.toHaveBeenCalled();
  });
  it('refuses a prepared attempt, a wrong resource day, or a missing epoch', async () => {
    const f = fixture(), service = f.create();
    for (const rows of [[{ epochKey: `resource-mining-v3:${day}`, attempted: true }],
      [{ epochKey: 'free-shadow-v2:2026-10-02', attempted: false }],
      [{ epochKey: 'resource-mining-v3:2026-10-01', attempted: false }], []]) {
      f.execute.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce(rows as never);
      await expect(service.abortProposed(request)).rejects.toThrow(/ATTEMPT_FENCED|SOURCE_CONFLICT/);
    }
    expect(h.abort).not.toHaveBeenCalled();
  });
  it('passes only the exact explicit decision to the existing abort helper after authorization and owner checks', async () => {
    const f = fixture(), service = f.create();
    expect(await service.abortProposed(request)).toEqual({ status: 'aborted', epochId, day, decisionKey: request.decisionKey });
    expect(f.authorizeAbort).toHaveBeenCalledExactlyOnceWith({ ...request, operator: operator.toBase58() });
    expect(Object.isFrozen(f.authorizeAbort.mock.calls[0]![0])).toBe(true);
    expect(h.abort).toHaveBeenCalledExactlyOnceWith(f.db, { epochId, decisionKey: request.decisionKey, reason: request.reason });
    expect(f.authorizeAbort.mock.invocationCallOrder[0]).toBeLessThan(f.execute.mock.invocationCallOrder[0]!);
    expect(f.execute.mock.invocationCallOrder[1]).toBeLessThan(h.abort.mock.invocationCallOrder[0]!);
    const query = new PgDialect().sqlToQuery(f.execute.mock.calls[1]![0]);
    expect(query.sql).toContain('mining_publication_attempts'); expect(query.params).toContain(epochId);
    expect(query.params).toContain(`resource-mining-v2:${day}`); expect(query.params).toContain(`resource-mining-v3:${day}`);
  });
  it('does not report success or retry when the existing atomic publication fence rejects a racing prepare', async () => {
    const f = fixture(), error = Error('MINING_PUBLICATION_FENCED'); h.abort.mockRejectedValueOnce(error);
    await expect(f.create().abortProposed(request)).rejects.toBe(error);
    expect(h.abort).toHaveBeenCalledOnce();
  });
});
