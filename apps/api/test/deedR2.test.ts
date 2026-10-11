/**
 * Deed metadata → R2 reconciler (owner 2026-07-26: api on a non-public host, so
 * wallet UIs read deed JSON from the R2 bucket; this loop keeps it fresh).
 * Tested against a fake putter — the R2 SigV4 leg is aws4fetch + one PUT and is
 * exercised live at deploy; what can rot silently is the RECONCILE logic below.
 */
import { getPublicKeyAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { players } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { claimBase, type DeedReaders } from '../src/game/baseClaim';
import { isDeedDirty, markDeedDirty } from '../src/game/deedMetadata';
import {
  assertDeedKey, deedScopedPutter, deedSyncHealth, markDeedSyncRunning, recordDeedSweepError,
  recordDeedSweepOk, setDeedSyncDisabled, sweepDeedMetadata, r2ConfigFromEnv, type ObjectPutter,
} from '../src/game/deedR2';

import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, randomWallet } from './helpers';

const conn = connectTestDb();
const db = conn.db;
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

async function deededPlayer(): Promise<{ wallet: string; deed: string }> {
  const p = await createTestPlayer(db);
  const deed = randomWallet(); // deed asset ids are base58 addresses
  await db.update(players)
    .set({ entryPaidAt: new Date(), deedAssetId: deed })
    .where(eq(players.wallet, p.wallet));
  await ensureStartingBase(db, p.wallet);
  return { wallet: p.wallet, deed };
}

describe('deed metadata R2 reconciler', () => {
  it('pushes on change, skips unchanged, and re-pushes after a real mutation', async () => {
    const p = await deededPlayer();
    const puts: Array<{ key: string; json: string }> = [];
    const put: ObjectPutter = async (key, body) => { puts.push({ key, json: body.toString() }); };
    const lastPushed = new Map<string, string>();

    // First sweep: this deed is new → pushed, keyed by the ASSET (the path the
    // deed's on-chain URI points at), with the legacy wallet alias alongside.
    let pushed = await sweepDeedMetadata(db, put, lastPushed);
    expect(pushed).toContain(p.deed);
    expect(puts.some((x) => x.key === `deed/asset/${p.deed}.json`)).toBe(true);
    expect(puts.some((x) => x.key === `deed/${p.wallet}.json`)).toBe(true);

    // Second sweep, nothing changed: NO push — this is what makes a 60s loop
    // affordable; without the hash gate every sweep would re-PUT every deed.
    puts.length = 0;
    pushed = await sweepDeedMetadata(db, put, lastPushed);
    expect(pushed).not.toContain(p.deed);
    expect(puts.length).toBe(0);

    // Mutate the base (keep upgrade) → next sweep pushes the NEW document.
    // This is the dynamic-deed contract, end to end: state change → new JSON.
    await db.update(players).set({ keepLevel: 7 }).where(eq(players.wallet, p.wallet));
    pushed = await sweepDeedMetadata(db, put, lastPushed);
    expect(pushed).toContain(p.deed);
    const doc = JSON.parse(puts.find((x) => x.key === `deed/asset/${p.deed}.json`)!.json) as
      { attributes: Array<{ trait_type: string; value: unknown }> };
    expect(doc.attributes.find((a) => a.trait_type === 'Keep Level')?.value).toBe(7);
  });

  it('a failed PUT is retried next sweep — the hash only advances on success', async () => {
    const p = await deededPlayer();
    const lastPushed = new Map<string, string>();
    let calls = 0;
    const flaky: ObjectPutter = async () => { calls++; throw new Error('R2 down'); };
    // Failure: nothing recorded as pushed…
    expect(await sweepDeedMetadata(db, flaky, lastPushed)).not.toContain(p.deed);
    // …so the next sweep tries the SAME deed again instead of skipping it.
    const ok: ObjectPutter = async () => { calls++; };
    expect(await sweepDeedMetadata(db, ok, lastPushed)).toContain(p.deed);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('a failing legacy alias never stalls the asset document (the URI deeds carry)', async () => {
    const p = await deededPlayer();
    const lastPushed = new Map<string, string>();
    const keys: string[] = [];
    const aliasDown: ObjectPutter = async (key) => {
      keys.push(key);
      if (key === `deed/${p.wallet}.json`) throw new Error('alias gone');
    };
    expect(await sweepDeedMetadata(db, aliasDown, lastPushed)).toContain(p.deed);
    expect(keys).toContain(`deed/asset/${p.deed}.json`);
    // …and the asset doc is NOT re-pushed forever because the alias keeps failing.
    keys.length = 0;
    expect(await sweepDeedMetadata(db, aliasDown, lastPushed)).not.toContain(p.deed);
    expect(keys.length).toBe(0);
  });

  it('r2ConfigFromEnv is all-or-nothing — partial config must DISABLE, not half-run', async () => {
    const full = {
      R2_ENDPOINT: 'https://acc.r2.cloudflarestorage.com/', R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_PUBLIC_BASE_URL: 'https://pub.r2.dev/',
    };
    const cfg = r2ConfigFromEnv(full as unknown as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.endpoint.endsWith('/')).toBe(false);      // trailing slashes normalised
    expect(cfg!.publicBaseUrl.endsWith('/')).toBe(false); // (they would double up in URIs)
    for (const missing of Object.keys(full)) {
      const partial = { ...full } as Record<string, string>;
      delete partial[missing];
      expect(r2ConfigFromEnv(partial as unknown as NodeJS.ProcessEnv)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// F2 (security review 2026-07-29, thaw blocker): a deed's document is keyed to
// the ASSET and describes whoever holds that deed's base RIGHT NOW. Before this,
// the URI was keyed to the minting wallet, so a sold deed kept pointing at the
// SELLER's document — and when the seller re-entered, their new deed was minted
// onto the very same URI. These tests replay exactly that sequence.
// ---------------------------------------------------------------------------
describe('deed documents follow the ASSET, not the wallet (F2)', () => {
  const PUB = 'https://pub.r2.dev';
  /** Sweep opts that emit an image URL WITHOUT invoking the renderer: the image
   *  URL is wallet-derived, which makes it the sharpest "whose base is this?"
   *  discriminator in the document. */
  const imageOpts = (wallets: string[]) => ({
    publicBaseUrl: PUB, lastImageHash: new Map<string, string>(), renderAvailable: false,
    pngKnown: new Map<string, boolean>(wallets.map((w) => [w, true])),
  });

  /** An ON-CURVE wallet — `ownershipEligible` rejects anything else, so a random
   *  32-byte string would fail the claim ~half the time. */
  const curveWallet = async (): Promise<string> => bs58.encode(await getPublicKeyAsync(utils.randomSecretKey()));

  it('after a sale the buyer\'s asset describes the BUYER\'s base — and the seller\'s new deed gets its OWN document', async () => {
    const seller = await deededPlayer();
    await db.update(players).set({ keepLevel: 7 }).where(eq(players.wallet, seller.wallet));
    const buyerWallet = await curveWallet();
    const readers: DeedReaders = {
      ownedDeeds: async (w) => (w === buyerWallet ? [seller.deed] : []),
      ownerOf: async (id) => (id === seller.deed
        ? { owner: buyerWallet, frozen: false, delegate: null, collection: 'DeedCollection' }
        : null),
      collection: 'DeedCollection',
    };

    const puts = new Map<string, string>();
    const put: ObjectPutter = async (key, body) => { puts.set(key, body.toString()); };
    const lastPushed = new Map<string, string>();
    const opts = imageOpts([seller.wallet, buyerWallet]);
    await sweepDeedMetadata(db, put, lastPushed, opts);
    const before = JSON.parse(puts.get(`deed/asset/${seller.deed}.json`)!) as Doc;
    expect(before.image).toContain(seller.wallet); // pre-sale: the seller's base

    // THE SALE. The claim marks the deed dirty precisely because the document is
    // now wrong in a way no trait change would necessarily reveal.
    expect(await claimBase(db, readers, buyerWallet)).toMatchObject({ claimed: true });
    expect(isDeedDirty(seller.deed)).toBe(true);

    // The seller re-enters and rebuilds — with a SECOND deed asset. Under the
    // wallet-keyed scheme this deed and the buyer's shared one URI.
    const rebuilt = await deededPlayer(); // a second, distinct deed asset
    await db.update(players).set({ keepLevel: 3 }).where(eq(players.wallet, rebuilt.wallet));

    puts.clear();
    const pushed = await sweepDeedMetadata(db, put, lastPushed, imageOpts([buyerWallet, rebuilt.wallet]));
    expect(pushed).toContain(seller.deed);
    expect(isDeedDirty(seller.deed)).toBe(false); // cleared only by a successful push

    // The traded asset now describes the BUYER's base — same asset-keyed image,
    // new holder. The image URL must not be renamed on every sale: marketplaces
    // cache the deed URI, while the bytes at this canonical key are republished
    // from the conveyed base.
    const sold = JSON.parse(puts.get(`deed/asset/${seller.deed}.json`)!) as Doc;
    expect(sold.image).toBe(`/deed/asset/${seller.deed}.png`);
    expect(sold.image).not.toContain(buyerWallet);
    expect(sold.image).not.toContain(seller.wallet);
    expect(trait(sold, 'Keep Level')).toBe(7); // the base that was sold
    // …and its NAME names the asset, not a holder: a wallet-derived name would
    // still be advertising the seller on every marketplace listing.
    expect(sold.name).toContain(seller.deed.slice(0, 4));
    expect(sold.name).not.toContain(seller.wallet.slice(0, 4));

    // Two assets, two documents — never one URI serving both.
    const second = JSON.parse(puts.get(`deed/asset/${rebuilt.deed}.json`)!) as Doc;
    expect(trait(second, 'Keep Level')).toBe(3);
    expect(second.name).not.toBe(sold.name);
  });

  it('every deed gets a DISTINCT key — no two assets share a document', async () => {
    const a = await deededPlayer();
    const b = await deededPlayer();
    const puts: string[] = [];
    const put: ObjectPutter = async (key) => { puts.push(key); };
    await sweepDeedMetadata(db, put, new Map());
    const assetKeys = puts.filter((k) => k.startsWith('deed/asset/'));
    expect(assetKeys).toContain(`deed/asset/${a.deed}.json`);
    expect(assetKeys).toContain(`deed/asset/${b.deed}.json`);
    expect(new Set(assetKeys).size).toBe(assetKeys.length);
  });

  it('a dirty deed re-publishes even when the document is byte-identical', async () => {
    const p = await deededPlayer();
    const puts: string[] = [];
    const put: ObjectPutter = async (key) => { puts.push(key); };
    const lastPushed = new Map<string, string>();
    await sweepDeedMetadata(db, put, lastPushed);
    puts.length = 0;
    // Nothing changed → the hash gate would skip it. The dirty mark must win:
    // that is what makes a claim visible within one sweep.
    markDeedDirty(p.deed);
    expect(await sweepDeedMetadata(db, put, lastPushed)).toContain(p.deed);
    expect(puts).toContain(`deed/asset/${p.deed}.json`);
  });

  it('a dirty deed STAYS dirty when the push fails', async () => {
    const p = await deededPlayer();
    markDeedDirty(p.deed);
    const down: ObjectPutter = async () => { throw new Error('R2 down'); };
    await sweepDeedMetadata(db, down, new Map());
    expect(isDeedDirty(p.deed)).toBe(true);
  });
});

/**
 * KEY SCOPING (security review 2026-07-29). The R2 bucket the deed sync writes
 * to ALSO hosts the $KEEP token's identity — keep-metadata-v3.json and
 * keep-token-logo.png, the URI written into the mint. The api holds
 * bucket-scoped write credentials, so the only thing standing between a bug in
 * this file and a silently re-branded token is the key guard.
 *
 * These tests assert the BOUNDARY, not the happy path: every key the sync
 * legitimately produces is allowed, and the token's objects are unreachable by
 * any spelling — including the ones a naive `startsWith('deed/')` would let
 * through.
 */
describe('deed sync cannot write outside deed/', () => {
  const WALLET = 'FQQUhH6tCNFxjpt78GCDhjy4HKMSR4KADJMxUDsLwyd1';

  it('allows exactly the four keys the legacy and stable syncs produce', () => {
    expect(assertDeedKey(`deed/asset/${WALLET}.json`)).toBeTruthy();
    expect(assertDeedKey(`deed/asset/${WALLET}.png`)).toBeTruthy();
    expect(assertDeedKey(`deed/${WALLET}.json`)).toBeTruthy();
    expect(assertDeedKey(`deed/${WALLET}.png`)).toBeTruthy();
  });

  it('refuses the $KEEP token objects, however they are spelled', () => {
    // Plain: the two objects that define the token's name and logo.
    expect(() => assertDeedKey('keep-metadata-v3.json')).toThrow(/REFUSING/);
    expect(() => assertDeedKey('keep-token-logo.png')).toThrow(/REFUSING/);
    // Traversal out of the prefix — this is why the guard enumerates key
    // SHAPES instead of testing the `deed/` prefix, which these would pass.
    expect(() => assertDeedKey('deed/../keep-metadata-v3.json')).toThrow(/REFUSING/);
    expect(() => assertDeedKey('deed/asset/../../keep-token-logo.png')).toThrow(/REFUSING/);
    // Anything else in the bucket, present or future.
    expect(() => assertDeedKey('deed-collection.json')).toThrow(/REFUSING/);
    expect(() => assertDeedKey('')).toThrow(/REFUSING/);
    // An absolute key, and a nested prefix that is not ours.
    expect(() => assertDeedKey('/keep-metadata-v3.json')).toThrow(/REFUSING/);
    expect(() => assertDeedKey('deed/sub/dir/x.json')).toThrow(/REFUSING/);
  });

  it('the guard wraps the PUTTER, so it holds for callers that build their own keys', async () => {
    // The protection must not depend on every call site remembering to check.
    // deedScopedPutter is what r2Putter (the object holding the R2 credentials)
    // and sweepDeedMetadata both return/consume.
    const written: string[] = [];
    const scoped = deedScopedPutter(async (key: string) => { written.push(key); });
    await scoped(`deed/${WALLET}.png`, Buffer.from('x'), 'image/png');
    await expect(scoped('keep-token-logo.png', Buffer.from('x'), 'image/png')).rejects.toThrow(/REFUSING/);
    expect(written).toEqual([`deed/${WALLET}.png`]);
  });
});

interface Doc { name: string; image: string; description: string; attributes: Array<{ trait_type: string; value: unknown }> }
const trait = (d: Doc, t: string): unknown => d.attributes.find((a) => a.trait_type === t)?.value;

describe('the sweep is bounded — it cannot outgrow its own interval', () => {
  /**
   * The scan was `select … where deed_asset_id is not null` with no LIMIT, run
   * on a bare setInterval. Each deed costs ~5 DB round-trips (layoutHash issues
   * 3, buildDeedMetadata 2), so at 20k deeds a pass is minutes long against a
   * 60-second timer — passes stack, each holding connections from a pool of 10,
   * and the symptom is the GAME getting slow with nothing pointing here.
   */
  it('visits at most `limit` deeds per pass', async () => {
    const mine: string[] = [];
    for (let i = 0; i < 4; i++) mine.push((await deededPlayer()).deed);

    const visited: string[] = [];
    const put: ObjectPutter = async () => {};
    await sweepDeedMetadata(db, put, new Map(), { limit: 2, onVisit: (id) => visited.push(id) });

    expect(visited).toHaveLength(2);
  });

  it('the cursor walks FORWARD, so successive passes cover new ground', async () => {
    // Ordering is by asset id, so a cursor of the last id visited must yield
    // strictly greater ids next time. Without this the sweep re-scans the head
    // of the table forever and deeds past the first slice are never reconciled.
    const put: ObjectPutter = async () => {};
    const first: string[] = [];
    await sweepDeedMetadata(db, put, new Map(), { limit: 3, onVisit: (id) => first.push(id) });
    expect(first.length).toBeGreaterThan(0);

    const second: string[] = [];
    await sweepDeedMetadata(db, put, new Map(), {
      limit: 3, after: first[first.length - 1]!, onVisit: (id) => second.push(id),
    });

    for (const id of second) expect(id > first[first.length - 1]!).toBe(true);
    expect(second.some((id) => first.includes(id))).toBe(false);
  });

  it('reports every deed it visits, including ones that needed no republish', async () => {
    // onVisit must not be the pushed list. A slice where nothing changed pushes
    // nothing; a cursor driven off that would never advance.
    await deededPlayer();
    const visited: string[] = [];
    const lastPushed = new Map<string, string>();
    const put: ObjectPutter = async () => {};
    await sweepDeedMetadata(db, put, lastPushed, { limit: 5, onVisit: (id) => visited.push(id) });
    const firstCount = visited.length;

    visited.length = 0;
    // Same lastPushed map → everything is already current → pushes nothing…
    const pushed = await sweepDeedMetadata(db, put, lastPushed, { limit: 5, onVisit: (id) => visited.push(id) });
    expect(pushed).toHaveLength(0);
    expect(visited).toHaveLength(firstCount); // …but still reports the visit
  });
});

/**
 * Liveness reporting (owner 2026-08-03).
 *
 * This exists because the sync stopped for five days and NOTHING noticed: the
 * game stayed healthy, only the NFTs froze, and a player found it by looking at
 * his own deed. These tests pin the judgement calls that make the signal usable
 * instead of noise — a quiet game stays green, a process that was never meant to
 * sync stays green — while a loop that has actually stopped goes red.
 */
describe('deed sync liveness', () => {
  it('a process that does not own the loop is healthy, with a reason', () => {
    // Otherwise every api container and every dev box reports unhealthy forever,
    // and the check gets muted — which is the same outcome as not having it.
    setDeedSyncDisabled('worker container owns the sync');
    const h = deedSyncHealth();
    expect(h.running).toBe(false);
    expect(h.ok).toBe(true);
    expect(h.stale).toBe(false);
    expect(h.disabledReason).toBe('worker container owns the sync');
  });

  it('goes red after several missed ticks, not after one slow sweep', () => {
    const t0 = 1_000_000;
    markDeedSyncRunning(60_000);
    recordDeedSweepOk(0, t0);
    // The loop shares a connection pool with live traffic and will sometimes run
    // long. One or two missed ticks must not flap the check.
    expect(deedSyncHealth(t0 + 120_000).stale, 'one slow sweep').toBe(false);
    // Four minutes of silence is not explicable as slowness.
    const dead = deedSyncHealth(t0 + 5 * 60_000);
    expect(dead.stale).toBe(true);
    expect(dead.ok).toBe(false);
    expect(dead.ageSec).toBe(300);
  });

  it('counts a sweep that pushed NOTHING as healthy', () => {
    // The whole point. Most sweeps push nothing because no base changed; if that
    // read as silence, /health would be red on any quiet game. This is why the
    // signal is last-sweep, not last-push.
    const t0 = 2_000_000;
    markDeedSyncRunning(60_000);
    recordDeedSweepOk(0, t0);
    const h = deedSyncHealth(t0 + 30_000);
    expect(h.ok).toBe(true);
    expect(h.lastPushAt, 'nothing was pushed').toBeNull();
    expect(h.lastSweepOkAt, 'but the loop is alive').toBe(t0);
  });

  it('derives staleness from the ACTUAL interval, not a hardcoded minute', () => {
    // If anyone tunes the cadence, the threshold must move with it or the check
    // silently becomes wrong.
    const t0 = 3_000_000;
    markDeedSyncRunning(10 * 60_000);
    recordDeedSweepOk(1, t0);
    expect(deedSyncHealth(t0 + 5 * 60_000).stale, 'inside one 10-min tick').toBe(false);
    expect(deedSyncHealth(t0 + 45 * 60_000).stale, 'four 10-min ticks missed').toBe(true);
  });

  it('a failing sweep surfaces the error but does not fake a heartbeat', () => {
    const t0 = 4_000_000;
    markDeedSyncRunning(60_000);
    recordDeedSweepOk(2, t0);
    recordDeedSweepError(new Error('R2 PUT 403'), t0 + 60_000);
    const h = deedSyncHealth(t0 + 90_000);
    expect(h.lastError).toBe('R2 PUT 403');
    expect(h.consecutiveFailures).toBe(1);
    // The loop is still ticking, so it is not stale yet — but the heartbeat must
    // NOT have advanced, or persistent failure would look healthy forever.
    expect(h.lastSweepOkAt).toBe(t0);
    expect(h.stale).toBe(false);
    // ...and once the failures outlast the stale window, it goes red.
    expect(deedSyncHealth(t0 + 5 * 60_000).stale).toBe(true);
  });

  it('a recovered sweep clears the failure state', () => {
    const t0 = 5_000_000;
    markDeedSyncRunning(60_000);
    recordDeedSweepError(new Error('transient'), t0);
    recordDeedSweepOk(1, t0 + 60_000);
    const h = deedSyncHealth(t0 + 60_000);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastError).toBeNull();
    expect(h.ok).toBe(true);
  });

  it('does not serve 503 on the way up, before the first sweep lands', () => {
    // A deploy must not flash red for its first minute. But it must NOT be
    // permanently green either: if the first sweep never arrives, that IS a dead
    // sync and the whole point is to notice.
    const t0 = 6_000_000;
    markDeedSyncRunning(60_000, t0);
    expect(deedSyncHealth(t0 + 1_000).stale, 'one second after boot').toBe(false);
    expect(deedSyncHealth(t0 + 60_000).stale, 'first tick, still starting').toBe(false);
    expect(deedSyncHealth(t0 + 10 * 60_000).stale, 'first sweep NEVER arrived').toBe(true);
  });

  it('a restart does not inherit the previous process heartbeat', () => {
    // lastSweepOkAt is module state. If a restart kept the old stamp, a worker
    // that boots and immediately fails to sweep would read as healthy using a
    // heartbeat from a process that no longer exists.
    const t0 = 7_000_000;
    markDeedSyncRunning(60_000, t0);
    recordDeedSweepOk(1, t0);
    expect(deedSyncHealth(t0).lastSweepOkAt).toBe(t0);
    markDeedSyncRunning(60_000, t0 + 60_000); // "restart"
    expect(deedSyncHealth(t0 + 60_000).lastSweepOkAt).toBeNull();
  });
});
