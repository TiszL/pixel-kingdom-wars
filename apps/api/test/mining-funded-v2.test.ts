/** D153.199 changes prospective scoring, never original funded rights. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { withFundedMiningReplayFixture as fixture } from './fixtures/fundedMiningReplay';
import { deriveFundedMiningWallet, type FundedMiningCapture } from '../src/mining/fundedMiningQualification';
import { executeFundedMiningClaim } from './fixtures/fundedMiningClaims';
import { getPreparedMiningPublication } from '../src/mining/publicationPreparation';
import { createMiningClaimEntitlementReader } from '../src/mining/claimEntitlement';
import { auditFundedMiningManifest, miningCanonical } from '../src/mining/fundedMiningAudit';

describe('prospective uncapped deed mining and rolling daily consistency', () => {
  it('publishes v1 then v2, consumes above the former deed cap and preserves cumulative claims and offline replay', async () => fixture(async f => {
    const original = await (await f.stage('2020-01-01')).publish();
    const oldManifest = original.prepared.manifestJson;
    const originalPaid = JSON.parse(oldManifest).participants.find((p: { wallet: string }) => p.wallet === f.buyer);
    const day2 = await (await f.stage('2020-01-02', { policyVersion: 2, paidQuantity: 8, freeQuantity: 3 })).publish();
    const manifest = JSON.parse(day2.prepared.manifestJson);
    expect(manifest).toMatchObject({ version: 4, scope: 'ordinary-paid-and-deedless-v2', input: { policyVersion: 2 } });
    const paid = manifest.participants.find((p: { wallet: string }) => p.wallet === f.buyer);
    expect(paid.eligibleUnits).toBe(8);
    expect(paid.eligibleUnits).toBeGreaterThan(originalPaid.capacityUnits);
    expect(paid.capacityUnits).toBeNull();
    expect(day2.settlement.dispositions.find(row => row.actorWallet === f.wallet)).toMatchObject({ consumed: 2, returned: 1 });
    expect(day2.settlement.dispositions.find(row => row.actorWallet === f.buyer)?.consumed).toBe(8);
    const capture = (manifest.captures as FundedMiningCapture[]).find(c => c.wallet === f.buyer)!;
    const legacy = deriveFundedMiningWallet(capture, f.identity.genesisHash, 1)[0]!;
    expect(paid.baseScoreBps).toBe(Math.floor(legacy.baseScoreBps * 10400 / 10000));
    const more = structuredClone(capture); more.bases[0]!.reservedUnits += 1;
    expect(BigInt(deriveFundedMiningWallet(more, f.identity.genesisHash, 2)[0]!.weight)).toBeGreaterThan(BigInt(paid.weight));
    expect(legacy.eligibleUnits).toBe(originalPaid.capacityUnits);
    const freeCapture = (manifest.captures as FundedMiningCapture[]).find(c => c.wallet === f.wallet)!;
    freeCapture.bases[0]!.reservedUnits = 100;
    expect(deriveFundedMiningWallet(freeCapture, f.identity.genesisHash, 2)[0]).toMatchObject({ capacityUnits: 2, eligibleUnits: 2 });

    const claim = await executeFundedMiningClaim({ ...f, wallet: f.buyer, walletSigner: f.buyerSigner }, day2, null);
    f.acceptClaim(claim);
    const entitlement = await createMiningClaimEntitlementReader(f.conn.db, f.identity)(f.buyer);
    expect(entitlement.kind).toBe('entitlement');
    if (entitlement.kind !== 'entitlement') throw Error('Cumulative right missing');
    expect(claim.payment).toBe(BigInt(entitlement.leaf.cumulativeKeep));
    expect(claim.postSnapshot.renownRecord).toMatchObject({ renownTotal: 2n, daysAttested: 2n });
    for (const p of [original, day2]) {
      p.chain.reader.getGenesisHash = async () => { throw Error('Saved rights must replay without live RPC'); };
      expect(await p.settle()).toEqual(p.settlement);
      expect(await getPreparedMiningPublication(f.conn.db, p.prepared.epochId)).toEqual(p.prepared);
    }
    expect(original.prepared.manifestJson).toBe(oldManifest);
    expect(await f.conn.sql`select * from mining_ingot_dispositions`).toHaveLength(4);
  }), 180_000);

  it('rejects stale epoch policy and invented, duplicate or incomplete participation history', async () => fixture(async f => {
    const stage = await f.stage('2020-01-01', { policyVersion: 2 });
    await expect(stage.prepare({ ...stage.request, policyVersion: 1 })).rejects.toMatchObject({ code: 'EPOCH_SCOPE_INVALID' });
    const published = await stage.publish(), m = JSON.parse(published.prepared.manifestJson);
    const capture = m.captures[0] as FundedMiningCapture;
    const missing = structuredClone(capture); missing.activity.days.shift();
    expect(() => deriveFundedMiningWallet(missing, f.identity.genesisHash, 2)).toThrow();
    const duplicate = structuredClone(capture); duplicate.activity.qualifiedRaids.push(duplicate.activity.qualifiedRaids[0]!);
    expect(() => deriveFundedMiningWallet(duplicate, f.identity.genesisHash, 2)).toThrow();
    const invented = structuredClone(capture); invented.activity.days[0]!.qualifyingRaidIds.push('fake-raid');
    expect(() => deriveFundedMiningWallet(invented, f.identity.genesisHash, 2)).toThrow();
    const moved = structuredClone(capture), raid = moved.activity.qualifiedRaids[0]!;
    moved.activity.days.find(d => d.day === raid.day)!.qualifyingRaidIds = [];
    moved.activity.days[0]!.qualifyingRaidIds = [raid.raidId]; raid.day = moved.activity.days[0]!.day;
    moved.activity.todayQualifyingRaidIds = [];
    expect(() => deriveFundedMiningWallet(moved, f.identity.genesisHash, 2)).toThrow();
    const noToday = structuredClone(capture);
    noToday.activity.qualifiedRaids = noToday.activity.qualifiedRaids.filter(r => r.day !== noToday.day);
    noToday.activity.todayQualifyingRaidIds = []; noToday.activity.days.at(-1)!.qualifyingRaidIds = [];
    expect(deriveFundedMiningWallet(noToday, f.identity.genesisHash, 2)[0]!.weight).toBe('0');
    // A stored v2 receipt cannot be reinterpreted using a v1 policy label.
    m.version = 3;
    expect(() => auditFundedMiningManifest({ manifestJson: miningCanonical(m), publication: published.prepared.publication,
      reservations: m.epoch.reservations.map((r: { id: string; baseId: string; actorWallet: string; qty: number }) => ({ reservationId: r.id, baseId: r.baseId, actorWallet: r.actorWallet, ingots: r.qty })), previousPublication: null })).toThrow();
  }), 180_000);

  it('refuses superseded migration replays while preserving v2 policy binding, saved rights and private guards', async () => fixture(async f => {
    const p = await (await f.stage('2020-01-01', { policyVersion: 2 })).publish();
    const manifests = await f.conn.sql`select * from mining_publication_manifests order by epoch_id`;
    const guards = () => f.conn.sql`select proname,proowner,prosecdef,proconfig,proacl::text,pg_get_functiondef(oid) definition from pg_proc
      where pronamespace='public'::regnamespace and proname in ('shardkeep_mining_settlement_guard','shardkeep_mining_entitlement_guard','shardkeep_mining_entitlement_complete',
        'shardkeep_divine_fragment_contract','shardkeep_divine_fragment_source','shardkeep_mining_resource_publication_seal_guard') order by proname`;
    const before = await guards();
    const seals = () => f.conn.sql`select
      (select record from divine_fragment_resource_publication_contract where singleton) resource_original,
      (select record from divine_fragment_enrolled_seeker_contract where singleton) enrolled_original,
      (select record from divine_fragment_vehicle_material_contract where singleton) vehicle_original,
      (select record from divine_fragment_vehicle_client_contract where singleton) client_original,
      (select record from divine_fragment_existing_wallet_contract where singleton) existing_wallet_original,
      (select record from divine_fragment_seeker_absence_contract where singleton) absence_original,
      (select record from divine_fragment_gems_zero_contract where singleton) gems_zero_original,
      (select record from divine_fragment_bound_cosmetics_contract where singleton) bound_cosmetics_original,
      shardkeep_divine_fragment_contract() current_contract`;
    const sealedBefore = await seals();
    // 2026-10-10 (CI 37503885235): the 0277 gems-zero seal is no longer the newest boundary. 0279 (bound cosmetics,
    // 409b2aff0) sealed nine more tables (bound_cosmetic_*, ordinary_equipment jobs/completions, the return seals)
    // and later successors re-seal functions through their own validators. Pin the rule: every 0277-sealed table
    // keeps its exact sealed shape, the current table projection is the 0279 record's, and the newest whole-system
    // check (shardkeep_divine_fragment_source, below) accepts this boundary. That check only holds when the fixture
    // clocks exist before the first Phase E seal (0261) — the publicationClock rule from 80b63eeee — so this case
    // uses it; replacing clock functions after migration would itself invalidate the 0269+ seals.
    const sealed = sealedBefore[0]! as { gems_zero_original: { tables: object }; bound_cosmetics_original: { tables: object; gemsZeroTables: object; boundCosmeticTables: object }; current_contract: { tables: object; gemsZeroTables: object; boundCosmeticTables: object } };
    expect(sealed.current_contract.tables).toMatchObject(sealed.gems_zero_original.tables);
    expect(Object.keys(sealed.current_contract.tables).length).toBeGreaterThan(Object.keys(sealed.gems_zero_original.tables).length);
    expect(sealed.current_contract.tables).toEqual(sealed.bound_cosmetics_original.tables);
    expect(sealed.current_contract.gemsZeroTables).toEqual(sealed.bound_cosmetics_original.gemsZeroTables);
    expect(sealed.current_contract.boundCosmeticTables).toEqual(sealed.bound_cosmetics_original.boundCosmeticTables);
    await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
    expect(sealedBefore[0]!.absence_original).not.toBeNull();
    // 0254 was replayable before successor custody existed. Reinstalling its
    // resource-era function set now downgrades successor custody and its current 0277 seal.
    // Each attempt must fail atomically, retaining current guards AND old rights.
    const migration = readFileSync(new URL('../drizzle/0254_mining_resource_publication.sql', import.meta.url), 'utf8');
    for (let pass = 0; pass < 2; pass++) {
      await expect(f.conn.sql.begin(async tx => {
        for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);
      })).rejects.toMatchObject({ code: 'P0001', message: 'DIVINE_FRAGMENT_SOURCE' });
      expect(await guards()).toEqual(before);
      expect(await seals()).toEqual(sealedBefore);
      expect(await f.conn.sql`select * from mining_publication_manifests order by epoch_id`).toEqual(manifests);
      await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
    }
    // The current prospective guard must preserve all retained v2 rights. A
    // historical guard replay is a downgrade once resource custody is admitted.
    const old = readFileSync(new URL('../drizzle/0251_mining_contribution_v2_score.sql', import.meta.url), 'utf8');
    await expect(f.conn.sql.begin(async tx => {
      for (const statement of old.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);
      await tx`select public.shardkeep_divine_fragment_source()`;
    })).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
    expect(await guards()).toEqual(before);
    expect(await seals()).toEqual(sealedBefore);
    await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
    expect(await f.conn.sql`select * from mining_publication_manifests order by epoch_id`).toEqual(manifests);
    for (const change of ['policy', 'key'] as const) {
      const manifest = JSON.parse(p.prepared.manifestJson);
      if (change === 'policy') manifest.input.policyVersion = 1;
      else manifest.epoch.key = 'free-shadow-v1:2020-01-01';
      // BEFORE INSERT must reject the altered consent before the duplicate-key
      // constraint. No JS planner participates in this direct SQL admission.
      await expect(f.conn.sql`insert into mining_publication_manifests(epoch_id,manifest_json,publication)
        values(${p.prepared.epochId},${miningCanonical(manifest)},${JSON.stringify(p.prepared.publication)}::jsonb)`)
        .rejects.toMatchObject({ code: 'P0001', message: 'MINING_FUNDED_POLICY_CONFLICT' });
    }
    expect(await f.conn.sql`select * from mining_publication_manifests order by epoch_id`).toEqual(manifests);
    expect(await getPreparedMiningPublication(f.conn.db, p.prepared.epochId)).toEqual(p.prepared);
    expect(await p.settle()).toEqual(p.settlement);
  }, { publicationClock: true }), 180_000);
});
