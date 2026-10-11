/**
 * On-chain deed URI sync.
 *
 * This exists because the deed was "dynamic" in every layer except the one the
 * player looks at: R2 served Keep 17 / 111 buildings while every wallet and the
 * Solana explorer showed Keep 15 / 85, indefinitely, because DAS only re-reads a
 * document when something ON CHAIN changes. So the properties worth pinning are
 * about SPENDING: this loop signs with the deed authority and pays a fee, and
 * the ways it can go wrong are "writes when it should not" (money) and "does not
 * write when it should" (the original bug).
 *
 * `sendUpdates` is injected, so nothing here can reach an RPC or a signer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { deedJsonUriVersioned, deedUriVersion, type DeedUriUpdate } from '@shardkeep/chain';
import { buildApp } from '../src/app';
import { deedChainSyncConfig } from '../src/jobs';
import { bases, players } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_CHAIN_SYNC_MS, chainUriIsCurrent, deedChainSyncHealth, markDeedChainSyncRunning,
  metadataVersion, recordDeedChainSweepError, recordDeedChainSweepOk, setDeedChainSyncDisabled,
  startDeedChainSync, sweepDeedChain, type DeedChainConfig,
} from '../src/game/deedChainSync';
import { buildDeedMetadata } from '../src/game/deedMetadata';
import { bootstrapSystemAccounts } from '../src/ledger';
import { TEST_CONFIG, connectTestDb, createTestPlayer, randomWallet } from './helpers';

const conn = connectTestDb();
const db = conn.db;
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

const BASE = 'https://pub-abc.r2.dev';

async function deededPlayer(): Promise<{ wallet: string; deed: string }> {
  const p = await createTestPlayer(db);
  const deed = randomWallet();
  await db.update(players)
    .set({ entryPaidAt: new Date(), deedAssetId: deed })
    .where(eq(players.wallet, p.wallet));
  return { wallet: p.wallet, deed };
}

/** Stands in for deedR2's record of what it last PUBLISHED. Built from the DB
 *  so a test can move a trait and re-publish, exactly as the real loop does. */
function publisher(): {
  publish: (assetId: string, wallet: string) => Promise<void>;
  read: (assetId: string) => string | null;
} {
  const docs = new Map<string, string>();
  return {
    publish: async (assetId, wallet) => {
      const meta = await buildDeedMetadata(db, wallet);
      docs.set(assetId, JSON.stringify(meta));
    },
    read: (assetId) => docs.get(assetId) ?? null,
  };
}

/** Records what WOULD be sent, and answers as a chain that accepted it all. */
function recorder(): {
  calls: DeedUriUpdate[][];
  send: (u: readonly DeedUriUpdate[]) => Promise<{
    updated: number; txs: number; alreadyCurrent: number; missing: string[];
  }>;
} {
  const calls: DeedUriUpdate[][] = [];
  return {
    calls,
    send: async (u) => {
      calls.push([...u]);
      // 6 updates per transaction — measured against devnet, not assumed.
      return { updated: u.length, txs: Math.ceil(u.length / 6), alreadyCurrent: 0, missing: [], failed: [] };
    },
  };
}

describe('deed chain sync', () => {
  it('asks for a versioned URI whose version is the document hash', async () => {
    const { wallet, deed } = await deededPlayer();
    const pub = publisher();
    await pub.publish(deed, wallet);
    const rec = recorder();
    await sweepDeedChain(db, { publicBaseUrl: BASE }, rec.send, { published: pub.read });

    const sent = rec.calls.flat().find((u) => u.asset === deed);
    expect(sent, 'the deeded player must be swept').toBeDefined();
    // Path preserved, version present — a version in the PATH would 404 and
    // every wallet would show a broken deed.
    expect(sent!.uri.startsWith(`${BASE}/deed/asset/${deed}.json?v=`)).toBe(true);
    expect(deedUriVersion(sent!.uri)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is STABLE across sweeps when nothing changed — this is the whole cost story', async () => {
    // Each write costs a transaction. If an unchanged base produced a new URI,
    // every deed would be rewritten on every tick forever. The on-chain updater
    // skips assets already carrying the URI, so stability is what makes the
    // steady state free.
    const { wallet, deed } = await deededPlayer();
    const pub = publisher();
    await pub.publish(deed, wallet);
    const a = recorder();
    const b = recorder();
    await sweepDeedChain(db, { publicBaseUrl: BASE }, a.send, { published: pub.read });
    await sweepDeedChain(db, { publicBaseUrl: BASE }, b.send, { published: pub.read });
    const first = a.calls.flat().find((u) => u.asset === deed)!;
    const second = b.calls.flat().find((u) => u.asset === deed)!;
    expect(second.uri).toBe(first.uri);
  });

  it('changes the version when the base changes — the bug this fixes', async () => {
    const { wallet, deed } = await deededPlayer();
    const pub = publisher();
    await pub.publish(deed, wallet);
    const before = recorder();
    await sweepDeedChain(db, { publicBaseUrl: BASE }, before.send, { published: pub.read });
    const uriBefore = before.calls.flat().find((u) => u.asset === deed)!.uri;

    // A trait a wallet renders (Keep Level) moves, AND the new document is
    // published — in that order, which is the invariant this feature rests on.
    await db.update(players).set({ keepLevel: 9 }).where(eq(players.wallet, wallet));
    await pub.publish(deed, wallet);

    const after = recorder();
    await sweepDeedChain(db, { publicBaseUrl: BASE }, after.send, { published: pub.read });
    const uriAfter = after.calls.flat().find((u) => u.asset === deed)!.uri;
    expect(uriAfter).not.toBe(uriBefore);
  });

  it('sends nothing at all when no player holds a deed', async () => {
    // A fresh cursor past the end must not produce an empty transaction.
    const rec = recorder();
    const r = await sweepDeedChain(db, { publicBaseUrl: BASE }, rec.send, {
      after: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', published: () => '{}',
    });
    expect(rec.calls).toEqual([]);
    expect(r.updated).toBe(0);
    expect(r.txs).toBe(0);
  });

  it('reports the batching win, so the cost is observable', async () => {
    // The API suite intentionally shares one database across files. Restrict
    // the publisher to this test's seven assets so a malformed compatibility
    // fixture from another file cannot occupy one of a global LIMIT 7 and turn
    // this cost assertion into an order-dependent 6/7 result.
    const deeds = new Set<string>();
    for (let i = 0; i < 7; i++) deeds.add((await deededPlayer()).deed);
    const rec = recorder();
    const r = await sweepDeedChain(db, { publicBaseUrl: BASE }, rec.send, {
      limit: 1_000, published: (a) => deeds.has(a) ? `{"doc":"${a}"}` : null,
    });
    expect(r.updated).toBe(7);
    // 7 updates at 6 per transaction is 2 — the point being that txs < updated.
    expect(r.txs).toBe(2);
    expect(r.txs).toBeLessThan(r.updated);
  });

  it('returns a cursor so a large fleet spreads across ticks', async () => {
    await deededPlayer();
    const rec = recorder();
    const pub = (a: string): string => `{"doc":"${a}"}`;
    const r = await sweepDeedChain(db, { publicBaseUrl: BASE }, rec.send, { limit: 1, published: pub });
    expect(r.cursor).toBeTruthy();
    // The cursor is an asset id, and the next pass starts strictly after it.
    const next = await sweepDeedChain(db, { publicBaseUrl: BASE }, recorder().send, {
      after: r.cursor!, limit: 1, published: pub,
    });
    expect(next.cursor).not.toBe(r.cursor);
  });

  it('versions every stable deed independently when one wallet owns several bases', async () => {
    const previous = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const owner = await createTestPlayer(db);
      const deedA = randomWallet();
      const deedB = randomWallet();
      await db.insert(bases).values([
        { ownerWallet: owner.wallet, deedAssetId: deedA, landPaidAt: new Date() },
        { ownerWallet: owner.wallet, deedAssetId: deedB, landPaidAt: new Date(), keepLevel: 2 },
      ]);
      const docs = new Map([
        [deedA, '{"base":"a"}'],
        [deedB, '{"base":"b"}'],
      ]);
      const rec = recorder();
      await sweepDeedChain(db, { publicBaseUrl: BASE }, rec.send, {
        // The API suite shares one database and can contain more than the
        // production sweep's 200-row page by the time this file runs. Include
        // the full fixture fleet so these two random ids cannot land on a later
        // cursor page and turn the assertion into a test-order lottery.
        limit: 1_000,
        published: (asset) => docs.get(asset) ?? null,
      });
      const sent = rec.calls.flat().filter((row) => row.asset === deedA || row.asset === deedB);
      expect(sent.map((row) => row.asset).sort()).toEqual([deedA, deedB].sort());
      expect(new Set(sent.map((row) => row.uri)).size).toBe(2);
      expect(sent.find((row) => row.asset === deedA)!.uri)
        .toContain(`v=${metadataVersion(docs.get(deedA)!)}`);
      expect(sent.find((row) => row.asset === deedB)!.uri)
        .toContain(`v=${metadataVersion(docs.get(deedB)!)}`);
    } finally {
      if (previous === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = previous;
    }
  });
});

describe('deed chain sync — the ordering invariant', () => {
  it('does NOT advertise a version before the document exists', async () => {
    // THE SUBTLE ONE. Hashing the live DB would stamp ?v=<new> on chain while
    // R2 still holds the OLD document. DAS reacts in seconds, fetches the old
    // bytes, caches them — and never looks again, because the on-chain URI
    // already equals the new version. That is the original stale-deed bug
    // wearing the fix as a disguise, so an unpublished deed must be SKIPPED.
    const { deed } = await deededPlayer();
    const rec = recorder();
    const r = await sweepDeedChain(db, { publicBaseUrl: BASE }, rec.send, {
      published: () => null, // nothing published yet
    });
    expect(rec.calls.flat().find((u) => u.asset === deed), 'must not be versioned yet').toBeUndefined();
    expect(r.updated).toBe(0);
  });

  it('versions a LAYOUT-only change, because the published doc carries the image', async () => {
    // Moving a building changes the picture but no trait. Hashing DB traits
    // alone would never move the URI, so the deed's picture — the whole visual
    // of the NFT — would never update in any wallet.
    const { deed } = await deededPlayer();
    const docs = new Map([[deed, '{"image":"…png?v=aaaaaaaa","attributes":[]}']]);
    const a = recorder();
    await sweepDeedChain(db, { publicBaseUrl: BASE }, a.send, { published: (k) => docs.get(k) ?? null });
    const before = a.calls.flat().find((u) => u.asset === deed)!.uri;

    // Same traits, new picture — exactly what a building move produces.
    docs.set(deed, '{"image":"…png?v=bbbbbbbb","attributes":[]}');
    const b = recorder();
    await sweepDeedChain(db, { publicBaseUrl: BASE }, b.send, { published: (k) => docs.get(k) ?? null });
    const after = b.calls.flat().find((u) => u.asset === deed)!.uri;
    expect(after).not.toBe(before);
  });

  it('a send failure still returns a cursor, so the fleet cannot freeze', async () => {
    // If a failed send threw out of the sweep, the caller's cursor would never
    // advance: the next tick re-reads the same page, fails identically, and
    // every deed after it is never visited again — permanently, on one bad row.
    await deededPlayer();
    const failing = async (u: readonly DeedUriUpdate[]): Promise<{
      updated: number; txs: number; alreadyCurrent: number; missing: string[]; failed: string[];
    }> => ({ updated: 0, txs: 0, alreadyCurrent: 0, missing: [], failed: u.map((x) => x.asset) });
    const r = await sweepDeedChain(db, { publicBaseUrl: BASE }, failing, {
      limit: 1, published: (a) => `{"doc":"${a}"}`,
    });
    expect(r.cursor, 'cursor must advance even when nothing confirmed').toBeTruthy();
    expect(r.failed.length).toBe(1);
    expect(r.updated).toBe(0);
  });

  it('skips a malformed deed_asset_id instead of batching it', async () => {
    const p = await createTestPlayer(db);
    await db.update(players)
      .set({ entryPaidAt: new Date(), deedAssetId: 'not-a-real-address' })
      .where(eq(players.wallet, p.wallet));
    const rec = recorder();
    await sweepDeedChain(db, { publicBaseUrl: BASE }, rec.send, { published: () => '{}' });
    expect(rec.calls.flat().some((u) => u.asset === 'not-a-real-address')).toBe(false);
  });
});

describe('metadataVersion', () => {
  it('is 8 hex chars, so the on-chain URI is fixed width', () => {
    // A Core asset stores its URI on chain; a variable-width version would
    // charge rent every time the length changed.
    for (const doc of ['{}', JSON.stringify({ a: 1 }), 'x'.repeat(5000)]) {
      expect(metadataVersion(doc)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('differs for documents that differ by one trait', () => {
    const a = JSON.stringify({ attributes: [{ trait_type: 'Keep Level', value: 15 }] });
    const b = JSON.stringify({ attributes: [{ trait_type: 'Keep Level', value: 17 }] });
    expect(metadataVersion(a)).not.toBe(metadataVersion(b));
  });
});

describe('chainUriIsCurrent', () => {
  it('treats a pre-migration unversioned URI as NOT current', () => {
    // Deeds minted before versioning carry a bare URI. They must be rewritten
    // exactly once; reading them as current would strand them forever.
    expect(chainUriIsCurrent(`${BASE}/deed/asset/abc.json`, 'a1b2c3d4')).toBe(false);
  });

  it('matches only the exact version', () => {
    const uri = deedJsonUriVersioned(BASE, 'abc', 'a1b2c3d4');
    expect(chainUriIsCurrent(uri, 'a1b2c3d4')).toBe(true);
    expect(chainUriIsCurrent(uri, 'ffffffff')).toBe(false);
  });
});

/**
 * Liveness (security review 2026-08-03 follow-up #5) — same recorder story as
 * deedR2's, because the chain leg has the SAME silent failure shape: R2 keeps
 * publishing, the game stays healthy, and every wallet quietly freezes at the
 * last URI that made it on chain. Plus the failure mode deedR2 does not have:
 * a loop that ticks perfectly but cannot SPEND (empty payer) is just as frozen,
 * and must go red rather than idle green.
 */
describe('deed chain sync liveness (review follow-up #5)', () => {
  const CFG: DeedChainConfig = {
    // Deliberately unreachable: nothing in these tests may touch an RPC. The
    // balance reader is injected, and a sweep with nothing published sends
    // nothing, so a connection attempt would itself be a failure.
    rpcUrl: 'http://127.0.0.1:1',
    adminSecret: new Uint8Array(64),
    collection: 'So11111111111111111111111111111111111111112',
    publicBaseUrl: BASE,
  };

  it('a process that does not own the loop is healthy, with a reason', () => {
    // DEED_CHAIN_SYNC is default-false; if that read as red, every dev box and
    // every api container would alarm forever and the check would get muted.
    setDeedChainSyncDisabled('DEED_CHAIN_SYNC not enabled');
    const h = deedChainSyncHealth();
    expect(h.running).toBe(false);
    expect(h.ok).toBe(true);
    expect(h.stale).toBe(false);
    expect(h.disabledReason).toBe('DEED_CHAIN_SYNC not enabled');
  });

  it('goes red after several missed ticks OF THE REAL 10-min interval', () => {
    // Staleness must be derived from the configured cadence: at 10 minutes a
    // hardcoded few-minute window would flap on every single slow sweep.
    const t0 = 1_000_000;
    markDeedChainSyncRunning(DEFAULT_CHAIN_SYNC_MS, t0);
    recordDeedChainSweepOk(0, t0);
    expect(deedChainSyncHealth(t0 + 2 * DEFAULT_CHAIN_SYNC_MS).stale, 'one slow sweep').toBe(false);
    const dead = deedChainSyncHealth(t0 + 5 * DEFAULT_CHAIN_SYNC_MS);
    expect(dead.stale).toBe(true);
    expect(dead.ok).toBe(false);
  });

  it('a sweep that wrote NOTHING is the healthy steady state', () => {
    // Most sweeps write nothing because no deed changed. If that read as
    // silence, /health would be red on any quiet day — the signal is the
    // sweep completing, not SOL being spent.
    const t0 = 2_000_000;
    markDeedChainSyncRunning(DEFAULT_CHAIN_SYNC_MS, t0);
    recordDeedChainSweepOk(0, t0);
    const h = deedChainSyncHealth(t0 + 60_000);
    expect(h.ok).toBe(true);
    expect(h.lastWriteAt, 'nothing was written').toBeNull();
    expect(h.lastSweepOkAt, 'but the loop is alive').toBe(t0);
  });

  it('a failing sweep surfaces the error but never fakes a heartbeat', () => {
    const t0 = 3_000_000;
    markDeedChainSyncRunning(DEFAULT_CHAIN_SYNC_MS, t0);
    recordDeedChainSweepOk(3, t0);
    recordDeedChainSweepError(new Error('RPC 503'), t0 + DEFAULT_CHAIN_SYNC_MS);
    const h = deedChainSyncHealth(t0 + 2 * DEFAULT_CHAIN_SYNC_MS);
    expect(h.lastError).toBe('RPC 503');
    expect(h.consecutiveFailures).toBe(1);
    // The heartbeat must NOT have advanced, or persistent failure would look
    // healthy forever...
    expect(h.lastSweepOkAt).toBe(t0);
    expect(h.stale).toBe(false);
    // ...and once the failures outlast the stale window, it goes red.
    expect(deedChainSyncHealth(t0 + 5 * DEFAULT_CHAIN_SYNC_MS).ok).toBe(false);
  });

  it('an EMPTY PAYER is a failure, not an idle-green skip', async () => {
    // The MIN_PAYER_SOL floor makes the loop decline to spend — correct, but a
    // permanently-empty payer freezes every deed exactly like a dead loop, and
    // before this the only symptom was a warning every 10 minutes in a log
    // nobody reads. The real pass() must record it so /health ages into red.
    const loop = startDeedChainSync(db, CFG, 60_000, async () => 0);
    try {
      await vi.waitFor(() => {
        expect(deedChainSyncHealth().lastError).toMatch(/below the .* floor/);
      });
    } finally {
      loop.stop();
    }
    const h = deedChainSyncHealth();
    expect(h.lastSweepOkAt, 'a declined sweep is NOT a heartbeat').toBeNull();
    expect(h.consecutiveFailures).toBeGreaterThanOrEqual(1);
    // Once the poverty outlasts the stale window, the check goes red.
    expect(deedChainSyncHealth(Date.now() + 5 * 60_000).ok).toBe(false);
  });

  it('the real loop stamps the heartbeat after a completed sweep', async () => {
    // Wires pass() → recordDeedChainSweepOk. With nothing published this
    // process, the sweep skips every deed and sends nothing — a full pass that
    // spends zero SOL, which is exactly the state a healthy quiet loop is in.
    const loop = startDeedChainSync(db, CFG, 60_000, async () => 1);
    try {
      await vi.waitFor(() => {
        expect(deedChainSyncHealth().lastSweepOkAt).not.toBeNull();
      });
    } finally {
      loop.stop();
    }
    expect(deedChainSyncHealth().ok).toBe(true);
  });

  it('GET /health serves 503 when the loop owns the sync and has stopped', async () => {
    // The end-to-end wiring: recorder → app.ts. An ordinary HTTP uptime check
    // must catch a dead chain loop with no extra tooling.
    const app = await buildApp(TEST_CONFIG, db);
    await app.ready();
    try {
      // Started an hour ago, no sweep ever landed — unambiguously dead.
      markDeedChainSyncRunning(60_000, Date.now() - 60 * 60_000);
      const res = await app.inject({ url: '/health' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { ok: boolean; deedChainSync: { stale: boolean } };
      expect(body.ok).toBe(false);
      expect(body.deedChainSync.stale).toBe(true);
    } finally {
      // Never leak a red global into other tests.
      setDeedChainSyncDisabled('test reset');
      await app.close();
    }
  });
});

/**
 * deedChainSyncConfig — signer preference (dynamic deeds, owner GO 2026-08-03).
 *
 * The coupling pinned here: the UNATTENDED sweep signs with the DEED-OPS
 * delegate key whenever one is configured, and only falls back to the admin
 * key — loudly — when it is not. If a refactor dropped the preference, the
 * loop would silently return to holding the key that mints KEEP and moves the
 * treasury, which is precisely the exposure the ops key exists to remove; a
 * silent fallback would hide the same regression behind a working loop.
 */
describe('deedChainSyncConfig — deed-ops signer preference', () => {
  const ENV_KEYS = [
    'DEED_CHAIN_SYNC', 'DEED_OPS_KEYPAIR_PATH', 'ADMIN_KEYPAIR_PATH',
    'REPO_ROOT', 'R2_PUBLIC_BASE_URL',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  const admin = Keypair.generate();
  const ops = Keypair.generate();
  let dir: string;
  let adminPath: string;
  let opsPath: string;

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = mkdtempSync(path.join(tmpdir(), 'deed-ops-'));
    adminPath = path.join(dir, 'admin.json');
    opsPath = path.join(dir, 'ops.json');
    writeFileSync(adminPath, JSON.stringify(Array.from(admin.secretKey)));
    writeFileSync(opsPath, JSON.stringify(Array.from(ops.secretKey)));
    process.env['DEED_CHAIN_SYNC'] = 'true';
    // The real repo root: the config reads infra/devnet.addresses.json for the
    // collection, and a fake root would test a disabled loop instead.
    process.env['REPO_ROOT'] = fileURLToPath(new URL('../../..', import.meta.url));
    // Non-loopback public base, or deedAssetBase() disables the loop.
    process.env['R2_PUBLIC_BASE_URL'] = BASE;
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers DEED_OPS_KEYPAIR_PATH for the signer when both keys are set', () => {
    process.env['ADMIN_KEYPAIR_PATH'] = adminPath;
    process.env['DEED_OPS_KEYPAIR_PATH'] = opsPath;
    const cfg = deedChainSyncConfig();
    expect(cfg).not.toBeNull();
    // The OPS secret, byte for byte — "prefers" means signs-with, not just reads.
    expect(Buffer.from(cfg!.adminSecret).equals(Buffer.from(ops.secretKey))).toBe(true);
  });

  it('falls back to the admin key when no ops key is set — and says so at boot', () => {
    // Allowed (existing deployments keep working on upgrade), but never silent:
    // the operator must learn at boot that the loop spends from the master key.
    process.env['ADMIN_KEYPAIR_PATH'] = adminPath;
    delete process.env['DEED_OPS_KEYPAIR_PATH'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = deedChainSyncConfig();
      expect(cfg).not.toBeNull();
      expect(Buffer.from(cfg!.adminSecret).equals(Buffer.from(admin.secretKey))).toBe(true);
      expect(warn.mock.calls.flat().join(' ')).toContain('DEED_OPS_KEYPAIR_PATH');
    } finally {
      warn.mockRestore();
    }
  });

  it('no signer at all still disables the loop', () => {
    delete process.env['ADMIN_KEYPAIR_PATH'];
    delete process.env['DEED_OPS_KEYPAIR_PATH'];
    expect(deedChainSyncConfig()).toBeNull();
  });
});
