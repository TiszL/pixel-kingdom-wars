import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  asset: null as Record<string, unknown> | null,
  assets: new Map<string, Record<string, unknown>>(),
  collection: null as Record<string, unknown> | null,
  collectionError: false,
  calls: [] as Array<{ key: string; options: unknown }>,
  requests: [] as Array<{ keys: string[]; options: unknown }>,
  connectionConfigs: [] as Array<Record<string, unknown>>,
  slots: [] as number[],
  missingAt: -1,
  wrongOwnerAt: -1,
  hangAt: -1,
  rateLimitAt: -1,
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      constructor(
        _url: string,
        private readonly config: { fetch?: typeof globalThis.fetch } & Record<string, unknown>,
      ) {
        h.connectionConfigs.push(config);
      }

      async getAccountInfoAndContext(key: { toBase58(): string }, options: unknown) {
        h.requests.push({ keys: [key.toBase58()], options });
        const call = h.calls.length;
        h.calls.push({ key: key.toBase58(), options });
        if (call === h.hangAt) {
          await this.config.fetch?.('http://mock.invalid', { method: 'POST' });
          throw new Error('aborted fetch unexpectedly resolved');
        }
        return {
          context: { slot: h.slots[call] ?? 0 },
          value: call === h.missingAt ? null : {
            executable: false,
            owner: new actual.PublicKey(call === h.wrongOwnerAt
              ? '11111111111111111111111111111111'
              : 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),
            lamports: 1,
            data: Buffer.alloc(1),
            rentEpoch: 0,
          },
        };
      }

      async getMultipleAccountsInfoAndContext(
        keys: Array<{ toBase58(): string }>, options: unknown,
      ) {
        h.requests.push({ keys: keys.map((key) => key.toBase58()), options });
        const start = h.calls.length;
        if (start === h.rateLimitAt) throw new Error('429 Too Many Requests');
        if (start === h.hangAt) {
          await this.config.fetch?.('http://mock.invalid', { method: 'POST' });
          throw new Error('aborted fetch unexpectedly resolved');
        }
        const values = keys.map((key, offset) => {
          const call = start + offset;
          h.calls.push({ key: key.toBase58(), options });
          if (call === h.missingAt) return null;
          return {
            executable: false,
            owner: new actual.PublicKey(call === h.wrongOwnerAt
              ? '11111111111111111111111111111111'
              : 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'),
            lamports: 1,
            data: Buffer.alloc(1),
            rentEpoch: 0,
          };
        });
        return { context: { slot: h.slots[start] ?? 0 }, value: values };
      }
    },
  };
});

vi.mock('@metaplex-foundation/mpl-core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deserializeAssetV1: (account: { publicKey?: { toString(): string } }) =>
    h.assets.get(account.publicKey?.toString() ?? '') ?? h.asset,
  deserializeCollectionV1: () => {
    if (h.collectionError) throw new Error('malformed collection');
    return h.collection;
  },
}));

const { publicKey } = await import('@metaplex-foundation/umi');
const {
  getFinalizedCoreAssetOwner, getFinalizedCoreAssetOwnerBatch, getFinalizedCoreAssetOwners,
} = await import('./coreOwnership');

const ASSET = publicKey('So11111111111111111111111111111111111111112');
const OWNER = publicKey('SysvarC1ock11111111111111111111111111111111');
const COLLECTION = publicKey('56RemMwZRxL7xMMV8TbiErZX2YfrnuY65x3t7sTQxKrT');

beforeEach(() => {
  h.calls.length = 0;
  h.requests.length = 0;
  h.connectionConfigs.length = 0;
  h.slots = [100, 105];
  h.missingAt = -1;
  h.wrongOwnerAt = -1;
  h.hangAt = -1;
  h.rateLimitAt = -1;
  h.assets.clear();
  h.asset = {
    publicKey: ASSET,
    owner: OWNER,
    updateAuthority: { type: 'Collection', address: COLLECTION },
    key: 1,
    name: 'Land Deed',
    uri: '',
    seq: null,
  };
  h.collection = {
    publicKey: COLLECTION,
    updateAuthority: { type: 'Address', address: OWNER },
    key: 2,
    name: 'Land Deeds',
    uri: '',
    numMinted: 1,
    currentSize: 1,
  };
  h.collectionError = false;
});

describe('finalized Core RPC ownership reader', () => {
  it('forwards the accepted slot floor and makes the collection read coherent', async () => {
    const result = await getFinalizedCoreAssetOwner({
      rpcUrl: 'http://mock', assetId: ASSET.toString(),
      expectedCollection: COLLECTION.toString(), minContextSlot: 97,
    });
    expect(result).toMatchObject({ owner: OWNER.toString(), slot: 100 });
    expect(h.requests).toEqual([{
      keys: [ASSET.toString(), COLLECTION.toString()],
      options: { commitment: 'finalized', minContextSlot: 97 },
    }]);
    expect(h.connectionConfigs).toEqual([expect.objectContaining({
      commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: expect.any(Function),
    })]);
  });

  it('fails closed after one rate-limited request without retry amplification', async () => {
    h.rateLimitAt = 0;
    expect(await getFinalizedCoreAssetOwner({
      rpcUrl: 'http://mock', assetId: ASSET.toString(),
      expectedCollection: COLLECTION.toString(),
    })).toBeNull();
    expect(h.requests).toHaveLength(1);
    expect(h.connectionConfigs[0]).toMatchObject({ disableRetryOnRateLimit: true });
  });

  it('reads many assets and their collection in one request while isolating bad assets', async () => {
    const missing = publicKey('SysvarRent111111111111111111111111111111111');
    const wrongProgram = publicKey('Vote111111111111111111111111111111111111111');
    const wrongCollection = publicKey('Stake11111111111111111111111111111111111111');
    h.assets.set(wrongCollection.toString(), {
      ...h.asset!, publicKey: wrongCollection,
      updateAuthority: { type: 'Collection', address: OWNER },
    });
    h.missingAt = 1;
    h.wrongOwnerAt = 2;

    const result = await getFinalizedCoreAssetOwners({
      rpcUrl: 'http://mock', expectedCollection: COLLECTION.toString(),
      assets: [ASSET, missing, wrongProgram, wrongCollection].map((asset, index) => ({
        assetId: asset.toString(), minContextSlot: 90 + index,
      })),
    });

    expect(h.requests).toEqual([{
      keys: [ASSET, missing, wrongProgram, wrongCollection, COLLECTION].map(String),
      options: { commitment: 'finalized', minContextSlot: 93 },
    }]);
    expect(result.get(ASSET.toString())).toMatchObject({ owner: OWNER.toString(), slot: 100 });
    expect(result.get(missing.toString())).toBeNull();
    expect(result.get(wrongProgram.toString())).toBeNull();
    expect(result.get(wrongCollection.toString())).toBeNull();
  });

  it('exposes the finalized context for an all-null successful batch', async () => {
    h.missingAt = 0;
    const batch = await getFinalizedCoreAssetOwnerBatch({
      rpcUrl: 'http://mock', expectedCollection: COLLECTION.toString(),
      assets: [{ assetId: ASSET.toString() }],
    });
    expect(batch).toMatchObject({ contextSlot: 100, transportSucceeded: true });
    expect(batch.owners.get(ASSET.toString())).toBeNull();
  });

  it('distinguishes transport failure from a successful missing asset', async () => {
    h.rateLimitAt = 0;
    const batch = await getFinalizedCoreAssetOwnerBatch({
      rpcUrl: 'http://mock', expectedCollection: COLLECTION.toString(),
      assets: [{ assetId: ASSET.toString() }],
    });
    expect(batch).toMatchObject({ contextSlot: null, transportSucceeded: false });
  });

  it.each([
    ['missing', () => { h.missingAt = 1; }],
    ['wrong-program', () => { h.wrongOwnerAt = 1; }],
    ['malformed', () => { h.collectionError = true; }],
  ])('fails the whole batch when the canonical collection is %s', async (_name, arrange) => {
    arrange();
    const batch = await getFinalizedCoreAssetOwnerBatch({
      rpcUrl: 'http://mock', expectedCollection: COLLECTION.toString(),
      assets: [{ assetId: ASSET.toString() }],
    });
    expect(batch).toMatchObject({ contextSlot: 100, transportSucceeded: false });
    expect(batch.owners.get(ASSET.toString())).toBeNull();
  });

  it('fails closed before trusting a deed from the wrong collection', async () => {
    expect(await getFinalizedCoreAssetOwner({
      rpcUrl: 'http://mock', assetId: ASSET.toString(), expectedCollection: OWNER.toString(),
    })).toBeNull();
    expect(h.requests).toHaveLength(1);
  });

  it('fails closed when the referenced collection cannot be finalized', async () => {
    h.missingAt = 1;
    expect(await getFinalizedCoreAssetOwner({
      rpcUrl: 'http://mock', assetId: ASSET.toString(),
    })).toBeNull();
  });

  it('rejects discriminator-shaped asset bytes outside the Core program', async () => {
    h.wrongOwnerAt = 0;
    expect(await getFinalizedCoreAssetOwner({
      rpcUrl: 'http://mock', assetId: ASSET.toString(),
    })).toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it('rejects a referenced collection outside the Core program', async () => {
    h.wrongOwnerAt = 1;
    expect(await getFinalizedCoreAssetOwner({
      rpcUrl: 'http://mock', assetId: ASSET.toString(),
    })).toBeNull();
    expect(h.calls).toHaveLength(2);
  });

  it('rejects an incoherent collection response below the asset context', async () => {
    h.slots = [100, 99];
    expect(await getFinalizedCoreAssetOwner({
      rpcUrl: 'http://mock', assetId: ASSET.toString(),
    })).toBeNull();
  });

  it('aborts the underlying RPC transport when the shared read deadline expires', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error('missing abort signal'));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    h.hangAt = 0;
    try {
      const pending = getFinalizedCoreAssetOwner({ rpcUrl: 'http://mock', assetId: ASSET.toString() });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
