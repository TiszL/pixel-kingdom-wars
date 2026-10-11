import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MiningClaimController, type MiningClaimPorts } from './controller';
import { MiningClaimJournalStore } from './journal';
import { miningClaimFixture } from './fixtures.test-support';

let f: ReturnType<typeof miningClaimFixture>, factory: IDBFactory, store: MiningClaimJournalStore;
let c: MiningClaimController, ports: MiningClaimPorts, prepared: boolean, submitted: boolean, paid: boolean, session: number, elapsed: number;
beforeEach(() => {
  f = miningClaimFixture(); factory = new IDBFactory(); store = new MiningClaimJournalStore(f.identity, factory);
  prepared = false; submitted = false; paid = false; session = 0; elapsed = 0;
  ports = {
    capture: () => { const original = session; return () => { if (session !== original) throw Error('Changed account'); }; },
    lock: async (_name, work) => work(), key: () => f.preparation.idempotencyKey, clock: () => elapsed,
    getStatus: vi.fn(async guard => { guard(); return f.status(); }),
    prepare: vi.fn(async (request, guard, retain) => {
      guard(); const saved = await store.read(); expect(saved.operation?.request).toEqual(request); expect(saved.operation?.prepareAttempted).toBe(true);
      prepared = true; await retain(f.preparation); guard(); return f.preparation;
    }),
    getPreparation: vi.fn(async (_request, guard, retain) => {
      guard(); const result = { wallet: f.identity.wallet, idempotencyKey: f.preparation.idempotencyKey,
        status: prepared ? 'prepared' : 'unknown', receipt: prepared ? f.preparation : null, serverNow: f.preparation.serverNow };
      await retain(result); guard(); return result;
    }),
    getClaim: vi.fn(async (_id, guard, retain) => { guard(); const result = f.claim(paid ? 'settled' : submitted ? 'retained' : 'prepared'); await retain(result); guard(); return result; }),
    live: vi.fn(async (_p, guard) => { guard(); }),
    sign: vi.fn(async (_p, guard) => { guard(); expect((await store.read()).operation?.signingStarted).toBe(true); return f.signed(); }),
    submit: vi.fn(async (body, guard) => { guard(); const saved = await store.read(); expect(saved.operation?.submitAttempted).toBe(true);
      expect(body).toEqual({ claimId: f.preparation.claimId, signedTransaction: saved.operation?.signed?.wire }); submitted = true;
      return { claimId: f.preparation.claimId, signature: f.signed().signature, delivery: 'submitted', serverNow: f.preparation.serverNow }; }),
  };
  c = new MiningClaimController(store, ports);
});
describe('web mining original claim controller', () => {
  it('recovers failed signed evidence after restart and archives by a fresh exact GET before explicit new preparation', async () => {
    await c.begin(); await c.review(); await c.sign();
    ports.getClaim = vi.fn(async (_id, guard, retain) => { const result = f.claim('failed'); await retain(result); guard(); return result; });
    c = new MiningClaimController(new MiningClaimJournalStore(f.identity, factory), ports); await c.open();
    await c.review(); await c.sign(); await c.submit(); expect(ports.sign).toHaveBeenCalledOnce(); expect(ports.submit).not.toHaveBeenCalled();
    const reads = vi.mocked(ports.getClaim).mock.calls.length; await c.archiveFailed(); expect(c.snapshot().error).toBeNull();
    expect(ports.getClaim).toHaveBeenCalledTimes(reads + 1); expect((await store.read()).archives[0]).toMatchObject({signed:f.signed(),claim:{state:'failed',settledBaseUnits:null}});
    await c.open(); expect(ports.prepare).toHaveBeenCalledOnce(); expect(ports.submit).not.toHaveBeenCalled();
    f.preparation.idempotencyKey=crypto.randomUUID();f.preparation.claimId=crypto.randomUUID();f.preparation.quoteId=f.preparation.claimId;
    const statusReads=vi.mocked(ports.getStatus).mock.calls.length;await c.begin();expect(c.snapshot().error).toBeNull();
    expect(ports.getStatus).toHaveBeenCalledTimes(statusReads+1);expect(ports.prepare).toHaveBeenCalledTimes(2);expect(ports.sign).toHaveBeenCalledOnce();
  });
  it('failed archival refuses changed proof and cannot retire ambiguous expired evidence', async () => {
    await c.begin(); await c.review(); await c.sign(); elapsed=Number.MAX_SAFE_INTEGER; await c.archiveFailed();expect((await store.read()).archives).toHaveLength(0);
    let result=f.claim('failed');ports.getClaim=vi.fn(async(_id,guard,retain)=>{await retain(result);guard();return result;});await c.open();
    const original=await store.read();result={...result,transactions:result.transactions.map(t=>({...t,settledAt:'2035-01-01T00:00:01.000Z'}))};
    await c.archiveFailed();expect(c.snapshot().error).not.toBeNull();expect(await store.read()).toEqual(original);expect(ports.submit).not.toHaveBeenCalled();
  });
  it('reused blockhash refusal requires fresh absent GET and another explicit attempt, never a retry', async () => {
    ports.prepare=vi.fn(async(_request,_guard,_retain,refusal)=>{await refusal({status:409,code:'CLAIM_BLOCKHASH_REUSED'});throw Error('Wait for a newly observed blockhash');});
    await c.begin();await c.open();expect(ports.prepare).toHaveBeenCalledOnce();expect((await store.read()).operation!.prepareRefusal!.code).toBe('CLAIM_BLOCKHASH_REUSED');
    await c.archiveRefusal();expect((await store.read()).operation).toBeNull();expect((await store.read()).archives[0]!.refusalConfirmedAbsent).toBe(true);
    expect(ports.prepare).toHaveBeenCalledOnce();expect(ports.sign).not.toHaveBeenCalled();expect(ports.submit).not.toHaveBeenCalled();
  });
  it('fresh GET can finish a paid split claim after its previously pending setup is verified failed', async () => {
    const tx=f.preparation.transactions[0]!;f.preparation.transactions=[{...tx,kind:'setup'},{...tx,ordinal:1,kind:'claim',rentLamports:'0'}];
    f.preparation.fees.feeLamports='10000';f.preparation.fees.totalLamports='20000';await c.begin();
    const paid=f.claim('settled'),claim={...paid.transactions[0]!,ordinal:1,kind:'claim' as const};
    const setup={ordinal:0,kind:'setup' as const,signature:'1'.repeat(63)+'2',landing:'pending' as const,settledBaseUnits:null,acceptedAt:f.preparation.serverNow,settledAt:null};
    let result:ReturnType<typeof f.claim>={...paid,transactions:[setup,claim]};ports.getClaim=vi.fn(async(_id,guard,retain)=>{await retain(result);guard();return result;});await c.open();
    result={...paid,transactions:[{...setup,landing:'failed',settledAt:f.preparation.serverNow},claim]};
    const reads=vi.mocked(ports.getClaim).mock.calls.length;await c.finish();expect(c.snapshot().error).toBeNull();expect(ports.getClaim).toHaveBeenCalledTimes(reads+1);
    expect((await store.read()).archives[0]!.claim).toEqual(result);expect(ports.sign).not.toHaveBeenCalled();expect(ports.submit).not.toHaveBeenCalled();
  });
  it('saves each intent before its one POST, requires reviewed SOL and archives only verified payment', async () => {
    await c.begin(); expect(c.snapshot().error).toBeNull(); expect(ports.prepare).toHaveBeenCalledOnce();
    await c.sign(); expect(ports.sign).not.toHaveBeenCalled();
    await c.review(); await c.sign(); expect(c.snapshot().error).toBeNull(); expect((await store.read()).operation?.signed).toEqual(f.signed());
    await c.submit(); await c.submit(); expect(ports.submit).toHaveBeenCalledOnce();
    await c.finish(); expect((await store.read()).operation).not.toBeNull();
    paid = true; await c.open(); await c.finish(); expect(c.snapshot().error).toBeNull();
    const journal = await store.read(); expect(journal.operation).toBeNull(); expect(journal.archives).toHaveLength(1);
    expect(journal.archives[0]?.claim?.state).toBe('settled');
  });
  it('recovers a lost preparation response through GET after restart without repeating POST', async () => {
    ports.prepare = vi.fn(async () => { prepared = true; throw Error('lost preparation reply'); });
    await c.begin(); c = new MiningClaimController(new MiningClaimJournalStore(f.identity, factory), ports);
    await c.open(); await c.begin(); expect((await store.read()).operation?.preparation?.claimId).toBe(f.preparation.claimId);
    expect(ports.prepare).toHaveBeenCalledOnce(); expect(ports.sign).not.toHaveBeenCalled();
  });
  it('retains a complete late preparation before rejecting its obsolete view', async () => {
    ports.prepare = vi.fn(async (_r, guard, retain) => { session++; await retain(f.preparation); guard(); return f.preparation; });
    await c.begin(); expect((await store.read()).operation?.preparation?.claimId).toBe(f.preparation.claimId);
    expect(ports.sign).not.toHaveBeenCalled();
  });
  it('saves a late valid wallet signature into the original journal without submitting from the new session', async () => {
    await c.begin(); await c.review(); ports.sign = vi.fn(async () => { session++; return f.signed(); });
    await c.sign(); expect((await store.read()).operation?.signed).toEqual(f.signed());
    expect(ports.submit).not.toHaveBeenCalled();
  });
  it('never resubmits a signed claim after a lost reply, even across a restart', async () => {
    await c.begin(); await c.review(); await c.sign();
    ports.submit = vi.fn(async () => { submitted = true; throw Error('lost send reply'); });
    await c.submit(); c = new MiningClaimController(new MiningClaimJournalStore(f.identity, factory), ports);
    await c.open(); await c.submit(); expect(ports.submit).toHaveBeenCalledOnce();
    expect((await store.read()).operation?.signed).toEqual(f.signed());
    paid = true; await c.open(); expect((await store.read()).operation?.claim?.state).toBe('settled');
  });
  it('refuses an expired SOL review or a changed root before wallet approval', async () => {
    await c.begin(); await c.review(); elapsed = Date.parse(f.preparation.expiresAt) - Date.parse(f.preparation.serverNow) + 1; await c.sign(); expect(ports.sign).not.toHaveBeenCalled();
    ports.getStatus = vi.fn(async () => ({ ...f.status(), rootSequence: '2' })); await c.review(); await c.sign();
    expect(ports.sign).not.toHaveBeenCalled();
  });
  it('cannot call a wallet or submit after durable storage rejects its attempt marker', async () => {
    await c.begin(); await c.review(); const cas = vi.spyOn(store, 'compareAndSet').mockRejectedValue(Error('storage unavailable'));
    await c.sign(); expect(ports.sign).not.toHaveBeenCalled(); cas.mockRestore();
    await c.review(); await c.sign(); vi.spyOn(store, 'compareAndSet').mockRejectedValue(Error('storage unavailable'));
    await c.submit(); expect(ports.submit).not.toHaveBeenCalled();
  });
  it('refuses mismatched server responses without overwriting the original request', async () => {
    ports.prepare = vi.fn(async (_r, _g, retain) => { const wrong = { ...f.preparation, idempotencyKey: crypto.randomUUID() }; await retain(wrong); return wrong; });
    await c.begin(); expect((await store.read()).operation?.preparation).toBeNull(); expect(c.snapshot().error).not.toBeNull();
    await c.begin(); expect(ports.prepare).toHaveBeenCalledOnce();
  });
  it('archives a definitive original prepare refusal only after GET confirms no preparation', async () => {
    ports.prepare = vi.fn(async (_request, _guard, _retain, refusal) => { await refusal({ status: 422, code: 'INSUFFICIENT_SOL' }); throw Error('Insufficient SOL'); });
    await c.begin(); expect((await store.read()).operation?.prepareRefusal?.code).toBe('INSUFFICIENT_SOL');
    await c.archiveRefusal(); const j = await store.read(); expect(j.operation).toBeNull();
    expect(j.archives[0]?.refusalConfirmedAbsent).toBe(true); expect(ports.prepare).toHaveBeenCalledOnce();
  });
});
