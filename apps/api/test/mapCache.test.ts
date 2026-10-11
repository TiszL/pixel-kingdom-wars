/**
 * Roster cache BOUNDS (docs/WORLDMAP-GLOBE-PLAN.md P5, pulled forward).
 *
 * WHY THIS FILE EXISTS. The cache's correctness (one load serves every viewer,
 * warzone is part of the key) is already pinned in world.test.ts. What was never
 * pinned is that the cache ever gives memory BACK. It did not: entries were only
 * replaced on the next read of the same valley, so the store held one full roster
 * — up to 500 players with names, clan tags and flags — for every valley anyone
 * had ever opened, for the life of the process. ~200 MB at 1 M players, ~2 GB and
 * OOM at 10 M. That is the one failure mode on the scale ladder that kills the
 * container outright instead of getting slowly slower, which is why it shipped
 * ahead of the rest of P5.
 *
 * These tests are pure (no DB): the loader is a stub, because what is under test
 * is the eviction policy, not the roster query.
 */
import { WORLD } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  getValleySnapshot, invalidateValley, isValleyWarm, mapCacheLoads, mapCacheSize,
  resetMapCache, sweepMapCache,
  type ValleySnapshot,
} from '../src/lib/mapCache';

const stub = (valleyId: string) => async (): Promise<ValleySnapshot> => ({
  valleyId, valleyName: 'STUB', players: [], camps: [],
});

const load = (id: string, at: number): Promise<ValleySnapshot> =>
  getValleySnapshot(id, false, stub(id), at);

describe('mapCache bounds', () => {
  it('reclaims a valley nobody is looking at any more — without waiting for it to be re-read', async () => {
    // WHY: this is the actual leak. Three valleys are opened and then abandoned;
    // the TTL lapses. Before the sweep, all three stayed resident forever because
    // an entry was only ever evicted by a NEW READ OF THAT SAME KEY — and the
    // whole point of a valley going quiet is that nobody reads it again.
    resetMapCache();
    const t0 = 1_000_000;
    await load('a', t0);
    await load('b', t0);
    await load('c', t0);
    expect(mapCacheSize()).toBe(3);

    const later = t0 + WORLD.mapCacheSec * 1000 + 1;
    await load('d', later); // one unrelated valley opens
    expect(mapCacheSize()).toBe(1); // a, b, c are gone; only the live one is held
  });

  it('never grows past its bound, and drops the LEAST RECENTLY USED valley — not the oldest', async () => {
    // WHY: a FIFO bound would evict the valley the whole server is watching (the
    // newest cohort's, written first and read constantly) and keep three valleys
    // one person glanced at. That turns a memory bound into a stampede on the
    // hottest roster query in the game, which is worse than the leak it fixes.
    resetMapCache();
    const t0 = 2_000_000;
    await load('a', t0);
    await load('b', t0);
    await load('c', t0);
    const loadsAfterSeed = mapCacheLoads();

    await load('a', t0 + 1); // 'a' is now the most recently USED, though written first
    expect(mapCacheLoads()).toBe(loadsAfterSeed); // served from cache, no reload

    sweepMapCache(t0 + 2, 2); // bound to two entries, still well inside the TTL
    expect(mapCacheSize()).toBe(2);

    await load('a', t0 + 3);
    expect(mapCacheLoads()).toBe(loadsAfterSeed); // 'a' survived: still cached
    await load('b', t0 + 4);
    expect(mapCacheLoads()).toBe(loadsAfterSeed + 1); // 'b' was the LRU: reloaded
  });

  it('isValleyWarm answers the question the /map limiter asks: will this read be free?', async () => {
    // WHY: the rate limiter charges for COLD LOADS, not for requests (routes.ts
    // mapBudget), and this predicate is how it tells them apart — so it has to agree
    // with what getValleySnapshot will actually do, not merely with "have I seen this
    // id". Both halves matter:
    //  - warm ⇒ the read is a cache hit, so continuing to look at a valley (poll +
    //    pan) draws on the ordinary WORLD.mapRateLimitPerMin allowance;
    //  - EXPIRED ⇒ cold again, so it is charged as an open. That is what bounds the
    //    open budget honestly at one load per valley per mapCacheSec: the miss
    //    repopulates the cache, so the next pan is warm once more.
    resetMapCache();
    const t0 = 4_000_000;
    expect(isValleyWarm('warm-a', t0)).toBe(false); // never seen
    await load('warm-a', t0);
    expect(isValleyWarm('warm-a', t0 + WORLD.mapCacheSec * 1000 - 1)).toBe(true);
    expect(isValleyWarm('warm-a', t0 + WORLD.mapCacheSec * 1000)).toBe(false); // TTL out
  });

  it('treats a backwards clock as a miss rather than serving a snapshot from the future', async () => {
    // WHY: `nowMs - at < ttl` alone is true for a NEGATIVE age too, so a clock
    // that steps backwards (NTP correction, a bad now= in a caller) would pin a
    // stale roster until the clock caught up. The guard is in the read path; the
    // sweep drops such entries as well so they cannot linger.
    resetMapCache();
    const t0 = 3_000_000;
    await load('a', t0);
    const loads = mapCacheLoads();
    await load('a', t0 - 5_000);
    expect(mapCacheLoads()).toBe(loads + 1);
  });

  it('does not let an in-flight stale loader repopulate after authoritative invalidation', async () => {
    // WHY: shield mutation now evicts after COMMIT. A map SELECT that began just
    // before commit may still finish afterward with the old snapshot; eviction
    // must fence that loader, not merely delete entries that already exist.
    resetMapCache();
    let announceStart!: () => void;
    const started = new Promise<void>((resolve) => { announceStart = resolve; });
    let release!: () => void;
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const staleLoad = getValleySnapshot('shield-race', false, async () => {
      announceStart();
      await finish;
      return {
        valleyId: 'shield-race', valleyName: 'STALE', players: [], camps: [],
      };
    }, 5_000_000);
    await started;

    invalidateValley('shield-race');
    release();
    expect((await staleLoad).valleyName).toBe('STALE'); // this old request may finish
    expect(mapCacheSize()).toBe(0); // but it cannot poison later requests

    const fresh = await getValleySnapshot(
      'shield-race', false,
      async () => ({
        valleyId: 'shield-race', valleyName: 'FRESH', players: [], camps: [],
      }),
      5_000_001,
    );
    expect(fresh.valleyName).toBe('FRESH');
    expect(mapCacheSize()).toBe(1);
  });
});
