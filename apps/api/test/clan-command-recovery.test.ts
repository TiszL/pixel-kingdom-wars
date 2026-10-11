import { randomUUID } from 'node:crypto';
import { CLANS } from '@shardkeep/shared';
import { ClanCommandReceiptSchema, ClanCommandStatusSchema } from '@shardkeep/shared/clanCommands';
import { eq, or, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import type { Db, DbTx } from '../src/db/client';
import { bases, baseSlots, clanCommandReceipts, clanMembers, clans, ledgerEntries, ledgerTransactions, players, sessions } from '../src/db/schema';
import { executeClanCommand, getClanCommand } from '../src/game/clanCommands';
import { clanChestInvariantHolds, createClan, getMyClan, joinClan, kickMember, leaveClan } from '../src/game/clans';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const oldMulti = process.env['MULTI_BASE_ENABLED'];
let fixtureSerial = 0;
beforeAll(() => { process.env['MULTI_BASE_ENABLED'] = 'false'; });
afterEach(() => { process.env['MULTI_BASE_ENABLED'] = 'false'; });
afterAll(async () => {
  if (oldMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = oldMulti;
  await conn.sql.end();
});
async function fixture() {
  const leader = await createTestPlayer(db);
  await rewardShards(db, leader.wallet, BigInt(CLANS.createCostShards), 'test.fund.shards', randomUUID());
  // Suites share one DB and run sequentially. Check both unique fields instead
  // of allowing a short random tag collision to bypass the recovery assertions.
  let name: string; let tag: string;
  do {
    tag = `R${(++fixtureSerial).toString(36).toUpperCase().padStart(CLANS.tagMaxLen - 1, '0')}`;
    if (tag.length > CLANS.tagMaxLen) throw new Error('clan recovery fixture tags exhausted');
    name = `Receipt ${tag}`;
  } while ((await db.select({ id: clans.id }).from(clans)
    .where(or(eq(clans.name, name), eq(clans.tag, tag))).limit(1)).length > 0);
  const clan = await createClan(db, leader.wallet, { name, tag }, randomUUID());
  return { leader, clan };
}
const leave = (clanId: string, idempotencyKey = randomUUID(), baseId: string | null = null) =>
  ({ kind: 'leave' as const, request: { clanId, idempotencyKey, baseId } });
const kick = (clanId: string, wallet: string, idempotencyKey = randomUUID()) =>
  ({ kind: 'kick' as const, request: { clanId, wallet, idempotencyKey } });
async function seedChest(clanId: string, amount: bigint) {
  const sys = await bootstrapSystemAccounts(db);
  await postTransaction(db, { idempotencyKey: randomUUID(), type: 'test.clan-recovery.seed',
    entries: [{ account: sys.shard_genesis, delta: -amount }, { account: sys.clan_chest, delta: amount }] });
  await db.update(clans).set({ chestShards: amount }).where(eq(clans.id, clanId));
}
function failReceipt(error: Error): Db {
  return new Proxy(db, { get(target, key) {
    if (key === 'transaction') return (run: (tx: DbTx) => Promise<unknown>) => target.transaction((tx) => run(new Proxy(tx, {
      get(t, k) {
        if (k === 'insert') return (table: typeof clanCommandReceipts) => {
          if (table === clanCommandReceipts) throw error;
          return t.insert(table);
        };
        const value = Reflect.get(t, k); return typeof value === 'function' ? value.bind(t) : value;
      },
    })));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe.sequential('clan management command recovery', () => {
  it('serializes identical dissolve retries into one immutable proof and one exact payout', async () => {
    const f = await fixture(); await seedChest(f.clan.id, 777n); const command = leave(f.clan.id);
    const before = (await getOrCreatePlayerAccount(db, f.leader.wallet, 'player_shards')).balance;
    const results = await Promise.all(Array.from({ length: 6 }, () => executeClanCommand(db, f.leader.wallet, command)));
    for (const result of results) expect(result).toEqual(results[0]);
    const proof = ClanCommandReceiptSchema.parse(results[0]);
    expect(proof).toMatchObject({ state: 'disbanded', payoutShards: '777', baseId: null });
    expect(proof.ledgerTransactionId).not.toBeNull();
    expect((await getOrCreatePlayerAccount(db, f.leader.wallet, 'player_shards')).balance).toBe(before + 777n);
    expect((await getMyClan(db, f.leader.wallet)).clan).toBeNull();
    const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, proof.ledgerTransactionId!));
    expect(txn).toMatchObject({ type: 'clan.chest_dissolve', metadata: { clanId: f.clan.id, wallet: f.leader.wallet } });
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, proof.ledgerTransactionId!));
    expect(entries.map((e) => e.delta).sort()).toEqual([-777n, 777n]);
    expect(await clanChestInvariantHolds(db)).toBe(true);
  });
  it('retains exact zero payout and never infers it from a later empty clan lookup', async () => {
    const f = await fixture(); const command = leave(f.clan.id);
    const result = await executeClanCommand(db, f.leader.wallet, command);
    expect(result).toMatchObject({ state: 'disbanded', payoutShards: '0', ledgerTransactionId: null });
    expect((await getClanCommand(db, f.leader.wallet, command.request.idempotencyKey)).receipt).toEqual(result);
    expect((await getClanCommand(db, f.leader.wallet, randomUUID())).receipt).toBeNull();
  });
  it('an old successful leave cannot remove a subsequent clan membership', async () => {
    const first = await fixture(); const second = await fixture(); const member = await createTestPlayer(db);
    await joinClan(db, member.wallet, first.clan.id); const command = leave(first.clan.id);
    const result = await executeClanCommand(db, member.wallet, command);
    expect(result.state).toBe('left'); await joinClan(db, member.wallet, second.clan.id);
    expect(await executeClanCommand(db, member.wallet, command)).toEqual(result);
    expect((await getMyClan(db, member.wallet)).clan?.id).toBe(second.clan.id);
    const stale = await executeClanCommand(db, member.wallet, leave(first.clan.id));
    expect(stale).toMatchObject({ state: 'refused', refusalCode: 'CLAN_CHANGED' });
    expect((await getMyClan(db, member.wallet)).clan?.id).toBe(second.clan.id);
  });
  it('a kick retry cannot kick a target who joined again after the original outcome', async () => {
    const f = await fixture(); const target = await createTestPlayer(db); await joinClan(db, target.wallet, f.clan.id);
    const command = kick(f.clan.id, target.wallet); const result = await executeClanCommand(db, f.leader.wallet, command);
    expect(result.state).toBe('kicked'); await joinClan(db, target.wallet, f.clan.id);
    expect(await executeClanCommand(db, f.leader.wallet, command)).toEqual(result);
    expect((await getMyClan(db, target.wallet)).clan?.id).toBe(f.clan.id);
  });
  it('a definitive refusal stays refused even when a later state would allow the action', async () => {
    const f = await fixture(); const target = await createTestPlayer(db); await joinClan(db, target.wallet, f.clan.id);
    const command = leave(f.clan.id); const refused = await executeClanCommand(db, f.leader.wallet, command);
    expect(refused).toMatchObject({ state: 'refused', refusalCode: 'CLAN_LEADER_NOT_ALONE' });
    await kickMember(db, f.leader.wallet, target.wallet);
    expect(await executeClanCommand(db, f.leader.wallet, command)).toEqual(refused);
    expect((await getMyClan(db, f.leader.wallet)).clan?.id).toBe(f.clan.id);
    expect((await executeClanCommand(db, f.leader.wallet, leave(f.clan.id))).state).toBe('disbanded');
  });
  it('refuses changed clan, base, target and operation consent under an existing key', async () => {
    const f = await fixture(); const target = await createTestPlayer(db); const command = kick(f.clan.id, target.wallet);
    const receipt = await executeClanCommand(db, f.leader.wallet, command);
    expect(receipt.refusalCode).toBe('CLAN_TARGET_ABSENT');
    for (const changed of [kick(randomUUID(), target.wallet, command.request.idempotencyKey),
      kick(f.clan.id, f.leader.wallet, command.request.idempotencyKey), leave(f.clan.id, command.request.idempotencyKey)]) {
      await expect(executeClanCommand(db, f.leader.wallet, changed)).rejects.toMatchObject({ code: 'CLAN_COMMAND_MISMATCH' });
    }
    const left = leave(f.clan.id); await executeClanCommand(db, f.leader.wallet, left);
    await expect(executeClanCommand(db, f.leader.wallet, leave(f.clan.id, left.request.idempotencyKey, randomUUID())))
      .rejects.toMatchObject({ code: 'CLAN_COMMAND_MISMATCH' });
  });
  it('receipt persistence failure rolls back membership, dissolution and money together', async () => {
    const f = await fixture(); await seedChest(f.clan.id, 123n); const command = leave(f.clan.id);
    const before = (await getOrCreatePlayerAccount(db, f.leader.wallet, 'player_shards')).balance;
    const error = new Error('synthetic receipt storage outage');
    await expect(executeClanCommand(failReceipt(error), f.leader.wallet, command)).rejects.toBe(error);
    expect((await getClanCommand(db, f.leader.wallet, command.request.idempotencyKey)).receipt).toBeNull();
    expect((await getMyClan(db, f.leader.wallet)).clan?.id).toBe(f.clan.id);
    expect((await getOrCreatePlayerAccount(db, f.leader.wallet, 'player_shards')).balance).toBe(before);
    expect(await clanChestInvariantHolds(db)).toBe(true);
    expect((await executeClanCommand(db, f.leader.wallet, command)).payoutShards).toBe('123');
  });
  it('keeps self/nonleader/absent-member refusals explicit without deleting membership', async () => {
    const f = await fixture(); const member = await createTestPlayer(db); await joinClan(db, member.wallet, f.clan.id);
    expect((await executeClanCommand(db, f.leader.wallet, kick(f.clan.id, f.leader.wallet))).refusalCode).toBe('CLAN_SELF_KICK');
    expect((await executeClanCommand(db, member.wallet, kick(f.clan.id, f.leader.wallet))).refusalCode).toBe('CLAN_NOT_LEADER');
    expect((await getMyClan(db, member.wallet)).clan?.id).toBe(f.clan.id);
  });
  it('overlapping legacy and v1 kicks do not fabricate attribution for the losing command', async () => {
    const f = await fixture(); const target = await createTestPlayer(db); await joinClan(db, target.wallet, f.clan.id);
    const command = kick(f.clan.id, target.wallet);
    const [legacy, versioned] = await Promise.allSettled([
      kickMember(db, f.leader.wallet, target.wallet), executeClanCommand(db, f.leader.wallet, command),
    ]);
    expect(versioned.status).toBe('fulfilled');
    if (versioned.status !== 'fulfilled') throw versioned.reason;
    expect(versioned.value.state).toBe(legacy.status === 'fulfilled' ? 'refused' : 'kicked');
    if (legacy.status === 'fulfilled') expect(versioned.value.refusalCode).toBe('CLAN_TARGET_ABSENT');
    expect((await getMyClan(db, target.wallet)).clan).toBeNull();
    expect((await getClanCommand(db, f.leader.wallet, command.request.idempotencyKey)).receipt).toEqual(versioned.value);
  });
  it('overlapping different dissolve keys pay once and retain a no-effect receipt for the loser', async () => {
    const f = await fixture(); await seedChest(f.clan.id, 111n);
    const results = await Promise.all([leave(f.clan.id), leave(f.clan.id)].map((command) => executeClanCommand(db, f.leader.wallet, command)));
    expect(results.map((r) => r.state).sort()).toEqual(['disbanded', 'refused']);
    expect(results.find((r) => r.state === 'disbanded')?.payoutShards).toBe('111');
    expect(results.find((r) => r.state === 'refused')?.refusalCode).toBe('CLAN_CHANGED');
    expect(await clanChestInvariantHolds(db)).toBe(true);
  });
  it('a legacy leave waiting on its old clan lock cannot delete a newly joined membership', async () => {
    const old = await fixture(); const next = await fixture(); const member = await createTestPlayer(db);
    await joinClan(db, member.wallet, old.clan.id);
    let announce!: (pid: number) => void; let release!: () => void;
    const entered = new Promise<number>((resolve) => { announce = resolve; });
    const permit = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.select().from(clans).where(eq(clans.id, old.clan.id)).for('update');
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`); announce(row!.pid);
      await permit;
      // Legal kick-then-join state change while the old leave waits. The clan
      // still exists, so an unqualified wallet delete would erase the NEW row.
      await tx.delete(clanMembers).where(eq(clanMembers.playerWallet, member.wallet));
      await tx.insert(clanMembers).values({ playerWallet: member.wallet, clanId: next.clan.id });
    });
    const pid = await entered; const pending = leaveClan(db, member.wallet);
    try {
      await expect.poll(async () => (await db.execute(sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`)).length,
        { timeout: 5000 }).toBeGreaterThan(0);
    } finally { release(); }
    await blocker; expect(await pending).toEqual({ left: true });
    expect((await getMyClan(db, member.wallet)).clan?.id).toBe(next.clan.id);
  });
  it('retains immutable rows against UPDATE, DELETE and TRUNCATE and rejects incomplete refusal evidence', async () => {
    const f = await fixture(); const command = leave(f.clan.id); const result = await executeClanCommand(db, f.leader.wallet, command);
    const retained = { cause: { code: '23514', message: 'clan command receipts are immutable and retained' } };
    await expect(db.update(clanCommandReceipts).set({ payoutShards: 99n })).rejects.toMatchObject(retained);
    await expect(db.delete(clanCommandReceipts)).rejects.toMatchObject(retained);
    await expect(db.execute(sql`truncate clan_command_receipts`)).rejects.toMatchObject(retained);
    await expect(db.insert(clanCommandReceipts).values({ actorWallet: f.leader.wallet, requestKey: randomUUID(), kind: 'leave',
      clanId: f.clan.id, state: 'refused', payoutShards: 0n })).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'clan_command_outcome_ck' } });
    expect((await getClanCommand(db, f.leader.wallet, command.request.idempotencyKey)).receipt).toEqual(result);
  });
  it('reports the original stable payout deed after selection and ownership change without authority calls on GET', async () => {
    const f = await fixture(); await seedChest(f.clan.id, 222n); const buyer = await createTestPlayer(db);
    const [a, b] = await db.insert(bases).values([0, 1].map(() => ({ ownerWallet: f.leader.wallet, status: 'active' as const, landPaidAt: new Date() }))).returning();
    await db.insert(baseSlots).values([{ wallet: f.leader.wallet, baseId: a!.id, slot: 1, active: true }, { wallet: f.leader.wallet, baseId: b!.id, slot: 2, active: true }]);
    await rewardBaseShards(db, b!.id, 17n, 'test.clan-recovery.fund', randomUUID());
    process.env['MULTI_BASE_ENABLED'] = 'true'; let authorityReads = 0;
    const command = { ...leave(f.clan.id, randomUUID(), b!.id), baseContext: { baseId: b!.id, assertAuthority: async () => { authorityReads++; } } };
    const result = await executeClanCommand(db, f.leader.wallet, command);
    expect(result).toMatchObject({ baseId: b!.id, payoutShards: '222', state: 'disbanded' });
    expect(await getBaseShardBalance(db, b!.id)).toBe(239n); expect(await getBaseShardBalance(db, a!.id)).toBe(0n);
    await db.update(baseSlots).set({ active: false }).where(eq(baseSlots.baseId, b!.id));
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, b!.id));
    const count = authorityReads;
    expect((await getClanCommand(db, f.leader.wallet, command.request.idempotencyKey)).receipt).toEqual(result);
    expect((await getClanCommand(db, buyer.wallet, command.request.idempotencyKey)).receipt).toBeNull();
    expect(authorityReads).toBe(count);
    expect(await executeClanCommand(db, f.leader.wallet, command)).toEqual(result);
    expect(authorityReads).toBe(count);
  });
  it('propagates authority outages as uncertainty without recording a false refusal or substituting a base', async () => {
    const f = await fixture(); const [base] = await db.insert(bases).values({ ownerWallet: f.leader.wallet, status: 'active', landPaidAt: new Date() }).returning();
    await db.insert(baseSlots).values({ wallet: f.leader.wallet, baseId: base!.id, slot: 1, active: true });
    process.env['MULTI_BASE_ENABLED'] = 'true'; const command = leave(f.clan.id, randomUUID(), base!.id);
    await expect(executeClanCommand(db, f.leader.wallet, command)).rejects.toMatchObject({ code: 'CLAN_BASE_CONTEXT_MISMATCH' });
    const error = new Error('synthetic finalized authority unavailable');
    await expect(executeClanCommand(db, f.leader.wallet, { ...command, baseContext: { baseId: base!.id, assertAuthority: async () => { throw error; } } })).rejects.toBe(error);
    expect((await getClanCommand(db, f.leader.wallet, command.request.idempotencyKey)).receipt).toBeNull();
    expect((await getMyClan(db, f.leader.wallet)).clan?.id).toBe(f.clan.id);
  });
  it('GET remains authenticated/private and actor scoped after land loss; growth and legacy responses stay gated', async () => {
    const f = await fixture(); const other = await createTestPlayer(db); const command = leave(f.clan.id);
    const receipt = await executeClanCommand(db, f.leader.wallet, command); const app = await buildApp(TEST_CONFIG, db);
    const cookies = async (wallet: string) => {
      const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    };
    try {
      const url = `/clans/v1/commands/${command.request.idempotencyKey}`; const own = await cookies(f.leader.wallet);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const res = await app.inject({ method: 'GET', url, cookies: own });
      expect(res.statusCode).toBe(200); expect(res.headers['cache-control']).toBe('private, no-store');
      expect(ClanCommandStatusSchema.parse(res.json()).receipt).toEqual(receipt);
      const stranger = await app.inject({ method: 'GET', url: `${url}?wallet=${f.leader.wallet}`, cookies: await cookies(other.wallet) });
      expect(ClanCommandStatusSchema.parse(stranger.json()).receipt).toBeNull();
      expect((await app.inject({ method: 'POST', url: '/clans/v1/leave', cookies: own, payload: command.request })).statusCode).toBe(402);
    } finally { await app.close(); }
  });
  it('routes retain exact terminal refusal/success bodies and reject noncanonical consent before mutation', async () => {
    const f = await fixture(); const target = await createTestPlayer(db); await joinClan(db, target.wallet, f.clan.id);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, f.leader.wallet));
    const [session] = await db.insert(sessions).values({ wallet: f.leader.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.leader.wallet, session!.id) };
    const app = await buildApp(TEST_CONFIG, db);
    try {
      const command = leave(f.clan.id);
      const bad = await app.inject({ method: 'POST', url: '/clans/v1/leave', cookies,
        payload: { ...command.request, idempotencyKey: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' } });
      expect(bad.statusCode).toBe(400); expect((await getMyClan(db, f.leader.wallet)).clan?.id).toBe(f.clan.id);
      const refused = await app.inject({ method: 'POST', url: '/clans/v1/leave', cookies, payload: command.request });
      expect(refused.statusCode).toBe(200); expect(refused.headers['cache-control']).toBe('private, no-store');
      expect(ClanCommandReceiptSchema.parse(refused.json())).toMatchObject({ state: 'refused', refusalCode: 'CLAN_LEADER_NOT_ALONE' });
      const kicked = await app.inject({ method: 'POST', url: '/clans/v1/kick', cookies, payload: kick(f.clan.id, target.wallet).request });
      expect(kicked.statusCode).toBe(200); expect(ClanCommandReceiptSchema.parse(kicked.json()).state).toBe('kicked');
      const again = await app.inject({ method: 'POST', url: '/clans/v1/leave', cookies, payload: command.request });
      expect(again.json()).toEqual(refused.json());
      const fresh = leave(f.clan.id); const done = await app.inject({ method: 'POST', url: '/clans/v1/leave', cookies, payload: fresh.request });
      expect(done.statusCode).toBe(200); expect(ClanCommandReceiptSchema.parse(done.json())).toMatchObject({ state: 'disbanded', payoutShards: '0' });
      await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, f.leader.wallet));
      const read = await app.inject({ method: 'GET', url: `/clans/v1/commands/${fresh.request.idempotencyKey}`, cookies });
      expect(ClanCommandStatusSchema.parse(read.json()).receipt).toEqual(done.json());
    } finally { await app.close(); }
  });
});
