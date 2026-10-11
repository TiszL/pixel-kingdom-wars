import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { adoptReservation, MarketJournalConflict, MarketJournalStore, matchCommandReceipt, parseMarketJournal } from './journal';
import { identity, purchase, receipt, reserveCommand, id } from './fixtures.test-support';

let factory: IDBFactory;
beforeEach(() => { factory = new IDBFactory(); });
const store = () => new MarketJournalStore(identity, factory);
describe('durable market journal', () => {
  it('commits the full frozen quote before a different page can restore it', async () => {
    const a = store(); const saved = await a.compareAndSet(0, (old) => ({ ...old, activated: true, purchase: purchase() }));
    expect(saved.revision).toBe(1); expect((await store().read()).purchase).toEqual(purchase());
  });
  it('makes simultaneous tab compare-and-set claims atomic', async () => {
    const result = await Promise.allSettled([store(), store()].map((s) => s.compareAndSet(0, (old) => ({ ...old, activated: true, command: reserveCommand() }))));
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((result.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(MarketJournalConflict);
  });
  it('rejects a late response from a tab whose journal revision lost ownership', async () => {
    const a = store(); const old = await a.read(); await store().compareAndSet(old.revision, (r) => ({ ...r, activated: true, command: reserveCommand() }));
    await expect(a.compareAndSet(old.revision, (r) => ({ ...r, activated: true, purchase: purchase() }))).rejects.toBeInstanceOf(MarketJournalConflict);
    expect((await a.read()).command?.request.idempotencyKey).toBe(id(1));
  });
  it('isolates wallet, API and cluster without removing another identity receipt', async () => {
    await store().compareAndSet(0, (r) => ({ ...r, activated: true, purchase: purchase() }));
    for (const changed of [{ ...identity, wallet: 'other' }, { ...identity, api: 'https://other.test/api' }, { ...identity, cluster: 'mainnet-beta' as const }]) {
      expect((await new MarketJournalStore(changed, factory).read()).purchase).toBeNull();
    }
    expect((await store().read()).purchase).not.toBeNull();
  });
  it('fails closed when browser storage cannot open', async () => {
    const s = new MarketJournalStore(identity, undefined);
    await expect(s.read()).rejects.toThrow('storage');
    await expect(s.compareAndSet(0, (r) => r)).rejects.toThrow('storage');
  });
  it('does not overwrite corrupted existing data or pretend it is empty', async () => {
    const s = store(); await s.read();
    const db = await new Promise<IDBDatabase>((resolve) => { const r = factory.open('pkw-market-v1'); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve) => { const tx = db.transaction('receipts', 'readwrite'); tx.objectStore('receipts').put({ version: 99 }, s.key); tx.oncomplete = () => resolve(); });
    await expect(s.read()).rejects.toThrow('Invalid saved');
    await expect(s.compareAndSet(0, (r) => r)).rejects.toThrow('Invalid saved');
    db.close();
  });
  it('keeps activation after Finish so legacy cannot silently reappear', async () => {
    const s = store(); await s.compareAndSet(0, (r) => ({ ...r, activated: true }));
    await expect(s.compareAndSet(1, (r) => ({ ...r, activated: false }))).rejects.toThrow('activation');
  });
  it('refuses to erase attempted or a known signature', async () => {
    const s = store(); await s.compareAndSet(0, (r) => ({ ...r, activated: true, purchase: { ...purchase(), attempted: true, signature: '2'.repeat(88) } }));
    await expect(s.compareAndSet(1, (r) => ({ ...r, purchase: purchase() }))).rejects.toThrow('attempt');
    await expect(s.compareAndSet(1, (r) => ({ ...r, purchase: { ...purchase(), attempted: true } }))).rejects.toThrow('signature');
  });
  it('only accepts a receipt matching all reviewed offer fields and destination', () => {
    for (const patch of [{ buyerBaseId: id(9) }, { sourceBaseId: id(9) }, { itemId: 'other' }, { listingId: id(9) }, { seller: identity.wallet }, { cluster: 'mainnet-beta' }, { idempotencyKey: id(9) }]) {
      const r = receipt(); Object.assign(r.quote, patch);
      expect(() => matchCommandReceipt(reserveCommand(), identity, r)).toThrow();
    }
    expect(matchCommandReceipt(reserveCommand(), identity, receipt()).receipt).toEqual(receipt());
  });
  it('keeps the original quote and committed proof monotonic', () => {
    const p = purchase(); p.receipt = { ...receipt(), state: 'committed', payable: false, paymentSignature: '2'.repeat(88) };
    expect(() => adoptReservation(p, receipt())).toThrow('regressed');
    const changed = structuredClone(p.receipt); changed.quote.feeTreasury = identity.wallet;
    expect(() => adoptReservation(p, changed)).toThrow();
    expect(() => adoptReservation({ ...p, signature: '3'.repeat(88) }, p.receipt)).toThrow('disagree');
  });
});


describe('retained terminal purchase history', () => {
  const ended = () => ({ ...purchase(), attempted: true, signature: '2'.repeat(88), receipt: { ...receipt(), state: 'superseded' as const, payable: false, resolvedAt: '2026-09-13T00:05:00.000Z' } });
  const archive = (s: MarketJournalStore, revision: number) => s.compareAndSet(revision, (old) => ({ ...old, purchase: null, archivedPurchases: [...old.archivedPurchases, old.purchase!] }));
  it('reads the existing deployed journal shape losslessly before any archive is created', () => {
    const old = { version: 1, identity, revision: 2, activated: true, command: null, purchase: ended(), refusal: null };
    expect(parseMarketJournal(old, identity)).toEqual({ ...old, archivedPurchases: [] });
  });
  it('requires an atomic complete terminal copy and rejects pruning, rewriting, duplicating or reactivating saved evidence', async () => {
    const s = store(); await s.compareAndSet(0, (old) => ({ ...old, activated: true, purchase: ended() }));
    await expect(s.compareAndSet(1, (old) => ({ ...old, purchase: null }))).rejects.toThrow('discarded');
    await expect(s.compareAndSet(1, (old) => ({ ...old, purchase: null, archivedPurchases: [{ ...old.purchase!, signature: null }] }))).rejects.toThrow('evidence');
    await archive(s, 1); const saved = await s.read();
    await expect(s.compareAndSet(2, (old) => ({ ...old, archivedPurchases: [] }))).rejects.toThrow('evidence');
    await expect(s.compareAndSet(2, (old) => ({ ...old, archivedPurchases: [{ ...old.archivedPurchases[0]!, signature: null }] }))).rejects.toThrow('evidence');
    await expect(s.compareAndSet(2, (old) => ({ ...old, archivedPurchases: [...old.archivedPurchases, ended()] }))).rejects.toThrow('ended');
    await expect(s.compareAndSet(2, (old) => ({ ...old, purchase: ended() }))).rejects.toThrow('ended');
    expect(await s.read()).toEqual(saved);
    const other = new MarketJournalStore({ ...identity, wallet: 'other' }, factory);
    expect((await other.read()).archivedPurchases).toEqual([]);
    expect((await store().read()).archivedPurchases).toEqual([ended()]);
  });
  it('fails closed when archive storage is invalid and never archives reserved or committed generations', async () => {
    const s = store(); await s.compareAndSet(0, (old) => ({ ...old, activated: true, purchase: { ...purchase(), attempted: true } }));
    await expect(archive(s, 1)).rejects.toThrow('ended');
    await s.compareAndSet(1, (old) => ({ ...old, purchase: { ...old.purchase!, receipt: { ...receipt(), state: 'committed', payable: false, paymentSignature: '2'.repeat(88) } } }));
    await expect(archive(s, 2)).rejects.toThrow('ended');
    const saved = await s.read();
    expect(() => parseMarketJournal({ ...saved, archivedPurchases: {} }, identity)).toThrow('history');
    expect(() => parseMarketJournal({ ...saved, archivedPurchases: [{ ...ended(), signature: 'bad' }] }, identity)).toThrow('purchase');
  });
});
