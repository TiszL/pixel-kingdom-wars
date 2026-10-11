/**
 * DEVNET PLAYTEST ONLY — in-game devnet SOL faucet (owner 2026-08-22: "getting
 * devnet sol automatically for users in-game … make onboarding flow 100% smooth
 * … only devnet feature so make sure properly separate it in advance to remove
 * it completely before mainnet release").
 *
 * Shape, chosen for custody hygiene: the API never holds a key. It records a
 * grant REQUEST after checking eligibility (flag on, devnet, wallet balance
 * below DEVNET_FAUCET.minBalanceSol, lifetime cap, cooldown, no pending row).
 * The worker — the only process that mounts DEVNET_FAUCET_KEYPAIR_PATH — pays
 * requested rows from the faucet treasury (a dedicated keypair the owner funds
 * with devnet SOL), confirms the transfer and writes the signature; the client
 * polls status and toasts "+0.5 DEVNET SOL ARRIVED". Failures are recorded with
 * a bounded reason and the client shows an honest retry (D-098: the public
 * faucet is never the path the game points at — it may ask for a mainnet
 * balance).
 *
 * Removal before mainnet: delete this module, routes-devnet-faucet.ts, the
 * devnet_faucet_grants table, the DEVNET_FAUCET constants/env, the worker queue
 * in jobs.ts and the client's useDevnetFaucet hook. Config already refuses
 * DEVNET_FAUCET_ENABLED=true on any cluster but devnet.
 */
import { DEVNET_FAUCET } from '@shardkeep/shared';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmRawTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { devnetFaucetGrants, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { serverTrack } from '../telemetry';

export type FaucetReason =
  | 'ok' | 'disabled' | 'not_devnet' | 'pending' | 'balance_ok' | 'cap_reached' | 'cooldown' | 'no_player'
  /** The balance RPC did not answer; retry later (never grants blind). */
  | 'rpc_unavailable';

export interface FaucetGrantDto {
  id: string;
  status: 'requested' | 'sent' | 'failed';
  lamports: string;
  txSignature: string | null;
  error: string | null;
  requestedAt: string;
  sentAt: string | null;
}

export interface FaucetStatus {
  enabled: boolean;
  eligible: boolean;
  reason: FaucetReason;
  balanceSol: number | null;
  grantSol: number;
  grantedSol: number;
  lifetimeCapSol: number;
  minBalanceSol: number;
  /** Policy the client may only DISPLAY (D-098): hours between grants, and
   * when the cooldown ends — set only while `reason` is 'cooldown'. */
  cooldownHours: number;
  nextEligibleAt: string | null;
  /** The most recent grant row (pending, sent or failed), if any. */
  last: FaucetGrantDto | null;
}

export interface FaucetPolicy {
  enabled: boolean;
  cluster: string;
}

const GRANT_LAMPORTS = BigInt(Math.round(DEVNET_FAUCET.grantSol * LAMPORTS_PER_SOL));
const CAP_LAMPORTS = BigInt(Math.round(DEVNET_FAUCET.lifetimeCapSol * LAMPORTS_PER_SOL));
const MIN_BALANCE_LAMPORTS = BigInt(Math.round(DEVNET_FAUCET.minBalanceSol * LAMPORTS_PER_SOL));
const FLOOR_LAMPORTS = BigInt(Math.round(DEVNET_FAUCET.treasuryFloorSol * LAMPORTS_PER_SOL));

function dto(row: typeof devnetFaucetGrants.$inferSelect): FaucetGrantDto {
  return {
    id: row.id, status: row.status, lamports: row.lamports.toString(),
    txSignature: row.txSignature, error: row.error,
    requestedAt: row.requestedAt.toISOString(), sentAt: row.sentAt?.toISOString() ?? null,
  };
}

const RPC_TIMEOUT_MS = 6_000;
/** Bounded balance read (hard 6 s timeout, web3.js itself never times out);
 * a transient RPC failure reads as "unknown" (null) and never grants — the
 * faucet is a convenience, not a right. Always called OUTSIDE a DB transaction. */
export async function readLamports(connection: Connection, wallet: string): Promise<bigint | null> {
  try {
    const balance = await Promise.race([
      connection.getBalance(new PublicKey(wallet), 'confirmed'),
      new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('rpc timeout')), RPC_TIMEOUT_MS); t.unref?.(); }),
    ]);
    return BigInt(balance);
  } catch {
    return null;
  }
}

async function grantedLamports(db: Db, wallet: string): Promise<bigint> {
  const rows = await db.execute<{ total: unknown }>(sql`select coalesce(sum(lamports), 0)::text as total
    from devnet_faucet_grants where wallet = ${wallet} and status <> 'failed'`);
  const first = (rows as unknown as Array<{ total: unknown }>)[0];
  return BigInt(String(first?.total ?? '0'));
}

async function lastGrant(db: Db, wallet: string) {
  const [row] = await db.select().from(devnetFaucetGrants).where(eq(devnetFaucetGrants.wallet, wallet))
    .orderBy(desc(devnetFaucetGrants.requestedAt)).limit(1);
  return row ?? null;
}

/**
 * Eligibility + the last grant, for the client banner. `balance` may be passed
 * by a caller that already read it; otherwise it is read through `connection`.
 */
export async function devnetFaucetStatus(
  db: Db, policy: FaucetPolicy, connection: Connection | null, wallet: string, now = new Date(),
  preRead?: { lamports: bigint | null },
): Promise<FaucetStatus> {
  const base = {
    enabled: policy.enabled && policy.cluster === 'devnet',
    grantSol: DEVNET_FAUCET.grantSol, lifetimeCapSol: DEVNET_FAUCET.lifetimeCapSol,
    minBalanceSol: DEVNET_FAUCET.minBalanceSol, cooldownHours: DEVNET_FAUCET.cooldownHours,
  };
  const last = await lastGrant(db, wallet);
  const granted = await grantedLamports(db, wallet);
  const grantedSol = Number(granted) / LAMPORTS_PER_SOL;
  const finish = (eligible: boolean, reason: FaucetReason, balanceSol: number | null, nextEligibleAt: string | null = null): FaucetStatus => ({
    ...base, eligible, reason, balanceSol, grantedSol, nextEligibleAt, last: last ? dto(last) : null,
  });
  if (!policy.enabled) return finish(false, 'disabled', null);
  if (policy.cluster !== 'devnet') return finish(false, 'not_devnet', null);
  if (last && last.status === 'requested') return finish(false, 'pending', null);
  if (granted + GRANT_LAMPORTS > CAP_LAMPORTS) return finish(false, 'cap_reached', null);
  if (last && last.status === 'sent' && last.sentAt) {
    // The client only displays this instant (countdown, 429 copy); the server
    // stays the one that decides whether the cooldown has passed.
    const nextEligibleAt = new Date(last.sentAt.getTime() + DEVNET_FAUCET.cooldownHours * 3_600_000);
    if (now.getTime() < nextEligibleAt.getTime()) return finish(false, 'cooldown', null, nextEligibleAt.toISOString());
  }
  const lamports = preRead ? preRead.lamports : (connection ? await readLamports(connection, wallet) : null);
  const balanceSol = lamports === null ? null : Number(lamports) / LAMPORTS_PER_SOL;
  if (lamports === null) return finish(false, 'rpc_unavailable', null);
  if (lamports >= MIN_BALANCE_LAMPORTS) return finish(false, 'balance_ok', balanceSol);
  return finish(true, 'ok', balanceSol);
}

/** Record a grant request after re-checking eligibility under a per-wallet
 * advisory lock (two taps cannot queue two grants). */
export async function requestDevnetFaucetGrant(
  db: Db, policy: FaucetPolicy, connection: Connection | null, wallet: string, now = new Date(),
): Promise<{ grant: FaucetGrantDto; status: FaucetStatus }> {
  const [player] = await db.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found');
  // The RPC read happens BEFORE the transaction so a slow devnet RPC can never
  // pin a pooled connection under the advisory lock.
  const preRead = { lamports: connection ? await readLamports(connection, wallet) : null };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`devnet-faucet:${wallet}`}, 0))`);
    const status = await devnetFaucetStatus(tx as unknown as Db, policy, connection, wallet, now, preRead);
    if (!status.eligible) {
      // D-098: none of these points at the public faucet — it may ask for a
      // mainnet balance, and the in-game faucet is the one the game stands by.
      const nextAt = status.nextEligibleAt
        ? `${status.nextEligibleAt.slice(0, 16).replace('T', ' ')} UTC` : 'later';
      const message: Record<FaucetReason, string> = {
        ok: 'eligible',
        disabled: 'the in-game devnet faucet is off right now — try again later',
        not_devnet: 'the in-game faucet exists only on devnet',
        pending: 'your previous devnet SOL grant is still being sent',
        balance_ok: 'your wallet already holds enough devnet SOL',
        cap_reached: 'you have received the playtest lifetime maximum from the in-game faucet',
        cooldown: `the in-game faucet can top you up again at ${nextAt}`,
        no_player: 'player not found',
        rpc_unavailable: 'could not read your devnet balance right now — try again in a minute',
      };
      const code = status.reason === 'pending' ? 409 : status.reason === 'rpc_unavailable' ? 503 : 429;
      throw new HttpError(code, message[status.reason], 'FAUCET_NOT_ELIGIBLE');
    }
    const [row] = await tx.insert(devnetFaucetGrants).values({ wallet, lamports: GRANT_LAMPORTS, requestedAt: now }).returning();
    serverTrack('devnet_faucet_requested', wallet, { lamports: GRANT_LAMPORTS.toString() }, { eventId: `faucet:${row!.id}` });
    return { grant: dto(row!), status: { ...status, eligible: false, reason: 'pending', last: dto(row!) } };
  });
}

export interface FaucetSender {
  publicKey: PublicKey;
  treasuryLamports(): Promise<bigint>;
  /** Sign, hand the signature to `onSigned` (persisted BEFORE broadcast, so a
   * crash between broadcast and the DB update can never pay twice), then send
   * and confirm; resolves with the same signature. */
  transfer(to: PublicKey, lamports: bigint, onSigned: (signature: string) => Promise<void>): Promise<string>;
  /** True when a previously recorded signature landed without error. */
  signatureLanded(signature: string): Promise<boolean>;
  /** Current balance of a player wallet (null when unknown) — re-checked right
   * before paying so a stale request never tops up a wallet that is fine. */
  walletLamports(wallet: PublicKey): Promise<bigint | null>;
}

/** A persisted signature that has not landed is resent only after the devnet
 * blockhash horizon has surely passed (~60–90 s); before that a late landing
 * plus a fresh transfer would pay twice. */
export const FAUCET_RESEND_AFTER_MS = 150_000;
const INTENT_PREFIX = 'broadcast pending since ';

/** The worker's real sender over the faucet keypair (confirmed commitment is
 * enough for test SOL; the client re-reads the balance anyway). */
export function makeDevnetFaucetSender(connection: Connection, keypair: Keypair): FaucetSender {
  return {
    publicKey: keypair.publicKey,
    treasuryLamports: async () => BigInt(await connection.getBalance(keypair.publicKey, 'confirmed')),
    transfer: async (to, lamports, onSigned) => {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight })
        .add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports: Number(lamports) }));
      tx.sign(keypair);
      const signature = bs58.encode(tx.signature!);
      await onSigned(signature);
      await sendAndConfirmRawTransaction(connection, tx.serialize(), { signature, blockhash, lastValidBlockHeight }, { commitment: 'confirmed' });
      return signature;
    },
    signatureLanded: async (signature) => {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = value[0];
      return !!st && st.err === null && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized');
    },
    walletLamports: (wallet) => readLamports(connection, wallet.toBase58()),
  };
}

/**
 * Worker sweep: pay requested grants oldest-first, bounded per run. A treasury
 * below DEVNET_FAUCET.treasuryFloorSol fails the rows with `treasury_low` (the
 * client then shows FAUCET UNAVAILABLE with a retry) instead of draining the
 * key that also backs the owner's devnet operations.
 */
export async function processDevnetFaucetGrants(
  db: Db, sender: FaucetSender, now = new Date(), limit = DEVNET_FAUCET.maxGrantsPerSweep,
  opts: { dailyBudgetLamports?: bigint } = {},
): Promise<{ sent: number; failed: number; skipped: number }> {
  const pending = await db.select().from(devnetFaucetGrants)
    .where(eq(devnetFaucetGrants.status, 'requested'))
    .orderBy(devnetFaucetGrants.requestedAt).limit(limit);
  let sent = 0; let failed = 0; let skipped = 0;
  if (pending.length === 0) return { sent, failed, skipped };
  const fail = async (id: string, error: string): Promise<void> => {
    await db.update(devnetFaucetGrants).set({ status: 'failed', error, sentAt: now })
      .where(and(eq(devnetFaucetGrants.id, id), eq(devnetFaucetGrants.status, 'requested')));
    failed += 1;
  };
  // Treasury-wide daily ceiling: what was already paid since 00:00 UTC today.
  const dailyBudget = opts.dailyBudgetLamports ?? BigInt(Math.round(DEVNET_FAUCET.dailyBudgetSol * LAMPORTS_PER_SOL));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const paidRows = await db.execute<{ total: unknown }>(sql`select coalesce(sum(lamports), 0)::text as total
    from devnet_faucet_grants where status = 'sent' and sent_at >= ${dayStart.toISOString()}::timestamptz`);
  let paidToday = BigInt(String((paidRows as unknown as Array<{ total: unknown }>)[0]?.total ?? '0'));
  let treasury = await sender.treasuryLamports();
  for (const row of pending) {
    // A row that already carries a signature is a broadcast whose DB update
    // was interrupted: settle it from chain state, never by paying again.
    if (row.txSignature) {
      const landed = await sender.signatureLanded(row.txSignature).catch(() => false);
      if (landed) {
        const updated = await db.update(devnetFaucetGrants).set({ status: 'sent', error: null, sentAt: now })
          .where(and(eq(devnetFaucetGrants.id, row.id), eq(devnetFaucetGrants.status, 'requested')))
          .returning({ id: devnetFaucetGrants.id });
        if (updated.length > 0) {
          sent += 1;
          serverTrack('devnet_faucet_granted', row.wallet, { lamports: row.lamports.toString(), recovered: true }, { eventId: `faucet-sent:${row.id}` });
        }
        continue;
      }
      const since = row.error?.startsWith(INTENT_PREFIX) ? Date.parse(row.error.slice(INTENT_PREFIX.length)) : NaN;
      if (!Number.isFinite(since) || now.getTime() - since < FAUCET_RESEND_AFTER_MS) { skipped += 1; continue; }
      // Horizon passed and nothing landed: fall through and resend with a new signature.
    }
    // A request nobody could pay in time (worker down, key missing) is not paid
    // late; the player simply claims again (or used the public faucet meanwhile).
    if (now.getTime() - row.requestedAt.getTime() > DEVNET_FAUCET.requestTtlMinutes * 60_000) { await fail(row.id, 'stale'); continue; }
    // Eligibility was checked at request time; re-check the one thing that
    // changes by itself — the wallet may have been funded since.
    const current = await sender.walletLamports(new PublicKey(row.wallet)).catch(() => null);
    if (current !== null && current >= MIN_BALANCE_LAMPORTS) { await fail(row.id, 'balance_ok_now'); continue; }
    if (paidToday + row.lamports > dailyBudget) { await fail(row.id, 'daily_budget'); skipped += 1; continue; }
    if (treasury - row.lamports < FLOOR_LAMPORTS) {
      await fail(row.id, 'treasury_low');
      skipped += 1;
      continue;
    }
    try {
      const signature = await sender.transfer(new PublicKey(row.wallet), row.lamports, async (sig) => {
        // Durable intent: signature + timestamp land before the broadcast.
        await db.update(devnetFaucetGrants).set({ txSignature: sig, error: `${INTENT_PREFIX}${now.toISOString()}` })
          .where(and(eq(devnetFaucetGrants.id, row.id), eq(devnetFaucetGrants.status, 'requested')));
      });
      const updated = await db.update(devnetFaucetGrants)
        .set({ status: 'sent', txSignature: signature, error: null, sentAt: now })
        .where(and(eq(devnetFaucetGrants.id, row.id), eq(devnetFaucetGrants.status, 'requested')))
        .returning({ id: devnetFaucetGrants.id });
      if (updated.length > 0) {
        sent += 1;
        treasury -= row.lamports;
        paidToday += row.lamports;
        serverTrack('devnet_faucet_granted', row.wallet, { lamports: row.lamports.toString() }, { eventId: `faucet-sent:${row.id}` });
      }
    } catch (e) {
      // If a signature was persisted the broadcast MAY have landed: leave the
      // row pending with its intent and let the next sweep settle it from
      // chain state. Only a pre-broadcast failure is a clean failure.
      const [fresh] = await db.select({ txSignature: devnetFaucetGrants.txSignature }).from(devnetFaucetGrants).where(eq(devnetFaucetGrants.id, row.id));
      if (fresh?.txSignature) { skipped += 1; continue; }
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      await fail(row.id, `rpc: ${reason}`);
    }
  }
  return { sent, failed, skipped };
}
