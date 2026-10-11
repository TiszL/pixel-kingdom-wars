/** Revalidate original wallet-funded Gems at evaluation-time finality. No deposit
 * status, new credit, useful-use threshold, or claim of historical finality time. */
import { createHash } from 'node:crypto';
import { verifyAsync } from '@noble/ed25519';
import { isCanonicalSolanaSignature, keepAta } from '@shardkeep/chain';
import { GEMS, TOKEN } from '@shardkeep/shared';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { SPL_TOKEN_PROGRAM_ID } from '../money/reserves';
import { attributeGemsFlowEvidence, attributePostZeroGemsFlowEvidence, type PostZeroGemsFlowInput, type PostZeroGemsFlowAttribution, type GemsFlowAttribution, type GemsAttributedLot } from './gemsFlowAttribution';
import { readGemsFlowEvidence, type GemsFlowEvidence, type GemsFlowFact } from './gemsFlowEvidence';
type Code = 'INVALID_INPUT' | 'SOURCE_UNAVAILABLE' | 'DUPLICATE_ORIGIN' | 'IDENTITY' | 'CHAIN_UNAVAILABLE' | 'CHAIN_MISMATCH' | 'ORIGIN_TIME_UNAVAILABLE' | 'TOO_LARGE' | 'BUSY';
export class GemsFinalizedOriginError extends Error {
 constructor(readonly code: Code) { super(`Finalized Gems origin refused: ${code}`); this.name = 'GemsFinalizedOriginError'; }
}
function fail(code: Code): never { throw new GemsFinalizedOriginError(code); }
function need(value: unknown, code: Code): asserts value { if (!value) fail(code); }
// Operational resource ceilings, never credit thresholds or game rewards.
const MAX_ORIGINS = 128, MAX_CHAIN_BYTES = 16_777_216, MAX_TX_BYTES = 1_048_576, MAX_KEYS = 256, MAX_RPC_MS = 10_000, U64 = (1n << 64n) - 1n;
const key = z.string().min(32).max(44).refine(value => { if (value.length < 32 || value.length > 44) return false; try { return new PublicKey(value).toBase58() === value; } catch { return false; } });
const signature = z.string().min(64).max(88).refine(value => value.length <= 88 && isCanonicalSolanaSignature(value));
const amount = z.string().max(20).regex(/^[1-9][0-9]*$/);
const metadataSchema = z.object({ wallet: key, depositId: z.uuid(), txSignature: signature, keepBaseUnits: amount, keep: amount, gems: amount, rate: z.literal(GEMS.gemsPerKeep), source: z.literal('wallet'), mint: key, destination: key }).strict();
const trustSchema = z.object({ cluster: z.enum(['devnet', 'mainnet-beta']), expectedGenesisHash: key, keepMint: key, reserveOwner: key, reserveAta: key }).strict();
export interface GemsFinalizedOriginReader {
 getGenesisHash(): Promise<string>;
 getSlot(commitment: 'finalized'): Promise<number>;
 getTransaction(signature: string, options: { commitment: 'finalized'; maxSupportedTransactionVersion: 0 }): Promise<VersionedTransactionResponse | null>;
}
export interface GemsFinalizedOriginWiring {
 trust: z.infer<typeof trustSchema>;
 /** Application owns provider selection/independence and abortable transport.
  * Mainnet requires its two already-validated independent economy providers. */
 connect(signal: AbortSignal): readonly GemsFinalizedOriginReader[];
}
interface Original {
 fact: GemsFlowFact; metadata: z.infer<typeof metadataSchema>;
}
export interface FinalizedGemsOrigin {
 originEventId: string; originTransactionId: string; depositId: string; signature: string;
 mint: string; reserveAta: string; rawKeepBaseUnits: string; convertedGems: string;
 slot: number; blockTime: number; finalizedContextSlots: number[]; messageSha256: string;
 trust: 'trusted-finalized-rpc'; finalityScope: 'finalized-at-evaluation'; historicalFinalizationTime: 'unavailable';
}
export interface FinalizedGemsOrigins {
 version: 1; sourcePolicyVersion: 1; wallet: string; day: string; birthEventId: string; sourceDigest: string;
 chainIdentity: z.infer<typeof trustSchema>; origins: FinalizedGemsOrigin[]; attribution: GemsFlowAttribution;
 usefulChainCreditAuthorized: false; allocationReady: false; publicationAuthorized: false;
}
function micros(value: string): bigint {
 need(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value), 'SOURCE_UNAVAILABLE');
 const whole = Date.parse(`${value.slice(0, 19)}Z`); need(Number.isFinite(whole), 'SOURCE_UNAVAILABLE');
 return BigInt(whole) * 1000n + BigInt(value.slice(20, 26));
}
function slot(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function rawAmount(value: unknown): bigint {
 need(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'CHAIN_MISMATCH'); const result = BigInt(value); need(result <= U64, 'CHAIN_MISMATCH'); return result;
}
/** Count decoded RPC metadata before parsing amounts or serializing any message. */
function metadataBytes(value: unknown): number {
 const pending = [value], seen = new WeakSet<object>(); let count = 0, bytes = 0;
 while (pending.length) {
  const current = pending.pop(); need(++count <= 100_000, 'TOO_LARGE');
  if (typeof current === 'string') { need(current.length <= MAX_TX_BYTES, 'TOO_LARGE'); bytes += Buffer.byteLength(current); }
  else if (current && typeof current === 'object') {
   need(!seen.has(current), 'CHAIN_MISMATCH'); seen.add(current);
   if (Array.isArray(current)) { need(current.length <= 10_000, 'TOO_LARGE'); pending.push(...current); }
   else { const keys = Object.keys(current); need(keys.length <= 128, 'TOO_LARGE'); for (const k of keys) { bytes += Buffer.byteLength(k); pending.push((current as Record<string, unknown>)[k]); } }
  } else if (typeof current === 'number') { need(Number.isFinite(current), 'CHAIN_MISMATCH'); bytes += 24; }
  else if (current === null || current === undefined || typeof current === 'boolean') bytes += 5;
  else fail('CHAIN_MISMATCH');
  need(bytes <= MAX_TX_BYTES && pending.length <= 100_000, 'TOO_LARGE');
 }
 return bytes;
}
type OriginFlow = Pick<GemsFlowEvidence,'wallet'|'day'|'coverageStartedAt'|'facts'>;
function originals(evidence: OriginFlow): Original[] {
 const result: Original[] = [];
 for (const fact of evidence.facts) if (fact.classification === 'wallet-conversion-ledger') {
  const source = fact.source as { transaction: { id: string; key: string; type: string; metadata: unknown } };
  const parsed = metadataSchema.safeParse(source.transaction.metadata); need(parsed.success, 'SOURCE_UNAVAILABLE'); const m = parsed.data;
  need(m.wallet === evidence.wallet && source.transaction.id === fact.transactionId && source.transaction.type === 'gems.buy' && source.transaction.key === `deposit:${m.depositId}:credit`, 'SOURCE_UNAVAILABLE');
  const raw = BigInt(m.keepBaseUnits), keep = BigInt(m.keep), gems = BigInt(m.gems);
  need(raw <= U64 && raw / (10n ** BigInt(TOKEN.decimals)) === keep && keep * BigInt(m.rate) === gems, 'SOURCE_UNAVAILABLE');
  result.push({ fact, metadata: m }); need(result.length <= MAX_ORIGINS, 'TOO_LARGE');
 }
 return result;
}
/** Query only immutable original credit observations. The exact transaction is
 * required to be post-marker, so prior unrecorded reuse cannot be accepted.
 * Whole transaction visibility matches B3q; future duplicates do not rewrite a
 * prior cutoff. Row/decoded-byte/time limits refuse rather than truncate. */
async function checkClaims(db: Db, evidence: OriginFlow, records: Original[], trust: z.infer<typeof trustSchema>): Promise<void> {
 try { await db.transaction(async tx => {
  await tx.execute(sql`set local statement_timeout='2000ms'`);
  await tx.execute(sql`lock table economy_chain_identity,mining_gems_flow_events in share mode nowait`);
  const identity = await tx.execute<{ cluster: string; keep_mint: string; gems_reserve_owner: string | null; gems_reserve_ata: string | null }>(sql`select cluster,keep_mint,gems_reserve_owner,gems_reserve_ata from economy_chain_identity where singleton`);
  need(identity.length === 1 && identity[0]!.cluster === trust.cluster && identity[0]!.keep_mint === trust.keepMint && identity[0]!.gems_reserve_owner === trust.reserveOwner && identity[0]!.gems_reserve_ata === trust.reserveAta, 'IDENTITY');
  if (!records.length) return;
  const signatures = records.map(r => r.metadata.txSignature), deposits = records.map(r => r.metadata.depositId);
  need(new Set(signatures).size === signatures.length && new Set(deposits).size === deposits.length, 'DUPLICATE_ORIGIN');
  const end = new Date(Date.parse(`${evidence.day}T00:00:00Z`) + 86_400_000).toISOString();
  const rows = await tx.execute<{ id: string; wallet: string; transaction_id: string | null; source_id: string; signature: string; deposit_id: string; bytes: string }>(sql`
   select e.id::text,e.wallet,e.transaction_id,e.source_id,e.after_state->'transaction'->'metadata'->>'txSignature' as signature,
    e.after_state->'transaction'->'metadata'->>'depositId' as deposit_id,octet_length(e.after_state::text)::text as bytes
   from mining_gems_flow_events e where e.source_table='ledger_entries' and e.operation='INSERT'
    and e.after_state->'account'->>'kind'='player_gems' and e.after_state->'transaction'->>'type'='gems.buy'
    and (e.after_state->'transaction'->'metadata'->>'txSignature'in (${sql.join(signatures.map(value => sql`${value}`), sql`, `)}) or e.after_state->'transaction'->'metadata'->>'depositId'in (${sql.join(deposits.map(value => sql`${value}`), sql`, `)}))
    and e.observed_at<${end}::timestamptz and not exists(select 1 from mining_gems_flow_events later where later.transaction_marker=e.transaction_marker and later.observed_at>=${end}::timestamptz)
   order by e.id limit 129`);
  need(rows.length <= MAX_ORIGINS && rows.reduce((n, row) => n + BigInt(row.bytes), 0n) <= 16_777_216n, 'TOO_LARGE');
  need(rows.length === records.length, 'DUPLICATE_ORIGIN');
  for (const original of records) {
   const matches = rows.filter(r => r.signature === original.metadata.txSignature || r.deposit_id === original.metadata.depositId);
   need(matches.length === 1, 'DUPLICATE_ORIGIN'); const row = matches[0]!;
   need(row.id === original.fact.id && row.wallet === evidence.wallet && row.transaction_id === original.fact.transactionId && row.source_id === original.fact.sourceId && row.signature === original.metadata.txSignature && row.deposit_id === original.metadata.depositId, 'DUPLICATE_ORIGIN');
  }
 }); } catch (error) {
  const e = error as { code?: string; cause?: { code?: string } }; if (e.code === '55P03' || e.cause?.code === '55P03') fail('BUSY'); if (e.code === '57014' || e.cause?.code === '57014') fail('TOO_LARGE'); throw error;
 }
}
async function verifyTransaction(tx: VersionedTransactionResponse | null, original: Original, evidence: OriginFlow, trust: z.infer<typeof trustSchema>) {
 need(tx && tx.meta, 'CHAIN_UNAVAILABLE'); const m = original.metadata, meta = tx.meta;
 const bytes = metadataBytes(meta); need(meta.err === null && slot(tx.slot), 'CHAIN_MISMATCH');
 need(slot(tx.blockTime), 'ORIGIN_TIME_UNAVAILABLE'); const blockMicros = BigInt(tx.blockTime) * 1_000_000n;
 const endMicros = BigInt(Date.parse(`${evidence.day}T00:00:00Z`) + 86_400_000) * 1000n;
 need(blockMicros >= micros(evidence.coverageStartedAt) && blockMicros <= micros(original.fact.observedAt) && blockMicros < endMicros, 'ORIGIN_TIME_UNAVAILABLE');
 const message = tx.transaction?.message; need(message && (message.version === 'legacy' || message.version === 0) && (tx.version === undefined || tx.version === message.version), 'CHAIN_MISMATCH');
 need(Array.isArray(message.staticAccountKeys) && message.staticAccountKeys.length > 0 && message.staticAccountKeys.length <= MAX_KEYS && Array.isArray(message.compiledInstructions) && message.compiledInstructions.length <= MAX_KEYS, 'TOO_LARGE');
 const loaded = meta.loadedAddresses;
 need(!loaded || (Array.isArray(loaded.writable) && Array.isArray(loaded.readonly) && loaded.writable.length + loaded.readonly.length <= MAX_KEYS), 'CHAIN_MISMATCH');
 if (message.version === 'legacy') need(!loaded || loaded.writable.length + loaded.readonly.length === 0, 'CHAIN_MISMATCH');
 else need(loaded && loaded.writable.length === message.addressTableLookups.reduce((n, row) => n + row.writableIndexes.length, 0) && loaded.readonly.length === message.addressTableLookups.reduce((n, row) => n + row.readonlyIndexes.length, 0), 'CHAIN_MISMATCH');
 need(message.header && Number.isInteger(message.header.numRequiredSignatures) && message.header.numRequiredSignatures > 0 && message.header.numRequiredSignatures <= message.staticAccountKeys.length, 'CHAIN_MISMATCH');
 const accountKeys = message.getAccountKeys({ accountKeysFromLookups: loaded ?? null }); need(accountKeys.length <= MAX_KEYS, 'TOO_LARGE');
 const keys = Array.from({ length: accountKeys.length }, (_, i) => accountKeys.get(i)!.toBase58());
 need(new Set(keys).size === keys.length && keys[0] === evidence.wallet && message.isAccountSigner(0), 'CHAIN_MISMATCH');
 need(Array.isArray(tx.transaction.signatures) && tx.transaction.signatures.length === message.header.numRequiredSignatures && tx.transaction.signatures.length > 0 && tx.transaction.signatures.length <= MAX_KEYS && tx.transaction.signatures[0] === m.txSignature && tx.transaction.signatures.every(value => signature.safeParse(value).success), 'CHAIN_MISMATCH');
 for (const ix of message.compiledInstructions) need(ix.data instanceof Uint8Array && ix.data.length <= 1232 && ix.accountKeyIndexes.length <= MAX_KEYS, 'TOO_LARGE');
 const serialized = Buffer.from(message.serialize()); need(serialized.length > 0 && serialized.length + 1 + tx.transaction.signatures.length * 64 <= 1232, 'TOO_LARGE');
 need(await verifyAsync(bs58.decode(m.txSignature), serialized, new PublicKey(evidence.wallet).toBytes()), 'CHAIN_MISMATCH');
 const index = keys.indexOf(trust.reserveAta); need(index >= 0 && m.destination === trust.reserveAta && m.mint === trust.keepMint, 'CHAIN_MISMATCH');
 // Same reserve balance-delta authority as keepDepositAmount. This exact-credit
 // revalidation does not search references or impose a new source-ATA policy.
 const balance = (rows: typeof meta.preTokenBalances) => {
  need(Array.isArray(rows) && rows.length <= MAX_KEYS, 'CHAIN_MISMATCH'); const matching = rows.filter(r => r.accountIndex === index); need(matching.length === 1, 'CHAIN_MISMATCH'); const row = matching[0]!;
  need(row.mint === trust.keepMint && row.owner === trust.reserveOwner && row.programId === SPL_TOKEN_PROGRAM_ID.toBase58() && row.uiTokenAmount?.decimals === TOKEN.decimals, 'CHAIN_MISMATCH'); return rawAmount(row.uiTokenAmount.amount);
 };
 const delta = balance(meta.postTokenBalances) - balance(meta.preTokenBalances); need(delta > 0n && delta.toString() === m.keepBaseUnits, 'CHAIN_MISMATCH');
 return { slot: tx.slot, blockTime: tx.blockTime, messageSha256: createHash('sha256').update(serialized).digest('hex'), bytes: bytes + serialized.length };
}
export type PostZeroFinalizedGemsOrigins = Omit<FinalizedGemsOrigins,'version'|'sourcePolicyVersion'|'birthEventId'|'attribution'> & {
 version:2;sourcePolicyVersion:2;sourceKind:'committed-zero-inventory-fifo';openingId:string;attribution:PostZeroGemsFlowAttribution;
};
async function readOrigins(db:Db,evidence:OriginFlow,records:Original[],trust:z.infer<typeof trustSchema>,wiring:GemsFinalizedOriginWiring):Promise<FinalizedGemsOrigin[]> {
  await checkClaims(db, evidence, records, trust);
  const origins: FinalizedGemsOrigin[] = [], controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   await Promise.race([
    (async () => {
     if (!records.length) return;
     const readers = [...wiring.connect(controller.signal)]; need(readers.length >= (trust.cluster === 'mainnet-beta' ? 2 : 1) && readers.length <= 2 && new Set(readers).size === readers.length, 'IDENTITY');
     let totalBytes = 0;
     for (const [provider, rpc] of readers.entries()) {
      need(!controller.signal.aborted, 'CHAIN_UNAVAILABLE'); need(await rpc.getGenesisHash() === trust.expectedGenesisHash, 'IDENTITY');
      const proof: Awaited<ReturnType<typeof verifyTransaction>>[] = [];
      for (const record of records) {
       need(!controller.signal.aborted, 'CHAIN_UNAVAILABLE'); const tx = await rpc.getTransaction(record.metadata.txSignature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
       const result = await verifyTransaction(tx, record, evidence, trust); totalBytes += result.bytes; need(totalBytes <= MAX_CHAIN_BYTES, 'TOO_LARGE'); proof.push(result);
      }
      const contextSlot = await rpc.getSlot('finalized'); need(slot(contextSlot), 'CHAIN_MISMATCH'); need(await rpc.getGenesisHash() === trust.expectedGenesisHash, 'IDENTITY');
      for (const [i, record] of records.entries()) {
       const result = proof[i]!; need(contextSlot >= result.slot, 'CHAIN_MISMATCH');
       if (provider === 0) origins.push({ originEventId: record.fact.id, originTransactionId: record.fact.transactionId!, depositId: record.metadata.depositId, signature: record.metadata.txSignature, mint: trust.keepMint, reserveAta: trust.reserveAta, rawKeepBaseUnits: record.metadata.keepBaseUnits, convertedGems: record.metadata.gems, slot: result.slot, blockTime: result.blockTime, finalizedContextSlots: [contextSlot], messageSha256: result.messageSha256, trust: 'trusted-finalized-rpc', finalityScope: 'finalized-at-evaluation', historicalFinalizationTime: 'unavailable' });
       else { const prior = origins[i]!; need(prior.slot === result.slot && prior.blockTime === result.blockTime && prior.messageSha256 === result.messageSha256, 'CHAIN_MISMATCH'); prior.finalizedContextSlots.push(contextSlot); }
      }
     }
    })(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GemsFinalizedOriginError('CHAIN_UNAVAILABLE')); }, MAX_RPC_MS); }),
   ]);
  } catch (error) { if (error instanceof GemsFinalizedOriginError) throw error; fail('CHAIN_UNAVAILABLE'); }
  finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  return origins;
}
export function createGemsFinalizedOriginReader(db: Db, wiring: GemsFinalizedOriginWiring) {
 const parsed = trustSchema.safeParse(wiring.trust); need(parsed.success, 'IDENTITY'); const trust = Object.freeze(parsed.data);
 need(keepAta(new PublicKey(trust.reserveOwner), new PublicKey(trust.keepMint), true).toBase58() === trust.reserveAta, 'IDENTITY');
 return async function read(input: unknown): Promise<FinalizedGemsOrigins> {
  // B3q validates the only request fields, original birth, closed cutoff and
  // copied source completeness before any chain work. FIFO is evaluated once.
  const evidence = await readGemsFlowEvidence(db, input), attribution = attributeGemsFlowEvidence(evidence), records = originals(evidence);
  const origins = await readOrigins(db,evidence,records,trust,wiring);
  const verified = new Set(origins.map(o => `${o.originEventId}:${o.originTransactionId}`));
  const clear = (lot: GemsAttributedLot): GemsAttributedLot => lot.originClass === 'wallet-conversion-ledger' && verified.has(`${lot.originEventId}:${lot.originTransactionId}`) ? { ...lot, requiresDepositVerification: false } : lot;
  const bound: GemsFlowAttribution = { ...attribution, currentLots: attribution.currentLots.map(clear), debits: attribution.debits.map(d => ({ ...d, consumed: d.consumed.map(clear) })), refunds: attribution.refunds.map(r => ({ ...r, restored: r.restored.map(clear) })) };
  return { version: 1, sourcePolicyVersion: 1, wallet: evidence.wallet, day: evidence.day, birthEventId: evidence.birthEventId, sourceDigest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), chainIdentity: { ...trust }, origins, attribution: bound, usefulChainCreditAuthorized: false, allocationReady: false, publicationAuthorized: false };
 };
}

/** Explicit source adapter; only the private zero-opening reader authenticates
 * the complete post-boundary source before this unchanged finalized check. */
export function createPostZeroGemsFinalizedOriginReader(db:Db,wiring:GemsFinalizedOriginWiring) {
 const parsed=trustSchema.safeParse(wiring.trust);need(parsed.success,'IDENTITY');const trust=Object.freeze(parsed.data);
 need(keepAta(new PublicKey(trust.reserveOwner),new PublicKey(trust.keepMint),true).toBase58()===trust.reserveAta,'IDENTITY');
 return async(evidence:PostZeroGemsFlowInput,sourceDigest:string):Promise<PostZeroFinalizedGemsOrigins>=>{
  const attribution=attributePostZeroGemsFlowEvidence(evidence),records=originals(evidence);
  need(/^[0-9a-f]{64}$/.test(sourceDigest),'SOURCE_UNAVAILABLE');
  const origins=await readOrigins(db,evidence,records,trust,wiring);
  return replayPostZeroGemsFinalizedOrigins({version:2,sourcePolicyVersion:2,sourceKind:evidence.sourceKind,openingId:evidence.openingId,wallet:evidence.wallet,day:evidence.day,sourceDigest,chainIdentity:{...trust},origins,attribution:clearPostZero(attribution,origins),usefulChainCreditAuthorized:false,allocationReady:false,publicationAuthorized:false},evidence,sourceDigest);
 };
}
function clearPostZero(attribution:PostZeroGemsFlowAttribution,origins:FinalizedGemsOrigin[]):PostZeroGemsFlowAttribution {
 const verified=new Set(origins.map(o=>`${o.originEventId}:${o.originTransactionId}`));
 const clear=(lot:GemsAttributedLot):GemsAttributedLot=>lot.originClass==='wallet-conversion-ledger'&&verified.has(`${lot.originEventId}:${lot.originTransactionId}`)?{...lot,requiresDepositVerification:false}:lot;
 return {...attribution,currentLots:attribution.currentLots.map(clear),debits:attribution.debits.map(d=>({...d,consumed:d.consumed.map(clear)})),refunds:attribution.refunds.map(r=>({...r,restored:r.restored.map(clear)}))};
}
const proofSchema=z.object({originEventId:z.string().regex(/^[1-9][0-9]*$/),originTransactionId:z.uuid(),depositId:z.uuid(),signature,mint:key,reserveAta:key,rawKeepBaseUnits:amount,convertedGems:amount,slot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),blockTime:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),finalizedContextSlots:z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).min(1).max(2),messageSha256:z.string().regex(/^[0-9a-f]{64}$/),trust:z.literal('trusted-finalized-rpc'),finalityScope:z.literal('finalized-at-evaluation'),historicalFinalizationTime:z.literal('unavailable')}).strict();
const postZeroSchema=z.object({version:z.literal(2),sourcePolicyVersion:z.literal(2),sourceKind:z.literal('committed-zero-inventory-fifo'),openingId:z.uuid(),wallet:key,day:z.string(),sourceDigest:z.string().regex(/^[0-9a-f]{64}$/),chainIdentity:trustSchema,origins:z.array(proofSchema).max(MAX_ORIGINS),attribution:z.unknown(),usefulChainCreditAuthorized:z.literal(false),allocationReady:z.literal(false),publicationAuthorized:z.literal(false)}).strict();
/** Retained source replay validates exact bindings; the live reader is still
 * the authority for finalized provider observations and source completeness. */
function canonicalPostZero(v:unknown):string{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonicalPostZero).join(',')+']';const r=v as Record<string,unknown>;return '{'+Object.keys(r).sort().map(k=>JSON.stringify(k)+':'+canonicalPostZero(r[k])).join(',')+'}';}
export function replayPostZeroGemsFinalizedOrigins(value:unknown,evidence:PostZeroGemsFlowInput,sourceDigest:string):PostZeroFinalizedGemsOrigins {
 const parsed=postZeroSchema.safeParse(value);need(parsed.success,'SOURCE_UNAVAILABLE');const p=parsed.data,trust=p.chainIdentity,records=originals(evidence);
 need(p.wallet===evidence.wallet&&p.day===evidence.day&&p.openingId===evidence.openingId&&p.sourceDigest===sourceDigest,'SOURCE_UNAVAILABLE');
 need(keepAta(new PublicKey(trust.reserveOwner),new PublicKey(trust.keepMint),true).toBase58()===trust.reserveAta,'IDENTITY');
 need(p.origins.length===records.length,'SOURCE_UNAVAILABLE');
 for(const [i,r] of records.entries()){
  const o=p.origins[i]!,m=r.metadata,t=BigInt(o.blockTime)*1000000n,end=BigInt(Date.parse(`${evidence.day}T00:00:00Z`)+86400000)*1000n;
  need(o.originEventId===r.fact.id&&o.originTransactionId===r.fact.transactionId&&o.depositId===m.depositId&&o.signature===m.txSignature&&o.mint===trust.keepMint&&o.mint===m.mint&&o.reserveAta===trust.reserveAta&&o.reserveAta===m.destination&&o.rawKeepBaseUnits===m.keepBaseUnits&&o.convertedGems===m.gems,'SOURCE_UNAVAILABLE');
  need(o.finalizedContextSlots.length>=(trust.cluster==='mainnet-beta'?2:1)&&o.finalizedContextSlots.every(s=>s>=o.slot)&&t>=micros(evidence.coverageStartedAt)&&t<=micros(r.fact.observedAt)&&t<end,'ORIGIN_TIME_UNAVAILABLE');
 }
 need(new Set(p.origins.map(o=>o.signature)).size===p.origins.length&&new Set(p.origins.map(o=>o.depositId)).size===p.origins.length,'DUPLICATE_ORIGIN');
 const attribution=clearPostZero(attributePostZeroGemsFlowEvidence(evidence),p.origins);
 need(canonicalPostZero(p.attribution)===canonicalPostZero(attribution),'SOURCE_UNAVAILABLE');
 return {...p,attribution};
}
