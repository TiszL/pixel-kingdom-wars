import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { BasePurchaseCancellationSchema, BasePurchaseNetworkSchema, BasePurchaseQuoteSchema, BasePurchaseRequestSchema, BasePurchaseStatusSchema,
  type BasePurchaseCancellation, type BasePurchaseNetwork, type BasePurchaseQuote, type BasePurchaseRequest, type BasePurchaseStatus } from '@shardkeep/shared/basePurchases';
import { ECONOMY, WARZONE } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { accounts, basePurchaseCancellations, basePurchaseShieldReceipts, deposits, ledgerEntries, ledgerTransactions, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { createDepositIntent, type DepositPayload, type DepositStableAuthorityContext, type VerifiedPayment } from './deposits';
import { NATIVE_SOL_MINT } from './mintDimension';

export const basePurchaseEnabled = (kind?: BasePurchaseRequest['kind']) => process.env['BASE_PURCHASE_V1_ENABLED'] === 'true'
  && (kind !== 'shield' && kind !== 'warzone_shield' || process.env['SHIELD_PURCHASE_V1_ENABLED'] === 'true')
  && (kind !== 'energy' && kind !== 'energy_pack' || process.env['ENERGY_PURCHASE_V1_ENABLED'] === 'true');
export function basePurchaseNetwork(cluster: BasePurchaseNetwork['cluster'], addresses: {
  coreProgram: string; config: string; treasuries: { liquidity: string; dev: string; ops: string };
}): BasePurchaseNetwork {
  const result = BasePurchaseNetworkSchema.parse({ cluster, coreProgram: addresses.coreProgram, configPda: addresses.config,
    treasuryLiquidity: addresses.treasuries.liquidity, treasuryDev: addresses.treasuries.dev,
    treasuryOps: addresses.treasuries.ops, systemProgram: '11111111111111111111111111111111' });
  for (const [key, value] of Object.entries(result)) if (key !== 'cluster') {
    if (new PublicKey(value).toBase58() !== value) throw new Error('noncanonical base purchase account');
  }
  return result;
}
const unavailable = () => new HttpError(503, 'original purchase evidence is unavailable', 'BASE_PURCHASE_EVIDENCE_UNAVAILABLE');
export function assertBasePurchaseNetwork(quote: BasePurchaseQuote, network?: BasePurchaseNetwork): void {
  if (!network || !BasePurchaseNetworkSchema.safeParse(network).success || Object.entries(network).some(([key, value]) => quote.rail[key as keyof typeof quote.rail] !== value)) {
    // Never turn a changed treasury/cluster into an unpaid expiry.
    throw new HttpError(503, 'original payment network configuration is unavailable', 'BASE_PURCHASE_RAIL_UNAVAILABLE');
  }
}
export function freezeBasePurchaseQuote(
  context: { request: BasePurchaseRequest; network: BasePurchaseNetwork } | undefined,
  id: string, reference: string, wallet: string, payload: DepositPayload, now: Date,
  upgrade?: { buildingType: 'mine' | 'goldforge'; fromLevel: number; costShards: number },
): DepositPayload {
  if (!context) return payload;
  const request = context.request;
  if (request.baseId !== payload.baseId
    || request.kind === 'builder' && request.expectedBuilders !== payload.expectedBuilders
    || request.kind === 'expansion' && request.expectedExpansions !== payload.expectedExpansions
    || request.kind === 'mine' && (!upgrade || request.buildingId !== payload.buildingId
      || request.buildingType !== upgrade.buildingType || request.fromLevel !== upgrade.fromLevel
      || request.toLevel !== upgrade.fromLevel + 1 || BigInt(upgrade.costShards) > BigInt(request.maxCostShards))) {
    throw new HttpError(409, 'base purchase changed before quoting', 'BASE_PURCHASE_CHANGED');
  }
  const directLamports = BigInt(payload.amountLamports ?? 0) * BigInt(WARZONE.shieldLiquidityDirectBps) / 10_000n;
  const quote = BasePurchaseQuoteSchema.parse({ version: 1, depositId: id, wallet, request,
    baseEpoch: { landPaidAt: payload.landPaidAt, deedAssetId: payload.deedAssetId }, reference,
    amountLamports: String(payload.amountLamports), quotedCostShards: upgrade ? String(upgrade.costShards) : null,
    ...(request.kind === 'energy' || request.kind === 'energy_pack' ? { energyQuantity: payload.energyQuantity } : {}),
    rail: { ...context.network, ...(request.kind === 'builder' || request.kind === 'shield' ? { mode: 'buy_sink', sinkKind: request.kind === 'builder' ? 8 : 4, destination: null }
      : request.kind === 'energy' || request.kind === 'energy_pack' ? { mode: 'buy_sink', sinkKind: request.kind === 'energy' ? 3 : 7, destination: null }
      : request.kind === 'warzone_shield' ? { mode: 'warzone_split', sinkKind: 6, destination: context.network.treasuryLiquidity,
        directLamports: directLamports.toString(), splitLamports: (BigInt(payload.amountLamports!) - directLamports).toString() }
      : { mode: 'sol_transfer', sinkKind: null, destination: context.network.treasuryLiquidity }) },
    createdAt: now.toISOString(),
    payableUntil: new Date(now.getTime() + (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin) * 60_000).toISOString(),
    retryAt: new Date(now.getTime() + ECONOMY.depositPendingTtlMin * 60_000).toISOString(),
  });
  return { ...payload, basePurchaseV1: quote };
}

/** These rows alone have database-enforced immutable quote/terminal retention. */
export function originalBasePurchase(row: typeof deposits.$inferSelect): BasePurchaseQuote | null {
  const raw = (row.payload as DepositPayload | null)?.basePurchaseV1;
  if (raw === undefined) return null;
  const parsed = BasePurchaseQuoteSchema.safeParse(raw);
  if (!parsed.success) throw unavailable();
  const q = parsed.data; const p = row.payload as DepositPayload;
  if (q.depositId !== row.id || q.wallet !== row.playerWallet || q.request.kind !== row.kind || q.reference !== row.reference
    || q.createdAt !== row.createdAt.toISOString() || q.request.baseId !== p.baseId || q.amountLamports !== String(p.amountLamports)
    || q.baseEpoch.landPaidAt !== p.landPaidAt || q.baseEpoch.deedAssetId !== p.deedAssetId
    || q.request.kind === 'builder' && q.request.expectedBuilders !== p.expectedBuilders
    || q.request.kind === 'expansion' && q.request.expectedExpansions !== p.expectedExpansions
    || q.request.kind === 'mine' && q.request.buildingId !== p.buildingId
    || (q.request.kind === 'energy' || q.request.kind === 'energy_pack') && q.energyQuantity !== p.energyQuantity) throw unavailable();
  return q;
}
/** Explicit rolling-version fence: pre-v1 workers never set this transaction-local marker. */
export async function allowBasePurchaseTerminal(tx: DbOrTx, id: string): Promise<void> {
  await tx.execute(sql`select set_config('shardkeep.base_purchase_v1', ${id}, true)`);
}
export async function assertBasePurchasePayment(tx: DbOrTx, row: typeof deposits.$inferSelect, payment: VerifiedPayment): Promise<void> {
  const quote = originalBasePurchase(row); if (!quote) return;
  if (!payment.basePurchaseV1 || JSON.stringify(payment.basePurchaseV1) !== JSON.stringify(quote)) {
    throw new HttpError(503, 'versioned payment verifier is required', 'BASE_PURCHASE_RAIL_UNAVAILABLE');
  }
  if (row.paymentSignature && row.paymentSignature !== payment.txSignature) {
    // The reference is public and may carry several attempts. Once exact
    // confirmed proof is pinned, another candidate cannot settle its history.
    throw new HttpError(503, 'original confirmed payment proof is unavailable', 'BASE_PURCHASE_EVIDENCE_UNAVAILABLE');
  }
  await allowBasePurchaseTerminal(tx, row.id);
}
async function state(tx: DbOrTx, row: typeof deposits.$inferSelect) {
  const quote = originalBasePurchase(row); if (!quote) throw unavailable();
  let receipt = null;
  if (row.status === 'credited') {
    if (!row.finalizedAt || !row.txSignature || row.amount?.toString() !== quote.amountLamports || row.mint !== NATIVE_SOL_MINT) throw unavailable();
    let shards = null;
    if (quote.request.kind === 'mine') {
      const [ledger] = await tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `mine-up:${row.id}`));
      const r = quote.request;
      if (!ledger || ledger.type !== `build.upgrade_${r.buildingType}`) throw unavailable();
      const m = ledger.metadata as Record<string, unknown> | null;
      if (m?.wallet !== quote.wallet || m.baseId !== r.baseId || m.buildingId !== r.buildingId || m.to !== r.toLevel) throw unavailable();
      const legs = await tx.select({ delta: ledgerEntries.delta, currency: accounts.currency, kind: accounts.kind,
        wallet: accounts.ownerWallet, baseId: accounts.baseId }).from(ledgerEntries)
        .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, ledger.id));
      const debit = legs.find(l => l.kind === 'base_shards' && l.baseId === r.baseId && l.wallet === null && l.currency === 'SHARDS' && l.delta < 0n);
      const burn = legs.find(l => l.kind === 'shard_burn' && l.baseId === null && l.wallet === null && l.currency === 'SHARDS' && l.delta > 0n);
      if (legs.length !== 2 || !debit || !burn || debit.delta + burn.delta !== 0n || burn.delta > BigInt(r.maxCostShards)) throw unavailable();
      shards = { receiptId: ledger.id, currency: 'SHARDS' as const, amount: burn.delta.toString() };
    }
    let shield;
    if (quote.request.kind === 'shield' || quote.request.kind === 'warzone_shield') {
      const [effect] = await tx.select().from(basePurchaseShieldReceipts).where(eq(basePurchaseShieldReceipts.depositId, row.id));
      if (!effect) throw unavailable();
      shield = { granted: effect.granted, expiresAt: effect.expiresAt?.toISOString() ?? null };
    }
    receipt = { version: 1 as const, depositId: row.id, acceptedAt: row.finalizedAt.toISOString(), txSignature: row.txSignature,
      amountLamports: row.amount!.toString(), shards,
      ...(quote.request.kind === 'energy' || quote.request.kind === 'energy_pack' ? { energy: { quantity: quote.energyQuantity! } } : {}), ...(shield ? { shield } : {}) };
  }
  return { quote, status: row.status, paymentSignature: row.paymentSignature, txSignature: row.txSignature,
    amount: row.amount?.toString() ?? null, finalizedAt: row.finalizedAt?.toISOString() ?? null, receipt };
}
async function lookup(tx: DbOrTx, wallet: string, key: string) {
  return (await tx.select().from(deposits).where(and(eq(deposits.playerWallet, wallet),
    sql`${deposits.payload}->'basePurchaseV1'->'request'->>'idempotencyKey' = ${key}`)))[0];
}
export async function getBasePurchase(db: DbOrTx, wallet: string, key: string, now = new Date(), kind?: BasePurchaseRequest['kind']): Promise<BasePurchaseStatus> {
  return db.transaction(async tx => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    const row = await lookup(tx, wallet, key);
    return BasePurchaseStatusSchema.parse({ version: 1, wallet, idempotencyKey: key, enabled: basePurchaseEnabled(row ? originalBasePurchase(row)?.request.kind : kind),
      serverNow: now.toISOString(), purchase: row ? await state(tx, row) : null });
  });
}
async function assertNotCancelled(tx: DbOrTx, wallet: string, key: string): Promise<void> {
  const [closed] = await tx.select({ key: basePurchaseCancellations.idempotencyKey }).from(basePurchaseCancellations)
    .where(and(eq(basePurchaseCancellations.wallet, wallet), eq(basePurchaseCancellations.idempotencyKey, key)));
  if (closed) throw new HttpError(409, 'this unquoted purchase request was cancelled', 'BASE_PURCHASE_CANCELLED');
}
/** This acknowledgement closes only an unquoted key. The shared player lock
 * prevents delayed preparation/POST from minting a quote after cancellation. */
export async function cancelUnquotedBasePurchase(db: DbOrTx, wallet: string, key: string): Promise<BasePurchaseCancellation> {
  return db.transaction(async tx => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    const row = await lookup(tx, wallet, key);
    if (!row) await tx.insert(basePurchaseCancellations).values({ wallet, idempotencyKey: key }).onConflictDoNothing();
    return BasePurchaseCancellationSchema.parse({ version: 1, wallet, idempotencyKey: key,
      cancelled: !row, purchase: row ? await state(tx, row) : null });
  });
}
export async function quoteBasePurchase(
  db: Db, wallet: string, input: BasePurchaseRequest, network: BasePurchaseNetwork | undefined, now = new Date(),
  prepare?: (baseId: string) => Promise<DepositStableAuthorityContext>,
): Promise<BasePurchaseStatus> {
  const request = BasePurchaseRequestSchema.parse(input);
  // Read before any present-day authority. The writer takes the same lock again
  // after preparation, so two requests cannot mint different references.
  const prior = await getBasePurchase(db, wallet, request.idempotencyKey, now, request.kind);
  if (prior.purchase) {
    if (JSON.stringify(prior.purchase.quote.request) !== JSON.stringify(request)) throw new HttpError(409, 'original purchase request differs', 'BASE_PURCHASE_MISMATCH');
    return prior;
  }
  await assertNotCancelled(db, wallet, request.idempotencyKey);
  if (!basePurchaseEnabled(request.kind)) throw new HttpError(503, 'new base purchases are paused', 'BASE_PURCHASE_DISABLED');
  if (!network) throw new HttpError(503, 'payment network is unavailable', 'BASE_PURCHASE_RAIL_UNAVAILABLE');
  BasePurchaseNetworkSchema.parse(network);
  const context = prepare ? await prepare(request.baseId) : undefined;
  return db.transaction(async tx => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    const existing = await getBasePurchase(tx, wallet, request.idempotencyKey, now, request.kind);
    if (existing.purchase) {
      if (JSON.stringify(existing.purchase.quote.request) !== JSON.stringify(request)) throw new HttpError(409, 'original purchase request differs', 'BASE_PURCHASE_MISMATCH');
      return existing;
    }
    await assertNotCancelled(tx, wallet, request.idempotencyKey);
    if (!basePurchaseEnabled(request.kind)) throw new HttpError(503, 'new base purchases are paused', 'BASE_PURCHASE_DISABLED');
    await createDepositIntent(tx as unknown as Db, wallet, request.kind,
      { baseId: request.baseId, ...(request.kind === 'mine' ? { buildingId: request.buildingId } : {}) }, now, context, { request, network });
    return getBasePurchase(tx, wallet, request.idempotencyKey, now, request.kind);
  });
}

/** Read legacy and versioned account indexes, including lookup-table destinations. */
function paymentInstructions(tx: unknown) {
  const value = tx as { transaction: { message: { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[];
    compiledInstructions?: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }>;
    instructions?: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
  } }; meta?: { loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } } };
  const message = value.transaction.message;
  const keys = [...(message.staticAccountKeys ?? message.accountKeys ?? []), ...(value.meta?.loadedAddresses?.writable ?? []),
    ...(value.meta?.loadedAddresses?.readonly ?? [])].map(k => k.toBase58());
  const instructions = message.compiledInstructions?.map(i => ({ programIdIndex: i.programIdIndex, accounts: i.accountKeyIndexes, data: Buffer.from(i.data) }))
    ?? message.instructions?.map(i => ({ ...i, data: Buffer.from(bs58.decode(i.data)) })) ?? [];
  return { keys, instructions };
}
/** Exact public buy_sink proof; builder retains its original exported helper. */
export function matchesBasePurchaseBuilderTransaction(tx: unknown, quote: BasePurchaseQuote, observedLamports = BigInt(quote.amountLamports)): boolean {
  if (quote.rail.mode !== 'buy_sink' && quote.rail.mode !== 'warzone_split') return false;
  try {
    const { keys, instructions } = paymentInstructions(tx);
    if (keys[0] !== quote.wallet) return false;
    const expected = [quote.rail.configPda, quote.wallet, quote.rail.treasuryLiquidity, quote.rail.treasuryDev,
      quote.rail.treasuryOps, quote.reference, quote.rail.systemProgram];
    return instructions.some(i => keys[i.programIdIndex] === quote.rail.coreProgram && i.accounts.length === expected.length
      && i.accounts.every((index, n) => keys[index] === expected[n]) && i.data.length === 17
      && i.data.subarray(0, 8).equals(createHash('sha256').update('global:buy_sink').digest().subarray(0, 8))
      && i.data[8] === quote.rail.sinkKind && i.data.readBigUInt64LE(9) === observedLamports);
  } catch { return false; }
}
/** Referenced direct payments are money evidence even if the split leg is missing. */
export function basePurchaseWarzoneDirectLamports(tx: unknown, quote: BasePurchaseQuote): bigint[] {
  if (quote.rail.mode !== 'warzone_split') return [];
  try {
    const { keys, instructions } = paymentInstructions(tx); const rail = quote.rail;
    if (keys[0] !== quote.wallet) return [];
    return instructions.filter(i => keys[i.programIdIndex] === rail.systemProgram && i.accounts.length === 3
      && keys[i.accounts[0]!] === quote.wallet && keys[i.accounts[1]!] === rail.destination && keys[i.accounts[2]!] === quote.reference
      && i.data.length === 12 && i.data.readUInt32LE(0) === 2 && i.data.readBigUInt64LE(4) > 0n)
      .map(i => i.data.readBigUInt64LE(4));
  } catch { return []; }
}
/** ONE transaction, exactly one frozen direct payment and one buy_sink. The
 * reference is an extra readonly account on the System transfer. Duplicate
 * payments are ambiguous evidence, never reported as the single quoted total. */
export function matchesBasePurchaseWarzoneTransaction(tx: unknown, quote: BasePurchaseQuote, splitLamports: bigint): boolean {
  if (quote.rail.mode !== 'warzone_split' || splitLamports !== BigInt(quote.rail.splitLamports)
    || !matchesBasePurchaseBuilderTransaction(tx, quote, splitLamports)) return false;
  try {
    const direct = basePurchaseWarzoneDirectLamports(tx, quote);
    const { keys, instructions } = paymentInstructions(tx);
    const discriminator = createHash('sha256').update('global:buy_sink').digest().subarray(0, 8);
    return direct.length === 1 && direct[0] === BigInt(quote.rail.directLamports)
      && instructions.filter(i => keys[i.programIdIndex] === quote.rail.coreProgram && i.data.subarray(0, 8).equals(discriminator)).length === 1;
  } catch { return false; }
}
