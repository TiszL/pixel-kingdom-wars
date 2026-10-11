import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { GemsJournalStore, parseGemsJournal } from './journal';
import { identity, intent, proof } from './fixtures.test-support';

describe('Gems strict durable journal', () => {
  it('missing browser storage refuses instead of treating a pending request as absent', async () => {
    const store = new GemsJournalStore(identity);
    await expect(store.read()).rejects.toThrow('storage');
  });
  it('unrecognised schema or mismatched proof fails closed', async () => {
    const store = new GemsJournalStore(identity, new IDBFactory()), empty = await store.read();
    for (const changed of [{ version: 2 }, { revision: -1 }, { extra: true }, { hydrated: true }, { attempted: true }, { receipt: proof(intent()) }])
      expect(() => parseGemsJournal({ ...empty, ...changed }, identity)).toThrow();
    expect(() => parseGemsJournal({ ...empty, intent: intent(), attempted: true, receipt: { ...proof(intent()), wallet: 'other' } }, identity)).toThrow();
  });
  it('corrupt indexed data is retained and blocks both reads and replacement writes', async () => {
    const factory = new IDBFactory(), store = new GemsJournalStore(identity, factory); await store.read();
    const raw = { version: 99, retained: 'must not be overwritten' };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('pkw-gems-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('commands', 'readwrite'); tx.objectStore('commands').put(raw, store.key);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    await expect(store.read()).rejects.toThrow(); await expect(store.compareAndSet(0, r => ({ ...r, intent: intent() }))).rejects.toThrow();
    const retained = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('commands', 'readonly'), get = tx.objectStore('commands').get(store.key);
      get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
    });
    expect(retained).toEqual(raw); db.close(); await store.close();
  });
  it('attempt and accepted evidence are monotonic and a later operation requires a fresh key', async () => {
    const store = new GemsJournalStore(identity, new IDBFactory());
    await store.compareAndSet(0, r => ({ ...r, intent: intent(), attempted: true }));
    await expect(store.compareAndSet(1, r => ({ ...r, attempted: false }))).rejects.toThrow('unsent');
    await store.compareAndSet(1, r => ({ ...r, receipt: proof(intent()), hydrated: true, finished: true }));
    await expect(store.compareAndSet(2, r => ({ ...r, finished: false }))).rejects.toThrow('replayed');
    await expect(store.compareAndSet(2, r => ({ ...r, intent: { ...intent(), keep: '11' }, attempted: false, receipt: null, hydrated: false, finished: false }))).rejects.toThrow('distinct key');
    const next = { ...intent(), idempotencyKey: 'another-key' };
    await store.compareAndSet(2, r => ({ ...r, intent: next, attempted: false, receipt: null, hydrated: false, finished: false }));
    expect((await store.read()).intent).toEqual(next);
  });
});
