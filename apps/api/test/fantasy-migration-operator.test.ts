import { randomUUID } from 'node:crypto';
import { ECONOMY } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyFantasyMigration, fantasyManifestHash, planFantasyMigration } from '../src/db/fantasyMigration';
import { assertFantasyMigrationOperator, parseFantasyMigrationOperatorArgs } from '../src/db/fantasyMigrationOperator';
import { bases, deposits, fantasyLandClaims, fantasyMigrationBatches, plots, plotReservations } from '../src/db/schema';
import { activateFantasyPurchaseCutover, fantasyPurchasesCutOver, getFantasyClaim, installFantasyCatalog, pendingLegacyFantasyPurchases, stageLockedLegacyFantasyPurchases } from '../src/game/fantasyLocation';
import { createDepositIntent, creditDeposit } from '../src/money/deposits';
import { createTestPlayer } from './helpers';
import { fantasyBaseFixture } from './fantasy-fixtures';
import { isolatedFantasyTestDb } from './fantasy-test-db';

const conn = isolatedFantasyTestDb(); const db = conn.db;
const originalFantasy = process.env['FANTASY_WORLD_ENABLED']; const originalMulti = process.env['MULTI_BASE_ENABLED'];
beforeAll(async () => { await conn.prepare(); await db.transaction(installFantasyCatalog);
  process.env['FANTASY_WORLD_ENABLED'] = 'false'; process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => {
  if (originalFantasy === undefined) delete process.env['FANTASY_WORLD_ENABLED']; else process.env['FANTASY_WORLD_ENABLED'] = originalFantasy;
  if (originalMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = originalMulti;
  await conn.dispose();
});
const hash = 'a'.repeat(64); const sha = 'b'.repeat(40);
const args = ['--manifest', 'private.json', '--expected-manifest-hash', hash, '--expected-build-sha', sha];
const context = { manifestHash: hash, buildSha: sha, gitSha: sha, gitDirty: false, fantasyEnabled: 'false', multiBaseEnabled: 'true' };

describe('reviewed fantasy release operator', () => {
  it('defaults to rollback and requires exact explicit approval/build identities before DB access', () => {
    const options = parseFantasyMigrationOperatorArgs(args);
    expect(options.apply).toBe(false);
    const applying = parseFantasyMigrationOperatorArgs(['--apply', ...args]);
    expect(() => assertFantasyMigrationOperator(applying, context)).not.toThrow();
    expect(() => assertFantasyMigrationOperator(options, { ...context, buildSha: 'dev', gitSha: null })).toThrow('Actual build');
    expect(() => assertFantasyMigrationOperator(options, { ...context, buildSha: 'dev' })).not.toThrow();
    expect(() => assertFantasyMigrationOperator(applying, { ...context, gitSha: null })).not.toThrow();
    for (const change of [{ manifestHash: 'c'.repeat(64) }, { gitSha: 'c'.repeat(40) }, { buildSha: 'c'.repeat(40) },
      { fantasyEnabled: 'true' }, { fantasyEnabled: undefined }, { multiBaseEnabled: 'false' }, { gitDirty: true }]) {
      expect(() => assertFantasyMigrationOperator(applying, { ...context, ...change })).toThrow();
    }
    for (const invalid of [[], ['--apply'], [...args, '--apply', '--apply'], [...args, '--unknown'],
      ['--manifest', 'private.json'], [...args, '--manifest', 'second.json']]) {
      expect(() => parseFantasyMigrationOperatorArgs(invalid)).toThrow();
    }
  });

  it('atomically migrates reviewed deeds and stages every pending Earth intent, retaining old payment identities on retries', async () => {
    const active = await fantasyBaseFixture(db); const inactive = await fantasyBaseFixture(db, { inactive: true });
    const pending = [];
    for (let index = 0; index < 2; index++) {
      const player = await createTestPlayer(db); const quote = await createDepositIntent(db, player.wallet, 'entry');
      if (!('baseId' in quote) || !quote.baseId) throw new Error('Expected legacy quote');
      pending.push({ wallet: player.wallet, id: quote.id, baseId: quote.baseId });
    }
    // A racing old quote may not be overlooked by an operator's earlier list.
    await expect(db.transaction(tx => stageLockedLegacyFantasyPurchases(tx, []))).rejects.toMatchObject({ code: 'FANTASY_CUTOVER_RETRY' });
    await expect(db.transaction(activateFantasyPurchaseCutover)).rejects.toMatchObject({ code: 'FANTASY_CUTOVER_RETRY' });
    expect(await db.select().from(fantasyLandClaims)).toHaveLength(0);
    const reservationsBefore = await db.select().from(plotReservations);
    const paymentsBefore = await db.select().from(deposits);
    const basesBefore = await db.select().from(bases);
    // Scope may be reviewed earlier, but apply requires evidence fresh NOW.
    const manifest = planFantasyMigration({ snapshotAt: new Date(Date.now() - 3_600_000).toISOString(), active: [active], inactive: [inactive], exclusions: [] });
    const expected = fantasyManifestHash(manifest);
    const dry = await applyFantasyMigration(db, manifest, expected, { dryRun: true });
    expect(dry).toMatchObject({ inserted: 2, retained: 0, pendingLegacyHeld: 2, dryRun: true });
    expect(await db.select().from(fantasyLandClaims)).toHaveLength(0);
    expect(await db.select().from(fantasyMigrationBatches)).toHaveLength(0);
    expect(await fantasyPurchasesCutOver(db)).toBe(false);
    const applied = await applyFantasyMigration(db, manifest, expected, { dryRun: false });
    expect(applied).toMatchObject({ inserted: 2, retained: 0, pendingLegacyHeld: 2, dryRun: false });
    expect(await fantasyPurchasesCutOver(db)).toBe(true);
    for (const original of pending) expect(await getFantasyClaim(db, original.baseId)).toMatchObject({ source: 'purchase', state: 'held', depositId: original.id });
    expect(await getFantasyClaim(db, active.baseId)).toMatchObject({ state: 'assigned' });
    expect(await getFantasyClaim(db, inactive.baseId)).toMatchObject({ state: 'held' });
    expect(await db.select().from(plotReservations)).toEqual(reservationsBefore);
    expect(await db.select().from(deposits)).toEqual(paymentsBefore);
    expect(await db.select().from(bases)).toEqual(basesBefore);
    const claims = await db.select().from(fantasyLandClaims);
    expect(await applyFantasyMigration(db, manifest, expected, { dryRun: false })).toMatchObject({ inserted: 0, retained: 2, pendingLegacyHeld: 2 });
    expect(await db.select().from(fantasyLandClaims)).toEqual(claims);
    const paid = pending[0]!;
    const hold = (await getFantasyClaim(db, paid.baseId))!;
    const retry = await createDepositIntent(db, paid.wallet, 'entry');
    expect(retry.id).toBe(paid.id);
    await creditDeposit(db, paid.id, { wallet: paid.wallet, kind: 'entry', txSignature: `operator-${randomUUID()}`,
      lamports: BigInt(Math.round(ECONOMY.entryFeeSol * 1e9)), finalized: true });
    expect(await getFantasyClaim(db, paid.baseId)).toMatchObject({ tileId: hold.tileId, state: 'assigned' });
    expect((await db.select().from(plots).where(eq(plots.baseId, paid.baseId)))[0]?.addressKind).toBe('legacy-earth');
    expect(await pendingLegacyFantasyPurchases(db)).toHaveLength(1);
  });

  it('never substitutes historical or future-dated ownership evidence for current finalized authority', async () => {
    for (const offset of [-120_000, 120_000]) {
      const fixture = await fantasyBaseFixture(db, { snapshotAt: new Date(Date.now() + offset) });
      const used = (await db.select().from(fantasyLandClaims)).map(row => row.tileId);
      const manifest = planFantasyMigration({ snapshotAt: fixture.now.toISOString(), active: [fixture], inactive: [], exclusions: [], unavailableTileIds: used });
      await expect(applyFantasyMigration(db, manifest, fantasyManifestHash(manifest), { dryRun: true })).rejects.toThrow('fresh finalized');
      expect(await getFantasyClaim(db, fixture.baseId)).toBeNull();
    }
  });

  it('fails closed before writing when sales flags or manifest approval differ', async () => {
    const manifest = planFantasyMigration({ snapshotAt: new Date().toISOString(), active: [], inactive: [], exclusions: [] });
    const count = await db.execute(sql`select count(*)::int as n from fantasy_land_claims`);
    await expect(applyFantasyMigration(db, manifest, '0'.repeat(64), { dryRun: false })).rejects.toThrow('hash mismatch');
    process.env['FANTASY_WORLD_ENABLED'] = 'true';
    try { await expect(applyFantasyMigration(db, manifest, fantasyManifestHash(manifest), { dryRun: false })).rejects.toThrow('staged'); }
    finally { process.env['FANTASY_WORLD_ENABLED'] = 'false'; }
    expect(await db.execute(sql`select count(*)::int as n from fantasy_land_claims`)).toEqual(count);
  });

  it('requires explicit reconciliation of an issued legacy payment whose reserved base identity is missing', async () => {
    const player = await createTestPlayer(db);
    await expect(db.transaction(async tx => {
      await tx.insert(deposits).values({ playerWallet: player.wallet, kind: 'entry', reference: randomUUID() });
      await pendingLegacyFantasyPurchases(tx);
    })).rejects.toMatchObject({ code: 'LEGACY_PAYMENT_RECONCILIATION_REQUIRED' });
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, player.wallet))).toHaveLength(0);
  });
});
