import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { GemsController, type GemsPorts } from './controller';
import { GemsJournalStore, parseGemsJournal } from './journal';
import { identity, intent, overview, proof, envelope } from './fixtures.test-support';
import { gemsCommand, gemsConsent, parseGemsIntent, parseGemsOverview, type GemsIntent } from './contracts';

function fixture(initial = intent()) {
  const saved = parseGemsIntent({ ...initial, consent: gemsConsent(initial, parseGemsOverview(overview())) });
  const factory = new IDBFactory(), store = new GemsJournalStore(identity, factory);
  let current = true, known = false;
  const post = vi.fn<GemsPorts['post']>(async () => { known = true; return { gems: '20' }; });
  const hydrate = vi.fn<GemsPorts['hydrate']>(async () => undefined);
  const ports: GemsPorts = {
    get: vi.fn(async path => path === '/gems' ? overview() : known ? proof(saved) : envelope(saved, null)), post, hydrate,
    validateScope: async () => undefined, key: () => saved.idempotencyKey, lock: async (_name, action) => action(),
    capture: () => () => { if (!current) throw new Error('Account changed'); },
  };
  const controller = new GemsController(store, ports);
  const { idempotencyKey: _key, consent: _consent, ...input } = saved;
  return { factory, store, controller, ports, post, hydrate, input, saved, switchAccount: () => { current = false; }, accept: () => { known = true; } };
}

describe('durable Gems operations', () => {
  it.each([false, true])('original refusal observer respects competing revision=%s and never writes twice', async competing => {
    const f = fixture(); let attemptRevision = -1;
    const refusal = new ApiError(422, 'insufficient', 'INSUFFICIENT_KEEP');
    f.post.mockImplementation(async (_path, _body, _guard, observe) => {
      attemptRevision = (await f.store.read()).revision;
      if (competing) await f.store.compareAndSet(attemptRevision, old => old);
      await observe!(refusal); await observe!(refusal); throw refusal;
    });
    await f.controller.review(f.input); await f.controller.confirm();
    const saved = await f.store.read();
    expect(saved.revision).toBe(attemptRevision + 1);
    expect(saved.refusal).toEqual(competing ? null : { status: 422, code: 'INSUFFICIENT_KEEP' });
    expect(saved.finished).toBe(!competing); expect(saved.receipt).toBeNull(); expect(f.post).toHaveBeenCalledOnce();
  });
  it.each(['gems-from-keep', 'gems-to-shards', 'gems-task-claim'] as const)('%s commits exact intent before POST and GET evidence before success', async kind => {
    const f = fixture(intent(kind));
    f.post.mockImplementation(async () => {
      expect(await new GemsJournalStore(identity, f.factory).read()).toMatchObject({ intent: f.saved, attempted: true, receipt: null });
      f.accept(); return {};
    });
    f.hydrate.mockImplementation(async () => {
      expect(await f.store.read()).toMatchObject({ receipt: proof(f.saved), hydrated: false, finished: false });
    });
    await f.controller.review(f.input); await f.controller.confirm();
    expect(f.post).toHaveBeenCalledTimes(1); expect(f.post.mock.calls[0]?.slice(0, 2)).toEqual(Object.values(gemsCommand(f.saved)));
    expect(await f.store.read()).toMatchObject({ hydrated: true, finished: true });
  });
  it('lost acknowledgement survives restart and auth outage without automatic POST or new key', async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await f.controller.review(f.input); await f.controller.confirm();
    const restarted = new GemsController(new GemsJournalStore(identity, f.factory), f.ports);
    await restarted.open(); expect(await f.store.read()).toMatchObject({ intent: f.saved, attempted: true, finished: false });
    f.ports.get = vi.fn(async () => { throw new Error('401'); }); await restarted.check();
    expect(await f.store.read()).toMatchObject({ receipt: null, finished: false }); expect(f.post).toHaveBeenCalledTimes(1);
  });
  it('explicit retry observes unknown first then resends only original exact consent after funds return', async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new Error('INSUFFICIENT_KEEP'));
    await f.controller.review(f.input); await f.controller.confirm();
    await f.controller.retry();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.post.mock.calls[0]?.slice(0, 2)).toEqual(f.post.mock.calls[1]?.slice(0, 2));
    expect(await f.store.read()).toHaveProperty('finished', true);
  });
  it('retry finding acceptance hydrates without sending and a failed hydration remains recoverable', async () => {
    const f = fixture(); f.hydrate.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await f.controller.review(f.input); await f.controller.confirm();
    expect(await f.store.read()).toMatchObject({ receipt: proof(f.saved), finished: false });
    const restarted = new GemsController(new GemsJournalStore(identity, f.factory), f.ports);
    await restarted.retry(); expect(f.post).toHaveBeenCalledTimes(1); expect(await f.store.read()).toHaveProperty('finished', true);
  });
  it('malformed or mismatched GET evidence never completes despite a positive POST', async () => {
    const f = fixture(); f.ports.get = vi.fn(async path => path === '/gems' ? overview() : { ...proof(f.saved), wallet: 'other' });
    await f.controller.review(f.input); await f.controller.confirm();
    expect(await f.store.read()).toMatchObject({ attempted: true, receipt: null, finished: false }); expect(f.hydrate).not.toHaveBeenCalled();
  });
  it('identity changing during durable write cannot send from the old approval', async () => {
    const f = fixture(), real = f.store.compareAndSet.bind(f.store);
    vi.spyOn(f.store, 'compareAndSet').mockImplementation(async (revision, update) => { const r = await real(revision, update); f.switchAccount(); return r; });
    await f.controller.review(f.input); await f.controller.confirm();
    expect(f.post).not.toHaveBeenCalled(); expect(await f.store.read()).toMatchObject({ intent: f.saved, attempted: false });
  });
  it('storage write failures fail closed before any network mutation', async () => {
    const f = fixture(); vi.spyOn(f.store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    await f.controller.review(f.input); await f.controller.confirm(); expect(f.post).not.toHaveBeenCalled();
    expect(f.controller.snapshot().error).toContain('disk full');
  });
  it('a pending original blocks new reviews and immutable proof cannot be erased or replaced', async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new Error('offline'));
    await f.controller.review(f.input); await f.controller.confirm();
    await f.controller.review({ kind: 'gems-from-keep', keep: '20' }); expect(f.controller.snapshot().error).toContain('original');
    let saved = await f.store.read();
    await expect(f.store.compareAndSet(saved.revision, r => ({ ...r, intent: null, attempted: false }))).rejects.toThrow('cannot be replaced');
    f.accept(); await f.controller.check(); saved = await f.store.read();
    await expect(f.store.compareAndSet(saved.revision, r => ({ ...r, receipt: null, hydrated: false, finished: false }))).rejects.toThrow('receipt changed');
  });
  it('origin wallet and cluster isolate recovery while cross-tab stale revisions fail closed', async () => {
    const f = fixture(); await f.store.compareAndSet(0, r => ({ ...r, intent: f.saved }));
    const other = new GemsJournalStore(identity, f.factory);
    await expect(other.compareAndSet(0, r => ({ ...r, intent: f.saved }))).rejects.toThrow('Another tab');
    for (const who of [{ ...identity, wallet: 'other' }, { ...identity, api: 'https://other.example/api' }, { ...identity, cluster: 'mainnet-beta' as const }])
      expect((await new GemsJournalStore(who, f.factory).read()).intent).toBeNull();
    expect(() => parseGemsJournal({ ...emptyJournal(), identity: { ...identity, wallet: 'other' } }, identity)).toThrow();
  });
  it('first task rejection retains terminal evidence and permits a distinct new request', async () => {
    const f = fixture(intent('gems-task-claim')); f.post.mockRejectedValueOnce(new ApiError(409, 'already settled', 'CLAIM_ALREADY_SETTLED'));
    await f.controller.review(f.input); await f.controller.confirm();
    expect(await f.store.read()).toMatchObject({ intent: f.saved, attempted: true, receipt: null, finished: true,
      refusal: { status: 409, code: 'CLAIM_ALREADY_SETTLED' } });
    f.ports.key = () => 'new-operation-key'; f.post.mockRejectedValueOnce(new Error('network unavailable'));
    await f.controller.review({ kind: 'gems-from-keep', keep: '10' }); await f.controller.confirm();
    expect(await f.store.read()).toMatchObject({ intent: { kind: 'gems-from-keep', idempotencyKey: 'new-operation-key' }, refusal: null,
      refusals: [{ intent: f.saved, refusal: { status: 409, code: 'CLAIM_ALREADY_SETTLED' } }] });
  });
  it('first insufficient funds is terminal but mismatched code kind or amount-reuse evidence remains unresolved', async () => {
    for (const error of [new ApiError(422, 'funds', 'INSUFFICIENT_KEEP'), new ApiError(422, 'other kind', 'INSUFFICIENT_GEMS'), new ApiError(409, 'mismatch', 'IDEMPOTENCY_BODY_MISMATCH')]) {
      const f = fixture(); f.post.mockRejectedValueOnce(error); await f.controller.review(f.input); await f.controller.confirm();
      expect((await f.store.read()).finished).toBe(error.code === 'INSUFFICIENT_KEEP');
    }
  });
  it('a definitive-looking retry rejection cannot erase an ambiguous original submission', async () => {
    const f = fixture(intent('gems-task-claim')); f.post.mockRejectedValueOnce(new Error('lost response'));
    await f.controller.review(f.input); await f.controller.confirm();
    f.post.mockRejectedValueOnce(new ApiError(409, 'already settled', 'CLAIM_ALREADY_SETTLED')); await f.controller.retry();
    expect(await f.store.read()).toMatchObject({ attempted: true, receipt: null, refusal: null, finished: false });
  });
  it('selling the target before its first conversion POST releases the journal with refusal evidence', async () => {
    const f = fixture(intent('gems-to-shards'));
    f.post.mockRejectedValueOnce(new ApiError(404, 'base no longer owned', 'BASE_NOT_OWNED'));
    await f.controller.review(f.input); await f.controller.confirm();
    expect(await f.store.read()).toMatchObject({ intent: f.saved, attempted: true, receipt: null, finished: true,
      refusal: { status: 404, code: 'BASE_NOT_OWNED' } });
    f.ports.key = () => 'after-base-sale'; f.post.mockRejectedValueOnce(new Error('offline'));
    await f.controller.review({ kind: 'gems-from-keep', keep: '10' }); await f.controller.confirm();
    expect(await f.store.read()).toMatchObject({ intent: { kind: 'gems-from-keep', idempotencyKey: 'after-base-sale' },
      refusals: [{ intent: f.saved, refusal: { status: 404, code: 'BASE_NOT_OWNED' } }] });
  });
  it('ownership refusal on retry cannot disprove a conversion accepted before the base was sold', async () => {
    const f = fixture(intent('gems-to-shards')); f.post.mockRejectedValueOnce(new Error('lost response'));
    await f.controller.review(f.input); await f.controller.confirm();
    f.post.mockRejectedValueOnce(new ApiError(404, 'base no longer owned', 'BASE_NOT_OWNED'));
    await f.controller.retry();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(await f.store.read()).toMatchObject({ intent: f.saved, attempted: true, receipt: null, refusal: null, finished: false });
  });
  it('receipt GET failure after successful POST never becomes a first-POST refusal', async () => {
    const f = fixture(); f.ports.get = vi.fn(async path => { if (path === '/gems') return overview(); throw new ApiError(422, 'funds', 'INSUFFICIENT_KEEP'); });
    await f.controller.review(f.input); await f.controller.confirm();
    expect(await f.store.read()).toMatchObject({ attempted: true, receipt: null, refusal: null, finished: false });
  });
  it('disabled and malformed capabilities never allow a new mutation', async () => {
    const f = fixture(); f.ports.get = vi.fn(async () => ({ features: {} }));
    await f.controller.review(f.input); await f.controller.confirm(); expect(f.post).not.toHaveBeenCalled();
    expect(f.controller.snapshot().enabled).toBe(false); expect((await f.store.read()).intent).toBeNull();
  });
  it.each(['gems-from-keep', 'gems-to-shards', 'gems-task-claim'] as const)('%s refuses a changed reviewed output before its first POST', async kind => {
    const f = fixture(intent(kind)); await f.controller.review(f.input);
    const reviewed = f.controller.snapshot().review!;
    expect(reviewed.consent).toEqual({ rate: kind === 'gems-task-claim' ? null : 2, output: kind === 'gems-task-claim' ? '10' : '20' });
    expect(Object.isFrozen(reviewed)).toBe(true); expect(Object.isFrozen(reviewed.consent)).toBe(true);
    f.ports.get = vi.fn(async () => ({ ...overview(), gemsPerKeep: 3, shardsPerGem: 3, tasks: [{ id: 'first-task', gems: 11, claimed: false }] }));
    await f.controller.confirm();
    expect(f.post).not.toHaveBeenCalled(); expect((await f.store.read()).intent).toBeNull();
    expect(f.controller.snapshot().error).toContain('changed');
  });
  it.each(['gems-from-keep', 'gems-to-shards', 'gems-task-claim'] as const)('%s preserves original consent through restart and will not resend at a changed rate or reward', async kind => {
    const f = fixture(intent(kind)); f.post.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await f.controller.review(f.input); await f.controller.confirm(); const saved = await f.store.read();
    const restarted = new GemsController(new GemsJournalStore(identity, f.factory), f.ports);
    f.ports.get = vi.fn(async path => path === '/gems'
      ? { ...overview(), gemsPerKeep: 3, shardsPerGem: 3, tasks: [{ id: 'first-task', gems: 11, claimed: false }] }
      : envelope(f.saved, null));
    await restarted.retry();
    expect(f.post).toHaveBeenCalledTimes(1); expect(await f.store.read()).toEqual(saved);
    expect(restarted.snapshot().error).toContain('changed');
    f.ports.get = vi.fn(async path => { if (path === '/gems') throw new Error('paused'); return proof(f.saved); });
    await restarted.check();
    expect((await f.store.read()).finished).toBe(true); expect(f.post).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('legacy saved consent missing with attempted=%s remains receipt-only', async attempted => {
    const f = fixture(), legacy = intent(); await f.store.compareAndSet(0, r => ({ ...r, intent: legacy, attempted }));
    f.ports.get = vi.fn(async path => path === '/gems' ? overview() : envelope(legacy, null));
    await f.controller.retry(); expect(f.post).not.toHaveBeenCalled();
    expect(f.controller.snapshot().error).toContain('no reviewed output');
    expect((await f.store.read()).intent?.consent).toBeUndefined();
    f.ports.get = vi.fn(async path => path === '/gems' ? overview() : proof(legacy));
    await f.controller.check(); expect((await f.store.read()).finished).toBe(true);
    expect(f.post).not.toHaveBeenCalled();
  });
  it('an unfinished intent cannot gain, lose or change its reviewed output through storage', async () => {
    const f = fixture(); f.post.mockRejectedValueOnce(new Error('offline'));
    await f.controller.review(f.input); await f.controller.confirm(); const saved = await f.store.read();
    const { consent: _consent, ...legacy } = saved.intent!;
    for (const changed of [legacy, { ...saved.intent!, consent: { rate: 3, output: '30' } }] as GemsIntent[]) {
      await expect(f.store.compareAndSet(saved.revision, r => ({ ...r, intent: changed }))).rejects.toThrow('cannot be replaced');
    }
    const old = fixture(); await old.store.compareAndSet(0, r => ({ ...r, intent: intent(), attempted: true }));
    await expect(old.store.compareAndSet(1, r => ({ ...r, intent: old.saved }))).rejects.toThrow('cannot be replaced');
  });
  it('older servers can expose Gems and recover proof without admitting an unguarded new request', async () => {
    const f = fixture(); f.ports.get = vi.fn(async () => ({ ...overview(), features: { gems: { version: 1, receipts: 1 } } }));
    await f.controller.review(f.input); await f.controller.confirm();
    expect(f.post).not.toHaveBeenCalled(); expect((await f.store.read()).intent).toBeNull();
    expect(f.controller.snapshot().enabled).toBe(false);
  });
  it.each(['gems-from-keep', 'gems-to-shards', 'gems-task-claim'] as const)('%s treats an atomic terms refusal as definitive only on the first POST', async kind => {
    for (const retry of [false, true]) {
      const f = fixture(intent(kind));
      f.post.mockRejectedValueOnce(retry ? new Error('response lost') : new ApiError(409, 'terms changed', 'GEMS_TERMS_CHANGED'));
      await f.controller.review(f.input); await f.controller.confirm();
      if (retry) { f.post.mockRejectedValueOnce(new ApiError(409, 'terms changed', 'GEMS_TERMS_CHANGED')); await f.controller.retry(); }
      expect((await f.store.read()).finished).toBe(!retry);
      expect((await f.store.read()).refusal?.code ?? null).toBe(retry ? null : 'GEMS_TERMS_CHANGED');
    }
  });
});
function emptyJournal() { return { version: 1, identity, revision: 0, intent: null, attempted: false, receipt: null, hydrated: false, finished: false }; }
