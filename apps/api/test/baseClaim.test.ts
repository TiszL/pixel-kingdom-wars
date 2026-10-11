/**
 * Pull-based base claim (CLANS-SELLABLE-DEEDS-PLAN S1-Q, owner 2026-07-29:
 * deeds are tradeable). Route-level, because the CONTRACT is the security
 * property: the claimant is the session wallet, the deed and the seller come
 * from chain truth + server truth, and the request body is ignored.
 *
 * WHY each test exists:
 *  - the currency invariant is the whole feature's safety story: a deed conveys
 *    structures/land/progress and NEVER a balance;
 *  - a wallet that holds no deed, or holds one the chain says is frozen /
 *    delegated / escrowed, must not be able to take anyone's base — that is the
 *    difference between "sold" and "listed";
 *  - claiming must be idempotent, because the client retries and a second
 *    transfer would move a base the buyer already owns off someone else;
 *  - the claim must not be AIMABLE: a lying DAS search or a hand-crafted body
 *    naming a victim's deed must change nothing.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { baseTransfers, buildings, players, plots } from '../src/db/schema';
import type { DeedReaders } from '../src/game/baseClaim';
import { ensureStartingBase } from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import { ensurePlotAssigned } from '../src/game/world';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, fundTestKeep, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;
let key = 0;
const k = (): string => `claim-${++key}-${Math.random().toString(36).slice(2)}`;

const COLLECTION = 'DeedCollection1111111111111111111111111111';

/** Authoritative on-chain ownership, per asset (what `ownerOf` reports). */
interface Own { owner: string; frozen?: boolean; delegate?: string | null; collection?: string | null }
const chain = new Map<string, Own>();
/** What the DAS *search* claims each wallet holds — kept separate so a test can
 *  make the cheap search LIE and prove the per-asset read is what decides. */
const search = new Map<string, string[]>();

const readers: DeedReaders = {
  ownedDeeds: async (wallet) => search.get(wallet) ?? [],
  ownerOf: async (assetId) => {
    const o = chain.get(assetId);
    return o
      ? { owner: o.owner, frozen: o.frozen ?? false, delegate: o.delegate ?? null, collection: o.collection ?? COLLECTION }
      : null;
  },
  collection: COLLECTION,
};

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
  app = await buildApp(TEST_CONFIG, db, { market: { deedReaders: readers } });
  await app.ready();
});
afterAll(async () => { await app.close(); await conn.sql.end(); });
beforeEach(() => { chain.clear(); search.clear(); });

/** A real ed25519 wallet with a session cookie (buyers must be ON-CURVE: a PDA
 *  may never receive a base, and ownershipEligible enforces that). */
async function login(): Promise<{ wallet: string; cookie: string }> {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  expect(verify.statusCode).toBe(200);
  return { wallet, cookie: verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
}

/** A real ed25519 (ON-CURVE) address. Sellers get one too, deliberately: with a
 *  random 32-byte wallet the on-curve guard would reject it ~half the time and
 *  silently stand in for the checks these tests are actually about. */
async function curveWallet(): Promise<string> {
  return bs58.encode(await getPublicKeyAsync(utils.randomSecretKey()));
}

/** A seller: paid base, deed, land, structures and real balances. */
async function seller(): Promise<{ wallet: string; deed: string }> {
  const wallet = await curveWallet();
  const deed = `deed-${wallet.slice(0, 10)}`;
  await db.insert(players).values({ wallet });
  await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  await db.update(players).set({
    entryPaidAt: new Date(), deedAssetId: deed, keepLevel: 6, expansions: 1, trophies: 180,
  }).where(eq(players.wallet, wallet));
  await ensureStartingBase(db, wallet);
  await ensurePlotAssigned(db, wallet);
  await fundTestKeep(db, wallet, 9_000n, 'test.fund', k());
  await rewardShards(db, wallet, 4_200n, 'test.fund.shards', k());
  return { wallet, deed };
}

const getClaimable = (cookie: string) =>
  app.inject({ method: 'GET', url: '/base/claimable', cookies: { [SESSION_COOKIE]: cookie } });
const postClaim = (cookie: string, payload?: unknown) =>
  app.inject({ method: 'POST', url: '/base/claim', cookies: { [SESSION_COOKIE]: cookie }, ...(payload ? { payload } : {}) });

describe('POST /base/claim (S1-Q, pull-based)', () => {
  it('hands the base to the deed holder — and NOT ONE unit of currency', async () => {
    const s = await seller();
    const buyer = await login(); // baseless, never paid entry
    chain.set(s.deed, { owner: buyer.wallet });
    search.set(buyer.wallet, [s.deed]);
    const sKeep = (await getOrCreatePlayerAccount(db, s.wallet, 'player_keep')).balance;
    const sShards = (await getOrCreatePlayerAccount(db, s.wallet, 'player_shards')).balance;

    const peek = await getClaimable(buyer.cookie);
    expect(peek.statusCode).toBe(200);
    expect(peek.json()).toMatchObject({ claimable: true, deedAssetId: s.deed, reason: 'ok' });

    const res = await postClaim(buyer.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claimed: true, deedAssetId: s.deed });

    // Buyer: base, land, progress, deed, entry — without paying entry again.
    const [b] = await db.select().from(players).where(eq(players.wallet, buyer.wallet));
    expect(b!.deedAssetId).toBe(s.deed);
    expect(b!.keepLevel).toBe(6);
    expect(b!.expansions).toBe(1);
    expect(b!.entryPaidAt).not.toBeNull();
    expect((await db.select().from(buildings).where(eq(buildings.playerWallet, buyer.wallet))).length).toBeGreaterThan(0);
    expect((await db.select().from(plots).where(eq(plots.playerWallet, buyer.wallet))).length).toBe(1);

    // Seller: baseless shell, trophies theirs — and EVERY balance untouched.
    const [after] = await db.select().from(players).where(eq(players.wallet, s.wallet));
    expect(after!.deedAssetId).toBeNull();
    expect(after!.keepLevel).toBe(1);
    expect(after!.entryPaidAt).toBeNull();
    expect(after!.trophies).toBe(180);
    expect((await getOrCreatePlayerAccount(db, s.wallet, 'player_keep')).balance).toBe(sKeep);
    expect((await getOrCreatePlayerAccount(db, s.wallet, 'player_shards')).balance).toBe(sShards);
    expect((await getOrCreatePlayerAccount(db, buyer.wallet, 'player_keep')).balance).toBe(0n);
    expect((await getOrCreatePlayerAccount(db, buyer.wallet, 'player_shards')).balance).toBe(0n);

    // Idempotent: the deed is now registered to the claimant, so a replay finds
    // nothing — no second transfer, no second audit row.
    const again = await postClaim(buyer.cookie);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ claimed: false, reason: 'none' });
    expect((await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, s.deed))).length).toBe(1);
  });

  it('a wallet holding no deed can claim nothing', async () => {
    const s = await seller(); // a base exists, owned by someone else
    const nobody = await login();
    expect((await getClaimable(nobody.cookie)).json()).toMatchObject({ claimable: false, reason: 'none' });
    expect((await postClaim(nobody.cookie)).json()).toMatchObject({ claimed: false, reason: 'none' });
    const [sRow] = await db.select().from(players).where(eq(players.wallet, s.wallet));
    expect(sRow!.deedAssetId).toBe(s.deed); // untouched
  });

  it('a frozen, delegated, escrowed or wrong-collection deed is NOT a completed sale', async () => {
    const shapes: Array<[string, Partial<Own>]> = [
      ['frozen (still soulbound)', { frozen: true }],
      ['delegated (listed, not sold)', { delegate: 'SomeDelegate11111111111111111111111111111111' }],
      ['wrong collection', { collection: 'NotOurDeeds111111111111111111111111111111' }],
    ];
    for (const [label, shape] of shapes) {
      const s = await seller();
      const buyer = await login();
      chain.set(s.deed, { owner: buyer.wallet, ...shape });
      search.set(buyer.wallet, [s.deed]);
      expect((await getClaimable(buyer.cookie)).json(), label)
        .toMatchObject({ claimable: false, reason: 'not_transferable' });
      expect((await postClaim(buyer.cookie)).json(), label).toMatchObject({ claimed: false });
      const [sRow] = await db.select().from(players).where(eq(players.wallet, s.wallet));
      expect(sRow!.deedAssetId, label).toBe(s.deed);
      chain.clear(); search.clear();
    }

    // Escrow PDA holds the asset (a live marketplace listing): the lister must
    // not be able to claim it back onto someone else's base either.
    const s2 = await seller();
    const lister = await login();
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('escrow')], new PublicKey('mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b'));
    chain.set(s2.deed, { owner: pda.toBase58() });
    search.set(lister.wallet, [s2.deed]);
    expect((await getClaimable(lister.cookie)).json()).toMatchObject({ claimable: false, reason: 'not_transferable' });
  });

  it('refuses a buyer who already has a base (the transfer parks, nothing moves)', async () => {
    const s = await seller();
    const buyer = await login();
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, buyer.wallet));
    await ensureStartingBase(db, buyer.wallet);
    chain.set(s.deed, { owner: buyer.wallet });
    search.set(buyer.wallet, [s.deed]);

    const res = await postClaim(buyer.cookie);
    expect(res.statusCode).toBe(422);
    // BUYER_OWNS_LAND, not BUYER_HAS_FREE_BASE: this buyer has entryPaidAt, and
    // that refusal is terminal (the client must not offer to abandon anything).
    expect(res.json()).toMatchObject({ error: { code: 'BUYER_OWNS_LAND' } });
    const [sRow] = await db.select().from(players).where(eq(players.wallet, s.wallet));
    expect(sRow!.deedAssetId).toBe(s.deed);
    expect((await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, s.deed))).length).toBe(0);
  });

  it('cannot be aimed at another player\'s deed — the body is ignored and the search is not trusted', async () => {
    const victim = await seller();
    const attacker = await login();
    // The asset really belongs to the victim; only the cheap search claims
    // otherwise (stale index / hostile response).
    chain.set(victim.deed, { owner: victim.wallet });
    search.set(attacker.wallet, [victim.deed]);

    expect((await getClaimable(attacker.cookie)).json()).toMatchObject({ claimable: false, reason: 'not_transferable' });
    // And a hand-crafted body naming the victim's deed + seller changes nothing.
    const res = await postClaim(attacker.cookie, { deedAssetId: victim.deed, sellerWallet: victim.wallet, from: victim.wallet });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claimed: false });
    const [vRow] = await db.select().from(players).where(eq(players.wallet, victim.wallet));
    expect(vRow!.deedAssetId).toBe(victim.deed);
    expect((await db.select().from(buildings).where(eq(buildings.playerWallet, attacker.wallet))).length).toBe(0);
  });

  it('requires a session — the 401 the thaw script probes for', async () => {
    const res = await app.inject({ method: 'GET', url: '/base/claimable' });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/base/claim' })).statusCode).toBe(401);
  });
});
