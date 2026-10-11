/**
 * D-009 refund sweep for the retired keep skins (M23 a8). What matters and why:
 *  - money moved is money honoured — every owned copy is refunded at its
 *    ORIGINAL purchase price. D-152 (owner 2026-09-20): historical refunds are
 *    GEMS grants (`grant:refund:<rowId>`) minted against the KEEP reward budget
 *    (which recycles to emission_pool, where the purchase recycled), never a
 *    custodial KEEP credit — custodial KEEP is being retired;
 *  - the sweep is IDEMPOTENT per PHYSICAL ROW: the post and the delete commit
 *    in one transaction, so a re-run can never credit the same row twice —
 *    while a copy that ENTERS the inventory later (escrow return, mid-sale
 *    settle) is a distinct purchased copy and MUST be refunded as its own
 *    position (security review 2026-08-15 finding 1);
 *  - market custody is honoured: an ACTIVE listing's held unit is unwound and
 *    refunded, while a RESERVED (possible SOL in flight) listing is skipped —
 *    and a retired skin can take no NEW reservations and is out of the public
 *    book (finding 2);
 *  - the info mail is best-effort — a disabled mail lane must never block the
 *    ledger refund.
 */
import { REMOVED_SKIN_REFUNDS } from '@shardkeep/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  itemListings, ledgerTransactions, mailMessages, playerItems, players,
} from '../src/db/schema';
import { getListings, reserveListing } from '../src/game/itemMarket';
import { fundGemsRewardBudget } from '../src/game/gemsGrants';
import { refundRemovedSkins } from '../src/game/skinRefunds';
import {
  bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction,
} from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb();
const db = conn.db;

/** D-152: the refund lands as GEMS; custodial KEEP never moves. */
const balance = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_gems')).balance;
const keepBalance = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;

/** Refund grants are backed by gems_reward_budget, which is funded from
 * emission_pool (the account purchases recycled into); seed the pool from the
 * mint dimension exactly like production genesis does, but small, then move
 * the backing into the budget the way the operator posting will. */
async function fundEmissionPool(amount: bigint): Promise<void> {
  const sys = await bootstrapSystemAccounts(db);
  await postTransaction(db, {
    idempotencyKey: `skin-refund-test-pool-${randomUUID()}`,
    type: 'test.fund.pool',
    entries: [
      { account: sys.keep_genesis, delta: -amount },
      { account: sys.emission_pool, delta: amount },
    ],
    metadata: { testFixture: true },
  });
}

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
  await fundEmissionPool(1_000_000n);
  await fundGemsRewardBudget(db, 1_000_000n, `skin-refund-test-budget-${randomUUID()}`, { testFixture: true });
});
afterEach(() => { delete process.env['MAIL_DELIVERY_ENABLED']; });
afterAll(async () => { await conn.sql.end(); });

describe.sequential('refundRemovedSkins', () => {
  it('refunds each owned copy at its original price, consumes the row, and unequips it', async () => {
    const p = await createTestPlayer(db);
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'skin_keep_frost', qty: 1 });
    await db.update(players).set({ keepSkin: 'skin_keep_frost' }).where(eq(players.wallet, p.wallet));
    const before = await balance(p.wallet);

    const sweep = await refundRemovedSkins(db);

    expect(sweep.refunded).toBeGreaterThanOrEqual(1);
    expect(await balance(p.wallet)).toBe(before + BigInt(REMOVED_SKIN_REFUNDS.skin_keep_frost));
    expect(await keepBalance(p.wallet)).toBe(0n); // never custodial KEEP (D-152)
    const rows = await db.select().from(playerItems)
      .where(and(eq(playerItems.playerWallet, p.wallet), eq(playerItems.itemId, 'skin_keep_frost')));
    expect(rows).toHaveLength(0); // the copy is consumed, not left dangling
    const [row] = await db.select({ keepSkin: players.keepSkin }).from(players)
      .where(eq(players.wallet, p.wallet));
    expect(row!.keepSkin).toBeNull();
  });

  it('a re-run refunds nothing further (idempotent), and a multi-copy stack pays qty × price once', async () => {
    const p = await createTestPlayer(db);
    // qty 2 is reachable historically via a market cancel returning a held copy.
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'skin_keep_gilded', qty: 2 });
    const before = await balance(p.wallet);

    await refundRemovedSkins(db);
    await refundRemovedSkins(db); // second run must be a no-op for this wallet

    expect(await balance(p.wallet)).toBe(before + 2n * BigInt(REMOVED_SKIN_REFUNDS.skin_keep_gilded));
    const txns = await db.select().from(ledgerTransactions)
      .where(like(ledgerTransactions.idempotencyKey, `grant:refund:skin.refund:${p.wallet}:skin_keep_gilded:%`));
    expect(txns).toHaveLength(1); // exactly one posting ever for this one row
  });

  it('REFUNDS a copy that re-enters the inventory after a sweep — a new physical row is a new owed position (D-009)', async () => {
    // Every path that can re-create a retired-skin row (escrow return on
    // cancel, mid-sale settle to the buyer) represents a copy somebody PAID
    // for that no earlier posting covered — the old wallet+item key consumed
    // such rows with no credit (security review 2026-08-15 finding 1). The
    // per-row key must pay it.
    const p = await createTestPlayer(db);
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'skin_keep_voidstone', qty: 1 });
    await refundRemovedSkins(db);
    const paidOnce = await balance(p.wallet);
    expect(paidOnce).toBe(BigInt(REMOVED_SKIN_REFUNDS.skin_keep_voidstone));

    // Simulates cancelListing's escrow return: a fresh player_items row.
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'skin_keep_voidstone', qty: 1 });
    await refundRemovedSkins(db);

    expect(await balance(p.wallet)).toBe(paidOnce + BigInt(REMOVED_SKIN_REFUNDS.skin_keep_voidstone));
    const rows = await db.select().from(playerItems)
      .where(and(eq(playerItems.playerWallet, p.wallet), eq(playerItems.itemId, 'skin_keep_voidstone')));
    expect(rows).toHaveLength(0); // consumed again
    const txns = await db.select().from(ledgerTransactions)
      .where(like(ledgerTransactions.idempotencyKey, `grant:refund:skin.refund:${p.wallet}:skin_keep_voidstone:%`));
    expect(txns).toHaveLength(2); // one posting per physical row, never more
  });

  it('cancels an ACTIVE skin listing so the held unit is returned and refunded', async () => {
    const p = await createTestPlayer(db);
    // The unit is held INSIDE the listing (list decremented inventory to 0).
    await db.insert(itemListings).values({
      sellerWallet: p.wallet,
      idempotencyKey: `skin-refund-test-${randomUUID()}`,
      itemId: 'skin_keep_frost',
      priceLamports: 1_000_000n,
      status: 'active',
    });
    const before = await balance(p.wallet);

    const sweep = await refundRemovedSkins(db);

    expect(sweep.skippedReserved).toBe(0);
    expect(await balance(p.wallet)).toBe(before + BigInt(REMOVED_SKIN_REFUNDS.skin_keep_frost));
    const [listing] = await db.select().from(itemListings)
      .where(and(eq(itemListings.sellerWallet, p.wallet), eq(itemListings.itemId, 'skin_keep_frost')));
    expect(listing!.status).toBe('cancelled');
    const rows = await db.select().from(playerItems)
      .where(and(eq(playerItems.playerWallet, p.wallet), eq(playerItems.itemId, 'skin_keep_frost')));
    expect(rows).toHaveLength(0); // returned by the cancel, then consumed by the refund
  });

  it('skips a RESERVED (mid-sale) listing entirely — no cancel, no refund of its unit', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    await db.insert(itemListings).values({
      sellerWallet: seller.wallet,
      idempotencyKey: `skin-refund-test-${randomUUID()}`,
      itemId: 'skin_keep_gilded',
      priceLamports: 1_000_000n,
      status: 'reserved',
      reservedBy: buyer.wallet,
      reservedUntil: new Date(Date.now() + 600_000),
      reference: `ref-${randomUUID()}`,
    });
    const before = await balance(seller.wallet);

    const sweep = await refundRemovedSkins(db);

    expect(sweep.skippedReserved).toBeGreaterThanOrEqual(1);
    expect(await balance(seller.wallet)).toBe(before); // a paying buyer may still be owed this item
    const [listing] = await db.select().from(itemListings)
      .where(and(eq(itemListings.sellerWallet, seller.wallet), eq(itemListings.itemId, 'skin_keep_gilded')));
    expect(listing!.status).toBe('reserved');
  });

  it('tolerates a disabled mail lane — the LEDGER refund lands, mail is best-effort', async () => {
    delete process.env['MAIL_DELIVERY_ENABLED']; // default-off: deliverSystemMail throws 503
    const p = await createTestPlayer(db);
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'skin_keep_frost', qty: 1 });

    const sweep = await refundRemovedSkins(db);

    expect(await balance(p.wallet)).toBe(BigInt(REMOVED_SKIN_REFUNDS.skin_keep_frost));
    expect(sweep.mailed).toBe(0);
  });

  it('delivers the info mail when the lane is up, funded by NO reward escrow', async () => {
    process.env['MAIL_DELIVERY_ENABLED'] = 'true';
    const p = await createTestPlayer(db);
    await db.insert(playerItems).values({ playerWallet: p.wallet, itemId: 'skin_keep_voidstone', qty: 1 });

    const sweep = await refundRemovedSkins(db);

    expect(sweep.mailed).toBeGreaterThanOrEqual(1);
    const [mail] = await db.select().from(mailMessages)
      .where(and(
        eq(mailMessages.recipientWallet, p.wallet),
        // Per-row dedupe key (mirrors the ledger key) — a second legitimate
        // refund later must mail again rather than dedupe into the first.
        like(mailMessages.dedupeKey, `skin.refund:${p.wallet}:skin_keep_voidstone:%`),
      ));
    // INFO mail only: the Gems moved through the ledger, never a mail
    // attachment (Gems never travel as mail, G-2) nor the reward escrow.
    expect(mail).toMatchObject({ kind: 'info', rewardState: null });
    expect(mail!.subject).toContain('REFUNDED');
  });

  it('refuses a NEW reservation of a retired skin listing — no fresh real-SOL commitment on a dead item', async () => {
    // A leftover reserved/active skin listing must drain through the existing
    // lifecycle only; letting a NEW buyer commit SOL to an item that cannot
    // render or be owned is a sale of nothing (finding 2).
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const [listing] = await db.insert(itemListings).values({
      sellerWallet: seller.wallet,
      idempotencyKey: `skin-refund-test-${randomUUID()}`,
      itemId: 'skin_keep_gilded',
      priceLamports: 1_000_000n,
      status: 'active',
    }).returning();
    await expect(
      reserveListing(db, { feeTreasury: seller.wallet }, buyer.wallet, listing!.id),
    ).rejects.toThrow(/retired/);
  });

  it('keeps retired skins OUT of the public book, even as leftover open rows', async () => {
    const seller = await createTestPlayer(db);
    await db.insert(itemListings).values({
      sellerWallet: seller.wallet,
      idempotencyKey: `skin-refund-test-${randomUUID()}`,
      itemId: 'skin_keep_frost',
      priceLamports: 1_000_000n,
      status: 'active',
    });
    const book = await getListings(db, new Date(), { itemId: 'skin_keep_frost' });
    expect(book.listings).toHaveLength(0);
    expect(book.summary.filter((s) => s.itemId === 'skin_keep_frost')).toHaveLength(0);
  });

  it('sweeps stray equipped pointers even when no inventory row backs them', async () => {
    // e.g. the only copy is escrowed in a reserved listing: nothing to refund
    // yet, but the dead equip slot must not keep naming a retired item.
    const p = await createTestPlayer(db);
    await db.execute(sql`update players set keep_skin = 'skin_keep_frost' where wallet = ${p.wallet}`);

    await refundRemovedSkins(db);

    const [row] = await db.select({ keepSkin: players.keepSkin }).from(players)
      .where(eq(players.wallet, p.wallet));
    expect(row!.keepSkin).toBeNull();
  });
});
