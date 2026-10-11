/** Foreground finalized-deed reader admission is process-local protection for
 * the public RPC. The background observer has its separate multi-asset path.
 *
 * 2026-09-18: the foreground read moved from getFinalizedCoreAssetOwner to the
 * single-asset getFinalizedCoreAssetOwnerBatch. It is the SAME one transport
 * request (asset + collection at one context), but it also says whether the
 * chain answered — the only way to retry a transport failure without ever
 * retrying an answer. The pacing, coalescing and queue-deadline rules pinned
 * below are unchanged; only the mocked transport function is. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_OWNERSHIP } from '@shardkeep/shared';

const h = vi.hoisted(() => ({
  readBatch: vi.fn(),
  readMany: vi.fn(),
}));

vi.mock('@shardkeep/chain', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shardkeep/chain')>(),
  getFinalizedCoreAssetOwnerBatch: h.readBatch,
  getFinalizedCoreAssetOwners: h.readMany,
}));

const { DeedReadUnavailableError, makeFinalizedDeedReader } = await import('../src/game/baseOwnership');

type Request = { assets: readonly { assetId: string }[] };
const ownedBy = (owner: string, slot = 10) => (
  { owner, frozen: false, delegate: null, collection: 'collection', slot }
);
/** The chain answered; `ownership` null is a POSITIVE "no eligible asset". */
const answered = (req: Request, ownership: ReturnType<typeof ownedBy> | null, slot = 10) => ({
  owners: new Map(req.assets.map(({ assetId }) => [assetId, ownership])),
  contextSlot: slot, transportSucceeded: true,
});
/** RPC error, rate limit, timeout or a node behind the context floor. */
const unanswered = (req: Request) => ({
  owners: new Map(req.assets.map(({ assetId }) => [assetId, null])),
  contextSlot: null, transportSucceeded: false,
});

beforeEach(() => {
  h.readBatch.mockReset();
  h.readMany.mockReset();
});

describe('foreground finalized deed reader', () => {
  it('coalesces concurrent reads only when asset and context floor are identical', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    h.readBatch.mockImplementation(async (req: Request) => {
      await blocked;
      return answered(req, ownedBy('owner'));
    });
    const reader = makeFinalizedDeedReader({ rpcUrl: 'http://rpc', deedCollection: 'collection' })!;
    const same = Array.from({ length: 20 }, () => reader('asset-a', 9));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.readBatch).toHaveBeenCalledOnce();
    // A stronger floor cannot consume the already-running weaker proof.
    const stronger = reader('asset-a', 10);
    release();
    await Promise.all([...same, stronger]);
    expect(h.readBatch).toHaveBeenCalledTimes(2);
  });

  it('starts distinct foreground reads in FIFO order at the configured safe rate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const starts: Array<{ assetId: string; at: number }> = [];
    h.readBatch.mockImplementation(async (req: Request) => {
      starts.push({ assetId: req.assets[0]!.assetId, at: Date.now() });
      return answered(req, null);
    });
    try {
      const reader = makeFinalizedDeedReader({ rpcUrl: 'http://rpc', deedCollection: 'collection' })!;
      const pending = ['a', 'b', 'c'].map((asset) => reader(asset));
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([{ assetId: 'a', at: 1_000 }]);
      await vi.advanceTimersByTimeAsync(BASE_OWNERSHIP.foregroundReadStartIntervalMs - 1);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      // Derived, not literal: the interval was retuned 500 -> 400 ms on
      // 2026-09-19 (Helius Developer plan). What matters is that every start
      // waits one WHOLE configured interval after the previous start.
      expect(starts[1]).toEqual({
        assetId: 'b', at: 1_000 + BASE_OWNERSHIP.foregroundReadStartIntervalMs,
      });
      await vi.advanceTimersByTimeAsync(BASE_OWNERSHIP.foregroundReadStartIntervalMs);
      expect(starts[2]).toEqual({
        assetId: 'c', at: 1_000 + 2 * BASE_OWNERSHIP.foregroundReadStartIntervalMs,
      });
      await Promise.all(pending);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when a burst cannot acquire a start slot before the queue deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    h.readBatch.mockImplementation(async (req: Request) => answered(req, null));
    try {
      const reader = makeFinalizedDeedReader({ rpcUrl: 'http://rpc', deedCollection: 'collection' })!;
      const requested = Math.ceil(
        BASE_OWNERSHIP.foregroundReadQueueTimeoutMs
          / BASE_OWNERSHIP.foregroundReadStartIntervalMs,
      ) + 3;
      const pending = Promise.allSettled(
        Array.from({ length: requested }, (_, i) => reader(`asset-${i}`)),
      );
      await vi.advanceTimersByTimeAsync(
        BASE_OWNERSHIP.foregroundReadQueueTimeoutMs
          + BASE_OWNERSHIP.foregroundReadStartIntervalMs,
      );
      // Starts at t=0 through the inclusive deadline; later FIFO entrants do
      // not call the transport at all.
      const started = Math.floor(
        BASE_OWNERSHIP.foregroundReadQueueTimeoutMs
          / BASE_OWNERSHIP.foregroundReadStartIntervalMs,
      ) + 1;
      expect(h.readBatch).toHaveBeenCalledTimes(started);
      const settled = await pending;
      expect(settled.slice(0, started)).toEqual(Array(started).fill({ status: 'fulfilled', value: null }));
      // Still fail-closed, but no longer an anonymous null: a declined start
      // REJECTS with its reason, because a null now means "the chain answered:
      // no eligible asset" and the 2026-09-18 incident could not be diagnosed
      // while every cause collapsed into the same null.
      for (const late of settled.slice(started)) {
        expect(late.status).toBe('rejected');
        expect((late as PromiseRejectedResult).reason).toBeInstanceOf(DeedReadUnavailableError);
        expect((late as PromiseRejectedResult).reason).toMatchObject({ reason: 'queue-timeout' });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // --- 2026-09-18 incident: two legitimate owners were answered 503
  // DEED_AUTHORITY_UNAVAILABLE in steady state. The public devnet RPC
  // occasionally errors or rate-limits one request; one such hiccup was enough
  // to refuse the player. ---

  it('retries ONE transport failure at the paced rate and returns the good read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const starts: number[] = [];
    h.readBatch.mockImplementation(async (req: Request) => {
      starts.push(Date.now());
      return starts.length === 1 ? unanswered(req) : answered(req, ownedBy('owner', 42));
    });
    try {
      const reader = makeFinalizedDeedReader({ rpcUrl: 'http://rpc', deedCollection: 'collection' })!;
      const pending = reader('asset-a', 7);
      await vi.advanceTimersByTimeAsync(BASE_OWNERSHIP.foregroundReadStartIntervalMs);
      await expect(pending).resolves.toMatchObject({ owner: 'owner', slot: 42 });
      // The retry is an ordinary FIFO start: it can never burst the public RPC.
      expect(starts).toEqual([1_000, 1_000 + BASE_OWNERSHIP.foregroundReadStartIntervalMs]);
      // The accepted-evidence floor rides along on the retry too.
      expect(h.readBatch.mock.calls.map(([req]) => req.assets)).toEqual([
        [{ assetId: 'asset-a', minContextSlot: 7 }], [{ assetId: 'asset-a', minContextSlot: 7 }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays bounded: a second transport failure rejects instead of retrying forever', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    h.readBatch.mockImplementation(async (req: Request) => unanswered(req));
    try {
      const reader = makeFinalizedDeedReader({ rpcUrl: 'http://rpc', deedCollection: 'collection' })!;
      const pending = reader('asset-a').then(() => 'resolved', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(BASE_OWNERSHIP.foregroundReadQueueTimeoutMs);
      expect(await pending).toMatchObject({ name: 'DeedReadUnavailableError', reason: 'rpc-error' });
      expect(h.readBatch).toHaveBeenCalledTimes(1 + BASE_OWNERSHIP.foregroundReadTransportRetries);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never retries an ANSWER: another owner or a missing asset is final after one read', async () => {
    // Retrying an answer could turn a finalized sale into `owned` on a lagging
    // node. Only an answer-less transport failure may be read again.
    const reader = makeFinalizedDeedReader({ rpcUrl: 'http://rpc', deedCollection: 'collection' })!;
    h.readBatch.mockImplementation(async (req: Request) => answered(req, ownedBy('buyer', 50)));
    await expect(reader('sold-asset')).resolves.toMatchObject({ owner: 'buyer' });
    expect(h.readBatch).toHaveBeenCalledTimes(1);
    h.readBatch.mockReset();
    h.readBatch.mockImplementation(async (req: Request) => answered(req, null));
    await expect(reader('burned-asset')).resolves.toBeNull();
    expect(h.readBatch).toHaveBeenCalledTimes(1);
  });

  it('does not start a retry after the original queue deadline has passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    // The first read hangs for its whole bounded transport timeout, so the one
    // end-to-end deadline is spent: worst case stays queue deadline + one read.
    h.readBatch.mockImplementation(async (req: Request) => {
      await new Promise<void>((resolve) => setTimeout(resolve, BASE_OWNERSHIP.observationReadTimeoutMs + 1));
      return unanswered(req);
    });
    try {
      const reader = makeFinalizedDeedReader({ rpcUrl: 'http://rpc', deedCollection: 'collection' })!;
      const pending = reader('asset-a').then(() => 'resolved', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(BASE_OWNERSHIP.observationReadTimeoutMs + 1);
      expect(await pending).toMatchObject({ reason: 'rpc-error' });
      expect(h.readBatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps observer readMany outside the foreground FIFO', async () => {
    h.readMany.mockResolvedValue(new Map());
    const reader = makeFinalizedDeedReader({ rpcUrl: 'http://rpc', deedCollection: 'collection' })!;
    await reader.readMany!([{ assetId: 'a' }, { assetId: 'b' }]);
    expect(h.readMany).toHaveBeenCalledOnce();
    expect(h.readBatch).not.toHaveBeenCalled();
  });
});
