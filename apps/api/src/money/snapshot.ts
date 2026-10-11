/**
 * Weekly merkle snapshot + outbox relay + proof-of-reserves (PLAN.md 4h —
 * GDD §1 pillar 4, §4.9 "publish it as a live proof-of-reserves page").
 *
 * buildWeeklySnapshot: freezes every player's liability (play balance plus
 * withdrawal, Forge-claim and deed-league escrows) into wallet-ascending leaves, builds the tree
 * with the EXACT on-chain hashing (packages/chain/merkle), stores
 * snapshot+leaves, and writes a `post_root` outbox row IN THE SAME db
 * transaction (transactional-outbox pattern, research §1).
 *
 * relayOutbox: drains pending rows through an injected chain sender (the real
 * one posts via shardkeep-core post_root with the admin keypair). Failures
 * record attempts+error and retry on the next run — post_root is init-once
 * per epoch on-chain, so a double-send of the same epoch fails harmlessly.
 */
import { buildMerkleTree, hashLeaf, toHex } from '@shardkeep/chain';
import { and, asc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts, baseForgePositions, baseLeagueEntitlements, bases, forgeContributions, merkleLeaves,
  mailAttachments, mailMessages, merkleSnapshots, outbox, withdrawals,
} from '../db/schema';
import { errorForStorage, HttpError } from '../lib/errors';
import { readCustodyTransparency } from './custodyTransparency';
import {
  IneligibleCustodyReserveError,
  publicCustodyReserveEvidence,
  type CustodyReserveEvidence,
} from './reserves';

/** Monday-aligned UTC week number (1970-01-05 was a Monday). */
export function epochForDate(at: Date): bigint {
  const MONDAY0 = Date.UTC(1970, 0, 5);
  return BigInt(Math.floor((at.getTime() - MONDAY0) / (7 * 86_400_000)));
}

interface MerkleSnapshotResult {
  epoch: bigint;
  root: string;
  totalBalance: bigint;
  leafCount: number;
  alreadyExisted: boolean;
}

export type SnapshotResult = MerkleSnapshotResult | {
  kind: 'no_liabilities';
  phase: 'frozen' | 'retired';
  epoch: bigint;
  root: null;
  totalBalance: 0n;
  leafCount: 0;
  alreadyExisted: false;
};

export async function buildWeeklySnapshot(db: Db, now = new Date()): Promise<SnapshotResult> {
  const epoch = epochForDate(now);
  return db.transaction(async (tx): Promise<SnapshotResult> => {
  const [existing] = await tx.select().from(merkleSnapshots).where(eq(merkleSnapshots.epoch, epoch));
  if (existing) {
    return {
      epoch, root: existing.root, totalBalance: existing.totalBalance,
      leafCount: existing.leafCount, alreadyExisted: true,
    };
  }

  // Liabilities per wallet: play balance plus every wallet/deed-attributed escrow.
  const balances = await tx.select().from(accounts)
    .where(and(eq(accounts.kind, 'player_keep'), sql`${accounts.ownerWallet} IS NOT NULL`))
    .orderBy(asc(accounts.ownerWallet));
  // A 'failed' payout still holds the player's funds in withdrawal_escrow (the
  // payout ledger txn only posts on SUCCESS), so it is STILL a live liability
  // until it is refunded — count it alongside unbonding/processing, else PoR
  // understates what we owe (security/audit finding: snapshot-excludes-failed-escrow).
  // 'refunded' is deliberately absent: refundFailedWithdrawal moved that gross
  // back into player_keep, so counting it here too would DOUBLE it in the leaf.
  const escrowRows = await tx.select().from(withdrawals)
    .where(inArray(withdrawals.status, ['unbonding', 'processing', 'failed']));
  const escrowByWallet = new Map<string, bigint>();
  for (const w of escrowRows) {
    escrowByWallet.set(w.playerWallet, (escrowByWallet.get(w.playerWallet) ?? 0n) + w.amount);
  }
  // Settled-but-unclaimed forge allocations are owed to a SPECIFIC wallet, so
  // they belong in that wallet's leaf too. Without this the player's inclusion
  // proof UNDER-attests what we owe them — the mirror of the /por overstatement
  // above, same omission (money review 2026-07-29 #3).
  const unclaimed = await tx.select({
    wallet: forgeContributions.playerWallet, keep: forgeContributions.keepPaid,
  }).from(forgeContributions).where(and(
    isNotNull(forgeContributions.keepEscrowTxnId),
    isNull(forgeContributions.claimedAt),
    isNull(forgeContributions.expiredAt),
  ));
  for (const r of unclaimed) {
    escrowByWallet.set(r.wallet, (escrowByWallet.get(r.wallet) ?? 0n) + (r.keep ?? 0n));
  }
  // Deed-native Forge claims follow the stable base, including through a sale.
  // Resolve the CURRENT owner at snapshot time rather than freezing the wallet
  // that happened to own it when settlement ran.
  const baseUnclaimed = await tx.select({
    wallet: bases.ownerWallet, keep: baseForgePositions.keepPaid,
  }).from(baseForgePositions).innerJoin(bases, eq(bases.id, baseForgePositions.baseId)).where(and(
    isNotNull(baseForgePositions.keepEscrowTxnId),
    isNull(baseForgePositions.claimedAt),
    isNull(baseForgePositions.expiredAt),
  ));
  for (const row of baseUnclaimed) {
    escrowByWallet.set(row.wallet, (escrowByWallet.get(row.wallet) ?? 0n) + (row.keep ?? 0n));
  }
  // Frozen league prizes are deed liabilities. Attribute each unpaid award to
  // the deed's CURRENT owner so a sale moves the future inclusion proof without
  // moving or duplicating the escrowed KEEP.
  const leagueUnpaid = await tx.select({
    wallet: bases.ownerWallet, keep: baseLeagueEntitlements.keepAmount,
  }).from(baseLeagueEntitlements).innerJoin(bases, eq(bases.id, baseLeagueEntitlements.baseId))
    .where(and(isNull(baseLeagueEntitlements.paidAt), sql`${baseLeagueEntitlements.keepAmount} > 0`));
  for (const row of leagueUnpaid) {
    escrowByWallet.set(row.wallet, (escrowByWallet.get(row.wallet) ?? 0n) + row.keep);
  }
  // Reward-mail KEEP is already removed from emission_pool and held in the
  // pooled mail_keep_escrow. Attribute each pending attachment to its wallet's
  // leaf; claimed mail has moved into player_keep and expired mail back to the
  // pool, so including either terminal state would count it twice. Mixed mail
  // stays pending after KEEP retirement for its remaining SHARDS/items; its
  // immutable conversion proof excludes only the retired KEEP attachment.
  const mailUnclaimed = await tx.select({
    wallet: mailMessages.recipientWallet,
    keep: mailAttachments.amount,
  }).from(mailAttachments).innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
    .where(and(eq(mailMessages.rewardState, 'pending'), eq(mailAttachments.kind, 'KEEP'),
      sql`not public.shardkeep_mail_keep_retired(${mailAttachments.id})`));
  for (const row of mailUnclaimed) {
    escrowByWallet.set(row.wallet, (escrowByWallet.get(row.wallet) ?? 0n) + (row.keep ?? 0n));
  }

  const liabilityByWallet = new Map<string, bigint>();
  for (const account of balances) liabilityByWallet.set(account.ownerWallet!, account.balance);
  for (const [wallet, escrow] of escrowByWallet) {
    liabilityByWallet.set(wallet, (liabilityByWallet.get(wallet) ?? 0n) + escrow);
  }
  const inputs = [...liabilityByWallet]
    .map(([wallet, amount]) => ({ wallet, amount }))
    .filter((l) => l.amount > 0n)
    .sort((a, b) => a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);
  if (inputs.length === 0) {
    // An empty wallet list alone cannot prove zero custody: an unattributed
    // escrow or malformed negative balance must not disappear from this read.
    // The latch and every account are observed in this same repeatable-read
    // transaction. This outcome records no Merkle root and queues no chain write.
    const [state] = await tx.execute<{ phase: string }>(sql`
      select phase from public.keep_custody_cutover_state where id`);
    if (state?.phase === 'frozen' || state?.phase === 'retired') {
      const [residual] = await tx.select({ id: accounts.id }).from(accounts)
        .where(and(inArray(accounts.kind, [
          'player_keep', 'withdrawal_escrow', 'forge_payout_escrow',
          'league_entitlement_escrow', 'mail_keep_escrow',
        ]), sql`${accounts.balance} <> 0`)).limit(1);
      if (!residual) return {
        kind: 'no_liabilities', phase: state.phase, epoch, root: null,
        totalBalance: 0n, leafCount: 0, alreadyExisted: false,
      };
    }
    throw new HttpError(422, 'no liabilities to snapshot');
  }

  const leaves = inputs.map((l) => hashLeaf(l.wallet, l.amount, epoch));
  const tree = buildMerkleTree(leaves);
  const root = toHex(tree.root);
  const total = inputs.reduce((s, l) => s + l.amount, 0n);

  await tx.insert(merkleSnapshots).values({
    epoch, root, totalBalance: total, leafCount: inputs.length,
  });
  await tx.insert(merkleLeaves).values(
    inputs.map((l, i) => ({ epoch, leafIndex: i, wallet: l.wallet, amount: l.amount })),
  );
  // Transactional outbox: the chain write rides the same commit.
  await tx.insert(outbox).values({
    kind: 'post_root',
    payload: { epoch: epoch.toString(), root, totalBalance: total.toString() },
  });
  return { epoch, root, totalBalance: total, leafCount: inputs.length, alreadyExisted: false };
  }, { isolationLevel: 'repeatable read' });
}

/** Injected chain sender: posts one root, returns the tx signature. */
export type RootSender = (epoch: bigint, rootHex: string, totalBalance: bigint) => Promise<string>;

export async function relayOutbox(db: Db, send: RootSender, now = new Date()): Promise<{ sent: number; failed: number }> {
  const pending = await db.select().from(outbox)
    .where(and(eq(outbox.status, 'pending'), eq(outbox.kind, 'post_root')))
    .orderBy(asc(outbox.id)).limit(20);
  let sent = 0;
  let failed = 0;
  for (const row of pending) {
    const p = row.payload as { epoch: string; root: string; totalBalance: string };
    try {
      const sig = await send(BigInt(p.epoch), p.root, BigInt(p.totalBalance));
      await db.update(outbox)
        .set({ status: 'sent', sentAt: now, lastError: null, txSignature: sig })
        .where(eq(outbox.id, row.id));
      sent++;
    } catch (e) {
      await db.update(outbox)
        .set({ attempts: sql`${outbox.attempts} + 1`, lastError: errorForStorage(e) })
        .where(eq(outbox.id, row.id));
      failed++;
    }
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// Proof of reserves
// ---------------------------------------------------------------------------

/** Production returns validated, structured custody evidence. The bigint arm is
 * retained only as an injected deterministic seam for existing unit tests; the
 * jobs.ts production integration MUST use makeFinalizedHotKeepReserveReader. */
export type ReserveReader = () => Promise<bigint | CustodyReserveEvidence>;

export interface ReserveCheck {
  reserveKeep: bigint;
  liabilityKeep: bigint;
  covered: boolean;
  deficit: bigint;
  custodyEvidence: CustodyReserveEvidence | null;
}

/**
 * THE solvency comparison (ONRAMP-WALLETS-PLAN §1 guardrail): the hot wallet's
 * live on-chain KEEP vs the ledger's custodial liability — every player's play
 * balance plus withdrawal, Forge-payout, league-entitlement and reward-mail escrows.
 * `covered === false` means the
 * books promise more KEEP than custody holds; callers must surface that LOUDLY
 * (weekly job logs an error, /por publishes it), never swallow it.
 *
 * It is also the PAYOUT BRAKE (money/withdrawals.ts makeCoverageGate): a false
 * `covered`, or a throw from `readHotKeep`, halts the withdrawal queue. So this
 * function is no longer a monitor — changing what it counts changes who gets
 * paid, and the gate and /por are guaranteed to agree because they are this.
 */
export async function checkReserves(db: Db, readHotKeep: ReserveReader): Promise<ReserveCheck> {
  const reading = await readHotKeep();
  let reserveKeep: bigint;
  let custodyEvidence: CustodyReserveEvidence | null = null;
  if (typeof reading === 'bigint') {
    reserveKeep = reading;
  } else {
    custodyEvidence = reading;
    if (!reading.eligible || reading.observedBalanceKeep === null) {
      throw new IneligibleCustodyReserveError(reading);
    }
    reserveKeep = reading.observedBalanceKeep;
  }
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${accounts.balance}), 0)` })
    .from(accounts)
    // forge_payout_escrow holds SETTLED-BUT-UNCLAIMED Gold Forge payouts: real
    // player money in our custody between settlement and the claim tap. Omitting
    // it made /por OVERSTATE coverage by exactly the unclaimed float (observed
    // live at 1,173 KEEP during E2E) — a published false claim about custody,
    // and it silenced the only solvency alarm (money review 2026-07-29 #1).
    .where(inArray(accounts.kind, [
      'player_keep', 'withdrawal_escrow', 'forge_payout_escrow', 'league_entitlement_escrow',
      'mail_keep_escrow',
    ]));
  const liabilityKeep = BigInt(row?.total ?? '0');
  return {
    reserveKeep,
    liabilityKeep,
    covered: reserveKeep >= liabilityKeep,
    deficit: liabilityKeep > reserveKeep ? liabilityKeep - reserveKeep : 0n,
    custodyEvidence,
  };
}

/** /por is public and unauthenticated — cache the RPC-backed coverage check so
 *  hammering the route can't drain the RPC quota. 60s staleness is fine for a
 *  transparency page. FAILURES are cached too (shorter TTL) and concurrent
 *  misses share ONE in-flight read: without both, a slow/down RPC turns every
 *  /por hit into a live RPC call — the exact drain the cache exists to prevent,
 *  reachable by anyone once the endpoint is unhealthy (security review #1). */
const COVERAGE_TTL_MS = 60_000;
const COVERAGE_FAIL_TTL_MS = 15_000;
interface CoverageRead {
  check: ReserveCheck | null;
  evidence: CustodyReserveEvidence | null;
}
let coverageCache: { at: number; value: CoverageRead } | null = null;
let coverageInflight: Promise<CoverageRead> | null = null;

/** TEST-ONLY: the module-level cache otherwise leaks state across suite files
 *  (vitest shares module instances within a worker). Never call in prod code. */
export function __resetCoverageCacheForTests(): void {
  coverageCache = null;
  coverageInflight = null;
}

async function cachedCoverage(db: Db, readHotKeep: ReserveReader): Promise<CoverageRead> {
  const ttl = coverageCache?.value.check === null ? COVERAGE_FAIL_TTL_MS : COVERAGE_TTL_MS;
  if (coverageCache && Date.now() - coverageCache.at < ttl) return coverageCache.value;
  if (coverageInflight) return coverageInflight; // single-flight: no thundering herd at expiry
  coverageInflight = checkReserves(db, readHotKeep)
    .then((check): CoverageRead => ({ check, evidence: check.custodyEvidence }))
    .catch((error): CoverageRead => ({
      check: null,
      evidence: error instanceof IneligibleCustodyReserveError ? error.evidence : null,
    })) // unknown/ineligible, NEVER covered
    .then((value) => { coverageCache = { at: Date.now(), value }; return value; })
    .finally(() => { coverageInflight = null; });
  return coverageInflight;
}

export async function getProofOfReserves(db: Db, readHotKeep?: ReserveReader | null) {
  const [latest] = await db.select().from(merkleSnapshots)
    .orderBy(sql`${merkleSnapshots.epoch} DESC`).limit(1);
  // Live coverage when the hot wallet is provisioned. A failed RPC read reports
  // `coverage: null` (unknown) — NEVER a fabricated "covered". Absent reader
  // (tests, no hot wallet) likewise reports null rather than pretending.
  const live = readHotKeep ? await cachedCoverage(db, readHotKeep) : null;
  const coverage = live?.check ?? null;
  const custody = live?.evidence ?? null;

  return {
    custodyTransition: await readCustodyTransparency(db),
    coverage: coverage
      ? {
          reserveKeep: coverage.reserveKeep.toString(),
          liabilityKeep: coverage.liabilityKeep.toString(),
          covered: coverage.covered,
          deficit: coverage.deficit.toString(),
        }
      : null,
    // Only controlled, unencumbered custody is called a reserve. Liquidity
    // pools, generic treasuries, programs and Config PDAs are deliberately not
    // published or summed here: none proves withdrawable KEEP custody.
    reserves: custody ? { liquidHotCustody: publicCustodyReserveEvidence(custody) } : null,
    liabilities: latest
      ? {
          epoch: latest.epoch.toString(),
          root: latest.root,
          totalBalance: latest.totalBalance.toString(),
          leafCount: latest.leafCount,
          createdAt: latest.createdAt,
        }
      : null,
  };
}

/** A player's inclusion proof for the latest snapshot (client-verifiable). */
export async function getInclusionProof(db: Db, wallet: string) {
  const [latest] = await db.select().from(merkleSnapshots)
    .orderBy(sql`${merkleSnapshots.epoch} DESC`).limit(1);
  if (!latest) throw new HttpError(404, 'no snapshot yet');
  const leaves = await db.select().from(merkleLeaves)
    .where(eq(merkleLeaves.epoch, latest.epoch))
    .orderBy(asc(merkleLeaves.leafIndex));
  const mine = leaves.find((l) => l.wallet === wallet);
  if (!mine) throw new HttpError(404, 'no balance in the latest snapshot');

  const tree = buildMerkleTree(leaves.map((l) => hashLeaf(l.wallet, l.amount, latest.epoch)));
  return {
    epoch: latest.epoch.toString(),
    root: latest.root,
    wallet,
    amount: mine.amount.toString(),
    leafIndex: mine.leafIndex,
    proof: tree.proof(mine.leafIndex).map(toHex),
  };
}
