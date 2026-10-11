/**
 * Weekly snapshot + outbox + PoR tests (PLAN.md 4h): merkle proofs verify
 * against the mirrored on-chain rules, snapshots are idempotent per epoch and
 * include unbonding escrow, the outbox relay is transactional and retries.
 */
import { ECONOMY } from '@shardkeep/shared';
import { buildMerkleTree, hashLeaf, verifyProof } from '@shardkeep/chain';
import { Keypair } from '@solana/web3.js';
import { and, asc, eq, inArray } from 'drizzle-orm';

/** Real on-curve withdrawal destination (payouts target its ATA). */
const DEST = Keypair.generate().publicKey.toBase58();
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accounts, baseLeagueEntitlements, bases, merkleLeaves, outbox, players, withdrawals,
} from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import {
  __resetCoverageCacheForTests,
  buildWeeklySnapshot,
  checkReserves,
  epochForDate,
  getInclusionProof,
  getProofOfReserves,
  relayOutbox,
} from '../src/money/snapshot';
import type { CustodyReserveEvidence } from '../src/money/reserves';
import { refundFailedWithdrawal, requestWithdrawal } from '../src/money/withdrawals';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `snap-${++key}-${Math.random().toString(36).slice(2)}`;

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
});
afterAll(async () => {
  await conn.sql.end();
});

describe('merkle (mirrors the on-chain verifier)', () => {
  it('proofs verify for every leaf; tampered amounts fail', () => {
    const version = 7n;
    const inputs = Array.from({ length: 13 }, (_, i) => ({
      wallet: '11111111111111111111111111111111', // system program id, valid base58 32 bytes
      amount: BigInt(100 + i),
    }));
    const leaves = inputs.map((l) => hashLeaf(l.wallet, l.amount, version));
    const tree = buildMerkleTree(leaves);
    inputs.forEach((l, i) => {
      expect(verifyProof(hashLeaf(l.wallet, l.amount, version), tree.proof(i), tree.root)).toBe(true);
      expect(verifyProof(hashLeaf(l.wallet, l.amount + 1n, version), tree.proof(i), tree.root)).toBe(false);
      expect(verifyProof(hashLeaf(l.wallet, l.amount, version + 1n), tree.proof(i), tree.root)).toBe(false);
    });
  });
});

describe('weekly snapshot (GDD §4.9)', () => {
  it('freezes balances + unbonding escrow, writes the outbox row transactionally, idempotent per epoch', async () => {
    const a = await createTestPlayer(db);
    await ensureStartingBase(db, a.wallet); // also grants ECONOMY.starterShards
    await fundTestKeep(db, a.wallet, 9_000n, 'test.fund', k());
    await rewardShards(db, a.wallet, 9_000n, 'test.fund.shards', k());
    // 4k of it heads out — must STILL count as a liability while unbonding
    await requestWithdrawal(db, a.wallet, 4_000n, DEST, k());

    const snap = await buildWeeklySnapshot(db);
    expect(snap.alreadyExisted).toBe(false);
    const leaves = await db.select().from(merkleLeaves)
      .where(eq(merkleLeaves.epoch, snap.epoch)).orderBy(asc(merkleLeaves.leafIndex));
    expect(snap.totalBalance).toBe(leaves.reduce((sum, leaf) => sum + leaf.amount, 0n));
    const mine = leaves.find((l) => l.wallet === a.wallet);
    // SPLIT: the starter stash is SHARDS now — the KEEP liability is exactly
    // the 9k funded (5k balance + 4k unbonding escrow).
    expect(mine!.amount).toBe(9_000n);

    const rows = await db.select().from(outbox).where(eq(outbox.status, 'pending'));
    expect(rows.some((r) => r.kind === 'post_root'
      && (r.payload as { root: string }).root === snap.root)).toBe(true);

    const again = await buildWeeklySnapshot(db);
    expect(again.alreadyExisted).toBe(true);
    expect(again.root).toBe(snap.root);
    expect(epochForDate(new Date())).toBe(snap.epoch);
  });

  it('never turns SHARDS/item league receipts into KEEP liabilities', async () => {
    const seller = Keypair.generate().publicKey.toBase58();
    const buyers = [
      Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58(),
    ];
    // Insert in reverse canonical order so DB/insertion order cannot accidentally
    // satisfy the deterministic Merkle contract.
    buyers.sort().reverse();
    await db.insert(players).values([{ wallet: seller }, ...buyers.map((wallet) => ({ wallet }))]);
    const created = await db.insert(bases).values(buyers.map(() => ({ ownerWallet: seller })))
      .returning({ id: bases.id });
    for (const [index, base] of created.entries()) {
      await db.update(bases).set({ ownerWallet: buyers[index]! }).where(eq(bases.id, base.id));
    }
    await db.insert(baseLeagueEntitlements).values(created.map((base, index) => ({
      week: '2040-01-02', baseId: base.id, tier: 'sol' as const,
      trophies: 2_000, keepAmount: 0n,
      cacheShardsGranted: BigInt((index + 1) * 10_000),
      itemsGranted: [{ itemId: 'finishers_seal' as const, qty: 1 }],
      paidAt: new Date('2040-01-02T00:15:00Z'),
    })));
    expect(await db.select().from(accounts).where(and(
      eq(accounts.kind, 'player_keep'), inArray(accounts.ownerWallet, buyers),
    ))).toHaveLength(0);

    const snap = await buildWeeklySnapshot(db, new Date('2040-06-04T00:00:00Z'));
    const leaves = await db.select().from(merkleLeaves)
      .where(eq(merkleLeaves.epoch, snap.epoch)).orderBy(asc(merkleLeaves.leafIndex));
    expect(snap.totalBalance).toBe(leaves.reduce((sum, leaf) => sum + leaf.amount, 0n));
    expect(leaves.map((leaf) => leaf.wallet))
      .toEqual([...leaves.map((leaf) => leaf.wallet)].sort());
    for (const buyer of buyers) expect(leaves.find((leaf) => leaf.wallet === buyer)).toBeUndefined();
    expect(leaves.find((leaf) => leaf.wallet === seller)).toBeUndefined();
  });

  it('rejects the retired positive-KEEP league receipt shape', async () => {
    const buyer = Keypair.generate().publicKey.toBase58();
    await db.insert(players).values({ wallet: buyer });
    const [base] = await db.insert(bases).values({ ownerWallet: buyer })
      .returning({ id: bases.id });
    await expect(db.insert(baseLeagueEntitlements).values({
      week: '2041-01-07', baseId: base!.id, tier: 'sol', trophies: 2_000,
      keepAmount: 123n,
    })).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('relay sends pending roots; failures record attempts and retry next run', async () => {
    // ensure at least one pending row exists (from the snapshot test or fresh)
    const pendingBefore = await db.select().from(outbox).where(and(
      eq(outbox.status, 'pending'), eq(outbox.kind, 'post_root'),
    ));
    expect(pendingBefore.length).toBeGreaterThan(0);

    const r1 = await relayOutbox(db, async () => { throw new Error('rpc down'); });
    expect(r1.failed).toBeGreaterThan(0);
    const afterFail = await db.select().from(outbox).where(and(
      eq(outbox.status, 'pending'), eq(outbox.kind, 'post_root'),
    ));
    expect(afterFail[0]!.attempts).toBeGreaterThan(0);
    expect(afterFail[0]!.lastError).toContain('rpc down');

    const sigs: string[] = [];
    const r2 = await relayOutbox(db, async (epoch, root) => {
      sigs.push(`${epoch}:${root.slice(0, 8)}`);
      return `sig-${sigs.length}`;
    });
    expect(r2.sent).toBeGreaterThan(0);
    const left = await db.select().from(outbox).where(and(
      eq(outbox.status, 'pending'), eq(outbox.kind, 'post_root'),
    ));
    expect(left.length).toBe(0);
  });

  it('serves PoR and a verifiable inclusion proof', async () => {
    const por = await getProofOfReserves(db);
    expect(por.liabilities).not.toBeNull();
    // No live finalized reader means no reserve claim. In particular, the
    // address manifest's liquidity/treasury/program entries are never presented
    // as custody merely because they are public addresses.
    expect(por.reserves).toBeNull();
    expect(por.coverage).toBeNull();

    const b = await createTestPlayer(db);
    await fundTestKeep(db, b.wallet, 777n, 'test.fund', k());
    await rewardShards(db, b.wallet, 777n, 'test.fund.shards', k());
    // b joined AFTER the snapshot → not in it
    await expect(getInclusionProof(db, b.wallet)).rejects.toThrow(/no balance in the latest/);

    // a player who IS in the snapshot gets a proof that verifies client-side
    // Multiple epochs coexist by design. Prove against the same latest epoch
    // returned above; selecting leafIndex 0 across every epoch makes the test
    // depend on PostgreSQL's otherwise-unordered tie resolution and can choose
    // a wallet that correctly is not present in the latest snapshot.
    const leaves = await db.select().from(merkleLeaves)
      .where(eq(merkleLeaves.epoch, BigInt(por.liabilities!.epoch)))
      .orderBy(asc(merkleLeaves.leafIndex));
    const someWallet = leaves[0]!.wallet;
    const proof = await getInclusionProof(db, someWallet);
    const leaf = hashLeaf(proof.wallet, BigInt(proof.amount), BigInt(proof.epoch));
    const ok = verifyProof(
      leaf,
      proof.proof.map((h) => Uint8Array.from(Buffer.from(h, 'hex'))),
      Uint8Array.from(Buffer.from(proof.root, 'hex')),
    );
    expect(ok).toBe(true);
  });

  it('checkReserves compares live reserve with all KEEP liabilities and never fabricates coverage', async () => {
    // WHY: this comparison IS the custodial promise ("every ledger KEEP is
    // backed 1:1 by real KEEP in the hot wallet"). Liability must include
    // EVERY ESCROW — withdrawal, Forge payout, and frozen league awards are
    // still owed to players, so summing only play balances overstates coverage.
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    await fundTestKeep(db, p.wallet, 50_000n, 'test.fund', k());
    // freeze part of it into withdrawal escrow (player_keep −, escrow +)
    await requestWithdrawal(db, p.wallet, 10_000n, DEST, k());

    const short = await checkReserves(db, async () => 1n);
    expect(short.covered).toBe(false);
    expect(short.liabilityKeep).toBeGreaterThanOrEqual(50_000n); // escrow still counted
    expect(short.deficit).toBe(short.liabilityKeep - 1n);

    const flush = await checkReserves(db, async () => short.liabilityKeep);
    expect(flush.covered).toBe(true);
    expect(flush.deficit).toBe(0n);

    // a failed RPC read must throw through — "unknown", never "covered"
    await expect(checkReserves(db, async () => { throw new Error('rpc down'); })).rejects.toThrow(/rpc down/);
  });

  it('/por coverage cache: one flight for concurrent hits, success cached, failure cached as UNKNOWN', async () => {
    // WHY: /por is public + unauthenticated; without these three properties a
    // slow or dead RPC turns every hit into a live RPC call — the quota drain
    // the cache exists to prevent (B2 security review #1). And a cached failure
    // must read as coverage:null (unknown), NEVER as covered.
    __resetCoverageCacheForTests();
    let calls = 0;
    let release!: (v: bigint) => void;
    const gate = new Promise<bigint>((res) => { release = res; });
    const slowReader = async (): Promise<bigint> => { calls++; return gate; };

    // single-flight: two concurrent requests share ONE reader call
    const [a, b] = [getProofOfReserves(db, slowReader), getProofOfReserves(db, slowReader)];
    release(10n ** 12n); // plenty to cover any liability the suite created
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(ra.coverage?.covered).toBe(true);
    expect(rb.coverage).toEqual(ra.coverage);

    // success cached: a third hit inside the TTL never touches the reader
    const rc = await getProofOfReserves(db, slowReader);
    expect(calls).toBe(1);
    expect(rc.coverage).toEqual(ra.coverage);

    // failure cached: a throwing reader yields coverage:null, and the SECOND
    // hit inside the fail-TTL serves the cached unknown without re-reading
    __resetCoverageCacheForTests();
    let failCalls = 0;
    const deadReader = async (): Promise<bigint> => { failCalls++; throw new Error('rpc down'); };
    const rf = await getProofOfReserves(db, deadReader);
    expect(rf.coverage).toBeNull();
    const rf2 = await getProofOfReserves(db, deadReader);
    expect(rf2.coverage).toBeNull();
    expect(failCalls).toBe(1);

    __resetCoverageCacheForTests(); // leave no cross-test residue
  });

  it('/por exposes eligibility evidence only for the canonical liquid-hot custody reserve', async () => {
    __resetCoverageCacheForTests();
    const owner = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const account = Keypair.generate().publicKey.toBase58();
    const evidence: CustodyReserveEvidence = {
      role: 'liquid_hot_custody', commitment: 'finalized', account,
      owner, mint,
      tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      canonicalAta: true, slot: 123, state: 'initialized', delegate: null,
      delegatedAmountBaseUnits: 0n,
      observedBalanceBaseUnits: 10n ** 21n,
      observedBalanceKeep: 10n ** 12n,
      eligible: true, ineligibilityReason: null,
    };
    const por = await getProofOfReserves(db, async () => evidence);
    expect(por.coverage?.reserveKeep).toBe('1000000000000');
    expect(por.reserves).toEqual({
      liquidHotCustody: expect.objectContaining({
        role: 'liquid_hot_custody', commitment: 'finalized', account,
        owner, mint, slot: 123, eligible: true,
        eligibleBalanceKeep: '1000000000000',
      }),
    });
    expect(por.reserves).not.toHaveProperty('treasuries');
    expect(por.reserves).not.toHaveProperty('liquidity');
    expect(por.reserves).not.toHaveProperty('config');
    expect(por.reserves).not.toHaveProperty('coreProgram');

    // An observed balance on an encumbered account remains visible evidence but
    // is eligible for ZERO and can never become a positive coverage verdict.
    __resetCoverageCacheForTests();
    const encumbered: CustodyReserveEvidence = {
      ...evidence,
      delegate: Keypair.generate().publicKey.toBase58(),
      eligible: false,
      ineligibilityReason: 'delegate_present',
    };
    const blocked = await getProofOfReserves(db, async () => encumbered);
    expect(blocked.coverage).toBeNull();
    expect(blocked.reserves?.liquidHotCustody).toMatchObject({
      eligible: false, ineligibilityReason: 'delegate_present',
      observedBalanceKeep: '1000000000000', eligibleBalanceKeep: '0',
    });
    __resetCoverageCacheForTests();
  });

  it('a refunded withdrawal is counted ONCE in the leaf — as balance, not balance + escrow', async () => {
    // WHY: refundFailedWithdrawal moves the gross escrow → player_keep. The leaf
    // adds escrow rows on TOP of the play balance, so if 'refunded' were ever
    // added to that status list the player's inclusion proof would attest DOUBLE
    // what we owe them — a published, signed overstatement of our liability that
    // the reserve gate would then read as a shortfall and halt payouts on.
    const p = await createTestPlayer(db);
    await ensureStartingBase(db, p.wallet);
    await fundTestKeep(db, p.wallet, 12_000n, 'test.fund', k());
    await rewardShards(db, p.wallet, 12_000n, 'test.fund.shards', k());
    const owed = 12_000n; // starter stash is SHARDS; KEEP liability is the funded 12k

    const w = await requestWithdrawal(db, p.wallet, 5_000n, DEST, k());
    // This row is refundable only after an operator has proved no broadcast.
    // A sender throw is ambiguous and must remain support-only.
    await db.update(withdrawals).set({
      status: 'failed',
      lastError: 'NOT BROADCAST — operator verified no matching chain transaction',
    }).where(eq(withdrawals.id, w.id));

    // While FAILED the escrow is still ours to give back → still in the leaf.
    const future = new Date(Date.now() + 21 * 86_400_000);
    const stranded = await buildWeeklySnapshot(db, future);
    const strandedLeaf = (await db.select().from(merkleLeaves)
      .where(eq(merkleLeaves.epoch, stranded.epoch))).find((l) => l.wallet === p.wallet);
    expect(strandedLeaf!.amount).toBe(owed);

    // After the refund the SAME total is attested — it moved accounts, it did
    // not appear or disappear.
    await refundFailedWithdrawal(db, w.id, { wallet: p.wallet });
    const later = new Date(future.getTime() + 7 * 86_400_000);
    const settled = await buildWeeklySnapshot(db, later);
    const settledLeaf = (await db.select().from(merkleLeaves)
      .where(eq(merkleLeaves.epoch, settled.epoch))).find((l) => l.wallet === p.wallet);
    expect(settledLeaf!.amount).toBe(owed);
  });
});
