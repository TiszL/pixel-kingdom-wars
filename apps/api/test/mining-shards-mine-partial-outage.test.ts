import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMISSION_CONTROL, getMiningQuota, MINING, PHASE_E_HARVESTER } from '@shardkeep/shared';
import { bases, baseSlots, buildings, mineAccrualStates, players, referrals } from '../src/db/schema';
import { capturePhysicalMineSources } from '../src/mining/shardsTaxMineFullCapture';
import { readHistoricalMineTaxSource } from '../src/mining/shardsTaxMineRecoveryHistory';
import { readMineProductionClock } from '../src/mining/shardsTaxMineProduction';
import { setEmissionMultBps } from '../src/game/gameConfig';
import { activeReferralBonusBps } from '../src/game/social';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createPartialMineFixture, type PartialMineFixture } from './fixtures/partialMineProduction';

let conn: ReturnType<typeof resourceClaimsDatabase> | undefined, f: PartialMineFixture | undefined;
const fixture = () => { if (!f) throw Error('Partial Mine fixture unavailable'); return f; };
beforeEach(async () => { conn = resourceClaimsDatabase(); await conn.setup(); f = await createPartialMineFixture(conn); }, 120_000);
afterEach(async () => { const old = f; f = undefined; await old?.closeServers(); const db = conn; conn = undefined;
  await db?.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe.sequential('normal partial Mine collection during operating provider outage', () => {
  it('uses actual current-source failure and converges concurrent taps to one original issue', async () => {
    const f = fixture(), unavailable = vi.fn(() => { throw Error('current provider unavailable'); });
    const app = await f.open({ physicalMineSourceProvider: { policy: f.bank.policy, connect: unavailable } });
    const responses = await Promise.all([f.collect(app), f.collect(app)]);
    for (const r of responses) expect([200, 503], r.body).toContain(r.statusCode);
    const retry = await f.collect(app); expect(retry.statusCode, retry.body).toBe(200);
    const sum = [...responses, retry].filter(r => r.statusCode === 200).reduce((n, r) => n + BigInt(r.json().amount), 0n);
    const tax = f.gross * BigInt(PHASE_E_HARVESTER.v1.islandPoolBps) / BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);
    expect(sum).toBe(f.gross - tax); expect(unavailable).toHaveBeenCalled();
    expect((await f.footprint()).ledger).toHaveLength(1);
    expect(await f.conn.sql`select id from shards_mine_admissions where base_id=${f.base.id}`).toHaveLength(0);
    expect(await f.state()).toMatchObject({ accrued_shards: '0', production_remainder: f.remainder.toString() });
  });

  it('retains one original partial source during historical outage and recovers after process restart without recapturing', async () => {
    const f = fixture(); let unavailable = true;
    const app = await f.open({ physicalMineRecoveryProvider: f.provider(() => unavailable) });
    const first = await f.collect(app); expect(first.statusCode, first.body).toBe(503);
    expect(first.json().error.code).toBe('SHARDS_MINE_RESOLUTION_HELD');
    const before = await f.footprint(); expect(before.settlements).toHaveLength(1); expect(before.segments).toHaveLength(1);
    expect(before.ledger).toHaveLength(0); expect(before.assessments).toHaveLength(0);
    expect(await f.state()).toMatchObject({ accrued_shards: f.gross.toString(), production_remainder: f.remainder.toString() });
    expect((await f.collect(app)).statusCode).toBe(503); expect(await f.footprint()).toEqual(before);
    await f.closeServers(); unavailable = false;
    const restarted = await f.open(), result = await f.collect(restarted); expect(result.statusCode, result.body).toBe(200);
    const after = await f.footprint(); expect(after.ledger).toHaveLength(1);
    expect(after.settlements.filter(s => s.value.kind === 'capture')).toEqual(before.settlements);
    const [child] = await f.conn.sql`select id from shards_mine_segments where mine_id=${f.mine.id} and recovery_parent_id is not null`;
    const source = await readHistoricalMineTaxSource(f.conn.db, child!.id);
    expect(source.original.wallet).toBe(f.wallet); expect(source.term.snapshot.source.round).toBe('2');
    expect((await f.collect(restarted)).json()).toEqual({ amount: '0' });
    expect(await readHistoricalMineTaxSource(f.conn.db, child!.id)).toEqual(source);
  });

  it('preserves earned numerator across real emission and active referral changes without repricing captured units', async () => {
    const f = fixture(), app = await f.open(); expect((await f.collect(app)).statusCode).toBe(200);
    const [original] = await f.conn.sql`select id from shards_mine_segments where mine_id=${f.mine.id} and recovery_parent_id is not null`;
    const saved = await readHistoricalMineTaxSource(f.conn.db, original!.id);
    const referee = Keypair.generate().publicKey.toBase58(), deed = Keypair.generate().publicKey.toBase58();
    await f.conn.db.insert(players).values({ wallet: referee, lastSeenAt: f.now });
    const [referralBase] = await f.conn.db.insert(bases).values({ ownerWallet: referee, keepLevel: 3, status: 'active', landPaidAt: f.now, deedAssetId: deed, deedMintAssetId: deed }).returning();
    await f.conn.db.insert(baseSlots).values({ wallet: referee, slot: 1, baseId: referralBase!.id });
    await f.conn.db.insert(referrals).values({ referrerWallet: f.wallet, refereeWallet: referee, qualifiedAt: f.now });
    const bonus = await activeReferralBonusBps(f.conn.db, f.wallet); expect(bonus).toBeGreaterThan(0);
    await setEmissionMultBps(f.conn.db, EMISSION_CONTROL.minBps, f.now);
    const nextQuota = BigInt(getMiningQuota(1, [1], 0, EMISSION_CONTROL.minBps, bonus)); expect(nextQuota).not.toBe(f.quota);
    const oldAt = f.now, delta = (f.day - f.remainder + nextQuota - 1n) / nextQuota;
    const next = new Date(Number((BigInt(+oldAt) + delta) / 1000n + 1n) * 1000);
    const elapsed = BigInt(+next - +oldAt), numerator = f.remainder + nextQuota * elapsed;
    await f.time(next); const result = await f.collect(app); expect(result.statusCode, result.body).toBe(200);
    expect(numerator / f.day).toBe(1n); expect(elapsed * nextQuota).toBeLessThan(f.day);
    expect(await f.state()).toMatchObject({ production_remainder: (numerator % f.day).toString(), accrued_shards: '0' });
    const [child] = await f.conn.sql`select id,quota::text,source_key from shards_mine_segments where mine_id=${f.mine.id} and recovery_parent_id is not null order by starts_at desc limit 1`;
    expect(child!.quota).toBe(nextQuota.toString());
    expect((await readMineProductionClock(f.conn.db, child!.id, child!.source_key))!.remainder).toBe(f.remainder.toString());
    expect(await readHistoricalMineTaxSource(f.conn.db, original!.id)).toEqual(saved);
    expect(await f.conn.sql`select sum(gross)::text gross,sum(net+tax)::text funded from shards_tax_assessments where wallet=${f.wallet}`)
      .toEqual([{ gross: (f.gross + 1n).toString(), funded: (f.gross + 1n).toString() }]);
  });

  it('does not reset an empty sibling or tracked fraction on taps and holds backward time without mutation', async () => {
    const f = fixture(), app = await f.open(); expect((await f.collect(app)).statusCode).toBe(200);
    const [sibling] = await f.conn.db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.base.id, type: 'mine', level: 1, tx: 4, ty: 4 }).returning();
    await f.conn.db.insert(mineAccrualStates).values({ mineBuildingId: sibling!.id, lastAccrualAt: f.now });
    const before = await f.state();
    for (let i = 0; i < 3; i++) expect((await f.collect(app)).json()).toEqual({ amount: '0' });
    expect(await f.state()).toEqual(before);
    const [empty] = await f.conn.db.select().from(mineAccrualStates).where(eq(mineAccrualStates.mineBuildingId, sibling!.id));
    expect(empty).toMatchObject({ accruedShards: 0n, productionRemainder: null, lastAccrualAt: f.now });
    const footprint = await f.footprint();
    await expect(capturePhysicalMineSources(f.conn.db, f.wallet, f.base.id, { clock: () => new Date(+f.now - 1) }))
      .rejects.toMatchObject({ code: 'SHARDS_MINE_CAPTURE_HELD' });
    expect(await f.footprint()).toEqual(footprint);
  });

  it('rolls back a real post-lock pause and refuses independent state contention and wrong ownership', async () => {
    const f = fixture(), before = await f.footprint();
    await expect(capturePhysicalMineSources(f.conn.db, f.wallet, f.base.id, { clock: () => {
      vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); return f.now;
    } })).rejects.toMatchObject({ code: 'PHASE_E_DISABLED' });
    expect(await f.footprint()).toEqual(before); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
    await expect(capturePhysicalMineSources(f.conn.db, Keypair.generate().publicKey.toBase58(), f.base.id))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const other = f.conn.reopen(); let release!: () => void, ready!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { ready = resolve; });
    const writer = other.sql.begin(async tx => { await tx`select mine_building_id from mine_accrual_states where mine_building_id=${f.mine.id} for update`; ready(); await held; });
    try { await started; await expect(f.capture()).rejects.toMatchObject({ code: 'SHARDS_MINE_CAPTURE_HELD' }); expect(await f.footprint()).toEqual(before); }
    finally { release(); await writer; await other.sql.end(); }
    await f.capture(); expect(await f.state()).toMatchObject({ production_remainder: f.remainder.toString() });
  });

  it('keeps first tracking owner-only and executes later normal collection with an explicitly granted fixture runtime role', async () => {
    const f = fixture(), role = 'mine_fraction_' + randomUUID().replaceAll('-', ''), password = randomUUID();
    await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
    let runtime: ReturnType<typeof createDb> | undefined;
    try {
      const [database] = await f.conn.sql`select current_database() name`;
      await f.conn.sql.unsafe(`grant connect on database ${database!.name} to ${role};grant usage on schema public to ${role};grant select,insert,update on all tables in schema public to ${role};grant usage on all sequences in schema public to ${role}`);
      // Existing0114 project_player_activity rebuilds the wallet/day row with
      // DELETE+INSERT when real gameplay emits its action. No other deletion
      // capability is needed by this fixture's ordinary collection path.
      await f.conn.sql.unsafe(`grant delete on public.player_activity_days to ${role}`);
      const url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + database!.name; url.username = role; url.password = password;
      runtime = createDb(url.toString(), { max: 3 });
      expect(await runtime.sql`select current_user u,session_user s`).toEqual([{ u: role, s: role }]);
      await expect(capturePhysicalMineSources(runtime.db, f.wallet, f.base.id, { clock: () => f.now })).rejects.toMatchObject({ code: 'SHARDS_MINE_CAPTURE_HELD' });
      expect((await f.state()).production_remainder).toBeNull();
      // Explicit fixture grants describe the app writer boundary; production
      // provisioning remains K240-held and no migration installs these grants.
      const app = await f.open({}, runtime.db), response = await f.collect(app);
      expect(response.statusCode, response.body + '\n' + f.errors.join('\n')).toBe(200); expect((await f.footprint()).ledger).toHaveLength(1);
      await f.closeServers();
    } finally { await runtime?.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
  });
});
