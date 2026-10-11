import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferralController, type ReferralPorts } from './controller';
import { ReferralJournalStore } from './journal';
import { deferred, identity, relationship, response, status } from './fixtures.test-support';

let factory: IDBFactory; let store: ReferralJournalStore; let controller: ReferralController; let ports: ReferralPorts;
let current: boolean; let epoch: number; let locked: boolean;
beforeEach(() => {
  factory = new IDBFactory(); store = new ReferralJournalStore(identity, factory); current = true; epoch = 0; locked = false;
  ports = {
    get: vi.fn(async () => status()), post: vi.fn(async () => response()),
    lock: async (_name, action) => { if (locked) throw new Error('another tab'); locked = true; try { return await action(); } finally { locked = false; } },
    capture: (newAction) => { const original = epoch; return () => { if (!current || (newAction && original !== epoch)) throw new Error('account or page changed'); }; },
    unsupported: (e) => e instanceof Error && e.message === 'unsupported', firstRefusal: (e) => e instanceof Error && e.message === 'atomic refusal',
  };
  controller = new ReferralController(store, ports);
});
const submit = async () => { await controller.review(' \uFEFFkeep-abcde\u00a0 '); await controller.confirm(); };
describe('explicit referral intent and exact recovery', () => {
  it('foreground, reload, review and Back never submit; confirm persists before its one POST', async () => {
    await controller.open(); await controller.open(); await controller.review('KEEP-ABCDE'); controller.dismiss(); await controller.confirm();
    expect(ports.post).not.toHaveBeenCalled();
    ports.post = vi.fn(async () => { expect((await new ReferralJournalStore(identity, factory).read()).code).toBe('KEEP-ABCDE'); return response(); });
    await submit(); expect(ports.post).toHaveBeenCalledExactlyOnceWith('/referrals/v1/use', { code: 'KEEP-ABCDE' });
    expect((await store.read()).outcome).toBe('applied');
  });
  it('holds uncertainty through null/404 status and restart, and retries only the identical normalized code explicitly', async () => {
    ports.post = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(response()); await submit();
    controller = new ReferralController(new ReferralJournalStore(identity, factory), ports);
    await controller.open(); await controller.review('KEEP-CQRPF'); expect(ports.post).toHaveBeenCalledTimes(1);
    ports.get = vi.fn().mockRejectedValueOnce(new Error('unsupported')).mockResolvedValue(status());
    await controller.retry(); expect(ports.post).toHaveBeenCalledTimes(1); expect((await store.read()).code).toBe('KEEP-ABCDE');
    await controller.retry(); expect(ports.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.post).mock.calls[0]).toEqual(vi.mocked(ports.post).mock.calls[1]);
  });
  it('only a proved first refusal permits correction; a later refusal cannot disprove an earlier attempt', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('atomic refusal')); await submit();
    expect((await store.read()).code).toBeNull(); expect((await store.read()).activated).toBe(true);
    await controller.review('KEEP-CQRPF'); expect(controller.snapshot().review).toBe('KEEP-CQRPF'); controller.dismiss();
    ports.post = vi.fn().mockRejectedValueOnce(new Error('lost')).mockRejectedValue(new Error('atomic refusal')); await submit();
    await controller.retry(); expect((await store.read()).code).toBe('KEEP-ABCDE');
    controller = new ReferralController(new ReferralJournalStore(identity, factory), ports); await controller.retry();
    expect((await store.read()).code).toBe('KEEP-ABCDE');
  });
  it('rescues positive status as observed attribution without claiming code-specific success', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost')); await submit(); ports.get = vi.fn(async () => status(true));
    await controller.retry(); expect(ports.post).toHaveBeenCalledTimes(1); expect((await store.read()).outcome).toBe('observed');
    await controller.finish(); const saved = await store.read(); expect(saved.code).toBeNull(); expect(saved.relationship).toEqual(relationship);
    ports.get = vi.fn(async () => status()); await controller.open(); await controller.review('KEEP-CQRPF');
    expect(controller.snapshot().error).toContain('relationship changed'); expect((await store.read()).relationship).toEqual(relationship);
  });
  it.each(['already_applied', 'already_bound'] as const)('preserves authoritative %s without reporting a new attribution', async (outcome) => {
    ports.post = vi.fn(async () => response(outcome)); await submit(); expect((await store.read()).outcome).toBe(outcome);
  });
  it('an existing or competing positive relationship prevents a fresh POST', async () => {
    ports.get = vi.fn(async () => status(true)); await submit(); expect(ports.post).not.toHaveBeenCalled();
    expect(controller.snapshot().journal?.outcome).toBe('observed');
  });
  it('404 capability and invalid/cross-wallet wire responses never authorize a POST', async () => {
    for (const get of [vi.fn().mockRejectedValue(new Error('unsupported')), vi.fn(async () => ({ ...status(), version: 2 })), vi.fn(async () => ({ ...status(), wallet: '3'.repeat(32) }))]) {
      ports.get = get; await submit(); expect(ports.post).not.toHaveBeenCalled();
    }
  });
  it('a mismatched code or wallet response keeps the original unresolved code', async () => {
    ports.post = vi.fn(async () => response('applied', 'KEEP-CQRPF')); await submit();
    expect((await store.read()).code).toBe('KEEP-ABCDE'); expect((await store.read()).relationship).toBeNull();
    ports.post = vi.fn(async () => ({ ...response(), wallet: '3'.repeat(32) })); await controller.retry();
    expect((await store.read()).relationship).toBeNull();
  });
  it('critical journal read/write failure prevents submission; receipt persistence failure permits GET rescue', async () => {
    vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('unreadable')); await controller.review('KEEP-ABCDE'); expect(ports.post).not.toHaveBeenCalled();
    vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); await submit(); expect(ports.post).not.toHaveBeenCalled();
    ports.post = vi.fn(async () => { vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('receipt disk full')); return response(); });
    await submit(); expect((await store.read()).code).toBe('KEEP-ABCDE'); expect((await store.read()).relationship).toBeNull();
    ports.get = vi.fn(async () => status(true)); await controller.open(); expect((await store.read()).relationship).toEqual(relationship);
  });
  it.each(['success', 'refusal'] as const)('late %s from an obsolete session cannot clear or settle its saved code', async (result) => {
    const pending = deferred<unknown>(); ports.post = vi.fn(() => pending.promise); const action = submit();
    await vi.waitFor(() => expect(ports.post).toHaveBeenCalledOnce()); current = false;
    if (result === 'success') pending.resolve(response()); else pending.reject(new Error('atomic refusal'));
    await action; expect((await store.read()).code).toBe('KEEP-ABCDE'); expect((await store.read()).relationship).toBeNull();
  });
  it('cross-tab CAS fences a late response even if another tab merely refreshed the record revision', async () => {
    const pending = deferred<unknown>(); ports.post = vi.fn(() => pending.promise); const action = submit();
    await vi.waitFor(() => expect(ports.post).toHaveBeenCalledOnce()); const saved = await store.read();
    await store.compareAndSet(saved.revision, (r) => ({ ...r })); pending.resolve(response()); await action;
    expect((await store.read()).relationship).toBeNull(); expect(controller.snapshot().error).toContain('another tab');
  });
  it('duplicate clicks and competing controllers do not queue another submission', async () => {
    const pending = deferred<unknown>(); ports.post = vi.fn(() => pending.promise); const action = submit();
    await vi.waitFor(() => expect(ports.post).toHaveBeenCalledOnce()); await controller.confirm();
    const other = new ReferralController(new ReferralJournalStore(identity, factory), ports); await other.retry();
    expect(other.snapshot().error).toContain('another tab'); expect(ports.post).toHaveBeenCalledOnce(); pending.resolve(response()); await action;
  });
  it.each(['dismiss', 'hidden', 'identity'] as const)('leaving during a deferred confirmation status read (%s) prevents POST', async (change) => {
    await controller.review('KEEP-ABCDE'); const pending = deferred<unknown>(); ports.get = vi.fn(() => pending.promise);
    const action = controller.confirm(); await vi.waitFor(() => expect(ports.get).toHaveBeenCalledOnce());
    if (change === 'dismiss') controller.dismiss(); else if (change === 'hidden') epoch += 1; else current = false;
    pending.resolve(status()); await action; expect(ports.post).not.toHaveBeenCalled(); expect((await store.read()).code).toBeNull();
  });
  it('Finish requires positive proof and never forgets an unresolved code', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost')); await submit(); await controller.finish(); expect((await store.read()).code).toBe('KEEP-ABCDE');
  });
});
