/** Retention and recovery only. A saved claimant signature never admits a send. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { verifyMiningClaimSignedWire } from '@shardkeep/chain/mining-claim-wire';
import type { DbOrTx } from '../db/client';
import { getMiningClaimPreparation,type MiningClaimPreparation } from './claimPreparationStore';
type Code='INVALID_INPUT'|'NOT_FOUND'|'INVALID_WIRE'|'SOURCE_CONFLICT'|'SIGNED_CONFLICT';
export class MiningClaimSignedStoreError extends Error{constructor(readonly code:Code){super(`Mining claim signed store refused: ${code}`);this.name='MiningClaimSignedStoreError';}}
function fail(code:Code):never{throw new MiningClaimSignedStoreError(code);}
const wallet=z.string().min(32).max(44).refine(v=>{if(v.length<32||v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const keySchema=z.object({wallet,claimId:z.uuid()}).strict();
export interface MiningClaimSignedKey{wallet:string;claimId:string}
export interface MiningClaimSignedInput extends MiningClaimSignedKey{signedTransaction:Uint8Array}
export interface MiningClaimSignedWire extends MiningClaimSignedKey{
 ordinal:number;kind:MiningClaimPreparation['transactions'][number]['kind'];signature:string;signedTransactionHex:string;
 wireSha256:string;messageSha256:string;acceptedAt:string;claimSubmissionAuthorized:false;
}
export interface MiningClaimSigned{preparation:MiningClaimPreparation;wires:MiningClaimSignedWire[]}
function key(value:unknown):MiningClaimSignedKey{const p=keySchema.safeParse(value);if(!p.success)fail('INVALID_INPUT');return p.data;}
async function preparation(db:DbOrTx,k:MiningClaimSignedKey):Promise<MiningClaimPreparation|null>{
 const [row]=await db.execute<{idempotency_key:string}>(sql`select idempotency_key from mining_claim_preparations where wallet=${k.wallet} and claim_id=${k.claimId}`);
 if(!row)return null;const p=await getMiningClaimPreparation(db,{wallet:k.wallet,idempotencyKey:row.idempotency_key});if(!p||p.claimId!==k.claimId)fail('SOURCE_CONFLICT');return p;
}
type WireRow={ordinal:number;wallet:string;wire_hex:string;signature_hex:string;wire_sha256:string;message_sha256:string;accepted_at:string};
function verify(p:MiningClaimPreparation,bytes:Uint8Array,ordinal:number,code:Code){
 const t=p.transactions[ordinal];if(!t)fail(code);
 try{return verifyMiningClaimSignedWire({intentBytes:Buffer.from(t.messageHex,'hex'),signedTransaction:bytes,wallet:new PublicKey(p.wallet),...(p.format?{format:p.format}:{})});}catch{fail(code);}
}
/** Queries only the authenticated wallet's immutable preparation and wire rows. */
export async function getMiningClaimSigned(db:DbOrTx,input:MiningClaimSignedKey):Promise<MiningClaimSigned|null>{
 const k=key(input),p=await preparation(db,k);if(!p)return null;
 const rows=await db.execute<WireRow>(sql`select ordinal,wallet,encode(signed_transaction,'hex') wire_hex,encode(signature,'hex') signature_hex,wire_sha256,message_sha256,to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') accepted_at from mining_claim_signed_wires where claim_id=${k.claimId} and wallet=${k.wallet} order by ordinal limit 3`);
 if(rows.length>p.transactions.length)fail('SOURCE_CONFLICT');
 const wires=rows.map(r=>{
  if(!Number.isInteger(r.ordinal)||r.ordinal<0||r.ordinal>=p.transactions.length||r.wallet!==k.wallet||typeof r.wire_hex!=='string'||r.wire_hex.length<132||r.wire_hex.length>2464||!/^(?:[0-9a-f]{2})+$/.test(r.wire_hex))fail('SOURCE_CONFLICT');
  const bytes=Buffer.from(r.wire_hex,'hex'),v=verify(p,bytes,r.ordinal,'SOURCE_CONFLICT');
  if(v.wireSha256!==r.wire_sha256||v.messageSha256!==r.message_sha256||bytes.subarray(1,65).toString('hex')!==r.signature_hex||typeof r.accepted_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(r.accepted_at))fail('SOURCE_CONFLICT');
  return {...k,ordinal:r.ordinal,kind:p.transactions[r.ordinal]!.kind,signature:v.signature,signedTransactionHex:r.wire_hex,wireSha256:v.wireSha256,messageSha256:v.messageSha256,acceptedAt:r.accepted_at,claimSubmissionAuthorized:false as const};
 });return {preparation:p,wires};
}
export async function acceptMiningClaimSigned(db:DbOrTx,input:MiningClaimSignedInput):Promise<MiningClaimSignedWire>{
 if(!input||typeof input!=='object'||Object.keys(input).length!==3||!Object.keys(input).every(k=>['wallet','claimId','signedTransaction'].includes(k)))fail('INVALID_INPUT');
 const k=key({wallet:input.wallet,claimId:input.claimId});
 if(!(input.signedTransaction instanceof Uint8Array)||input.signedTransaction.length<66||input.signedTransaction.length>1232)fail('INVALID_INPUT');
 const bytes=Uint8Array.from(input.signedTransaction); // Copy before the first await.
 const p=await preparation(db,k);if(!p)fail('NOT_FOUND');
 let ordinal=-1;for(let i=0;i<p.transactions.length;i++)if(Buffer.from(bytes.subarray(65)).toString('hex')===p.transactions[i]!.messageHex){if(ordinal!==-1)fail('SOURCE_CONFLICT');ordinal=i;}
 if(ordinal<0)fail('INVALID_WIRE');const verified=verify(p,bytes,ordinal,'INVALID_WIRE');
 const prior=await getMiningClaimSigned(db,k),old=prior?.wires.find(w=>w.ordinal===ordinal);
 if(old){if(old.signedTransactionHex!==Buffer.from(bytes).toString('hex'))fail('SIGNED_CONFLICT');return old;}
 try{await db.execute(sql`insert into mining_claim_signed_wires(claim_id,signed_transaction) values(${k.claimId},${Buffer.from(bytes)}) on conflict(claim_id,ordinal) do nothing`);}
 catch(e){if(((e as {cause?:{code?:string}}).cause?.code??(e as {code?:string}).code)==='23505')fail('SIGNED_CONFLICT');throw e;}
 const saved=(await getMiningClaimSigned(db,k))?.wires.find(w=>w.ordinal===ordinal);
 if(!saved||saved.wireSha256!==verified.wireSha256||saved.signedTransactionHex!==Buffer.from(bytes).toString('hex'))fail('SIGNED_CONFLICT');return saved;
}
