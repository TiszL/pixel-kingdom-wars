/** DEV_LOGIN_REALM (docs/REALM-THEMES-PLAN.md §3 P0 "Dev realm switch"): the realm
 * kits are reviewed one realm at a time under a REAL base, so the stable dev-login
 * base must change realm from the env alone. WHY these pins: an assigned fantasy
 * claim is immutable by trigger (drizzle/0118 fantasy_claim_identity_guard), so the
 * switch cannot move the claim — it must (1) seed a fresh dev base in the realm,
 * (2) make an already-seated dev base PRESENT the realm on every reader while the
 * persisted address stays where it is, (3) never touch a paid or migrated base,
 * (4) re-seat the kit's expansion obstacle rows so the previous realm's trees do
 * not stand in the new one, (5) do nothing when unset, (6) never exist in
 * production (config.test.ts), (7) purge nothing while the fantasy world is off,
 * since it then presents nothing (the flags are live-env reads; the boot-time
 * refusal in config.ts does not cover a value flipped after boot). */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GRID } from '@shardkeep/shared';
import { currentBaseVisualForRealm } from '@shardkeep/shared/baseVisual';
import { fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { bases, builderJobs, deposits, fantasyLandClaims, obstacles, plots } from '../src/db/schema';
import { resolveBaseVisual } from '../src/game/baseVisual';
import { installFantasyCatalog } from '../src/game/fantasyLocation';
import { resolveFantasyLocation } from '../src/game/fantasyLocationRead';
import { fantasyBaseFixture } from './fantasy-fixtures';
import { isolatedFantasyTestDb } from './fantasy-test-db';
import { TEST_CONFIG, randomWallet } from './helpers';

const conn = isolatedFantasyTestDb(); const db = conn.db;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  await conn.prepare();
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('FANTASY_WORLD_ENABLED', 'true'); vi.stubEnv('DEV_LOGIN', 'true');
  app = await buildApp({ ...TEST_CONFIG, NODE_ENV: 'development' }, db);
  await app.ready();
});
afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); await conn.dispose(); });

const switchTo = (realm: string | undefined) => { if (realm === undefined) vi.stubEnv('DEV_LOGIN_REALM', ''); else vi.stubEnv('DEV_LOGIN_REALM', realm); };
async function login(wallet: string) {
  const response = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { wallet } });
  expect(response.statusCode).toBe(200);
  return response.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}
async function presented(cookie: string) {
  const base = await app.inject({ url: '/base', cookies: { [SESSION_COOKIE]: cookie } });
  expect(base.statusCode).toBe(200);
  const list = await app.inject({ url: '/bases', cookies: { [SESSION_COOKIE]: cookie } });
  expect(list.statusCode).toBe(200);
  const address = (list.json() as { bases: Array<{ fantasyLocation: { realmId: string } | null }> }).bases[0]!.fantasyLocation!;
  return { visual: (base.json() as { visualContext: { realmId: string } }).visualContext, address };
}
const liveClaim = async (baseId: string) => (await db.select().from(fantasyLandClaims)
  .where(and(eq(fantasyLandClaims.baseId, baseId), eq(fantasyLandClaims.state, 'assigned'))))[0]!;
const offPlotRows = (baseId: string) => db.select().from(obstacles).where(eq(obstacles.baseId, baseId))
  .then((rows) => rows.filter((r) => r.tx < 0 || r.tx >= GRID.plotTiles || r.ty < 0 || r.ty >= GRID.plotTiles));

describe('DEV_LOGIN_REALM presents the stable dev base in the realm under review', () => {
  it('seeds a fresh dev base in the realm, then presents another realm on the next login without moving the claim', async () => {
    const wallet = randomWallet();
    switchTo('frostveil');
    const first = await presented(await login(wallet));
    expect(first).toEqual({ visual: currentBaseVisualForRealm('frostveil'), address: expect.objectContaining({ realmId: 'frostveil' }) });
    const [base] = await db.select().from(bases).where(eq(bases.ownerWallet, wallet));
    const claim = await liveClaim(base!.id);
    expect((await db.select().from(plots).where(eq(plots.baseId, base!.id)))[0]).toMatchObject({ addressKind: 'fantasy', fantasyTileId: claim.tileId });

    switchTo('crownlands');
    const second = await presented(await login(wallet));
    // Presentation follows the switch on every reader; the persisted address does not (immutable claim).
    expect(second.visual).toEqual(currentBaseVisualForRealm('crownlands'));
    expect(second.address.realmId).toBe('frostveil');
    expect(await liveClaim(base!.id)).toEqual(claim);
    expect(await resolveBaseVisual(db, base!.id)).toEqual(currentBaseVisualForRealm('crownlands'));
    // The reader's own gate (config.ts devLoginRealm): with DEV_LOGIN off the value is inert even
    // though this app was built past loadConfig — a stale switch must not present the fixture
    // base elsewhere on a host that cannot dev-login.
    vi.stubEnv('DEV_LOGIN', 'false');
    try { expect(await resolveBaseVisual(db, base!.id)).toEqual(currentBaseVisualForRealm('frostveil')); }
    finally { vi.stubEnv('DEV_LOGIN', 'true'); }

    // Unset: the base presents its persisted address again — the pre-switch behaviour.
    switchTo(undefined);
    const third = await presented(await login(wallet));
    expect(third.visual).toEqual(currentBaseVisualForRealm('frostveil'));
    expect(await liveClaim(base!.id)).toEqual(claim);
  });

  it('re-seats the kit obstacle rows on every login under the switch, keeping the plot scatter and any row a builder job touched', async () => {
    const wallet = randomWallet();
    switchTo(undefined);
    await login(wallet);
    const [base] = await db.select().from(bases).where(eq(bases.ownerWallet, wallet));
    // Kit rows sit off the legacy plot (kitObstacles.ts seats nothing on it); the starting scatter sits on it.
    const [standing, cleared] = await db.insert(obstacles).values([
      { playerWallet: wallet, baseId: base!.id, spriteKey: 'tree_old', tx: -3, ty: 12 },
      { playerWallet: wallet, baseId: base!.id, spriteKey: 'bush', tx: 33, ty: 4, clearedAt: new Date() },
    ]).returning();
    // The cleared row's job holds its shard-debit receipt: the row is audit, not scenery, and survives.
    await db.insert(builderJobs).values({ playerWallet: wallet, baseId: base!.id, kind: 'clear_obstacle', obstacleId: cleared!.id,
      finishesAt: new Date(), completedAt: new Date() });
    const scatter = (await db.select().from(obstacles).where(and(eq(obstacles.baseId, base!.id), isNull(obstacles.clearedAt)))).length - 1;
    expect(scatter).toBeGreaterThan(0);
    await login(wallet);
    expect((await offPlotRows(base!.id)).map((r) => r.id).sort()).toEqual([standing!.id, cleared!.id].sort()); // unset: never touched
    switchTo('elderwood');
    await login(wallet);
    expect((await offPlotRows(base!.id)).map((r) => r.id)).toEqual([cleared!.id]);
    expect(await db.select().from(obstacles).where(and(eq(obstacles.baseId, base!.id), isNull(obstacles.clearedAt)))).toHaveLength(scatter);
  });

  it('presents a base that has no fantasy address at all, and re-seats its kit rows, with the fantasy world off', async () => {
    // The local review host runs WITHOUT the fantasy world (its dev DB cannot pass the
    // deed-economy cutover that MULTI_BASE_ENABLED triggers), so the owner's 112-building
    // legacy base has no fantasy claim. The switch must still present the realm under review
    // there — that base IS the review base (docs/REALM-THEMES-PLAN.md §3 P0) — and the purge
    // must still run, since the base now presents a realm whose kit seats different rows.
    const wallet = randomWallet();
    vi.stubEnv('FANTASY_WORLD_ENABLED', 'false');
    try {
      switchTo(undefined);
      await login(wallet);
      const [base] = await db.select().from(bases).where(eq(bases.ownerWallet, wallet));
      expect(await resolveFantasyLocation(db, base!.id)).toBeNull();
      expect(await resolveBaseVisual(db, base!.id)).toEqual(currentBaseVisualForRealm('crownlands'));
      const [standing] = await db.insert(obstacles).values([
        { playerWallet: wallet, baseId: base!.id, spriteKey: 'tree_old', tx: -3, ty: 12 },
      ]).returning();
      switchTo('elderwood');
      expect(await resolveBaseVisual(db, base!.id)).toEqual(currentBaseVisualForRealm('elderwood'));
      // A legacy single-base host reads GET /base by wallet and passes no base id at all.
      expect(await resolveBaseVisual(db, undefined)).toEqual(currentBaseVisualForRealm('elderwood'));
      await login(wallet);
      expect(await offPlotRows(base!.id)).toEqual([]);
      expect(standing).toBeDefined();
      switchTo(undefined);
      expect(await resolveBaseVisual(db, base!.id)).toEqual(currentBaseVisualForRealm('crownlands'));
    } finally {
      vi.stubEnv('FANTASY_WORLD_ENABLED', 'true');
      switchTo(undefined);
    }
  });

  it('never presents a migrated or paid claim elsewhere, and refuses an unknown realm loudly', async () => {
    const migrated = await fantasyBaseFixture(db, { installClaim: true });
    const paid = await fantasyBaseFixture(db);
    await db.transaction((tx) => installFantasyCatalog(tx));
    const occupied = new Set((await db.select({ tileId: fantasyLandClaims.tileId }).from(fantasyLandClaims)).map((c) => c.tileId));
    const tile = [...fantasyTiles('sunscar')].find((t) => t.allocation === 'ordinary' && !occupied.has(t.tileId))!;
    const [receipt] = await db.insert(deposits).values({ playerWallet: paid.wallet, kind: 'entry', reference: `paid:${paid.baseId}`,
      status: 'credited', amount: 200_000_000n, finalizedAt: new Date(), payload: { baseId: paid.baseId } }).returning();
    await db.insert(fantasyLandClaims).values({ worldId: tile.worldId, tileId: tile.tileId, baseId: paid.baseId,
      source: 'purchase', depositId: receipt!.id, state: 'assigned', assignedAt: new Date() });
    switchTo('frostveil');
    expect((await resolveBaseVisual(db, migrated.baseId)).realmId).toBe('crownlands');
    expect((await resolveBaseVisual(db, paid.baseId)).realmId).toBe('sunscar');
    switchTo('atlantis');
    await expect(resolveBaseVisual(db, migrated.baseId)).rejects.toThrow('DEV_LOGIN_REALM');
    switchTo(undefined);
  });
});
