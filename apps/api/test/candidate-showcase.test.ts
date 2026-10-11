/**
 * QA showcase seed (scripts/candidate/showcase.mjs, owner 2026-10-06).
 *
 * WHY these assertions: the owner demos "multiple bases to show designs" and "one raid" from the
 * WORLD MAP on the candidate lane. A kingdom only appears on the map with land (land_paid_at), an
 * assigned realm claim and an active owner slot (fantasyGlobe.ts publicClaim); it is only raidable
 * by a landowner (raids.ts land-tier partition) with a high-enough Keep and no shield. Its look is
 * the designed campaign fort, so every count must equal the plan's, built through the real services
 * from a Keep-1 start. A second run must change nothing (the operator re-runs it before the demo),
 * and a reset must never touch a tester's own base.
 */
import { randomUUID } from 'node:crypto';
import { SIM_VERSION } from '@shardkeep/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureStartingBase } from '../src/game/base';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { getFantasyParcel } from '../src/game/fantasyGlobe';
import { acceptLiveRaidCommand } from '../src/game/liveRaids';
import { createRaid, recoverDueStartedLiveRaids } from '../src/game/raids';
import { RAID_RULES } from '@shardkeep/shared';
import { connectTestDb, createTestPlayer } from './helpers';
// @ts-expect-error -- candidate operator script is plain ESM without declarations
import * as showcase from '../../../scripts/candidate/showcase.mjs';

const { db, sql } = connectTestDb();
// The QA lane's shape (profile gems: true): with Gems on, any KEEP/Gems grant would be an unbacked Gems
// mint, which the ledger refuses (G-3) — the 2026-10-06 QA failure this suite now reproduces and guards.
const FLAGS = {
  MULTI_BASE_ENABLED: 'true', FANTASY_WORLD_ENABLED: 'true', PHASE_E_BUILDINGS_ENABLED: 'true',
  HERO_RECRUITMENT_ENABLED: 'true', GEMS_ENABLED: 'true', SOLANA_CLUSTER: 'devnet',
} as const;
const previous: Record<string, string | undefined> = {};
const authorize = async (wallet: string, baseId: string, locked?: unknown) => {
  if (locked) await assertFreshLockedBaseAuthority(locked as never, wallet, baseId);
};

async function counts() {
  const [row] = await sql`select
    (select count(*) from players)::int as players, (select count(*) from bases)::int as bases,
    (select count(*) from buildings)::int as buildings, (select count(*) from builder_jobs)::int as jobs,
    (select count(*) from ledger_transactions)::int as ledger, (select count(*) from fantasy_land_claims)::int as claims,
    (select count(*) from plots)::int as plots, (select count(*) from deposits)::int as deposits,
    (select count(*) from base_hero_progress)::int as heroes, (select count(*) from base_army)::int as army`;
  return row;
}

/** A tester's own deedless starter, exactly as onboarding founds one, signed in normally. */
async function testerStarter() {
  const { wallet } = await createTestPlayer(db);
  const baseId = randomUUID();
  await sql`insert into bases(id,owner_wallet,status) values(${baseId},${wallet},'active')`;
  await sql`insert into base_slots(wallet,slot,base_id,active) values(${wallet},1,${baseId},true)`;
  await ensureStartingBase(db, wallet, baseId);
  await sql`insert into sessions(wallet,expires_at) values(${wallet},now()+interval '1 hour')`;
  return { wallet, baseId };
}

let built: Array<Record<string, any>> = [];
const warCamps: string[] = [];

beforeAll(async () => {
  for (const [key, value] of Object.entries(FLAGS)) { previous[key] = process.env[key]; process.env[key] = value; }
  built = await showcase.buildShowcase(db);
}, 1_800_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await sql.end();
});

describe('candidate showcase seed', () => {
  it('builds every planned kingdom as a landed, mapped, designed fort through the real services', async () => {
    expect(built.map((receipt) => receipt.kingdom)).toEqual(showcase.KINGDOMS.map((spec: { key: string }) => spec.key));
    for (const receipt of built) {
      const spec = showcase.KINGDOMS.find((row: { key: string }) => row.key === receipt.kingdom);
      const plan = await showcase.kingdomPlan(spec);
      const [base] = await sql`select b.*, s.active from bases b join base_slots s on s.base_id=b.id where b.id=${receipt.baseId}`;
      expect(base).toMatchObject({ keep_level: plan.keepLevel, expansions: plan.expansion, status: 'active', active: true });
      expect(base!.land_paid_at).not.toBeNull();
      const types = await sql`select type, count(*)::int as n, min(level)::int as lo, max(level)::int as hi
        from buildings where base_id=${receipt.baseId} group by type`;
      const byType = Object.fromEntries(types.map((row) => [row.type, row]));
      expect(byType['keep']).toMatchObject({ n: 1, lo: plan.keepLevel });
      expect(byType['wall']).toMatchObject({ n: plan.walls.length, lo: plan.wallLevel, hi: plan.wallLevel });
      for (const [type, n] of Object.entries(plan.counts as Record<string, number>)) {
        if (type === 'wall') continue;
        const levels = plan.buildings.filter((row: { type: string }) => row.type === type).map((row: { level: number }) => row.level);
        expect(byType[type], type).toMatchObject({ n, lo: Math.min(...levels), hi: Math.max(...levels) });
      }
      // Built, not written: every non-wall building has its completed build job, all in the fixture past.
      const [jobs] = await sql`select count(*) filter (where kind='build')::int as builds,
        count(*) filter (where completed_at is null)::int as open, max(completed_at) < now() as past
        from builder_jobs where base_id=${receipt.baseId}`;
      expect(jobs).toMatchObject({ builds: plan.buildings.length, open: 0, past: true });
      if (plan.hero) {
        const [hero] = await sql`select level from base_hero_progress where base_id=${receipt.baseId} and hero=${plan.hero.hero}`;
        expect(hero?.level).toBe(plan.hero.level);
      }
      // Grants equal the plan's cost: no hidden surplus is left in the kingdom.
      const [purse] = await sql`select coalesce(sum(balance),0)::text as shards from accounts where base_id=${receipt.baseId} and kind='base_shards'`;
      expect(purse!.shards).toBe('0');
      // No KEEP or Gems ever enters a showcase wallet: KEEP/Gems-priced steps use the lane's zero-charge fixtures.
      const [money] = await sql`select count(*)::int as n from ledger_entries e join accounts a on a.id=e.account_id
        where a.owner_wallet=${base!.owner_wallet} and a.kind in ('player_keep','player_gems','player_gems_store')`;
      expect(money!.n).toBe(0);
      // On the WORLD MAP in its own realm, under its own name and Keep.
      const parcel = await getFantasyParcel(db, base!.owner_wallet, receipt.land.tileId);
      expect(parcel.availability).toBe('occupied');
      expect(parcel.tile.realmId).toBe(spec.realm);
      expect(parcel.detail).toBeTruthy();
    }
  });

  it('is idempotent: a second run is all duplicates and changes no row', async () => {
    const before = await counts();
    // The operator's --dry-run prints the plan and writes nothing.
    const dry = await showcase.runShowcase(db, null, ['--dry-run']);
    expect(dry.kingdoms.map((plan: { kingdom: string }) => plan.kingdom)).toEqual(showcase.KINGDOMS.map((spec: { key: string }) => spec.key));
    expect(await counts()).toEqual(before);
    const again = await showcase.buildShowcase(db);
    expect(again.every((receipt: { duplicate?: boolean }) => receipt.duplicate === true)).toBe(true);
    expect(await counts()).toEqual(before);
  }, 600_000);

  it('lets a landed tester base, upgraded around its own layout, attack a raid target from the map and resolve at the current SIM', async () => {
    const tester = await testerStarter();
    const ownLayout = await sql`select id,type,level,tx,ty from buildings where base_id=${tester.baseId} order by id`;
    // Deedless: sealed away from every landed kingdom (production land-tier rule).
    const target = built.find((receipt) => receipt.kingdom === 'thornwake-outpost')!;
    await expect(createRaid(db, tester.wallet, { attackerBaseId: tester.baseId, defenderBaseId: target.baseId,
      idempotencyKey: randomUUID(), authorizeAttackerBase: authorize, authorizeDefenderBase: authorize }))
      .rejects.toMatchObject({ statusCode: 404 });

    const land = await showcase.grantLand(db, null, { wallet: tester.wallet, baseId: tester.baseId });
    expect(land.land.chainTransactions).toBe(0);
    expect((await showcase.grantLand(db, null, { wallet: tester.wallet, baseId: tester.baseId })).duplicate).toBe(true);

    const upgrade = await showcase.upgradeOwnerBase(db, null, { wallet: tester.wallet, baseId: tester.baseId, targetKeep: 10 });
    expect(upgrade.after.keep_level).toBe(10);
    expect(upgrade.army.trained).toBeTruthy();
    // Nothing the tester placed moved or vanished.
    const kept = await sql`select id,type,tx,ty from buildings where id in ${sql(ownLayout.map((row) => row.id))} order by id`;
    expect(kept.map((row) => [row.id, row.tx, row.ty])).toEqual(ownLayout.map((row) => [row.id, row.tx, row.ty]));
    const beforeRepeat = await counts();
    expect((await showcase.upgradeOwnerBase(db, null, { wallet: tester.wallet, baseId: tester.baseId, targetKeep: 10 })).duplicate).toBe(true);
    expect(await counts()).toEqual(beforeRepeat);

    const raid = await createRaid(db, tester.wallet, { attackerBaseId: tester.baseId, defenderBaseId: target.baseId,
      idempotencyKey: randomUUID(), authorizeAttackerBase: authorize, authorizeDefenderBase: authorize });
    expect(raid.simVersion).toBe(SIM_VERSION);
    const army = await sql`select troop,count from base_army where base_id=${tester.baseId} and count>0 order by troop`;
    const targetPlan = await showcase.kingdomPlan(showcase.KINGDOMS.find((row: { key: string }) => row.key === target.kingdom));
    const edge = (30 - targetPlan.claimTiles) / 2 - 2; // deploy ring, two tiles outside the target's claim
    const deploys = army.flatMap((row, lane) => Array.from({ length: row.count }, (_, i) => ({
      troop: row.troop, tx: edge, ty: 9 + ((lane * 3 + i) % 12) })));
    // A defended stable base is a live raid (defender lock): deploy through the live command path, then let
    // the canonical recovery settle the elapsed battle exactly as the candidate's lifecycle loop does.
    const t0 = Date.now();
    for (const [i, deploy] of deploys.entries()) {
      await acceptLiveRaidCommand(db, tester.wallet, raid.id, randomUUID(), { kind: 'deploy', payload: deploy }, new Date(t0 + i * 100));
    }
    const settled = await recoverDueStartedLiveRaids(db, new Date(t0 + deploys.length * 100 + (RAID_RULES.battleDurationSec + 5) * 1000), undefined, raid.id);
    expect(settled.resolved).toBe(1);
    const [resolved] = await sql`select status, result, sim_version from raids where id=${raid.id}`;
    expect(resolved).toMatchObject({ status: 'resolved', sim_version: SIM_VERSION });
    console.log(`showcase raid vs ${target.kingdom}: ${JSON.stringify({ army, result: resolved!.result })}`);
  }, 900_000);

  it('gives a signed-in tester a landed war camp that wins against the lighter raid target, leaving his free home as it was', async () => {
    const tester = await testerStarter();
    const camp = await showcase.buildKingdom(db, showcase.warCampSpec(tester.wallet), { profile: null });
    warCamps.push(camp.baseId);
    expect(camp).toMatchObject({ tester: true, slot: 2, realm: 'crownlands' });
    expect(camp.after.keep_level).toBe(showcase.DEFAULT_OWNER_KEEP);
    expect(Object.keys(camp.army.trained).length).toBeGreaterThan(0);
    // The war camp is a second landed base; the free home and the wallet's entry purchase are untouched,
    // so the phone's buy-land screens and the free home's Phase E state stay as they were.
    const [home] = await sql`select land_paid_at, status from bases where id=${tester.baseId}`;
    expect(home).toMatchObject({ land_paid_at: null, status: 'active' });
    const [player] = await sql`select entry_paid_at from players where wallet=${tester.wallet}`;
    expect(player!.entry_paid_at).toBeNull();
    expect((await showcase.buildKingdom(db, showcase.warCampSpec(tester.wallet), { profile: null })).duplicate).toBe(true);

    const target = built.find((receipt) => receipt.kingdom === 'cinderfall-camp')!;
    const raid = await createRaid(db, tester.wallet, { attackerBaseId: camp.baseId, defenderBaseId: target.baseId,
      idempotencyKey: randomUUID(), authorizeAttackerBase: authorize, authorizeDefenderBase: authorize });
    const army = await sql`select troop,count from base_army where base_id=${camp.baseId} and count>0 order by troop`;
    const targetPlan = await showcase.kingdomPlan(showcase.KINGDOMS.find((row: { key: string }) => row.key === target.kingdom));
    const edge = (30 - targetPlan.claimTiles) / 2 - 2;
    const t0 = Date.now();
    let i = 0;
    for (const [lane, row] of army.entries()) for (let n = 0; n < row.count; n++) {
      await acceptLiveRaidCommand(db, tester.wallet, raid.id, randomUUID(),
        { kind: 'deploy', payload: { troop: row.troop, tx: edge, ty: 9 + ((lane * 3 + n) % 12) } }, new Date(t0 + i++ * 100));
    }
    expect((await recoverDueStartedLiveRaids(db, new Date(t0 + i * 100 + (RAID_RULES.battleDurationSec + 5) * 1000), undefined, raid.id)).resolved).toBe(1);
    const [resolved] = await sql`select status, sim_version, result from raids where id=${raid.id}`;
    expect(resolved).toMatchObject({ status: 'resolved', sim_version: SIM_VERSION });
    // The stage needs a visible win: a full war camp must take stars off the lighter target.
    expect(resolved!.result.stars).toBeGreaterThanOrEqual(1);
    // After a rehearsal raid the operator refills the camps for the stage raid: back to the same army,
    // never past camp capacity (a second refill trains nothing).
    const spent = await sql`select coalesce(sum(count),0)::int as n from base_army where base_id=${camp.baseId}`;
    const refill = await showcase.refillArmy(db, null, { wallet: tester.wallet, baseId: camp.baseId });
    const full = await sql`select coalesce(sum(count),0)::int as n from base_army where base_id=${camp.baseId}`;
    expect(full[0]!.n).toBeGreaterThan(spent[0]!.n);
    expect(Object.keys(refill.army.trained).length).toBeGreaterThan(0);
    expect((await showcase.refillArmy(db, null, { wallet: tester.wallet, baseId: camp.baseId })).army.trained).toEqual({});
  }, 900_000);

  it('reset retires only the kingdoms it built and leaves tester bases alone', async () => {
    const testers = await sql`select base_id from candidate_showcase_actions`;
    const result = await showcase.resetShowcase(db);
    expect(result.retired.map((row: { key: string }) => row.key).sort()).toEqual(built.map((row) => row.kingdom).sort());
    for (const receipt of built) {
      const [base] = await sql`select status from bases where id=${receipt.baseId}`;
      expect(base!.status).toBe('inactive');
      expect(await sql`select 1 from base_slots where base_id=${receipt.baseId}`).toHaveLength(0);
      // Off the world map: the tile keeps its permanent claim history but shows no kingdom.
      const parcel = await getFantasyParcel(db, receipt.wallet, receipt.land.tileId);
      expect(parcel.detail).toBeNull();
    }
    for (const row of testers) {
      const [base] = await sql`select status, land_paid_at from bases where id=${row.base_id}`;
      expect(base).toMatchObject({ status: 'active' });
      expect(base!.land_paid_at).not.toBeNull();
    }
    for (const baseId of warCamps) {
      const [camp] = await sql`select status from bases where id=${baseId}`;
      expect(camp!.status).toBe('active');
    }
    expect((await showcase.resetShowcase(db)).retired).toEqual([]);
  });
  it('a failure inside a kingdom\'s first transaction leaves nothing; a failure mid-build resumes to the same kingdom', async () => {
    const probe = { key: 'resume-probe', name: 'ResumeProbe', realm: 'crownlands', stage: 6 };
    const before = await counts();
    // 1. Fail the LAST statement of stage 1 (the journal insert): player, base, slot, land, Keep and the
    //    SHARDS grant were already written in that transaction and must all roll back.
    await sql.unsafe(`create or replace function showcase_probe_fail() returns trigger language plpgsql as $$
      begin raise exception 'probe: stage-1 failure'; end $$`);
    await sql.unsafe(`create trigger showcase_probe_stage1 before insert on candidate_showcase_kingdoms
      for each row when (new.key = 'resume-probe') execute function showcase_probe_fail()`);
    const probeFailure = async () => {
      const error = await showcase.buildKingdom(db, probe).then(() => null, (e: Error & { cause?: Error }) => e);
      expect(String(error?.cause?.message ?? error?.message)).toMatch(/probe: stage-1 failure/);
    };
    await probeFailure();
    await sql.unsafe('drop trigger showcase_probe_stage1 on candidate_showcase_kingdoms');
    expect(await counts()).toEqual(before);
    expect(await sql`select 1 from players where name='ResumeProbe'`).toHaveLength(0);
    // 2. Fail mid-build (the wall batch, after the Keep and the first buildings landed): the journal row
    //    stays 'building' and holds the fixture clock.
    await sql.unsafe(`create trigger showcase_probe_walls before insert on buildings
      for each row when (new.type = 'wall') execute function showcase_probe_fail()`);
    await probeFailure();
    await sql.unsafe('drop trigger showcase_probe_walls on buildings');
    const [half] = await sql`select state, base_id from candidate_showcase_kingdoms where key='resume-probe'`;
    expect(half!.state).toBe('building');
    expect((await sql`select count(*)::int as n from buildings where base_id=${half!.base_id} and type<>'keep'`)[0]!.n).toBeGreaterThan(0);
    // 3. The re-run resumes the same base to the full plan, with no second grant (purse ends at 0).
    const done = await showcase.buildKingdom(db, probe);
    expect(done.baseId).toBe(half!.base_id);
    const plan = await showcase.kingdomPlan(probe);
    expect(done.after.keep_level).toBe(plan.keepLevel);
    expect((await sql`select count(*)::int as n from buildings where base_id=${done.baseId} and type='wall'`)[0]!.n).toBe(plan.walls.length);
    const [purse] = await sql`select coalesce(sum(balance),0)::text as shards from accounts where base_id=${done.baseId} and kind='base_shards'`;
    expect(purse!.shards).toBe('0');
    expect((await showcase.buildKingdom(db, probe)).duplicate).toBe(true);
    await sql.unsafe('drop function showcase_probe_fail()');
  }, 600_000);
});
