/**
 * Gems ledger invariants (D-152; GEMS-CURRENCY §3 G-1..G-4; E2-GEMS-CONTRACT §1).
 *
 * WHY each pin exists:
 *  - G-1 one-way: Gems are "non-withdrawable KEEP". A posting that debits a
 *    player's Gems and credits KEEP or SOL is a Gems→money exit, and the
 *    per-currency balance check alone would ALLOW it as a four-entry row. The
 *    engine refuses it (GemsOneWayError) so no future caller can open the door.
 *  - G-3 backing: every Gem minted has a KEEP debit of the same amount in the
 *    same transaction (conversion, or the reward budget for a grant) — the
 *    daily KEEP ceiling can never be exceeded through Gems.
 *  - G-4 recycle: converted KEEP lands in emission_pool, funding later epochs.
 *  - Bounds and idempotency: a replayed key with a different amount must never
 *    silently succeed (409), a grant on an exhausted budget must fail closed.
 */
import { randomUUID } from 'node:crypto';
import { GEMS } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, ledgerEntries } from '../src/db/schema';
import { convertGemsToShards, convertKeepToGems } from '../src/game/gems';
import { fundGemsRewardBudget, grantGems } from '../src/game/gemsGrants';
import { refundPostedSpend, spendGems } from '../src/game/spend';
import { HttpError } from '../src/lib/errors';
import {
  GemsOneWayError, GemsUnbackedMintError, InsufficientFundsError, bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction,
} from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const k = () => randomUUID();
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

const bal = async (wallet: string, kind: 'player_keep' | 'player_gems' | 'player_shards') =>
  (await getOrCreatePlayerAccount(db, wallet, kind)).balance;
const sysBal = async (id: string) => (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!.balance;
async function entriesOf(txnId: string) {
  const rows = await db.select({ delta: ledgerEntries.delta, kind: accounts.kind, currency: accounts.currency, owner: accounts.ownerWallet })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txnId));
  return rows.map((r) => `${r.kind}:${r.currency}:${r.delta}:${r.owner ? 'w' : '-'}`).sort();
}
/** Seed the finite emission pool from the mint dimension so a grant's KEEP
 *  backing is real without draining the shared allocation (helpers.ts note). */
async function seedEmissionPool(keep: bigint) {
  const sys = await bootstrapSystemAccounts(db);
  await postTransaction(db, { idempotencyKey: `test.gems.seed:${k()}`, type: 'test.seed',
    entries: [{ account: sys.keep_genesis, delta: -keep }, { account: sys.emission_pool, delta: keep }] });
}

describe('KEEP → Gems (gems.from_keep)', () => {
  it('posts the four-entry backed shape and recycles the KEEP (G-3, G-4)', async () => {
    const { wallet } = await createTestPlayer(db);
    await fundTestKeep(db, wallet, 100n, 'test.fund', k());
    const sys = await bootstrapSystemAccounts(db);
    const poolBefore = await sysBal(sys.emission_pool);
    const mintBefore = await sysBal(sys.gems_mint);
    const res = await convertKeepToGems(db, wallet, 40n, 'key-from-keep-1');
    expect(res).toMatchObject({ keep: '40', gems: String(40 * GEMS.gemsPerKeep), rate: GEMS.gemsPerKeep, duplicate: false });
    expect(await entriesOf(res.receiptId)).toEqual([
      'emission_pool:KEEP:40:-', 'gems_mint:GEMS:-40:-', 'player_gems:GEMS:40:w', 'player_keep:KEEP:-40:w',
    ]);
    expect(await bal(wallet, 'player_keep')).toBe(60n);
    expect(await bal(wallet, 'player_gems')).toBe(40n);
    expect((await sysBal(sys.emission_pool)) - poolBefore).toBe(40n);
    expect(mintBefore - (await sysBal(sys.gems_mint))).toBe(40n);
  });

  it('replays the same key without moving money and refuses a different amount (409)', async () => {
    const { wallet } = await createTestPlayer(db);
    await fundTestKeep(db, wallet, 100n, 'test.fund', k());
    const first = await convertKeepToGems(db, wallet, 10n, 'key-replay');
    const again = await convertKeepToGems(db, wallet, 10n, 'key-replay');
    expect(again).toMatchObject({ receiptId: first.receiptId, duplicate: true });
    expect(await bal(wallet, 'player_gems')).toBe(10n);
    await expect(convertKeepToGems(db, wallet, 11n, 'key-replay')).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_BODY_MISMATCH' });
    expect(await bal(wallet, 'player_gems')).toBe(10n);
  });

  it('enforces the bounds and the custodial balance with definitive 422 codes', async () => {
    const { wallet } = await createTestPlayer(db);
    await fundTestKeep(db, wallet, 5n, 'test.fund', k());
    await expect(convertKeepToGems(db, wallet, 0n, k())).rejects.toMatchObject({ statusCode: 422, code: 'GEMS_PURCHASE_BELOW_MINIMUM' });
    await expect(convertKeepToGems(db, wallet, BigInt(GEMS.maxConvertKeepPerTx) + 1n, k())).rejects.toMatchObject({ statusCode: 422, code: 'GEMS_PURCHASE_ABOVE_MAXIMUM' });
    await expect(convertKeepToGems(db, wallet, 6n, k())).rejects.toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_KEEP' });
    expect(await bal(wallet, 'player_keep')).toBe(5n);
    expect(await bal(wallet, 'player_gems')).toBe(0n);
  });
});

describe('spend and refund', () => {
  it('spendGems moves player_gems → gems_sink with GEMS metadata; a refund mirrors it exactly', async () => {
    const { wallet } = await createTestPlayer(db);
    await fundTestKeep(db, wallet, 50n, 'test.fund', k());
    await convertKeepToGems(db, wallet, 50n, k());
    const posted = await spendGems(db, wallet, 30n, 'test.gems.sink', `sink:${wallet}:a`, { note: 1 });
    expect(await entriesOf(posted.transaction.id)).toEqual(['gems_sink:GEMS:30:-', 'player_gems:GEMS:-30:w']);
    expect(await bal(wallet, 'player_gems')).toBe(20n);
    await expect(spendGems(db, wallet, 21n, 'test.gems.sink', `sink:${wallet}:b`)).rejects.toBeInstanceOf(InsufficientFundsError);
    const refund = await refundPostedSpend(db, posted, `sink:${wallet}:a:refund`, 'test.gems.sink.system_refund', { refundOf: posted.transaction.id });
    expect(await entriesOf(refund.transaction.id)).toEqual(['gems_sink:GEMS:-30:-', 'player_gems:GEMS:30:w']);
    expect(await bal(wallet, 'player_gems')).toBe(50n);
    const replay = await refundPostedSpend(db, posted, `sink:${wallet}:a:refund`, 'test.gems.sink.system_refund');
    expect(replay.duplicate).toBe(true);
    expect(await bal(wallet, 'player_gems')).toBe(50n);
  });
});

describe('G-1: Gems never become KEEP or SOL', () => {
  it('rejects a balanced four-entry posting that debits player_gems and credits player_keep', async () => {
    const { wallet } = await createTestPlayer(db);
    await fundTestKeep(db, wallet, 10n, 'test.fund', k());
    await convertKeepToGems(db, wallet, 10n, k());
    const sys = await bootstrapSystemAccounts(db);
    const gems = await getOrCreatePlayerAccount(db, wallet, 'player_gems');
    const keep = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
    await expect(postTransaction(db, { idempotencyKey: k(), type: 'test.exit', entries: [
      { account: gems.id, delta: -5n }, { account: sys.gems_sink, delta: 5n },
      { account: sys.emission_pool, delta: -5n }, { account: keep.id, delta: 5n },
    ] })).rejects.toBeInstanceOf(GemsOneWayError);
    const sol = await getOrCreatePlayerAccount(db, wallet, 'player_sol_credit');
    await expect(postTransaction(db, { idempotencyKey: k(), type: 'test.exit', entries: [
      { account: gems.id, delta: -1n }, { account: sys.gems_sink, delta: 1n },
      { account: sys.sol_treasury, delta: -1n }, { account: sol.id, delta: 1n },
    ] })).rejects.toBeInstanceOf(GemsOneWayError);
    expect(await bal(wallet, 'player_gems')).toBe(10n);
    expect(await bal(wallet, 'player_keep')).toBe(0n);
  });

  it('still allows the specified Gems postings (to SHARDS, and KEEP → Gems credits)', async () => {
    const { wallet } = await createTestPlayer(db);
    await fundTestKeep(db, wallet, 20n, 'test.fund', k());
    await convertKeepToGems(db, wallet, 20n, k());
    const res = await convertGemsToShards(db, wallet, 8n, 'key-to-shards');
    expect(res).toMatchObject({ gems: '8', shards: String(8 * GEMS.shardsPerGem), rate: GEMS.shardsPerGem, duplicate: false });
    expect(await entriesOf(res.receiptId)).toEqual([
      'gems_sink:GEMS:8:-', 'player_gems:GEMS:-8:w', 'player_shards:SHARDS:8:w', 'shard_genesis:SHARDS:-8:-',
    ]);
    expect(await bal(wallet, 'player_gems')).toBe(12n);
    await expect(convertGemsToShards(db, wallet, 13n, k())).rejects.toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_GEMS' });
    await expect(convertGemsToShards(db, wallet, 9n, 'key-to-shards')).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });
});

describe('G-3: every Gems mint carries its KEEP backing in the same posting', () => {
  it('rejects a gems_mint debit without an equal KEEP debit from a backing account', async () => {
    const { wallet } = await createTestPlayer(db);
    const sys = await bootstrapSystemAccounts(db);
    const gems = await getOrCreatePlayerAccount(db, wallet, 'player_gems');
    // Unbacked mint (balanced per currency, no KEEP leg at all).
    await expect(postTransaction(db, { idempotencyKey: k(), type: 'test.unbacked', entries: [
      { account: sys.gems_mint, delta: -5n }, { account: gems.id, delta: 5n },
    ] })).rejects.toBeInstanceOf(GemsUnbackedMintError);
    // Wrong amount of backing.
    await fundTestKeep(db, wallet, 10n, 'test.fund', k());
    const keep = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
    await expect(postTransaction(db, { idempotencyKey: k(), type: 'test.short-backed', entries: [
      { account: keep.id, delta: -4n }, { account: sys.emission_pool, delta: 4n },
      { account: sys.gems_mint, delta: -5n }, { account: gems.id, delta: 5n },
    ] })).rejects.toBeInstanceOf(GemsUnbackedMintError);
    // Backing from a non-backing KEEP account (the pool itself) is not backing.
    await expect(postTransaction(db, { idempotencyKey: k(), type: 'test.pool-backed', entries: [
      { account: sys.emission_pool, delta: -5n }, { account: sys.keep_genesis, delta: 5n },
      { account: sys.gems_mint, delta: -5n }, { account: gems.id, delta: 5n },
    ] })).rejects.toBeInstanceOf(GemsUnbackedMintError);
    expect(await bal(wallet, 'player_gems')).toBe(0n);
    expect(await bal(wallet, 'player_keep')).toBe(10n);
  });
});

describe('grants (E2-GEMS-CONTRACT §1.3)', () => {
  it('mints only against the KEEP reward budget and fails closed when it is exhausted', async () => {
    const { wallet } = await createTestPlayer(db);
    const sys = await bootstrapSystemAccounts(db);
    await seedEmissionPool(10n);
    const funded = await fundGemsRewardBudget(db, 10n, k(), { by: 'test' });
    expect(await entriesOf(funded.transaction.id)).toEqual(['emission_pool:KEEP:-10:-', 'gems_reward_budget:KEEP:10:-']);
    const poolBefore = await sysBal(sys.emission_pool);
    const grant = await grantGems(db, { wallet, gems: 7n, reason: 'task', ref: 'alpha' });
    expect(await entriesOf(grant.transaction.id)).toEqual([
      'emission_pool:KEEP:7:-', 'gems_mint:GEMS:-7:-', 'gems_reward_budget:KEEP:-7:-', 'player_gems:GEMS:7:w',
    ]);
    expect((await sysBal(sys.emission_pool)) - poolBefore).toBe(7n); // the backing recycles
    const replay = await grantGems(db, { wallet, gems: 7n, reason: 'task', ref: 'alpha' });
    expect(replay).toMatchObject({ duplicate: true, transaction: { id: grant.transaction.id } });
    // Other suites legitimately fund this shared account. Exceed its actual
    // balance without draining it: refusal must leave both sides unchanged.
    const remainingBudget = await sysBal(sys.gems_reward_budget);
    const err = await grantGems(db, { wallet, gems: remainingBudget + 1n, reason: 'task', ref: 'beta' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 503, code: 'GEMS_BUDGET_EXHAUSTED' });
    expect(await bal(wallet, 'player_gems')).toBe(7n);
    expect(await sysBal(sys.gems_reward_budget)).toBe(remainingBudget);
  });
});
