/** Actual private SQL contract counterexamples. Explicit owner-storage corruption
 * below tests independent reads, not protection from an arbitrary superuser. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbTx } from '../src/db/client';
import { prepareMineProductionSettlement, attachMineProductionClock, readMineProductionClock, mineUnitCompletion } from '../src/mining/shardsTaxMineProduction';
import { prefetchPhysicalMineCustody } from '../src/mining/shardsTaxMineCustody';
import { prefetchHistoricalShardsTermAt } from '../src/mining/shardsTaxHistoricalTermDiscovery';
import { pinHistoricalShardsTerm } from '../src/game/expeditionTermStore';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createPartialMineFixture, partialMineAnchor, partialMineDay, partialMineQuota, type PartialMineFixture } from './fixtures/partialMineProduction';

let conn: ReturnType<typeof resourceClaimsDatabase> | undefined, active: PartialMineFixture | undefined;
beforeEach(async () => { conn = resourceClaimsDatabase(); await conn.setup(); }, 120_000);
afterEach(async () => { const f = active; active = undefined; await f?.closeServers(); const db = conn; conn = undefined;
  await db?.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });
async function fixture(cutoff?: Date) { if (!conn) throw Error('Database unavailable'); active = await createPartialMineFixture(conn, cutoff); return active; }
async function refusal(work: Promise<unknown>, expected: string) {
  try { await work; } catch (error) {
    let leaf = error as { cause?: unknown; message?: string };
    while (leaf.cause && typeof leaf.cause === 'object') leaf = leaf.cause as typeof leaf;
    expect(leaf.message).toBe(expected); return;
  }
  throw Error(`Expected exact refusal ${expected}`);
}
async function pending(f: PartialMineFixture, tx: DbTx) {
  const before = await f.state(), lastAt = new Date(before.last_accrual_at), remainder = BigInt(before.production_remainder);
  const elapsed = (5n * f.day - remainder + f.quota - 1n) / f.quota;
  const now = new Date(+lastAt + Number(elapsed)), numerator = remainder + f.quota * elapsed;
  const gross = numerator / f.day, after = numerator % f.day; expect(gross).toBe(5n);
  const id = await prepareMineProductionSettlement(tx, { mineId: f.mine.id, baseId: f.base.id, wallet: f.wallet,
    version: before.version, lastAt, previous: BigInt(before.accrued_shards), remainderBefore: remainder, now,
    quota: f.quota, capacity: f.quota, gross, remainderAfter: after, targetBuffer: BigInt(before.accrued_shards) + gross,
    targetAt: now, kind: 'capture' });
  async function insert(first: bigint, last: bigint, options: { side?: boolean; marker?: boolean } = {}) {
    const segmentId = randomUUID(), key = `mine:${f.mine.id}:v${before.version}:u${first}${options.marker === false ? '' : ':p' + id}`;
    const starts = new Date(Number(mineUnitCompletion(BigInt(+lastAt), f.quota, f.day, first, remainder)));
    const ends = new Date(Number(mineUnitCompletion(BigInt(+lastAt), f.quota, f.day, last, remainder)));
    await tx.execute(sql`insert into shards_mine_segments(id,mine_id,base_id,wallet,source_key,starts_at,ends_at,quota,anchor_at,first_unit,last_unit,gross,buffer)
      values(${segmentId},${f.mine.id},${f.base.id},${f.wallet},${key},${starts.toISOString()},${ends.toISOString()},${f.quota.toString()},${lastAt.toISOString()},${first.toString()},${last.toString()},${(last-first+1n).toString()},${(last-first+1n).toString()})`);
    if (options.side !== false) await attachMineProductionClock(tx, segmentId, id);
  }
  async function apply() {
    await tx.execute(sql`update mine_accrual_states set version=version+1,last_accrual_at=${now.toISOString()},
      accrued_shards=${(BigInt(before.accrued_shards)+gross).toString()},production_remainder=${after.toString()} where mine_building_id=${f.mine.id}`);
  }
  return { insert, apply, id };
}

describe.sequential('retained production clock consistency', () => {
  it('rejects equal-sum overlap, gap, omitted clock and late original after early constraint flush with full rollback', async () => {
    const f = await fixture(); await f.capture(); const before = await f.footprint();
    for (const mode of ['overlap', 'gap', 'missing-side', 'missing-marker', 'after-flush'] as const) {
      await refusal(f.conn.db.transaction(async tx => {
        const p = await pending(f, tx);
        if (mode === 'overlap') { await p.insert(1n, 3n); await p.insert(2n, 3n); }
        else if (mode === 'gap') await p.insert(2n, 5n);
        else await p.insert(1n, 5n, { side: mode !== 'missing-side', marker: mode !== 'missing-marker' });
        await p.apply(); await tx.execute(sql`set constraints all immediate`);
        if (mode === 'after-flush') await p.insert(6n, 6n);
      }), mode === 'missing-marker' || mode === 'after-flush' ? 'MINE_PRODUCTION_ORIGINAL_CLOCK' : 'MINE_PRODUCTION_SEGMENTS');
      expect(await f.footprint(), mode).toEqual(before);
    }
    for (const mode of ['legacy', 'adoption', 'wallet-bearing'] as const) {
      await refusal(f.conn.sql.begin(async tx => {
        await tx`set constraints all immediate`;
        const key = mode === 'adoption' ? `legacy-adoption:${f.wallet}:${f.mine.id}` : `legacy:${f.mine.id}`;
        if (mode === 'wallet-bearing') await tx`insert into shards_mine_segments(id,mine_id,base_id,wallet,source_key,starts_at,ends_at,quota,anchor_at,first_unit,last_unit,gross,buffer)
          values(${randomUUID()},${f.mine.id},${f.base.id},${f.wallet},${key},${f.now.toISOString()},${f.now.toISOString()},${f.quota.toString()},${f.anchor.toISOString()},1,1,1,1)`;
        else await tx`insert into shards_mine_segments(id,mine_id,base_id,source_key,starts_at,ends_at,quota,gross,buffer)
          values(${randomUUID()},${f.mine.id},${f.base.id},${key},${f.now.toISOString()},${f.now.toISOString()},0,1,1)`;
      }), 'MINE_PRODUCTION_LEGACY_SOURCE');
      expect(await f.footprint(), mode).toEqual(before);
    }
  });

  it('refuses disabled child hooks and missing v2 child clocks on actual owner SQL resolution', async () => {
    const f = await fixture(); await f.capture();
    const [parent] = await f.conn.sql`select * from shards_mine_segments where mine_id=${f.mine.id}`;
    const custody = await prefetchPhysicalMineCustody(f.conn.db, parent!.id);
    const certificate = await prefetchHistoricalShardsTermAt(f.bank.connect, f.bank.policy, new Date(parent!.starts_at).toISOString());
    const source = certificate.snapshot.source, domain = { genesisHash: source.genesisHash, programId: source.programId, auctionConfig: source.auctionConfig };
    const clock = await readMineProductionClock(f.conn.db, parent!.id, parent!.source_key), before = await f.footprint();
    for (const mode of ['before-header', 'before-child', 'missing-side'] as const) {
      await refusal(f.conn.db.transaction(async tx => {
        await pinHistoricalShardsTerm(tx, { readHistoricalTerm: async () => certificate });
        if (mode === 'before-header') await tx.execute(sql`alter table shards_mine_segments disable trigger mine_production_child_clock`);
        await tx.execute(sql`insert into shards_mine_resolutions(parent_id,term_source,custody,verified_at)
          values(${parent!.id},${JSON.stringify(domain)}::jsonb,${JSON.stringify({ version: 1, ...custody.custody, evidence: custody })}::jsonb,${f.now.toISOString()})`);
        if (mode === 'before-child') await tx.execute(sql`alter table shards_mine_segments disable trigger mine_production_child_clock`);
        const child = randomUUID();
        await tx.execute(sql`insert into shards_mine_segments(id,mine_id,base_id,wallet,source_key,starts_at,ends_at,quota,anchor_at,first_unit,last_unit,gross,buffer,recovery_parent_id)
          values(${child},${f.mine.id},${f.base.id},${f.wallet},${'mine-recovered:' + parent!.id + ':u' + parent!.first_unit + ':p' + clock!.settlementId},
          ${new Date(parent!.starts_at).toISOString()},${new Date(parent!.ends_at).toISOString()},${parent!.quota},${new Date(parent!.anchor_at).toISOString()},
          ${parent!.first_unit},${parent!.last_unit},${parent!.gross},${parent!.gross},${parent!.id})`);
        await tx.execute(sql`insert into shards_mine_resolution_terms(segment_id,parent_id,term_id,term_hash,certificate)
          values(${child},${parent!.id},${certificate.snapshot.termId},${certificate.termHash},${JSON.stringify(certificate)}::jsonb)`);
        await tx.execute(sql`update shards_mine_segments set buffer=0,resolved=gross where id=${parent!.id}`);
        // Deliberately corrupt the private child side under owner DDL before
        // deferred completion. The independent child check must refuse it even
        // though the other original resolution graph is internally complete.
        await tx.execute(sql`alter table shards_mine_segment_production disable trigger mine_production_segment_guard`);
        await tx.execute(sql`delete from shards_mine_segment_production where segment_id=${child}`);
        await tx.execute(sql`alter table shards_mine_segment_production enable trigger mine_production_segment_guard`);
        await tx.execute(sql`set constraints all immediate`);
      }), mode === 'missing-side' ? 'MINE_PRODUCTION_CHILD_CLOCK' : 'MINE_PRODUCTION_HOOKS_REQUIRED');
      expect(await f.footprint(), mode).toEqual(before);
    }
  });

  it('pairs genuine policy-boundary legacy and new unit partitions without taxing old stock', async () => {
    const tenth = (10n * partialMineDay + partialMineQuota - 1n) / partialMineQuota;
    const f = await fixture(new Date(+partialMineAnchor + Number(tenth) + 1));
    await f.capture();
    const pieces = await f.conn.sql`select wallet,gross::text,source_key from shards_mine_segments where mine_id=${f.mine.id} order by starts_at`;
    expect(pieces).toHaveLength(2); expect(pieces[0]).toMatchObject({ wallet: null, gross: '10' });
    expect(pieces[1]).toMatchObject({ wallet: f.wallet, gross: '10' });
    for (const piece of pieces) expect(piece.source_key).toMatch(/:p[0-9a-f-]{36}$/);
    expect((await f.footprint()).sides).toHaveLength(1);
    const app = await f.open(), response = await f.collect(app); expect(response.statusCode, response.body).toBe(200);
    expect(await f.conn.sql`select sum(gross)::text gross,sum(net+tax)::text funded from shards_tax_assessments where wallet=${f.wallet}`)
      .toEqual([{ gross: '10', funded: '10' }]);
    expect(await f.state()).toMatchObject({ accrued_shards: '0', production_remainder: f.remainder.toString() });
  });

  it('blocks tracked deletion, reopening, identity changes and version reuse but permits notification-only writes', async () => {
    const f = await fixture(); await f.capture(); const before = await f.footprint();
    const vectors = [
      ['delete', 'delete from mine_accrual_states where mine_building_id=$1', 'MINE_PRODUCTION_RESET'],
      ['reset', 'update mine_accrual_states set production_remainder=null where mine_building_id=$1', 'MINE_PRODUCTION_RESET'],
      ['identity', `update mine_accrual_states set mine_building_id='${randomUUID()}' where mine_building_id=$1`, 'MINE_PRODUCTION_RESET'],
      ['rewind', 'update mine_accrual_states set version=version-1 where mine_building_id=$1', 'MINE_PRODUCTION_VERSION'],
      ['jump', 'update mine_accrual_states set version=version+2 where mine_building_id=$1', 'MINE_PRODUCTION_VERSION'],
      ['stock-without-version', 'update mine_accrual_states set accrued_shards=accrued_shards+1 where mine_building_id=$1', 'MINE_PRODUCTION_VERSION'],
    ];
    for (const [name, query, code] of vectors) {
      await refusal(f.conn.sql.unsafe(query!, [f.mine.id]), code!); expect(await f.footprint(), name).toEqual(before);
    }
    // Truncate also includes FK-dependent immutable tables; either the state's
    // explicit guard or retained-table guard must refuse the actual cascade.
    let truncated = false;
    try { await f.conn.sql`truncate mine_accrual_states cascade`; truncated = true; }
    catch (error) { expect((error as Error).message).toMatch(/MINE_PRODUCTION_RESET|SHARDS_MINE_HISTORY_IMMUTABLE/); }
    expect(truncated).toBe(false); expect(await f.footprint()).toEqual(before);
    await f.conn.sql`update mine_accrual_states set full_notification_check_at=${f.now.toISOString()} where mine_building_id=${f.mine.id}`;
    expect(await f.state()).toMatchObject({ version: 1, production_remainder: f.remainder.toString() });
  });

  it('refuses changed installed hooks and old snapshots before opening any new production authority', async () => {
    const f = await fixture(); await f.capture(); const before = await f.footprint();
    for (const trigger of ['mine_production_state_guard', 'mine_production_state_applied', 'mine_production_state_truncate']) {
      await refusal(f.conn.sql.begin(async tx => {
        await tx.unsafe(`alter table mine_accrual_states disable trigger ${trigger}`);
        await tx`select shardkeep_mine_production_hooks()`;
      }), 'MINE_PRODUCTION_HOOKS_REQUIRED');
    }
    await refusal(f.conn.sql.begin(async tx => {
      await tx`drop trigger mine_production_state_guard on mine_accrual_states`;
      await tx`create trigger mine_production_state_guard before insert or update of version or delete on mine_accrual_states for each row execute function shardkeep_mine_production_state_guard()`;
      await tx`select shardkeep_mine_production_hooks()`;
    }), 'MINE_PRODUCTION_HOOKS_REQUIRED');
    await refusal(f.conn.db.transaction(async tx => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      await pending(f, tx);
    }), 'MINE_PRODUCTION_ISOLATION');
    expect(await f.footprint()).toEqual(before);
  });

  it('rejects labeled privileged storage corruption independently before history can authorize collection', async () => {
    const f = await fixture(); await f.capture();
    const [segment] = await f.conn.sql`select id,source_key from shards_mine_segments where mine_id=${f.mine.id}`;
    const clock = await readMineProductionClock(f.conn.db, segment!.id, segment!.source_key); expect(clock).toBeDefined();
    const before = await f.footprint();
    for (const changed of ["wallet=wallet||'corrupt'", "quota=quota+1", "anchor_at=anchor_at-interval '1 millisecond'", 'applied=false', 'state_version=state_version+1', 'gross=gross+1']) {
      // ALTER + inconsistent data is deliberately privileged fixture corruption.
      // Roll back the transaction after observing the independent read refusal.
      await expect(f.conn.db.transaction(async tx => {
        await tx.execute(sql`alter table shards_mine_production_settlements disable trigger mine_production_settlement_guard`);
        // wallet retains its FK, so use a valid alternate existing player instead.
        const alteration = changed.startsWith('wallet=') ? "wallet=(select wallet from players where wallet<> '" + f.wallet + "' order by wallet limit 1)" : changed;
        if (changed.startsWith('wallet=')) {
          await tx.execute(sql`insert into players(wallet) values(${randomUUID()})`);
        }
        await tx.execute(sql.raw(`update shards_mine_production_settlements set ${alteration} where id='${clock!.settlementId}'`));
        await tx.execute(sql`alter table shards_mine_production_settlements enable trigger mine_production_settlement_guard`);
        await readMineProductionClock(tx, segment!.id, segment!.source_key);
      })).rejects.toThrow('Original Mine production clock differs');
      expect(await f.footprint(), changed).toEqual(before);
    }
    await expect(f.conn.db.transaction(async tx => {
      await tx.execute(sql`alter table shards_mine_segment_production disable trigger mine_production_segment_guard`);
      await tx.execute(sql`delete from shards_mine_segment_production where segment_id=${segment!.id}`);
      await tx.execute(sql`alter table shards_mine_segment_production enable trigger mine_production_segment_guard`);
      await readMineProductionClock(tx, segment!.id, segment!.source_key);
    })).rejects.toThrow('Original Mine production clock differs');
    expect(await f.footprint()).toEqual(before);
    const app = await f.open(); expect((await f.collect(app)).statusCode).toBe(200);
    const [child] = await f.conn.sql`select id,source_key from shards_mine_segments where mine_id=${f.mine.id} and recovery_parent_id is not null`;
    const afterIssue = await f.footprint();
    await expect(f.conn.db.transaction(async tx => {
      await tx.execute(sql`alter table shards_mine_segment_production disable trigger mine_production_segment_guard`);
      await tx.execute(sql`update shards_mine_segment_production set settlement_id=(select id from shards_mine_production_settlements
        where mine_id=${f.mine.id} and kind='collect') where segment_id=${child!.id}`);
      await tx.execute(sql`alter table shards_mine_segment_production enable trigger mine_production_segment_guard`);
      await readMineProductionClock(tx, child!.id, child!.source_key);
    })).rejects.toThrow('Original Mine production clock differs');
    expect(await f.footprint()).toEqual(afterIssue);
  });

  it('keeps v2 source guards and immutable history after old migration replay and explicitly checks a zero-quota settlement', async () => {
    const f = await fixture(), app = await f.open(); expect((await f.collect(app)).statusCode).toBe(200);
    const [child] = await f.conn.sql`select id,source_key from shards_mine_segments where mine_id=${f.mine.id} and recovery_parent_id is not null`;
    const original = await readMineProductionClock(f.conn.db, child!.id, child!.source_key), before = await f.footprint();
    for (const filename of ['0201_shards_mine_resolutions.sql', '0202_shards_mine_resolution_contract.sql']) {
      const migration = await readFile(new URL('../drizzle/' + filename, import.meta.url), 'utf8');
      for (const chunk of migration.split('--> statement-breakpoint').filter(s => s.trim())) await f.conn.sql.unsafe(chunk);
    }
    await f.conn.sql`select shardkeep_mine_production_hooks()`;
    expect(await readMineProductionClock(f.conn.db, child!.id, child!.source_key)).toEqual(original);
    expect((await f.collect(app)).json()).toEqual({ amount: '0' }); expect(await f.footprint()).toEqual(before);
    // Current production config clamps emission above zero. This is the actual
    // lower-level SQL contract for a zero quota, not a claim that HTTP exposes it.
    const state = await f.state(), next = new Date(+f.now + 1);
    await f.conn.db.transaction(async tx => {
      await prepareMineProductionSettlement(tx, { mineId: f.mine.id, baseId: f.base.id, wallet: f.wallet, version: state.version,
        lastAt: new Date(state.last_accrual_at), previous: 0n, remainderBefore: f.remainder, now: next,
        quota: 0n, capacity: 0n, gross: 0n, remainderAfter: f.remainder, targetBuffer: 0n, targetAt: next, kind: 'reanchor' });
      await tx.execute(sql`update mine_accrual_states set last_accrual_at=${next.toISOString()},version=version+1 where mine_building_id=${f.mine.id}`);
    });
    const final = await f.state();
    expect(final).toMatchObject({ accrued_shards: '0', production_remainder: f.remainder.toString() });
    expect(new Date(final.last_accrual_at)).toEqual(next);
  });
});
