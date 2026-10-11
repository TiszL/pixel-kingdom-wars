/**
 * Operator tools for the 2026-08-22 owner decisions (K-048 / K-047):
 *  - purgeSyntheticAccounts: retire the scripted 2026-06-12/13 sign-in-burst
 *    wallets — base abandoned via the supported path, balances posted back to
 *    the pools (never a deleted ledger entry), state rows gone, bases inactive,
 *    player + history tombstoned; a real player is never selected.
 *  - backfillWelcomeKeep: one 5,000 KEEP reward mail per EXISTING Keeper,
 *    idempotent, skipping wallets whose welcome already carried KEEP.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYTEST } from '@shardkeep/shared';
import { ensureStartingBase } from '../src/game/base';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { accounts, bases, buildings, mailMessages, players, sessions, testerMilestones } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger/accounts';
import { backfillWelcomeKeep, selectWelcomeKeepCandidates } from '../src/db/backfillWelcomeKeep';
import { purgeSyntheticAccount, selectSyntheticAccounts } from '../src/db/purgeSyntheticAccounts';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let cluster: string | undefined;

beforeAll(async () => {
  process.env['MAIL_DELIVERY_ENABLED'] = 'true';
  cluster = process.env['SOLANA_CLUSTER'];
  delete process.env['SOLANA_CLUSTER'];
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  delete process.env['MAIL_DELIVERY_ENABLED'];
  if (cluster === undefined) delete process.env['SOLANA_CLUSTER']; else process.env['SOLANA_CLUSTER'] = cluster;
  await conn.sql.end();
});

/** Found a base the way the app does: the `bases` identity row plus the
 * starter terrain. `mail=false` models the pre-release era (no welcome mail). */
async function found(wallet: string, mail: boolean): Promise<void> {
  const prev = process.env['MAIL_DELIVERY_ENABLED'];
  process.env['MAIL_DELIVERY_ENABLED'] = mail ? 'true' : 'false';
  try {
    const baseId = await ensureWalletBaseIdentity(db, wallet, { createEmpty: true });
    await ensureStartingBase(db, wallet, baseId ?? undefined);
  } finally {
    if (prev === undefined) delete process.env['MAIL_DELIVERY_ENABLED']; else process.env['MAIL_DELIVERY_ENABLED'] = prev;
  }
}
async function session(wallet: string): Promise<void> {
  await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + 3_600_000) });
}
async function balance(id: string): Promise<bigint> {
  return (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!.balance;
}

describe.sequential('purgeSyntheticAccounts', () => {
  it('selects only the burst-day, never-seen, landless, no-history wallets and retires them without touching the ledger history', async () => {
    const sys = await bootstrapSystemAccounts(db);
    // A synthetic wallet: created in the burst, one session, auto-base, dev-grant KEEP, never seen again.
    const bot = await createTestPlayer(db);
    await found(bot.wallet, false);
    await session(bot.wallet);
    await fundTestKeep(db, bot.wallet, 47_000n, 'test.dev-grant', `purge-test:${bot.wallet}`);
    await db.update(players).set({ createdAt: new Date('2026-06-12T10:00:00Z'), lastSeenAt: null }).where(eq(players.wallet, bot.wallet));
    // A real player created the same day who came back — never selected.
    const human = await createTestPlayer(db);
    await found(human.wallet, false);
    await session(human.wallet);
    await db.update(players).set({ createdAt: new Date('2026-06-12T11:00:00Z'), lastSeenAt: new Date('2026-07-01T00:00:00Z') }).where(eq(players.wallet, human.wallet));
    // A burst-day wallet that later bought land — never selected.
    const buyer = await createTestPlayer(db);
    await found(buyer.wallet, false);
    await session(buyer.wallet);
    await db.update(players).set({ createdAt: new Date('2026-06-13T10:00:00Z'), lastSeenAt: null }).where(eq(players.wallet, buyer.wallet));
    await db.update(bases).set({ landPaidAt: new Date() }).where(eq(bases.ownerWallet, buyer.wallet));

    // An in-flight raid against the synthetic base blocks its retirement until the raid settles.
    const { raids } = await import('../src/db/schema');
    const [raid] = await db.insert(raids).values({
      attackerWallet: human.wallet, defenderWallet: bot.wallet, status: 'pending_orders', seed: 1n,
      snapshot: {}, armySnapshot: {}, ordersDeadlineAt: new Date(Date.now() + 60_000),
    }).returning({ id: raids.id });
    expect(await selectSyntheticAccounts(db, { only: [bot.wallet] })).toEqual([]);
    expect(await purgeSyntheticAccount(db, bot.wallet)).toBeNull();
    await db.update(raids).set({ status: 'resolved' }).where(eq(raids.id, raid!.id));

    const selected = await selectSyntheticAccounts(db, { only: [bot.wallet, human.wallet, buyer.wallet] });
    expect(selected.map((c) => c.wallet)).toEqual([bot.wallet]);
    expect(selected[0]!.keepBalance).toBe(47_000n);
    expect(selected[0]!.buildings).toBeGreaterThan(0);

    const pool0 = await balance(sys.emission_pool);
    const burn0 = await balance(sys.shard_burn);
    const shardsBefore = (await db.execute<{ total: string }>(sql`select coalesce(sum(balance),0)::text as total from accounts
      where (owner_wallet = ${bot.wallet} and kind = 'player_shards')
         or (base_id in (select id from bases where owner_wallet = ${bot.wallet}) and kind in ('base_shards','base_forge_escrow'))`) as unknown as Array<{ total: string }>)[0]!.total;

    const r = await purgeSyntheticAccount(db, bot.wallet);
    expect(r).not.toBeNull();
    expect(r!.keepReturned).toBe(47_000n);
    expect(r!.buildingsDeleted).toBeGreaterThan(0);
    expect(r!.basesDeactivated).toBeGreaterThan(0);
    // Balances went back to the pools through the ledger; nothing was deleted there.
    expect(await balance(sys.emission_pool)).toBe(pool0 + 47_000n);
    expect(await balance(sys.shard_burn)).toBe(burn0 + BigInt(shardsBefore));
    const keepAcc = (await db.select().from(accounts).where(and(eq(accounts.ownerWallet, bot.wallet), eq(accounts.kind, 'player_keep'))))[0]!;
    expect(keepAcc.balance).toBe(0n);
    const entries = (await db.execute<{ n: number }>(sql`select count(*)::int as n from ledger_entries where account_id = ${keepAcc.id}`) as unknown as Array<{ n: number }>)[0]!.n;
    expect(entries).toBeGreaterThanOrEqual(2); // the grant AND the return are both still there
    // Every purge transaction balances to zero.
    const unbalanced = (await db.execute<{ n: number }>(sql`select count(*)::int as n from (
      select t.id from ledger_transactions t join ledger_entries e on e.txn_id = t.id
      where t.type = 'purge.synthetic' group by t.id having sum(e.delta) <> 0) x`) as unknown as Array<{ n: number }>)[0]!.n;
    expect(unbalanced).toBe(0);
    // State is gone, the base is inactive, the player row is a tombstone.
    expect(await db.select().from(buildings).where(eq(buildings.playerWallet, bot.wallet))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.wallet, bot.wallet))).toHaveLength(0);
    expect(await db.select().from(testerMilestones).where(eq(testerMilestones.wallet, bot.wallet))).toHaveLength(0);
    expect((await db.select().from(bases).where(eq(bases.ownerWallet, bot.wallet))).every((b) => b.status === 'inactive')).toBe(true);
    expect((await db.select().from(players).where(eq(players.wallet, bot.wallet)))[0]).toBeTruthy();
    // Idempotent: it no longer qualifies (base inactive), so a second run is a no-op.
    expect(await purgeSyntheticAccount(db, bot.wallet)).toBeNull();
    // The human and the buyer are untouched.
    expect((await db.select().from(buildings).where(eq(buildings.playerWallet, human.wallet))).length).toBeGreaterThan(0);
    expect((await db.select().from(bases).where(eq(bases.ownerWallet, buyer.wallet)))[0]!.status).toBe('active');
  });
});

describe.sequential('backfillWelcomeKeep', () => {
  it('mails 5,000 KEEP once to existing Keepers with a base and a session, skipping post-release founders and the synthetic cohort', async () => {
    const sys = await bootstrapSystemAccounts(db);
    // Existing Keeper: founded a base before the release (the welcome mail the
    // old code sent carried no KEEP) — simulate by founding with mail disabled.
    const veteran = await createTestPlayer(db);
    await found(veteran.wallet, false);
    await session(veteran.wallet);
    // Post-release founder: the first-base welcome already carries KEEP.
    const fresh = await createTestPlayer(db);
    await found(fresh.wallet, true);
    await session(fresh.wallet);
    // Synthetic burst wallet (never seen, landless, base) — not a player.
    const bot = await createTestPlayer(db);
    await found(bot.wallet, false);
    await session(bot.wallet);
    await db.update(players).set({ createdAt: new Date('2026-06-13T09:00:00Z'), lastSeenAt: null }).where(eq(players.wallet, bot.wallet));
    // A wallet with a base but no session ever — not a player either.
    const ghost = await createTestPlayer(db);
    await found(ghost.wallet, false);
    // A Keeper whose base is no longer active (deed sold / reconciled) is still an
    // existing player and is owed the reward.
    const sold = await createTestPlayer(db);
    await found(sold.wallet, false);
    await session(sold.wallet);
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.ownerWallet, sold.wallet));

    const only = [veteran.wallet, fresh.wallet, bot.wallet, ghost.wallet, sold.wallet];
    expect((await selectWelcomeKeepCandidates(db, only)).map((c) => c.wallet).sort()).toEqual([veteran.wallet, sold.wallet].sort());

    const pool0 = await balance(sys.emission_pool);
    const escrow0 = await balance(sys.mail_keep_escrow);
    const first = await backfillWelcomeKeep(db, { only });
    expect(first.delivered.sort()).toEqual([veteran.wallet, sold.wallet].sort());
    const [mail] = await db.select().from(mailMessages)
      .where(and(eq(mailMessages.recipientWallet, veteran.wallet), eq(mailMessages.dedupeKey, `welcome-keep:${veteran.wallet}`)));
    expect(mail).toBeTruthy();
    expect(mail!.kind).toBe('reward');
    const att = (await db.execute<{ kind: string; amount: string }>(sql`select kind, amount::text as amount from mail_attachments where message_id = ${mail!.id}`) as unknown as Array<{ kind: string; amount: string }>);
    expect(att).toEqual([{ kind: 'KEEP', amount: String(PLAYTEST.welcomeKeep) }]);
    expect(await balance(sys.emission_pool)).toBe(pool0 - 2n * BigInt(PLAYTEST.welcomeKeep));
    expect(await balance(sys.mail_keep_escrow)).toBe(escrow0 + 2n * BigInt(PLAYTEST.welcomeKeep));
    // Idempotent: neither is a candidate any more; nothing is reserved twice.
    const second = await backfillWelcomeKeep(db, { only });
    expect(second.delivered).toEqual([]);
    expect(await balance(sys.emission_pool)).toBe(pool0 - 2n * BigInt(PLAYTEST.welcomeKeep));
  });
});
