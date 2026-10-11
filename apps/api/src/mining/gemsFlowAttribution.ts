/** Source policy 1: FIFO provenance only. Useful use and chain finality are separate gates. */
import { GEMS } from '@shardkeep/shared';
import { z } from 'zod';
import type { DbOrTx } from '../db/client';
import { readGemsFlowEvidence, type GemsFlowEvidence, type GemsFlowFact } from './gemsFlowEvidence';
type Code = 'SOURCE_UNAVAILABLE' | 'REFUND_UNAVAILABLE' | 'BALANCE_MISMATCH' | 'TOO_LARGE';
export class GemsFlowAttributionError extends Error {
 constructor(readonly code: Code) { super(`Gems attribution refused: ${code}`); this.name = 'GemsFlowAttributionError'; }
}
function fail(code: Code): never { throw new GemsFlowAttributionError(code); }
// Resource/SQL storage ceilings, never game rewards, costs or eligibility thresholds.
const MAX_FACTS = 10_000, MAX_BYTES = 16_777_216, MAX_SEGMENTS = 100_000, MAX_LEDGER_AMOUNT = 9_223_372_036_854_775_807n;
const unsigned = z.string().max(20).regex(/^(0|[1-9][0-9]*)$/), positive = z.string().max(20).regex(/^[1-9][0-9]*$/), integer = z.string().max(21).regex(/^-?(0|[1-9][0-9]*)$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const receiptSchema = z.array(z.object({ id: positive, accountId: z.uuid(), delta: integer, kind: z.string(), currency: z.string(), wallet: z.string().nullable(), baseId: z.uuid().nullable() }).strict()).max(32);
const sourceSchema = z.object({
 entry: z.object({ id: positive, txnId: z.uuid(), accountId: z.uuid(), delta: integer }).strict(),
 account: z.object({ id: z.uuid(), kind: z.literal('player_gems'), currency: z.literal('GEMS'), wallet: z.string(), baseId: z.null() }).strict(),
 transaction: z.object({ id: z.uuid(), key: z.string(), type: z.string(), metadata: z.record(z.string(), z.unknown()), createdAt: z.string() }).strict(),
}).strict();
const factSchema = z.object({ id: positive, observedAt: timestamp, effectiveObservedAt: timestamp, transactionMarker: positive, sourceTable: z.enum(['accounts', 'ledger_entries', 'ledger_transactions']), sourceId: z.string(), operation: z.enum(['INSERT', 'UPDATE', 'DELETE']), accountId: z.uuid().nullable(), transactionId: z.uuid().nullable(), classification: z.string(), source: z.unknown(), before: z.null(), receipt: z.unknown() }).strict();
type OriginClass = 'grant' | 'custodial-conversion' | 'wallet-conversion-ledger';
export interface GemsAttributedLot {
 lotId: string; originEventId: string; originTransactionId: string; originClass: OriginClass;
 originatedAt: string; availableEventId: string; availableAt: string; amount: string; requiresDepositVerification: boolean;
}
export interface GemsAttributedDebit {
 eventId: string; transactionId: string; transactionType: string; effectiveObservedAt: string; amount: string;
 excludedGemsToShards: boolean; consumed: GemsAttributedLot[]; refundedByEventId: string | null;
 candidateConvertedGems: { custodial: string; walletLedger: string }; pendingIrreversibleUseEvidence: true;
}
export interface GemsFlowAttribution {
 version: 1; sourcePolicyVersion: 1; attributionPolicy: 'fifo-v1'; wallet: string; day: string; birthEventId: string;
 currentLots: GemsAttributedLot[]; debits: GemsAttributedDebit[];
 refunds: Array<{ eventId: string; transactionId: string; originalDebitEventId: string; amount: string; restored: GemsAttributedLot[] }>;
 balanceGems: string; usefulChainCreditAuthorized: false; allocationReady: false; publicationAuthorized: false;
}
/** Internal policy2 source adapter. The authenticated existing zero account is
 * the opening state, never a fabricated newly created account. */
export interface PostZeroGemsFlowInput {
 sourceKind:'committed-zero-inventory-fifo';openingId:string;accountId:string;
 wallet:string;day:string;coverageStartedAt:string;facts:GemsFlowFact[];netGems:string;
}
export type PostZeroGemsFlowAttribution=Omit<GemsFlowAttribution,'version'|'sourcePolicyVersion'|'birthEventId'>&{
 version:2;sourcePolicyVersion:2;sourceKind:'committed-zero-inventory-fifo';openingId:string;
};
/** Check traversal/decoded-byte bounds without serializing an unbounded caller value. */
function bounded(value: unknown): void {
 const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }], seen = new WeakSet<object>(); let bytes = 0, nodes = 0;
 while (stack.length) {
  const item = stack.pop()!; if (++nodes > 1_000_000 || item.depth > 32) return fail('TOO_LARGE'); const v = item.value;
  if (typeof v === 'string') { if (v.length > 1_048_576) return fail('TOO_LARGE'); bytes += Buffer.byteLength(v, 'utf8'); }
  else if (v !== null && typeof v === 'object') {
   if (seen.has(v)) return fail('SOURCE_UNAVAILABLE'); seen.add(v);
   if (Array.isArray(v)) { if (v.length > MAX_FACTS) return fail('TOO_LARGE'); for (const child of v) stack.push({ value: child, depth: item.depth + 1 }); }
   else for (const key in v) { if (!Object.hasOwn(v, key)) continue; bytes += Buffer.byteLength(key, 'utf8'); stack.push({ value: (v as Record<string, unknown>)[key], depth: item.depth + 1 }); }
  } else if (typeof v === 'number') { if (!Number.isFinite(v)) return fail('SOURCE_UNAVAILABLE'); bytes += 24; }
  else if (typeof v === 'boolean' || v === null) bytes += 5;
  else return fail('SOURCE_UNAVAILABLE');
  if (bytes > MAX_BYTES || stack.length > 1_000_000) return fail('TOO_LARGE');
 }
}
function compare(a: Pick<GemsFlowFact, 'effectiveObservedAt' | 'transactionMarker' | 'id'>, b: Pick<GemsFlowFact, 'effectiveObservedAt' | 'transactionMarker' | 'id'>): number {
 if (a.effectiveObservedAt !== b.effectiveObservedAt) return a.effectiveObservedAt < b.effectiveObservedAt ? -1 : 1;
 if (a.transactionMarker !== b.transactionMarker) return BigInt(a.transactionMarker) < BigInt(b.transactionMarker) ? -1 : 1;
 return BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
}
function magnitude(value: string, code: Code): bigint { const amount = BigInt(value); if (amount < -MAX_LEDGER_AMOUNT || amount > MAX_LEDGER_AMOUNT) return fail(code); return amount; }
function posting(f: GemsFlowFact, wallet: string) {
 const code = f.classification === 'sink-refund' ? 'REFUND_UNAVAILABLE' : 'SOURCE_UNAVAILABLE';
 const source = sourceSchema.safeParse(f.source), receipt = receiptSchema.safeParse(f.receipt); if (!source.success || !receipt.success) return fail(code);
 const s = source.data, r = receipt.data;
 if (s.entry.id !== f.sourceId || s.entry.txnId !== f.transactionId || s.entry.accountId !== f.accountId || s.account.id !== f.accountId || s.account.wallet !== wallet || s.transaction.id !== f.transactionId) return fail(code);
 if (new Set(r.map(e => e.id)).size !== r.length || new Set(r.map(e => e.accountId)).size !== r.length) return fail(code);
 const player = r.find(e => e.id === s.entry.id);
 if (!player || player.accountId !== f.accountId || player.delta !== s.entry.delta || player.kind !== 'player_gems' || player.currency !== 'GEMS' || player.wallet !== wallet || player.baseId !== null) return fail(code);
 const sums = new Map<string, bigint>(); for (const e of r) sums.set(e.currency, (sums.get(e.currency) ?? 0n) + magnitude(e.delta, code));
 if ([...sums.values()].some(sum => sum !== 0n)) return fail(code);
 const delta = magnitude(s.entry.delta, code); if (delta === 0n) return fail(code);
 const has = (kind: string, currency: string, amount: bigint, owner: string | null = null, baseId: string | null = null) => r.some(e => e.kind === kind && e.currency === currency && BigInt(e.delta) === amount && e.wallet === owner && e.baseId === baseId);
 const m = s.transaction.metadata, t = s.transaction;
 if (['grant', 'custodial-conversion', 'wallet-conversion-ledger'].includes(f.classification)) {
  if (delta <= 0n || r.length !== 4 || m['wallet'] !== wallet || m['gems'] !== delta.toString() || !has('gems_mint', 'GEMS', -delta) || !has('emission_pool', 'KEEP', delta)) return fail(code);
  if (f.classification === 'grant') {
   const reason = m['reason'], ref = m['ref']; const key = reason === 'welcome' || reason === 'dev' ? `grant:${reason}:${wallet}` : reason === 'task' && typeof ref === 'string' && ref.length ? `grant:task:${ref}:${wallet}` : reason === 'refund' && typeof ref === 'string' && ref.length ? `grant:refund:${ref}` : null;
   if (t.type !== 'gems.grant' || t.key !== key || !has('gems_reward_budget', 'KEEP', -delta)) return fail(code);
  } else {
   if (m['keep'] !== delta.toString() || m['rate'] !== GEMS.gemsPerKeep) return fail(code);
   if (f.classification === 'custodial-conversion') {
    if (t.type !== 'gems.from_keep' || m['source'] !== 'ledger' || !t.key.startsWith(`gems:from-keep:${wallet}:`) || t.key.length <= `gems:from-keep:${wallet}:`.length || !has('player_keep', 'KEEP', -delta, wallet)) return fail(code);
   } else if (t.type !== 'gems.buy' || m['source'] !== 'wallet' || !z.uuid().safeParse(m['depositId']).success || typeof m['txSignature'] !== 'string' || t.key !== `deposit:${m['depositId']}:credit` || !has('onchain_inflow', 'KEEP', -delta)) return fail(code);
  }
 } else if (f.classification === 'excluded-gems-to-shards') {
  const amount = -delta, base = m['baseId'];
  if (delta >= 0n || r.length !== 4 || t.type !== 'gems.to_shards' || !t.key.startsWith(`gems:to-shards:${wallet}:`) || m['wallet'] !== wallet || m['gems'] !== amount.toString() || m['shards'] !== amount.toString() || m['rate'] !== GEMS.shardsPerGem || !has('gems_sink', 'GEMS', amount) || !has('shard_genesis', 'SHARDS', -amount) || !(base === undefined ? has('player_shards', 'SHARDS', amount, wallet) : typeof base === 'string' && has('base_shards', 'SHARDS', amount, null, base))) return fail(code);
 } else if (f.classification === 'system-spend') {
  if (delta >= 0n || r.length !== 2 || m['wallet'] !== wallet || m['currency'] !== 'GEMS' || !has('gems_sink', 'GEMS', -delta)) return fail(code);
 } else if (f.classification === 'sink-refund') {
  if (delta <= 0n || r.length !== 2 || !has('gems_sink', 'GEMS', -delta)) return fail(code);
 } else return fail('SOURCE_UNAVAILABLE');
 return { source: s, receipt: r, delta };
}
export function attributeGemsFlowEvidence(evidence: GemsFlowEvidence): GemsFlowAttribution {
 if (!evidence || !Array.isArray(evidence.facts) || evidence.facts.length > MAX_FACTS) return fail('TOO_LARGE'); bounded(evidence);
 if (evidence.version !== 1 || evidence.sourcePolicyVersion !== 1 || evidence.transactionVisibility !== 'whole-db-transaction-at-last-observation' || evidence.hasSourceMutations !== false || evidence.hasUnclassified !== false || evidence.allocationReady !== false || evidence.publicationAuthorized !== false || evidence.usefulChainCreditAuthorized !== false || !positive.safeParse(evidence.birthEventId).success || !unsigned.safeParse(evidence.netGems).success || !timestamp.safeParse(evidence.coverageStartedAt).success) return fail('SOURCE_UNAVAILABLE');
 return {version:1,sourcePolicyVersion:1,attributionPolicy:'fifo-v1',wallet:evidence.wallet,day:evidence.day,birthEventId:evidence.birthEventId,...attributeFacts(evidence)};
}
export function attributePostZeroGemsFlowEvidence(evidence:PostZeroGemsFlowInput):PostZeroGemsFlowAttribution{
 bounded({sourceKind:evidence.sourceKind,openingId:evidence.openingId,accountId:evidence.accountId,wallet:evidence.wallet,day:evidence.day,coverageStartedAt:evidence.coverageStartedAt,facts:evidence.facts,netGems:evidence.netGems});if(evidence.sourceKind!=='committed-zero-inventory-fifo'||!z.uuid().safeParse(evidence.openingId).success||!z.uuid().safeParse(evidence.accountId).success||!unsigned.safeParse(evidence.netGems).success||!timestamp.safeParse(evidence.coverageStartedAt).success||!Array.isArray(evidence.facts)||evidence.facts.length>MAX_FACTS)fail('SOURCE_UNAVAILABLE');
 return {version:2,sourcePolicyVersion:2,sourceKind:evidence.sourceKind,openingId:evidence.openingId,attributionPolicy:'fifo-v1',wallet:evidence.wallet,day:evidence.day,...attributeFacts(evidence,evidence.accountId)};
}
function attributeFacts(evidence:Pick<GemsFlowEvidence,'wallet'|'day'|'coverageStartedAt'|'facts'|'netGems'>,openingAccount?:string){
 const dayStart = Date.parse(`${evidence.day}T00:00:00Z`); if (!Number.isFinite(dayStart) || new Date(dayStart).toISOString().slice(0, 10) !== evidence.day) return fail('SOURCE_UNAVAILABLE');
 const end = new Date(dayStart + 86_400_000).toISOString().replace('.000Z', '.000000Z');
 type ActiveLot = { fact: GemsAttributedLot; remaining: bigint };
 const queue: ActiveLot[] = [], debits: GemsAttributedDebit[] = [], refunds: GemsFlowAttribution['refunds'] = [];
 const original = new Map<string, { fact: GemsFlowFact; posting: ReturnType<typeof posting>; debit: GemsAttributedDebit }>();
 const ids = new Set<string>(), ledgerIds = new Set<string>(), transactions = new Set<string>(), accounts = new Set<string>(openingAccount?[openingAccount]:[]), groupTimes = new Map<string, string>();
 let head = 0, balance = 0n, segments = 0, previous: GemsFlowFact | undefined;
 const addLot = (lot: GemsAttributedLot) => { if (++segments > MAX_SEGMENTS) return fail('TOO_LARGE'); queue.push({ fact: lot, remaining: BigInt(lot.amount) }); };
 for (const raw of evidence.facts) {
  const parsed = factSchema.safeParse(raw); if (!parsed.success) return fail('SOURCE_UNAVAILABLE'); const f = parsed.data as GemsFlowFact;
  if (f.operation !== 'INSERT' || ids.has(f.id) || (previous && compare(previous, f) >= 0) || f.observedAt < evidence.coverageStartedAt || f.observedAt > f.effectiveObservedAt || f.effectiveObservedAt >= end || (groupTimes.has(f.transactionMarker) && groupTimes.get(f.transactionMarker) !== f.effectiveObservedAt)) return fail('SOURCE_UNAVAILABLE');
  ids.add(f.id); groupTimes.set(f.transactionMarker, f.effectiveObservedAt); previous = f;
  if (f.classification === 'account-created') {
   const account = z.object({ id: z.uuid(), kind: z.literal('player_gems'), currency: z.literal('GEMS'), owner_wallet: z.literal(evidence.wallet), base_id: z.null(), initialBalance: z.literal('0') }).strict().safeParse(f.source);
   if (!account.success || f.sourceTable !== 'accounts' || account.data.id !== f.accountId || f.sourceId !== f.accountId || f.transactionId !== null || accounts.size !== 0 || !Array.isArray(f.receipt) || f.receipt.length !== 0) return fail('SOURCE_UNAVAILABLE'); accounts.add(account.data.id); continue;
  }
  if (f.sourceTable !== 'ledger_entries' || !f.accountId || !accounts.has(f.accountId) || !f.transactionId || ledgerIds.has(f.sourceId) || transactions.has(f.transactionId)) return fail('SOURCE_UNAVAILABLE');
  ledgerIds.add(f.sourceId); transactions.add(f.transactionId); const p = posting(f, evidence.wallet);
  if (['grant', 'custodial-conversion', 'wallet-conversion-ledger'].includes(f.classification)) {
   addLot({ lotId: `${f.id}:0`, originEventId: f.id, originTransactionId: f.transactionId, originClass: f.classification as OriginClass, originatedAt: f.effectiveObservedAt, availableEventId: f.id, availableAt: f.effectiveObservedAt, amount: p.delta.toString(), requiresDepositVerification: f.classification === 'wallet-conversion-ledger' }); balance += p.delta;
  } else if (f.classification === 'system-spend' || f.classification === 'excluded-gems-to-shards') {
   let remaining = -p.delta; if (remaining > balance) return fail('BALANCE_MISMATCH'); const consumed: GemsAttributedLot[] = []; let custodial = 0n, walletLedger = 0n;
   while (remaining > 0n) {
    while (queue[head]?.remaining === 0n) head++; const lot = queue[head]; if (!lot) return fail('BALANCE_MISMATCH');
    const amount = lot.remaining < remaining ? lot.remaining : remaining; if (++segments > MAX_SEGMENTS) return fail('TOO_LARGE'); consumed.push({ ...lot.fact, amount: amount.toString() }); lot.remaining -= amount; remaining -= amount;
    if (lot.fact.originClass === 'custodial-conversion') custodial += amount; if (lot.fact.originClass === 'wallet-conversion-ledger') walletLedger += amount;
   }
   balance += p.delta; const excluded = f.classification === 'excluded-gems-to-shards';
   const debit: GemsAttributedDebit = { eventId: f.id, transactionId: f.transactionId, transactionType: p.source.transaction.type, effectiveObservedAt: f.effectiveObservedAt, amount: (-p.delta).toString(), excludedGemsToShards: excluded, consumed, refundedByEventId: null, candidateConvertedGems: { custodial: excluded ? '0' : custodial.toString(), walletLedger: excluded ? '0' : walletLedger.toString() }, pendingIrreversibleUseEvidence: true };
   debits.push(debit); original.set(f.transactionId, { fact: f, posting: p, debit });
  } else if (f.classification === 'sink-refund') {
   const t = p.source.transaction, m = t.metadata, ref = m['refundOf'], prior = typeof ref === 'string' ? original.get(ref) : undefined;
   if (!prior || prior.debit.refundedByEventId !== null || prior.debit.excludedGemsToShards) return fail('REFUND_UNAVAILABLE');
   const ot = prior.posting.source.transaction, om = ot.metadata, raid = m['raidId'], buff = m['buff'];
   if (t.type !== 'raid.buffs.system_refund' || ot.type !== 'raid.buffs' || !z.uuid().safeParse(raid).success || typeof buff !== 'string' || buff.length === 0 || buff.length > 128 || m['wallet'] !== evidence.wallet || m['currency'] !== 'GEMS' || m['originalKey'] !== ot.key || om['raidId'] !== raid || om['buff'] !== buff || om['live'] !== true || ot.key !== `raid:${raid}:live-buff:${buff}` || t.key !== `raid:${raid}:live-buff-refund:${buff}` || p.delta !== -prior.posting.delta || prior.posting.receipt.length !== 2 || !p.receipt.every(e => prior.posting.receipt.some(o => o.accountId === e.accountId && o.kind === e.kind && o.currency === e.currency && o.wallet === e.wallet && o.baseId === e.baseId && BigInt(o.delta) === -BigInt(e.delta)))) return fail('REFUND_UNAVAILABLE');
   const restored = prior.debit.consumed.map((lot, index) => ({ ...lot, lotId: `${f.id}:${index}`, availableEventId: f.id, availableAt: f.effectiveObservedAt }));
   for (const lot of restored) addLot(lot); balance += p.delta; prior.debit.refundedByEventId = f.id; prior.debit.candidateConvertedGems = { custodial: '0', walletLedger: '0' };
   refunds.push({ eventId: f.id, transactionId: f.transactionId, originalDebitEventId: prior.fact.id, amount: p.delta.toString(), restored });
  } else return fail('SOURCE_UNAVAILABLE');
  if (balance < 0n || balance > MAX_LEDGER_AMOUNT) return fail('BALANCE_MISMATCH');
 }
 if (balance !== BigInt(evidence.netGems!)) return fail('BALANCE_MISMATCH');
 return { currentLots: queue.filter(l => l.remaining > 0n).map(l => ({ ...l.fact, amount: l.remaining.toString() })), debits, refunds, balanceGems: balance.toString(), usefulChainCreditAuthorized: false as const, allocationReady: false as const, publicationAuthorized: false as const };
}
export async function readGemsFlowAttribution(db: DbOrTx, input: unknown): Promise<GemsFlowAttribution> {
 return attributeGemsFlowEvidence(await readGemsFlowEvidence(db, input));
}
