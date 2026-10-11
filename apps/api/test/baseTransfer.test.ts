/**
 * Sellable bases S1/S2 (CLANS-SELLABLE-DEEDS-PLAN, 2026-07-27). THE INVARIANT
 * under test: a deed conveys STRUCTURES / PROGRESS / LAND and NEVER currency —
 * every balance stays with the seller. Everything else here is the handover
 * policy (conservative defaults pending Q-S1/Q-S2 sign-off).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildings, builderJobs, mineState, players, plots, shields } from '../src/db/schema';
import { ensureStartingBase, placeBuilding } from '../src/game/base';
import { collectMine } from '../src/game/emission';
import { ownershipEligible, sweepDeedTransfers, transferBase } from '../src/game/baseTransfer';
import { rewardShards } from '../src/game/spend';
import { ensurePlotAssigned } from '../src/game/world';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `xfer-${++key}-${Math.random().toString(36).slice(2)}`;

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

async function seller() {
  const p = await createTestPlayer(db);
  await db.update(players).set({
    entryPaidAt: new Date(), deedAssetId: `deed-${p.wallet.slice(0, 8)}`,
    keepLevel: 7, expansions: 1, trophies: 250,
  }).where(eq(players.wallet, p.wallet));
  await ensureStartingBase(db, p.wallet);
  await ensurePlotAssigned(db, p.wallet);
  await fundTestKeep(db, p.wallet, 12_345n, 'test.fund', k());
  await rewardShards(db, p.wallet, 6_789n, 'test.fund.shards', k());
  return p;
}

describe('transferBase (S2)', () => {
  it('moves structures/land/progress/deed — and NOT ONE unit of currency', async () => {
    const s = await seller();
    const b = await createTestPlayer(db); // baseless buyer
    const sKeep = (await getOrCreatePlayerAccount(db, s.wallet, 'player_keep')).balance;
    const sShards = (await getOrCreatePlayerAccount(db, s.wallet, 'player_shards')).balance;

    const res = await transferBase(db, s.wallet, b.wallet, `deed-${s.wallet.slice(0, 8)}`);
    expect(res.buildings).toBeGreaterThan(0);
    expect(res.plot).toBe(true);

    // Buyer: owns the base, the land, the progress, the deed, and entry.
    const [buyer] = await db.select().from(players).where(eq(players.wallet, b.wallet));
    expect(buyer!.deedAssetId).toBe(`deed-${s.wallet.slice(0, 8)}`);
    expect(buyer!.keepLevel).toBe(7);
    expect(buyer!.expansions).toBe(1);
    expect(buyer!.entryPaidAt).not.toBeNull();
    expect((await db.select().from(buildings).where(eq(buildings.playerWallet, b.wallet))).length)
      .toBe(res.buildings);
    expect((await db.select().from(plots).where(eq(plots.playerWallet, b.wallet))).length).toBe(1);

    // Seller: fresh unpaid shell (Q-S2 default)…
    const [after] = await db.select().from(players).where(eq(players.wallet, s.wallet));
    expect(after!.deedAssetId).toBeNull();
    expect(after!.keepLevel).toBe(1);
    expect(after!.expansions).toBe(0);
    expect(after!.entryPaidAt).toBeNull();
    expect(after!.trophies).toBe(250); // trophies are THEIRS, not the base's
    // …with EVERY balance intact. This line is the whole feature's safety story.
    expect((await getOrCreatePlayerAccount(db, s.wallet, 'player_keep')).balance).toBe(sKeep);
    expect((await getOrCreatePlayerAccount(db, s.wallet, 'player_shards')).balance).toBe(sShards);
    // And the buyer got NO currency out of thin air.
    expect((await getOrCreatePlayerAccount(db, b.wallet, 'player_keep')).balance).toBe(0n);
    expect((await getOrCreatePlayerAccount(db, b.wallet, 'player_shards')).balance).toBe(0n);
  });

  it('refuses a buyer who already has a base (Q-S1 default: transfers PARK)', async () => {
    const s = await seller();
    const b = await seller(); // buyer with their own paid base
    // The refusal split into two machine-readable cases when free onboarding
    // landed (2026-08-09): a LANDOWNER is terminal (one wallet = one parcel,
    // enforced on chain), while a free base in the way is recoverable by
    // abandoning it. This buyer owns land, so it is the terminal one. See
    // test/land-gate.test.ts for the free-builder case.
    await expect(transferBase(db, s.wallet, b.wallet, `deed-${s.wallet.slice(0, 8)}`))
      .rejects.toMatchObject({ statusCode: 422, code: 'BUYER_OWNS_LAND' });
    // Nothing moved.
    const [sRow] = await db.select().from(players).where(eq(players.wallet, s.wallet));
    expect(sRow!.deedAssetId).not.toBeNull();
  });

  it('kills in-flight builder jobs and shields with the sale, and cannot re-run', async () => {
    const s = await seller();
    const b = await createTestPlayer(db);
    await placeBuilding(db, s.wallet, 'cannon' as never, 9, 9, k()); // leaves a pending job
    await db.insert(shields).values({ playerWallet: s.wallet, source: 'loss', expiresAt: new Date(Date.now() + 3_600_000) });

    const res = await transferBase(db, s.wallet, b.wallet, `deed-${s.wallet.slice(0, 8)}`);
    // Review #4/#5: nothing of value is destroyed — the pending job and the
    // shield MOVED with the base (the old delete was an instant-build exploit
    // and burned paid shields, including the 10-SOL warzone shield).
    expect(res.jobsMoved).toBe(1);
    expect(res.shieldsMoved).toBe(1);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.playerWallet, b.wallet))).filter((j) => !j.completedAt).length).toBe(1);
    expect((await db.select().from(shields).where(eq(shields.playerWallet, b.wallet))).length).toBe(1);
    expect((await db.select().from(shields).where(eq(shields.playerWallet, s.wallet))).length).toBe(0);
    // Idempotent by outcome: the seller is deedless now, so a replayed sweep
    // (same DAS observation twice) cannot double-fire.
    await expect(transferBase(db, s.wallet, b.wallet, `deed-${s.wallet.slice(0, 8)}`)).rejects.toThrow(/holds no deed/);
    // Review #1: a STALE observation (different deed id than the seller now
    // holds) must 409, never move the wrong base.
    const s2 = await seller();
    await expect(transferBase(db, s2.wallet, (await createTestPlayer(db)).wallet, 'deed-STALE'))
      .rejects.toThrow(/changed since observation/);
  });
});

describe('the mine clock is settled on BOTH sides of a transfer', () => {
  it('a stale buyer anchor cannot mint shards for a period they did not own the mine', async () => {
    // Security review 2026-07-29 F1, PROVED before the fix: mine_state is keyed
    // by wallet and accrues lazily at the CURRENT quota, so a buyer whose
    // anchor is days old collected a full storage-cap of shards minted from
    // shard_genesis the instant they claimed a base. That breaks the deed's one
    // hard promise — it conveys land and structures, NEVER currency — and it
    // minted real supply. transferBase now re-anchors both wallets.
    const s = await seller();
    const b = await createTestPlayer(db);
    // The base being sold has a real mine — that is what makes the buyer's
    // quota jump from 0 the moment they claim.
    await db.insert(buildings).values({
      playerWallet: s.wallet, type: 'mine' as never, level: 5, tx: 12, ty: 12,
    });
    // The buyer has an OLD anchor (they mined on some earlier base, then idled).
    await db.insert(mineState).values({
      playerWallet: b.wallet, accruedShards: 0n,
      lastAccrualAt: new Date(Date.now() - 5 * 86_400_000),
    }).onConflictDoUpdate({
      target: mineState.playerWallet,
      set: { lastAccrualAt: new Date(Date.now() - 5 * 86_400_000), accruedShards: 0n },
    });

    await transferBase(db, s.wallet, b.wallet, `deed-${s.wallet.slice(0, 8)}`);

    // Claiming a base must not hand the buyer a backdated harvest.
    const got = await collectMine(db, b.wallet);
    expect(got.amount).toBe(0n);
  });
});

describe('sweepDeedTransfers (S1)', () => {
  it('requires N consecutive confirmations, validates the owner, and skips escrow shapes', async () => {
    const s = await seller();
    // The buyer must be a REAL (on-curve) wallet: random 32-byte test wallets
    // are ~50% off-curve, and ownershipEligible rightly reads those as PDAs.
    const { Keypair } = await import('@solana/web3.js');
    const buyerWallet = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet: buyerWallet }).onConflictDoNothing();
    const b = { wallet: buyerWallet };
    const deed = `deed-${s.wallet.slice(0, 8)}`;
    const good = { owner: b.wallet, frozen: false, delegate: null, collection: null };
    const ownerOf = async (assetId: string) => (assetId === deed ? good : null);
    const confirmations = new Map();

    // Sweep 1: observed ONCE — not confirmed, NOT applied (review #2a: one
    // lagging indexer read must never move a base).
    let res = await sweepDeedTransfers(db, ownerOf, { confirmations });
    expect(res.transferred).toBe(0);
    // Sweep 2: same owner again — confirmed, applied.
    res = await sweepDeedTransfers(db, ownerOf, { confirmations });
    expect(res.transferred).toBe(1);
    const [buyer] = await db.select().from(players).where(eq(players.wallet, b.wallet));
    expect(buyer!.deedAssetId).toBe(deed);

    // Escrow/frozen/delegated/PDA shapes are "not a sale yet" (review #3) —
    // never a transfer, never a seller lockout.
    expect(ownershipEligible({ owner: b.wallet, frozen: true, delegate: null, collection: null }, null)).toBe(false);
    expect(ownershipEligible({ owner: b.wallet, frozen: false, delegate: 'SomeDelegate11111111111111111111111111111111', collection: null }, null)).toBe(false);
    expect(ownershipEligible({ owner: 'not-base58!!', frozen: false, delegate: null, collection: null }, null)).toBe(false);
    // An off-curve address (PDA) may not receive a base — derive a REAL one
    // (findProgramAddressSync guarantees off-curve; the all-1s system address
    // is famously ON-curve, which is exactly why the guard must check curves).
    const { PublicKey } = await import('@solana/web3.js');
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('escrow')], new PublicKey('mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b'));
    expect(ownershipEligible({ owner: pda.toBase58(), frozen: false, delegate: null, collection: null }, null)).toBe(false);
    // Wrong collection: not our deed family.
    expect(ownershipEligible({ owner: b.wallet, frozen: false, delegate: null, collection: 'other' }, 'expected')).toBe(false);
  });
});
