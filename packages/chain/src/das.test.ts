/**
 * DAS ownership reads.
 *
 * WHY these tests: `getOwnedCoreAssets` is what tells the server which Land
 * Deeds a wallet owns — `ownedDeeds` in game/baseClaim.ts, i.e. whether a
 * player may claim the base they paid for. It used to ask for page 1 / limit
 * 100 and filter to the deed collection CLIENT-side, so a wallet holding more
 * than 100 assets could own a deed and be told it owned none (2026-07-29
 * review, finding (b)). Missing a deed is a silent, user-facing loss, so the
 * paging and the server-side filter are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { getOwnedCoreAssets } from './das';

interface DasCall { method: string; params: Record<string, unknown> }

/** An indexer holding `total` assets in ONE collection, honouring page/limit. */
function fakeDas(total: number, collection: string, calls: DasCall[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as DasCall;
    calls.push(body);
    const limit = Number(body.params['limit']);
    const page = Number(body.params['page']);
    const start = (page - 1) * limit;
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) => ({
      id: `asset-${start + i}`,
      content: { metadata: { name: `Deed ${start + i}` } },
      grouping: [{ group_key: 'collection', group_value: collection }],
      ownership: { frozen: false },
    }));
    return { ok: true, json: async () => ({ result: { items } }) } as Response;
  }) as unknown as typeof fetch;
}

describe('getOwnedCoreAssets', () => {
  it('asks the INDEXER to filter by collection instead of filtering a page of clutter', async () => {
    const calls: DasCall[] = [];
    await getOwnedCoreAssets({
      heliusApiKey: 'k', owner: 'w', collection: 'DeedCol', fetchImpl: fakeDas(3, 'DeedCol', calls),
    });
    // searchAssets is the only DAS method that takes `grouping`; getAssetsByOwner
    // would hand back an arbitrary page of the wallet and hope the deed is in it.
    expect(calls[0]!.method).toBe('searchAssets');
    expect(calls[0]!.params['grouping']).toEqual(['collection', 'DeedCol']);
    expect(calls[0]!.params['ownerAddress']).toBe('w');
  });

  it('WALKS THE PAGES — a deed past the first page is still found', async () => {
    const calls: DasCall[] = [];
    // One full page + a partial one. The old code stopped after page 1.
    const pageSize = 1000;
    const assets = await getOwnedCoreAssets({
      heliusApiKey: 'k', owner: 'w', collection: 'DeedCol',
      fetchImpl: fakeDas(pageSize + 7, 'DeedCol', calls),
    });
    expect(assets).toHaveLength(pageSize + 7);
    expect(assets.at(-1)!.id).toBe(`asset-${pageSize + 6}`);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.params['page']).toBe(2);
  });

  it('stops paging even if the indexer never returns a short page', async () => {
    // Termination cannot depend on the third party being well-behaved.
    let calls = 0;
    const endless = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as DasCall;
      const limit = Number(body.params['limit']);
      const items = Array.from({ length: limit }, (_, i) => ({ id: `a${calls}-${i}` }));
      return { ok: true, json: async () => ({ result: { items } }) } as Response;
    }) as unknown as typeof fetch;

    const assets = await getOwnedCoreAssets({ heliusApiKey: 'k', owner: 'w', fetchImpl: endless });
    expect(calls).toBeLessThanOrEqual(5);
    expect(assets.length).toBe(calls * 1000);
  });

  it('keeps whatever it read when a later page fails, and never throws', async () => {
    let calls = 0;
    const flaky = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) throw new Error('ECONNRESET');
      const body = JSON.parse(String(init?.body)) as DasCall;
      const limit = Number(body.params['limit']);
      const items = Array.from({ length: limit }, (_, i) => ({ id: `a${i}` }));
      return { ok: true, json: async () => ({ result: { items } }) } as Response;
    }) as unknown as typeof fetch;

    // Partial beats empty: the caller (marketplace view, deed claim) can act on
    // what we did see, and an error is never reported as "you own nothing".
    const assets = await getOwnedCoreAssets({ heliusApiKey: 'k', owner: 'w', fetchImpl: flaky });
    expect(assets).toHaveLength(1000);
  });
});
