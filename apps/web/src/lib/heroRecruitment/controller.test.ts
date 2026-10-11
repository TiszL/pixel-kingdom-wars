import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HeroRecruitmentController, type HeroRecruitmentPorts } from './controller';
import { HeroRecruitmentJournalStore, makeHeroRecruitmentIntent } from './journal';
import { baseA, baseB, deferred, hydration, identity, input, intent, key, legacyAck, receipt, status, target } from './fixtures.test-support';
let factory: IDBFactory, store: HeroRecruitmentJournalStore, controller: HeroRecruitmentController, ports: HeroRecruitmentPorts;
let current: boolean, epoch: number, locked: boolean;
beforeEach(() => {
  factory = new IDBFactory(); store = new HeroRecruitmentJournalStore(identity, factory); current = true; epoch = 0; locked = false;
  ports = { get: vi.fn(async () => status()), post: vi.fn(async () => receipt()), key: () => key,
    lock: async (_name, run) => { if (locked) throw new Error('another tab'); locked = true; try { return await run(); } finally { locked = false; } },
    capture: newAction => { const old = epoch; return () => { if (!current || newAction && epoch !== old) throw new Error('account or page changed'); }; },
    unsupported: e => e instanceof Error && e.message === 'unsupported',
    consent: vi.fn(async (i, k, mechanism) => makeHeroRecruitmentIntent(mechanism, { ...intent().request, ...i, idempotencyKey: k })), validate: vi.fn(async () => undefined),
    confirmed: vi.fn(), hydrate: vi.fn(async () => hydration), refreshUnknownLegacy: vi.fn(async () => undefined) };
  controller = new HeroRecruitmentController(store, ports);
});
const submit = async () => { await controller.review(input); await controller.confirm(); };
describe('Hero command mechanism and exact original consent', () => {
  it('open review Back and foreground stay GET-only; exact intent commits before POST', async () => {
    await controller.open(); await controller.review(input); controller.dismiss(); await controller.confirm(); expect(ports.post).not.toHaveBeenCalled();
    ports.post = vi.fn(async () => { expect((await new HeroRecruitmentJournalStore(identity, factory).read()).intent).toEqual(intent()); return receipt(); });
    await submit(); expect(ports.post).toHaveBeenCalledExactlyOnceWith('/heroes/recruit/v1', intent().request, expect.any(Function));
    expect((await store.read()).receipt).toEqual(receipt()); expect(ports.confirmed).toHaveBeenCalledOnce();
  });
  it('process death after durable consent never auto-submits; explicit retry uses original exact body', async () => {
    await store.compareAndSet(0, r => ({ ...r, intent: intent() })); controller = new HeroRecruitmentController(new HeroRecruitmentJournalStore(identity, factory), ports);
    await controller.open(); expect(ports.post).not.toHaveBeenCalled(); await controller.retry();
    expect(ports.post).toHaveBeenCalledExactlyOnceWith('/heroes/recruit/v1', intent().request, expect.any(Function)); expect(ports.validate).toHaveBeenCalledWith(intent(), expect.any(Function), true);
  });
  it.each(['disabled', 'unsupported'])('fresh %s preserves legacy but permanently binds an unknown request to it', async mode => {
    ports.get = mode === 'disabled' ? vi.fn(async () => status(null, false)) : vi.fn().mockRejectedValue(new Error('unsupported'));
    ports.post = vi.fn().mockRejectedValue(new Error('lost reply')); await submit();
    expect(ports.post).toHaveBeenCalledExactlyOnceWith('/base/buildings', intent('legacy').legacyBody, expect.any(Function));
    ports.get = vi.fn(async () => status(receipt())); controller = new HeroRecruitmentController(new HeroRecruitmentJournalStore(identity, factory), ports);
    await controller.open(); await controller.retry(); await controller.finish(); await submit();
    expect(ports.post).toHaveBeenCalledOnce(); expect(ports.get).not.toHaveBeenCalled(); expect(ports.refreshUnknownLegacy).toHaveBeenCalledOnce();
    expect((await store.read()).intent).toEqual(intent('legacy')); expect((await store.read()).finished).toBe(false);
  });
  it('legacy positive ACK proves only original actor/building and persists before cue', async () => {
    ports.get = vi.fn(async () => status(null, false)); ports.post = vi.fn(async () => legacyAck());
    ports.confirmed = vi.fn(() => expect(controller.snapshot().journal?.legacyAcceptance).toEqual({ actor: identity.wallet, building: receipt().building }));
    await submit(); await controller.finish(); expect((await store.read()).receipt).toBeNull(); expect((await store.read()).finished).toBe(true);
    await controller.open(); expect(ports.post).toHaveBeenCalledOnce(); expect(ports.confirmed).toHaveBeenCalledOnce();
  });
  it.each(['actor', 'base', 'tile'])('rejects mismatched legacy %s without cue or fabricated receipt', async changed => {
    ports.get = vi.fn(async () => status(null, false)); const ack = legacyAck();
    if (changed === 'actor') ack.building.playerWallet = target; else if (changed === 'base') ack.building.baseId = baseB; else ack.building.tx++;
    ports.post = vi.fn(async () => ack); await submit(); expect((await store.read()).legacyAcceptance).toBeNull(); expect(ports.confirmed).not.toHaveBeenCalled();
  });
  it('v1 unknown never downgrades after404/disabled; historical receipt survives the kill switch', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost')); await submit();
    ports.get = vi.fn().mockRejectedValue(new Error('unsupported')); await controller.retry();
    ports.get = vi.fn(async () => status(null, false)); await controller.retry(); await submit(); expect(ports.post).toHaveBeenCalledOnce();
    ports.get = vi.fn(async () => status(receipt(), false)); await controller.open(); await controller.finish(); expect((await store.read()).finished).toBe(true); expect(ports.confirmed).not.toHaveBeenCalled();
  });
  it.each(['network', 'malformed', 'wallet'])('%s status cannot authorize legacy fallback', async failure => {
    ports.get = failure === 'network' ? vi.fn().mockRejectedValue(new Error('network')) : vi.fn(async () => failure === 'wallet' ? { ...status(), wallet: target } : { ...status(), version: 2 });
    await submit(); expect(ports.post).not.toHaveBeenCalled(); expect((await store.read()).intent).toBeNull();
  });
  it('support changes after review invalidate consent before durable submit', async () => {
    await controller.review(input); ports.get = vi.fn(async () => status(null, false)); await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect((await store.read()).intent).toBeNull();
  });
  it('receipt hydration failure retains acceptance; original destination unavailable permits Finish without repost', async () => {
    ports.hydrate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ base: 'unavailable', items: 'unavailable', roster: 'unavailable' });
    await submit(); await controller.finish(); expect((await store.read()).finished).toBe(false);
    ports.get = vi.fn(async () => status(receipt())); await controller.open(); await controller.finish(); expect((await store.read()).finished).toBe(true); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('receipt actor/request/funding mismatch and changed immutable receipt stay unresolved', async () => {
    ports.post = vi.fn(async () => ({ ...receipt(), actor: target })); await submit(); expect((await store.read()).receipt).toBeNull();
    ports.get = vi.fn(async () => status(receipt(baseB))); await controller.open(); expect((await store.read()).receipt).toBeNull();
    ports.get = vi.fn(async () => status({ ...receipt(), funding: { kind: 'keep', amount: '1', ledgerTransactionId: baseB } })); await controller.open(); expect((await store.read()).receipt).toBeNull();
    ports.get = vi.fn(async () => status(receipt())); await controller.open();
    ports.get = vi.fn(async () => status({ ...receipt(), createdAt: '2026-09-14T00:00:00.000Z' })); await controller.open(); expect((await store.read()).receipt).toEqual(receipt());
  });
  it('failed strict intent write blocks POST; failed receipt write blocks cue and GET can rescue', async () => {
    vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); await submit(); expect(ports.post).not.toHaveBeenCalled();
    ports.post = vi.fn(async () => { vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); return receipt(); }); await submit();
    expect((await store.read()).receipt).toBeNull(); expect(ports.confirmed).not.toHaveBeenCalled();
    ports.get = vi.fn(async () => status(receipt())); await controller.open(); expect((await store.read()).receipt).toEqual(receipt()); expect(ports.confirmed).not.toHaveBeenCalled();
  });
  it.each(['Back', 'hidden', 'account'])('%s during final preflight prevents obsolete POST', async change => {
    await controller.review(input); const pending = deferred<unknown>(); ports.get = vi.fn(() => pending.promise); const action = controller.confirm();
    await vi.waitFor(() => expect(ports.get).toHaveBeenCalledOnce()); if (change === 'Back') controller.dismiss(); else if (change === 'hidden') epoch++; else current = false;
    pending.resolve(status()); await action; expect(ports.post).not.toHaveBeenCalled();
  });
  it('duplicate click, another tab and a late old-account response cannot apply or play success', async () => {
    const pending = deferred<unknown>(); ports.post = vi.fn(() => pending.promise); const action = submit(); await vi.waitFor(() => expect(ports.post).toHaveBeenCalledOnce());
    await controller.confirm(); const other = new HeroRecruitmentController(new HeroRecruitmentJournalStore(identity, factory), ports); await other.retry(); expect(other.snapshot().error).toContain('another tab');
    current = false; pending.resolve(receipt()); await action; expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).receipt).toBeNull(); expect(ports.confirmed).not.toHaveBeenCalled();
  });
  it('a CAS loser cannot overwrite receipt or cue after another tab changed the record', async () => {
    ports.post = vi.fn(async () => { const saved = await store.read(); await store.compareAndSet(saved.revision, r => ({ ...r })); return receipt(); });
    await submit(); expect((await store.read()).receipt).toBeNull(); expect(ports.confirmed).not.toHaveBeenCalled();
  });
});

describe('exact currency acceptance and uncertainty', () => {
  const exactIntent = () => ({ ...intent('v1', baseA, false), expectedCurrency: 'GEMS' as const });
  const paid = () => { const r = receipt(baseA, false); r.funding = { ...r.funding, kind: 'gems' } as typeof r.funding; return r; };
  const refusal = { status: 409, code: 'CURRENCY_CONSENT_CHANGED' };
  const configure = () => { ports.consent = vi.fn(async () => exactIntent()); ports.currencyRefused = e => e === refusal; };
  it('lost reply survives process restart; retry sends original header and receipt funding is proved', async () => {
    configure(); ports.post = vi.fn().mockRejectedValue(new Error('lost reply')); await submit();
    controller = new HeroRecruitmentController(new HeroRecruitmentJournalStore(identity, factory), ports);
    await controller.open(); expect(ports.post).toHaveBeenCalledOnce();
    ports.post = vi.fn(async () => paid()); await controller.retry();
    expect(ports.post).toHaveBeenCalledExactlyOnceWith('/heroes/recruit/v1', exactIntent().request, expect.any(Function), 'GEMS', expect.any(Function));
    expect((await store.read()).receipt?.funding.kind).toBe('gems');
  });
  it('wrong paid currency cannot resolve the journal, but a later contract-first receipt can', async () => {
    configure(); ports.post = vi.fn(async () => receipt(baseA, false)); await submit();
    expect((await store.read()).receipt).toBeNull(); expect(ports.confirmed).not.toHaveBeenCalled();
    const contract = { ...receipt(), request: exactIntent().request };
    ports.get = vi.fn(async () => status(contract)); await controller.open();
    expect((await store.read()).receipt?.funding.kind).toBe('contract');
  });
  it('only the known first refusal retires a command; an ambiguous retry cannot', async () => {
    configure(); ports.post = vi.fn().mockRejectedValue(refusal); await submit();
    expect(await store.read()).toMatchObject({ refusal: 'CURRENCY_CONSENT_CHANGED', finished: true, receipt: null });
    await controller.retry(); expect(ports.post).toHaveBeenCalledOnce();
    ports.consent = vi.fn(async () => ({ ...exactIntent(), request: { ...exactIntent().request, idempotencyKey: baseB } }));
    ports.post = vi.fn().mockRejectedValue(new Error('lost reply')); await submit();
    expect((await store.read()).refusal).toBeUndefined();
    ports.get = vi.fn(async () => status(null, true, baseB)); ports.post = vi.fn().mockRejectedValue(refusal);
    await controller.retry(); expect((await store.read()).finished).toBe(false); expect((await store.read()).refusal).toBeUndefined();
  });
  it('failure saving a first refusal keeps the original command uncertain', async () => {
    configure(); ports.post = vi.fn(async () => { vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); throw refusal; });
    await submit(); expect((await store.read()).finished).toBe(false); expect((await store.read()).refusal).toBeUndefined();
  });
  it.each([false, true])('original refusal observer respects competing revision=%s and never writes twice', async competing => {
    configure(); let attemptRevision = -1;
    ports.post = vi.fn(async (_path, _body, _guard, _currency, observe) => {
      attemptRevision = (await store.read()).revision;
      if (competing) await store.compareAndSet(attemptRevision, old => old);
      await observe!(refusal); await observe!(refusal); throw refusal;
    });
    await submit(); const saved = await store.read();
    expect(saved.revision).toBe(attemptRevision + 1);
    expect(saved.refusal).toBe(competing ? undefined : 'CURRENCY_CONSENT_CHANGED');
    expect(saved.finished).toBe(!competing); expect(saved.receipt).toBeNull(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('historical cash consent accepts its actual Gems receipt without acquiring new currency authorization', async () => {
    await store.compareAndSet(0, r => ({ ...r, intent: intent('v1', baseA, false) }));
    ports.get = vi.fn(async () => status(paid(), false)); await controller.open(); await controller.finish();
    expect((await store.read()).intent).not.toHaveProperty('expectedCurrency'); expect((await store.read()).finished).toBe(true);
    expect(ports.post).not.toHaveBeenCalled();
  });
});
