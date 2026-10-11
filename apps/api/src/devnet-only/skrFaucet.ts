import { SKR_FAUCET } from '@shardkeep/shared';

/** D153.290 / Amendment 1 daily admission uses UTC, independently of block height. */
export function utcWindow(now: Date): { day: string; nextEligibleAt: string } {
  if (!Number.isSafeInteger(now.getTime())) throw new Error('invalid faucet clock');
  const day = now.toISOString().slice(0, 10);
  return { day, nextEligibleAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() };
}
export function skrGrantRaw(decimals: number): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 19) throw new Error('invalid SKR decimals');
  const raw = BigInt(SKR_FAUCET.devnet.grantSkr) * 10n ** BigInt(decimals);
  if (raw > (1n << 64n) - 1n) throw new Error('SKR grant exceeds u64');
  return raw;
}
/** Null inventory values deliberately keep signing unavailable. Amounts are
 * registry-decimal raw integers; pending reservations count even after a
 * possibly landed transfer has already lowered the observed balance. */
export function treasuryAdmission(input: {
  decimals: number; balanceRaw: bigint; reservedAllRaw: bigint; reservedDayRaw: bigint; sentTodayRaw: bigint;
  floorSkr: number | null; dailyBudgetSkr: number | null;
}): 'ok' | 'unconfigured' | 'treasury_low' | 'daily_budget' {
  const amount = skrGrantRaw(input.decimals);
  const { floorSkr, dailyBudgetSkr } = input;
  if (floorSkr === null || dailyBudgetSkr === null) return 'unconfigured';
  if (!Number.isSafeInteger(floorSkr) || floorSkr < 0 || !Number.isSafeInteger(dailyBudgetSkr)
      || dailyBudgetSkr < SKR_FAUCET.devnet.grantSkr || input.balanceRaw < 0n
      || input.reservedAllRaw < 0n || input.reservedDayRaw < 0n || input.reservedDayRaw > input.reservedAllRaw || input.sentTodayRaw < 0n) throw new Error('invalid faucet inventory policy');
  const scale = 10n ** BigInt(input.decimals);
  if (input.balanceRaw - input.reservedAllRaw - amount < BigInt(floorSkr) * scale) return 'treasury_low';
  if (input.sentTodayRaw + input.reservedDayRaw + amount > BigInt(dailyBudgetSkr) * scale) return 'daily_budget';
  return 'ok';
}

import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { Message, PublicKey, VersionedTransaction, type Signer } from '@solana/web3.js';
import { assertDevnetSkrGenesis, assertPlayerSignedFaucetTransfer, buildDevnetSkrClaimMessage,
  faucetCosign, readDevnetSkrMint, readDevnetSkrTreasury, skrClaimOutcome, skrPlayerCost,
  type SkrClaimTerms, type SkrFaucetRpc } from '@shardkeep/chain/devnet-skr-faucet-transfer';
import type { SkrIdentity } from '../money/skrIdentity';
import { HttpError } from '../lib/errors';
import type { SkrAttempt, SkrGrant, SkrGrantUnit, SkrFaucetStore } from './skrFaucetStore';
import { localSkrReconcileGate, reconciliationBinding, skrRpcBudget, type SkrReconcileBinding, type SkrReconcileContext } from './skrFaucetReconciliation';

export interface SkrFaucetPolicy {
  enabled: boolean; cluster: 'devnet' | 'mainnet-beta'; identity: SkrIdentity | null; authority: string | null;
  floorSkr: number | null; dailyBudgetSkr: number | null;
}
function fail(code: string, status = 503): HttpError { return new HttpError(status, `SKR faucet ${code.toLowerCase()}`, `SKR_FAUCET_${code}`); }
function admitted(policy: SkrFaucetPolicy): asserts policy is SkrFaucetPolicy & { identity: SkrIdentity; authority: string } {
  if (!policy.enabled || policy.cluster !== 'devnet') throw fail('DISABLED');
  if (!policy.identity || !policy.authority) throw fail('UNCONFIGURED');
}
export function grantDto(grant: SkrGrant, attempt: SkrAttempt | null) {
  return { id: grant.id, status: grant.status, mint: grant.mint, decimals: grant.decimals, amountRaw: grant.amountRaw,
    error: grant.error, requestedAt: grant.requestedAt.toISOString(), sentAt: grant.sentAt?.toISOString() ?? null,
    attempt: attempt ? { id: attempt.id, phase: attempt.phase, signature: attempt.landedSignature ?? attempt.signature,
      lastValidBlockHeight: attempt.lastValidBlockHeight.toString() } : null };
}
function termsFor(grant: SkrGrant, attempt: Pick<SkrAttempt, 'reference' | 'recentBlockhash' | 'lastValidBlockHeight'>, authority: string): SkrClaimTerms {
  const height = Number(attempt.lastValidBlockHeight);
  if (!Number.isSafeInteger(height) || height <= 0) throw fail('RETAINED_HEIGHT');
  return { wallet: grant.wallet, authority, mint: grant.mint, decimals: grant.decimals, amountRaw: grant.amountRaw,
    reference: attempt.reference, recentBlockhash: attempt.recentBlockhash, lastValidBlockHeight: height };
}
async function abandon(unit: SkrGrantUnit, attempt: SkrAttempt, now: Date) {
  return unit.updateAttempt(attempt.id, { phase: 'abandoned', settledAt: now });
}
async function expireUnsignedDay(unit: SkrGrantUnit, now: Date): Promise<boolean> {
  if (unit.grant.day === utcWindow(now).day) return false;
  for (const attempt of unit.attempts) if (attempt.phase === 'prepared' || attempt.phase === 'player_signed') await abandon(unit, attempt, now);
  if (!unit.attempts.some((attempt) => attempt.phase === 'submitted')) await unit.updateGrant({ status: 'failed', error: 'day_changed' });
  return true;
}
export function makeSkrFaucetService(policy: SkrFaucetPolicy, store: SkrFaucetStore, rpc: SkrFaucetRpc, options: {
  now?: () => Date;
  reference?: () => string;
  eligibility(wallet: string, baseId: string | undefined, at: Date): Promise<{ reason: string; deed: string | null }>;
  refreshDeed(wallet: string, baseId: string): Promise<string>;
  enqueue?: (grantId: string, attemptId: string) => Promise<void>;
}) {
  const now = options.now ?? (() => new Date());
  const reference = options.reference ?? (() => new PublicKey(randomBytes(32)).toBase58());
  let cachedMint: SkrIdentity | null = null;
  async function readMint() {
    admitted(policy); const proof = await readDevnetSkrMint(rpc, policy.identity.mint);
    if (proof.decimals !== policy.identity.decimals) throw fail('MINT_CHANGED');
    cachedMint = { mint: proof.mint, decimals: proof.decimals }; return proof;
  }
  function visibleGrant(wallet: string, grant: SkrGrant, attempt: SkrAttempt | null, nextEligibleAt: string) {
    return grant.wallet === wallet ? grantDto(grant, attempt) : { status: grant.status, nextEligibleAt };
  }
  async function status(wallet: string, baseId?: string) {
    const window = utcWindow(now()); let reason = 'ok', deed: string | null = null;
    if (!policy.enabled || policy.cluster !== 'devnet') reason = 'disabled';
    else if (!policy.identity || !policy.authority) reason = 'unconfigured';
    else if (!cachedMint || cachedMint.mint !== policy.identity.mint || cachedMint.decimals !== policy.identity.decimals) reason = 'unavailable';
    else ({ reason, deed } = await options.eligibility(wallet, baseId, now()));
    const today = await store.findToday(wallet, deed, window.day);
    if (today) reason = today.grant.wallet !== wallet || today.grant.status !== 'requested' ? 'daily_limit'
      : today.attempt?.phase === 'player_signed' || today.attempt?.phase === 'submitted' ? 'submitted'
      : today.attempt?.phase === 'prepared' ? 'pending' : 'sign_required';
    return { enabled: policy.enabled && policy.cluster === 'devnet', cluster: 'devnet' as const, isTestToken: true,
      label: SKR_FAUCET.devnet.label, symbol: SKR_FAUCET.devnet.symbol, mint: policy.identity?.mint ?? null,
      decimals: cachedMint?.decimals ?? null, grantSkr: String(SKR_FAUCET.devnet.grantSkr),
      grantRaw: cachedMint ? skrGrantRaw(cachedMint.decimals).toString() : null, ...window,
      eligible: reason === 'ok', reason, today: today ? visibleGrant(wallet, today.grant, today.attempt, window.nextEligibleAt) : null };
  }
  async function claim(wallet: string, baseId: string) {
    admitted(policy); const enteredAt = now(); await readMint();
    const refreshedDeed = await options.refreshDeed(wallet, baseId);
    const result = await store.reserve({ wallet, baseId, refreshedDeed, enteredAt, mint: policy.identity.mint,
      decimals: policy.identity.decimals, amountRaw: skrGrantRaw(policy.identity.decimals).toString() }, now);
    if (result.conflict) throw new HttpError(429, 'daily allocation already reserved', 'SKR_FAUCET_DAILY_LIMIT', {
      nextEligibleAt: utcWindow(enteredAt).nextEligibleAt, today: visibleGrant(wallet, result.grant, null, utcWindow(enteredAt).nextEligibleAt),
    });
    return { grant: grantDto(result.grant, null), nextEligibleAt: utcWindow(enteredAt).nextEligibleAt };
  }
  async function prepare(wallet: string, grantId: string) {
    admitted(policy); if (wallet === policy.authority) throw fail('AUTHORITY_IS_PLAYER', 409);
    // Retry one snapshot race. All RPC happens before acquiring the grant lock.
    for (let pass = 0; pass < 2; pass++) {
      const snapshot = await store.readGrant(grantId, wallet);
      await assertDevnetSkrGenesis(rpc);
      const height = await rpc.getBlockHeight('confirmed');
      if (!Number.isSafeInteger(height) || height < 0) throw fail('RPC_UNAVAILABLE');
      const existing = snapshot.attempts.find((attempt) => attempt.phase === 'prepared' && BigInt(height) <= attempt.lastValidBlockHeight);
      const block = existing ? { blockhash: existing.recentBlockhash, lastValidBlockHeight: Number(existing.lastValidBlockHeight) }
        : await rpc.getLatestBlockhash('confirmed');
      const candidate = existing ?? { reference: reference(), recentBlockhash: block.blockhash, lastValidBlockHeight: BigInt(block.lastValidBlockHeight) };
      const terms = termsFor(snapshot.grant, candidate, policy.authority);
      const built = buildDevnetSkrClaimMessage(terms), cost = await skrPlayerCost(rpc, terms, Message.from(built.message));
      const result = await store.withGrant(grantId, wallet, async (unit) => {
        if (unit.grant.status !== 'requested') return { error: fail('TERMINAL', 409) };
        if (await expireUnsignedDay(unit, now())) return { error: fail('DAY_CHANGED', 409) };
        if (unit.grant.mint !== policy.identity!.mint || unit.grant.decimals !== policy.identity!.decimals) return { error: fail('MINT_CHANGED') };
        if (unit.attempts.some((attempt) => attempt.phase === 'player_signed' || attempt.phase === 'submitted')) return { error: fail('ATTEMPT_LIVE', 409) };
        const current = unit.attempts.find((attempt) => attempt.phase === 'prepared');
        if (current && BigInt(height) <= current.lastValidBlockHeight) {
          if (current.id !== existing?.id) return { retry: true as const };
          if (!cost.sufficient) return { error: fail('SOL_FOR_FEE', 409) };
          if (!current.message.equals(built.message)) return { error: fail('RETAINED_MESSAGE') };
          return { value: { grant: grantDto(unit.grant, current), unsignedTransaction: built.unsignedWire,
            networkFeeLamports: cost.networkFeeLamports.toString(), accountRentLamports: cost.accountRentLamports.toString() } };
        }
        if (existing && current?.id !== existing.id) return { retry: true as const };
        if (current) await abandon(unit, current, now());
        if (unit.attempts.filter((attempt) => attempt.faucetWire !== null).length >= SKR_FAUCET.devnet.maxAttempts) {
          await unit.updateGrant({ status: 'failed', error: 'max_attempts' }); return { error: fail('MAX_ATTEMPTS', 409) };
        }
        if (!cost.sufficient) return { error: fail('SOL_FOR_FEE', 409) };
        const attempt = await unit.addAttempt({ grantId, attemptNo: Math.max(0, ...unit.attempts.map((item) => item.attemptNo)) + 1,
          message: built.message, reference: terms.reference, recentBlockhash: terms.recentBlockhash,
          lastValidBlockHeight: BigInt(terms.lastValidBlockHeight), createdAt: now() });
        return { value: { grant: grantDto(unit.grant, attempt), unsignedTransaction: built.unsignedWire,
          networkFeeLamports: cost.networkFeeLamports.toString(), accountRentLamports: cost.accountRentLamports.toString() } };
      });
      if ('error' in result && result.error) throw result.error;
      if ('value' in result && result.value) return result.value;
    }
    throw fail('PREPARE_CHANGED', 409);
  }
  async function submit(wallet: string, attemptId: string, signedTransaction: string) {
    admitted(policy); const owner = await store.readAttemptOwner(attemptId, wallet);
    const result = await store.withGrant(owner.grant.id, wallet, async (unit) => {
      const attempt = unit.attempts.find((item) => item.id === attemptId);
      if (!attempt) return { error: fail('NOT_OWNED', 404) };
      // Exact retained-wire retry only reads its DTO: a lost response remains
      // recoverable after settlement/day change and never signs or wakes twice.
      if (attempt.playerWire?.toString('base64') === signedTransaction) return { value: grantDto(unit.grant, attempt), wake: false };
      if (unit.grant.status !== 'requested') return { error: fail('TERMINAL', 409) };
      if (await expireUnsignedDay(unit, now())) return { error: fail('DAY_CHANGED', 409) };
      if (attempt.phase !== 'prepared') return { error: fail('ATTEMPT_CONFLICT', 409) };
      let verified: ReturnType<typeof assertPlayerSignedFaucetTransfer>;
      try { verified = assertPlayerSignedFaucetTransfer(termsFor(unit.grant, attempt, policy.authority!), attempt.message, signedTransaction); }
      catch (error) { return { error: fail(error instanceof Error && 'code' in error && error.code === 'BLOCKHASH_CHANGED' ? 'BLOCKHASH_CHANGED' : 'INVALID_TRANSACTION', 409) }; }
      const updated = await unit.updateAttempt(attempt.id, { phase: 'player_signed', playerWire: Buffer.from(signedTransaction, 'base64'),
        signature: verified.signature, mutation: verified.mutation });
      return { value: grantDto(unit.grant, updated), wake: true };
    });
    if ('error' in result && result.error) throw result.error;
    if ('wake' in result && result.wake) { try { await options.enqueue?.(owner.grant.id, attemptId); } catch { /* Durable sweep will find the committed player_signed row. */ } }
    if ('value' in result && result.value) return { grant: result.value };
    throw fail('INVALID_STATE');
  }
  /** K-night-03 native recovery reads: DB only (no chain read, no admission), so saved evidence stays checkable
   * while the faucet is paused. Strict page `{ items, nextCursor }`; nextCursor is the last item id only on a full page. */
  async function listGrants(wallet: string, after?: string) {
    const page = await store.ownedRequested(wallet, after);
    const items = page.rows.map((row) => grantDto(row.grant, row.attempt));
    return { items, nextCursor: page.more ? items[items.length - 1]!.id : null };
  }
  async function readGrant(wallet: string, grantId: string) {
    const owned = await store.readGrant(grantId, wallet); // 404 SKR_FAUCET_NOT_OWNED for another wallet's or no grant
    return { grant: grantDto(owned.grant, owned.attempts[0] ?? null) };
  }
  return { status, claim, prepare, submit, listGrants, readGrant, prime: async () => { try { await readMint(); } catch { cachedMint = null; } } };
}

/** Per-grant work commits its exact signed wire before returning it for send.
 * The DB implementation holds a mint advisory lock through the budget decision
 * and marks submitted in that transaction, so another worker sees its reserve. */
export async function processSkrFaucetGrant(policy: SkrFaucetPolicy, store: SkrFaucetStore, rpc: SkrFaucetRpc,
  signer: Signer, grantId: string, now: () => Date = () => new Date(), context?: SkrReconcileContext): Promise<void> {
  if (!policy.enabled || policy.cluster !== 'devnet' || !policy.identity || !policy.authority
      || policy.floorSkr === null || policy.dailyBudgetSkr === null) return;
  if (signer.publicKey.toBase58() !== policy.authority) return;
  const gate = context?.gate ?? localSkrReconcileGate(store);
  const budget = context?.budget ?? skrRpcBudget();
  if (!budget.available()) return;
  const sourceRpc = rpc; rpc = budget.wrap(sourceRpc);
  const broadcast = async (wire: Buffer) => {
    try {
      await assertDevnetSkrGenesis(rpc);
      const signature = await rpc.sendRawTransaction(wire, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
      if (signature !== bs58.encode(VersionedTransaction.deserialize(wire).signatures[0]!)) throw fail('BROADCAST_RESPONSE');
    } catch { /* Retained submitted bytes are the only rebroadcast candidate. */ }
  };
  // Non-locking read, then bounded RPC, then compare the same immutable attempt
  // under only its grant lock. No outcome RPC can hold a DB transaction.
  const snapshot = await store.readReconciliation(grantId);
  if (!snapshot || snapshot.grant.status !== 'requested') return;
  const submitted = snapshot.attempts.find((item) => item.phase === 'submitted');
  if (submitted) {
    const binding = reconciliationBinding(snapshot.grant, submitted);
    const ticket = await gate.claim(binding, now().getTime());
    if (!ticket) return; // backoff, parked, missing or corrupt state: no RPC/transaction
    const scan = budget.scan(sourceRpc);
    const diagnostic: { reason: 'pending' | 'capped' | 'incomplete' | 'unavailable' | 'budget' } = { reason: 'unavailable' };
    const outcome = await skrClaimOutcome(scan.rpc, { signature: submitted.signature!, reference: submitted.reference,
      lastValidBlockHeight: Number(submitted.lastValidBlockHeight), faucetWire: submitted.faucetWire!.toString('base64') },
      (value) => { diagnostic.reason = value; });
    const reason = scan.exhaustionReason() ?? diagnostic.reason;
    const unchanged = (unit: SkrGrantUnit) => unit.grant.status === 'requested'
      && unit.grant.mint === snapshot.grant.mint && unit.grant.day === snapshot.grant.day
      && unit.grant.amountRaw === snapshot.grant.amountRaw && unit.attempts.some((item) => item.id === submitted.id
        && item.phase === 'submitted' && item.signature === submitted.signature && item.reference === submitted.reference
        && item.lastValidBlockHeight === submitted.lastValidBlockHeight && item.faucetWire?.equals(submitted.faucetWire!)
        && item.message.equals(submitted.message));
    if (outcome.state === 'unknown') {
      await gate.finish(ticket, reason, now().getTime());
      // Only a still-live pending original may be re-broadcast, never re-signed.
      // Capped/incomplete/scan-cap/budget/deadline/unavailable checks open no DB transaction.
      if (reason === 'pending' && budget.available()) {
        let height: number;
        try { height = await rpc.getBlockHeight('confirmed'); } catch { return; }
        if (Number.isSafeInteger(height) && height >= 0 && BigInt(height) <= submitted.lastValidBlockHeight) {
          const original = await store.withGrant(grantId, null, async (unit) => unchanged(unit) ? submitted.faucetWire : null);
          if (original) await broadcast(original);
        }
      }
      return;
    }
    // 'unknown' already returned above: the attempt stays `submitted` (fail closed, no
    // settlement, no arrival claim). TS keeps that `outcome.state` narrowing here but drops it
    // inside the async closure below ('unknown' shares a union member with 'expired'), so
    // capture the narrowed value; its type now proves 'unknown' can never be written as a phase.
    const settledPhase = outcome.state;
    await store.withGrant(grantId, null, async (unit) => {
      if (!unchanged(unit)) return;
      await unit.updateAttempt(submitted.id, { phase: settledPhase, settledAt: now(),
        ...('landedSignature' in outcome ? { landedSignature: outcome.landedSignature } : {}) });
      if (outcome.state === 'finalized') await unit.updateGrant({ status: 'sent', error: null, sentAt: now() });
      else if (unit.attempts.filter((item) => item.faucetWire !== null).length >= SKR_FAUCET.devnet.maxAttempts)
        await unit.updateGrant({ status: 'failed', error: 'max_attempts' });
      else await unit.updateGrant({ error: outcome.state === 'failed' ? 'chain_failed' : 'expired' });
    }); // no mint lock: settlement only releases an existing reservation
    await gate.finish(ticket, null, now().getTime());
    return;
  }
  let newBinding: SkrReconcileBinding | null = null;
  const outgoing = await store.withGrant(grantId, null, async (unit): Promise<Buffer | null> => {
    if (unit.grant.status !== 'requested') return null;
    const attempt = unit.attempts.find((item) => item.phase === 'player_signed')
      ?? unit.attempts.find((item) => item.phase === 'submitted') ?? unit.attempts.find((item) => item.phase === 'prepared');
    if (!attempt) { await expireUnsignedDay(unit, now()); return null; }
    if (attempt.phase !== 'submitted' && await expireUnsignedDay(unit, now())) return null;
    if (attempt.phase === 'submitted') return null; // raced with a prior worker; next sweep uses the outside-lock path
    await assertDevnetSkrGenesis(rpc);
    if (attempt.phase === 'prepared') {
      const height = await rpc.getBlockHeight('confirmed');
      if (Number.isSafeInteger(height) && BigInt(height) > attempt.lastValidBlockHeight) await abandon(unit, attempt, now());
      return null;
    }
    if (unit.attempts.some((other) => other.id !== attempt.id && other.phase === 'submitted')) return null;
    if (unit.grant.mint !== policy.identity!.mint || unit.grant.decimals !== policy.identity!.decimals) { await unit.updateGrant({ error: 'mint_changed' }); return null; }
    const terms = termsFor(unit.grant, attempt, policy.authority!);
    if (!attempt.playerWire) throw fail('PLAYER_WIRE');
    const verified = assertPlayerSignedFaucetTransfer(terms, attempt.message, attempt.playerWire.toString('base64'));
    const mintProof = await readDevnetSkrMint(rpc, terms.mint);
    if (mintProof.decimals !== terms.decimals) { await unit.updateGrant({ error: 'mint_changed' }); return null; }
    if (unit.attempts.filter((item) => item.faucetWire !== null).length >= SKR_FAUCET.devnet.maxAttempts) {
      await abandon(unit, attempt, now()); await unit.updateGrant({ status: 'failed', error: 'max_attempts' }); return null;
    }
    const treasury = await readDevnetSkrTreasury(rpc, terms.mint, terms.authority);
    const totals = await unit.tallies(terms.mint, utcWindow(now()).day);
    const allowed = treasuryAdmission({ decimals: terms.decimals, balanceRaw: treasury.balanceRaw, ...totals,
      floorSkr: policy.floorSkr, dailyBudgetSkr: policy.dailyBudgetSkr });
    if (allowed !== 'ok') { await unit.updateGrant({ error: allowed }); return null; }
    const cost = await skrPlayerCost(rpc, terms, verified.transaction.message, verified.priorityFeeLamports);
    const height = await rpc.getBlockHeight('confirmed');
    if (!Number.isSafeInteger(height) || height < 0) throw fail('RPC_UNAVAILABLE');
    if (await expireUnsignedDay(unit, now())) return null;
    if (!cost.sufficient || height > terms.lastValidBlockHeight - SKR_FAUCET.devnet.submitHeightMargin) {
      await abandon(unit, attempt, now()); await unit.updateGrant({ error: !cost.sufficient ? 'sol_for_fee' : 'height_margin' }); return null;
    }
    // Re-read synchronously: awaiting the earlier expiry helper can yield across midnight.
    if (unit.grant.day !== utcWindow(now()).day) { await expireUnsignedDay(unit, now()); return null; }
    // No await between this final day check and signing exact verified bytes.
    const wire = Buffer.from(faucetCosign(terms, attempt.message, attempt.playerWire.toString('base64'), signer), 'base64');
    await unit.updateAttempt(attempt.id, { phase: 'submitted', faucetWire: wire });
    await unit.updateGrant({ error: null });
    newBinding = reconciliationBinding(unit.grant, { ...attempt, faucetWire: wire }); return wire;
  }, policy.identity.mint);
  if (outgoing && newBinding) {
    // Persist control before first send. If Redis fails after commit, keep the
    // submitted wire/floor reservation and require operator reconciliation.
    await gate.register(newBinding, now().getTime());
    await broadcast(outgoing);
  }
}
