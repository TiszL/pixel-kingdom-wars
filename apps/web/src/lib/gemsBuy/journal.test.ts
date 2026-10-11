import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { GemsBuyJournalStore, type GemsBuyIdentity, type GemsBuyPurchase } from './journal';
import { address, binding, quote, request, signature } from './fixtures.test-support';
const identity: GemsBuyIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: binding.wallet };
const draft = (): GemsBuyPurchase => ({ request, binding, quote: null, prepared: null, signature: null, broadcastStarted: false, deposit: null, hydrated: false });
describe('wallet Gems strict journal', () => {
  it('isolates original origin/API/cluster/wallet and refuses a stale tab CAS', async () => {
    const factory = new IDBFactory(), store = new GemsBuyJournalStore(identity, factory);
    await store.compareAndSet(0, old => ({ ...old, purchase: draft() }));
    await expect(new GemsBuyJournalStore(identity, factory).compareAndSet(0, old => old)).rejects.toThrow('Another tab');
    for (const scope of [{ origin: 'https://other.test' }, { api: 'https://other.test/api' }, { cluster: 'mainnet-beta' as const }, { wallet: address(40) }]) {
      expect((await new GemsBuyJournalStore({ ...identity, ...scope }, factory).read()).purchase).toBeNull();
    }
  });
  it('immutable request/config/quote and monotone wallet phases cannot be rewritten or cleared', async () => {
    const store = new GemsBuyJournalStore(identity, new IDBFactory());
    let saved = await store.compareAndSet(0, old => ({ ...old, purchase: draft() }));
    for (const patch of [{ request: { ...request, keepIn: 11 } }, { binding: { ...binding, mint: address(40) } }]) {
      await expect(store.compareAndSet(saved.revision, old => ({ ...old, purchase: { ...old.purchase!, ...patch } }))).rejects.toThrow();
    }
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, purchase: { ...old.purchase!, quote: quote() } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, purchase: { ...old.purchase!, quote: { ...quote(), destination: address(40) } } }))).rejects.toThrow();
    const prepared = { blockhash: address(35), lastValidBlockHeight: 123, messageFingerprint: 'a'.repeat(64) };
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, purchase: { ...old.purchase!, prepared, signature: signature(1) } }))).rejects.toThrow('phase');
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, purchase: { ...old.purchase!, prepared } }));
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, purchase: null }))).rejects.toThrow();
    await expect(store.compareAndSet(saved.revision, old => ({ ...old, purchase: { ...old.purchase!, prepared: null } }))).rejects.toThrow();
  });
  it('unavailable durable storage prevents starting any payment', async () => {
    await expect(new GemsBuyJournalStore(identity, undefined).read()).rejects.toThrow('storage');
  });
});
