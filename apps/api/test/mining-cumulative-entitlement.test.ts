import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { describe, it, expect } from 'vitest';
import { buildMiningAllocationTree, encodeMiningAllocationLeaf, encodeMiningAllocationProof, type MiningAllocationLeaf } from '@shardkeep/chain/mining-allocation';
import { projectMiningClaimEntitlements, createMiningClaimEntitlementReader } from '../src/mining/claimEntitlement';
import { loadAuditedMiningPrior } from '../src/mining/publicationHistory';
import { withCumulativeFreePublicationFixture as fixture } from './fixtures/cumulativeFreePublication';

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];
const identity = (f: Fixture) => ({ ...f.identity, keepMint: f.backing.trust.keepMint.toBase58(), reserveOwner: f.backing.trust.reserveOwner.toBase58(),
  reviewedDeploymentSlot: f.backing.trust.reviewedDeploymentSlot, reviewedProgramDataSha256: f.backing.trust.reviewedProgramDataSha256 });
async function leaves(f: Fixture, sequence: string) { return (await loadAuditedMiningPrior(f.conn.db, { ...identity(f), sequence })).declaration.leaves; }
async function insert(f: Fixture, epochId: string, input: readonly MiningAllocationLeaf[], options: { reverseIndex?: boolean; foreignLabel?: boolean } = {}) {
  const tree = buildMiningAllocationTree(input);
  return f.conn.sql.begin(async tx => {
    await tx`insert into mining_claim_entitlement_headers(epoch_id) values(${epochId})`;
    for (let i = 0; i < tree.leafCount; i++) {
      const leaf = tree.leaves[i]!, wallet = options.foreignLabel && i === 0 ? Keypair.generate().publicKey.toBase58() : leaf.wallet;
      await tx`insert into mining_claim_entitlement_leaves(epoch_id,wallet,leaf_index,leaf_bytes,proof_bytes)
        values(${epochId},${wallet},${options.reverseIndex ? tree.leafCount - i - 1 : i},${Buffer.from(encodeMiningAllocationLeaf(leaf))},${Buffer.from(encodeMiningAllocationProof(tree.proof(i)))})`;
    }
  });
}
async function absent(f: Fixture, epochId: string) {
  expect(await f.conn.sql`select epoch_id from mining_claim_entitlement_headers where epoch_id=${epochId}`).toHaveLength(0);
  expect(await f.conn.sql`select wallet from mining_claim_entitlement_leaves where epoch_id=${epochId}`).toHaveLength(0);
}

describe('cumulative projection SQL authority', () => {
  it('requires the complete exact predecessor projection before sequence two can commit', async () => fixture(async f => {
    const first = await f.first(), second = await (await f.stageDay('2020-01-02')).publish(), epoch = second.prepared.epochId;
    await expect(projectMiningClaimEntitlements(f.conn.db, { epochId: epoch })).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
    await expect(insert(f, epoch, await leaves(f, '2'))).rejects.toThrow('MINING_ENTITLEMENT_PREDECESSOR');
    await absent(f, epoch);
    await projectMiningClaimEntitlements(f.conn.db, { epochId: first.prepared.epochId });
    expect(await projectMiningClaimEntitlements(f.conn.db, { epochId: epoch })).toMatchObject({ sequence: '2', leafCount: 2 });
    const inactive = await createMiningClaimEntitlementReader(f.conn.db, f.identity)(f.buyer);
    expect(inactive.kind).toBe('entitlement');
  }), 120_000);

  it('rejects owner projection mistakes even when the forged tree has a valid total and internally valid proofs', async () => fixture(async f => {
    const first = await f.first(); await projectMiningClaimEntitlements(f.conn.db, { epochId: first.prepared.epochId });
    const second = await (await f.stageDay('2020-01-02')).publish(), epoch = second.prepared.epochId, original = await leaves(f, '2');
    const active = original.find(l => l.wallet === f.wallet)!, inactive = original.find(l => l.wallet === f.buyer)!;
    expect(active.cumulativeKeep).toBeGreaterThan(1n);
    const transfer = original.map(l => ({ ...l, cumulativeKeep: l.cumulativeKeep + (l.wallet === f.wallet ? -1n : 1n) }));
    expect(buildMiningAllocationTree(transfer).total).toBe(buildMiningAllocationTree(original).total);
    const forged: readonly (readonly MiningAllocationLeaf[])[] = [
      transfer,
      original.filter(l => l.wallet !== f.buyer),
      original.map(l => l.wallet === f.buyer ? { ...l, wallet: Keypair.generate().publicKey.toBase58() } : l),
      original.map(l => l.wallet === f.buyer ? { ...l, cumulativeRenown: 1n, cumulativeDays: 1n } : l),
      original.map(l => l.wallet === f.wallet ? { ...l, cumulativeKeep: l.cumulativeKeep + inactive.cumulativeKeep } : l),
    ];
    for (const wrong of forged) {
      await expect(insert(f, epoch, wrong)).rejects.toThrow('MINING_ENTITLEMENT_INCOMPLETE'); await absent(f, epoch);
    }
    await expect(insert(f, epoch, original, { reverseIndex: true })).rejects.toThrow('MINING_ENTITLEMENT_INCOMPLETE'); await absent(f, epoch);
    await expect(insert(f, epoch, original, { foreignLabel: true })).rejects.toThrow('MINING_ENTITLEMENT_LEAF'); await absent(f, epoch);
    await expect(insert(f, epoch, original.map(l => ({ ...l, sequence: 1n })))).rejects.toThrow('MINING_ENTITLEMENT_LEAF'); await absent(f, epoch);
    await insert(f, epoch, original);
    expect(await projectMiningClaimEntitlements(f.conn.db, { epochId: epoch })).toMatchObject({ sequence: '2', totalCumulative: second.prepared.publication.total });
  }), 120_000);

  it('serializes duplicate projection without changing old rows and keeps runtime writes refused despite broad grants', async () => fixture(async f => {
    const first = await f.first(); await projectMiningClaimEntitlements(f.conn.db, { epochId: first.prepared.epochId });
    const old = await f.conn.sql`select wallet,leaf_index,encode(leaf_bytes,'hex') leaf,encode(proof_bytes,'hex') proof from mining_claim_entitlement_leaves where epoch_id=${first.prepared.epochId} order by leaf_index`;
    const second = await (await f.stageDay('2020-01-02')).publish(), epoch = second.prepared.epochId;
    const runs = await Promise.allSettled([projectMiningClaimEntitlements(f.conn.db, { epochId: epoch }), projectMiningClaimEntitlements(f.conn.db, { epochId: epoch })]);
    const result = await projectMiningClaimEntitlements(f.conn.db, { epochId: epoch });
    expect(runs.some(r => r.status === 'fulfilled')).toBe(true);
    for (const run of runs) if (run.status === 'fulfilled') expect(run.value).toEqual(result); else expect(run.reason).toMatchObject({ code: 'BUSY' });
    expect(await f.conn.sql`select wallet from mining_claim_entitlement_leaves`).toHaveLength(4);
    expect(await f.conn.sql`select wallet,leaf_index,encode(leaf_bytes,'hex') leaf,encode(proof_bytes,'hex') proof from mining_claim_entitlement_leaves where epoch_id=${first.prepared.epochId} order by leaf_index`).toEqual(old);
    await expect(f.conn.sql`insert into mining_claim_entitlement_headers(epoch_id) values(${epoch})`).rejects.toMatchObject({ code: '23505' });
    const role = `cumulative_claim_${randomUUID().replaceAll('-', '')}`;
    await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
    try {
      await expect(f.conn.sql.begin(async tx => { await tx.unsafe(`set local role ${role}`); await tx`insert into mining_claim_entitlement_headers(epoch_id) values(${epoch})`; })).rejects.toThrow('MINING_ENTITLEMENT_OWNER_REQUIRED');
      await expect(f.conn.sql`update mining_claim_entitlement_leaves set leaf_bytes=leaf_bytes`).rejects.toThrow('MINING_ENTITLEMENT_IMMUTABLE');
      await expect(f.conn.sql`delete from mining_claim_entitlement_headers where epoch_id=${first.prepared.epochId}`).rejects.toThrow('MINING_ENTITLEMENT_IMMUTABLE');
      await expect(f.conn.sql`truncate mining_claim_entitlement_leaves`).rejects.toThrow('MINING_ENTITLEMENT_IMMUTABLE');
    } finally { await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
  }), 120_000);

  it('has one deferred full-set check per header, retains widened bounded constraints and replays migration without rewriting history', async () => fixture(async f => {
    const first = await f.first(); await projectMiningClaimEntitlements(f.conn.db, { epochId: first.prepared.epochId });
    const second = await (await f.stageDay('2020-01-02')).publish(); await projectMiningClaimEntitlements(f.conn.db, { epochId: second.prepared.epochId });
    const before = await f.conn.sql`select to_jsonb(h) row from mining_claim_entitlement_headers h order by sequence`;
    const migration = readFileSync(new URL('../drizzle/0178_mining_cumulative_entitlements.sql', import.meta.url), 'utf8');
    for (let i = 0; i < 2; i++) await f.conn.sql.begin(async tx => { for (const statement of migration.split('--> statement-breakpoint').filter(s => s.trim())) await tx.unsafe(statement); });
    expect(await f.conn.sql`select to_jsonb(h) row from mining_claim_entitlement_headers h order by sequence`).toEqual(before);
    const triggers = await f.conn.sql`select c.relname,t.tgname,t.tgdeferrable,t.tginitdeferred from pg_trigger t join pg_class c on c.oid=t.tgrelid
      where t.tgfoid='public.shardkeep_mining_entitlement_complete()'::regprocedure order by t.tgname`;
    expect(triggers).toEqual([{ relname: 'mining_claim_entitlement_headers', tgname: 'mining_claim_entitlement_headers_complete', tgdeferrable: true, tginitdeferred: true }]);
    // Copy only CHECK constraints into a rolled-back temp table: these boundary
    // probes cannot create a production header or bypass any production trigger.
    const rollback = Error('rollback boundary fixture');
    const bounds = async (sequence: string, count: number) => f.conn.sql.begin(async tx => {
      await tx.unsafe('create temporary table test_claim_header_bounds (like public.mining_claim_entitlement_headers including constraints) on commit drop');
      await tx`insert into test_claim_header_bounds select (jsonb_populate_record(null::test_claim_header_bounds,to_jsonb(h)||jsonb_build_object('sequence',${sequence}::text,'leaf_count',${count}::integer))).* from mining_claim_entitlement_headers h where h.epoch_id=${first.prepared.epochId}`;
      throw rollback;
    });
    await expect(bounds('18446744073709551615', 10000)).rejects.toBe(rollback);
    for (const [sequence, count] of [['0', 2], ['18446744073709551616', 2], ['2', 10001], ['2', 0]] as const) await expect(bounds(sequence, count)).rejects.toMatchObject({ code: '23514' });
    const leafBound = async (index: number) => f.conn.sql.begin(async tx => {
      await tx.unsafe('create temporary table test_claim_leaf_bounds (like public.mining_claim_entitlement_leaves including constraints) on commit drop');
      await tx`insert into test_claim_leaf_bounds select (jsonb_populate_record(null::test_claim_leaf_bounds,to_jsonb(l)||jsonb_build_object('leaf_index',${index}::integer))).* from mining_claim_entitlement_leaves l limit 1`;
      throw rollback;
    });
    await expect(leafBound(9999)).rejects.toBe(rollback);
    for (const index of [-1, 10000]) await expect(leafBound(index)).rejects.toMatchObject({ code: '23514' });
    await expect(f.conn.sql.begin('isolation level repeatable read', async tx => { await tx`insert into mining_claim_entitlement_headers(epoch_id) values(${first.prepared.epochId})`; })).rejects.toThrow('MINING_ENTITLEMENT_READ_COMMITTED_REQUIRED');
  }), 120_000);
});
