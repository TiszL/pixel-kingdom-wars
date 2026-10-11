/** Immutable custody only. Retaining ordinal1 proves neither finalized setup
 * nor permission to relay/pay; separate admission must establish those facts. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {MiningTaxClaimPreparation} from '@shardkeep/shared/miningTaxClaimsApi';
import {verifyMiningClaimSignedWire} from '@shardkeep/chain/mining-claim-wire';
import type {DbOrTx} from '../db/client';
import {getMiningTaxClaimPreparationRecord,MiningTaxClaimPreparationStoreError} from './taxClaimPreparationStore';
type Code='INVALID_INPUT'|'NOT_FOUND'|'INVALID_WIRE'|'SOURCE_CONFLICT'|'SIGNED_CONFLICT';
export class MiningTaxClaimSignedStoreError extends Error{constructor(readonly code:Code){super(`Mining tax signed custody refused: ${code}`);this.name='MiningTaxClaimSignedStoreError';}}
function fail(code:Code):never{throw new MiningTaxClaimSignedStoreError(code);}
const wallet=z.string().min(32).max(44).refine(v=>{try{const p=new PublicKey(v);return p.toBase58()===v&&!p.equals(PublicKey.default)&&PublicKey.isOnCurve(p.toBytes());}catch{return false;}});
const keySchema=z.object({wallet,idempotencyKey:z.uuid().refine(v=>v===v.toLowerCase())}).strict();
export interface MiningTaxClaimSignedKey{wallet:string;idempotencyKey:string}
export interface MiningTaxClaimSignedInput extends MiningTaxClaimSignedKey{signedTransaction:Uint8Array}
export interface MiningTaxClaimSignedWire extends MiningTaxClaimSignedKey{
 claimId:string;ordinal:number;kind:MiningTaxClaimPreparation['transactions'][number]['kind'];signature:string;signedTransactionHex:string;
 wireSha256:string;messageSha256:string;acceptedAt:string;currentSigningAuthorized:false;relayAuthorized:false;settlementAuthorized:false;
}
export interface MiningTaxClaimSigned{preparation:MiningTaxClaimPreparation;wires:MiningTaxClaimSignedWire[]}
function own(value:unknown,names:readonly string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==names.length||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!names.includes(k)))fail('INVALID_INPUT');}
function key(value:unknown):MiningTaxClaimSignedKey{own(value,['wallet','idempotencyKey']);const p=keySchema.safeParse(value);if(!p.success)fail('INVALID_INPUT');return p.data;}
async function preparation(db:DbOrTx,k:MiningTaxClaimSignedKey){
 try{return (await getMiningTaxClaimPreparationRecord(db,k))?.artifact??null;}catch(e){if(e instanceof MiningTaxClaimPreparationStoreError)fail('SOURCE_CONFLICT');throw e;}
}
function verify(p:MiningTaxClaimPreparation,bytes:Uint8Array,ordinal:number,code:Code){
 const t=p.transactions[ordinal];if(!t||t.ordinal!==ordinal)fail(code);
 try{const v=verifyMiningClaimSignedWire({intentBytes:Buffer.from(t.messageHex,'hex'),signedTransaction:bytes,wallet:new PublicKey(p.wallet)});if(v.messageSha256!==t.messageSha256)fail(code);return v;}catch{fail(code);}
}
type Row={wallet:string;idempotency_key:string;claim_id:string;ordinal:number;wire_hex:string;signature_hex:string;wire_sha256:string;message_sha256:string;accepted_at:string};
/** Original evidence is revalidated independently of today's provider, tuning,
 * flags or expiry. SQL byte hashes alone never authenticate an Ed25519 signature. */
export async function getMiningTaxClaimSigned(db:DbOrTx,input:MiningTaxClaimSignedKey):Promise<MiningTaxClaimSigned|null>{
 const k=key(input),p=await preparation(db,k);if(!p)return null;
 const rows=await db.execute<Row>(sql`select wallet,idempotency_key,claim_id,ordinal,encode(signed_transaction,'hex') wire_hex,encode(signature,'hex') signature_hex,wire_sha256,message_sha256,to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') accepted_at from mining_tax_claim_signed_wires where wallet=${k.wallet} and idempotency_key=${k.idempotencyKey} order by ordinal limit 3`);
 if(rows.length>p.transactions.length)fail('SOURCE_CONFLICT');const seen=new Set<number>();
 const wires=rows.map(r=>{
  if(r.wallet!==k.wallet||r.idempotency_key!==k.idempotencyKey||r.claim_id!==p.claimId||!Number.isInteger(r.ordinal)||r.ordinal<0||r.ordinal>=p.transactions.length||seen.has(r.ordinal)
   ||typeof r.wire_hex!=='string'||r.wire_hex.length<132||r.wire_hex.length>2464||!/^(?:[0-9a-f]{2})+$/.test(r.wire_hex))fail('SOURCE_CONFLICT');seen.add(r.ordinal);
  const bytes=Buffer.from(r.wire_hex,'hex'),v=verify(p,bytes,r.ordinal,'SOURCE_CONFLICT');
  if(v.wireSha256!==r.wire_sha256||v.messageSha256!==r.message_sha256||bytes.subarray(1,65).toString('hex')!==r.signature_hex||typeof r.accepted_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(r.accepted_at)||!Number.isFinite(Date.parse(r.accepted_at)))fail('SOURCE_CONFLICT');
  return {...k,claimId:p.claimId,ordinal:r.ordinal,kind:p.transactions[r.ordinal]!.kind,signature:v.signature,signedTransactionHex:r.wire_hex,wireSha256:v.wireSha256,messageSha256:v.messageSha256,acceptedAt:r.accepted_at,currentSigningAuthorized:false as const,relayAuthorized:false as const,settlementAuthorized:false as const};
 });return {preparation:p,wires};
}
/** Store the exact externally signed original packet before any separate relay.
 * No claim/setup completion, replacement, archival or balance change occurs. */
export async function acceptMiningTaxClaimSigned(db:DbOrTx,input:MiningTaxClaimSignedInput):Promise<MiningTaxClaimSignedWire>{
 own(input,['wallet','idempotencyKey','signedTransaction']);const k=key({wallet:input.wallet,idempotencyKey:input.idempotencyKey});
 if(!(input.signedTransaction instanceof Uint8Array)||input.signedTransaction.length<66||input.signedTransaction.length>1232)fail('INVALID_INPUT');
 const bytes=Uint8Array.from(input.signedTransaction),hex=Buffer.from(bytes).toString('hex'); // Own bytes before the first await.
 const p=await preparation(db,k);if(!p)fail('NOT_FOUND');
 const matches=p.transactions.filter(t=>t.messageHex===Buffer.from(bytes.subarray(65)).toString('hex'));if(matches.length!==1)fail('INVALID_WIRE');
 const ordinal=matches[0]!.ordinal,verified=verify(p,bytes,ordinal,'INVALID_WIRE');
 const old=(await getMiningTaxClaimSigned(db,k))?.wires.find(w=>w.ordinal===ordinal);
 if(old){if(old.signedTransactionHex!==hex)fail('SIGNED_CONFLICT');return old;}
 try{await db.execute(sql`insert into mining_tax_claim_signed_wires(claim_id,signed_transaction) values(${p.claimId},${Buffer.from(bytes)}) on conflict(claim_id,ordinal) do nothing`);}
 catch(e){if(((e as {cause?:{code?:string}}).cause?.code??(e as {code?:string}).code)==='23505')fail('SIGNED_CONFLICT');throw e;}
 const saved=(await getMiningTaxClaimSigned(db,k))?.wires.find(w=>w.ordinal===ordinal);
 if(!saved||saved.wireSha256!==verified.wireSha256||saved.signedTransactionHex!==hex)fail('SIGNED_CONFLICT');return saved;
}
