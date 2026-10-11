/** Immutable retention only. A buyer signature never grants delivery permission. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {verifyMiningClaimSignedWire} from '@shardkeep/chain/mining-claim-wire';
import type {DbOrTx} from '../db/client';
import {getRealmSalePreparation,RealmSalePreparationStoreError,type RealmSalePreparation} from './realmSalePreparationStore';
type Code='INVALID_INPUT'|'NOT_FOUND'|'INVALID_WIRE'|'SOURCE_CONFLICT'|'SIGNED_CONFLICT';
export class RealmSaleSignedStoreError extends Error{constructor(readonly code:Code){super(`Realm sale signed store refused: ${code}`);this.name='RealmSaleSignedStoreError';}}
function fail(code:Code):never{throw new RealmSaleSignedStoreError(code);}
const wallet=z.string().min(32).max(44).refine(v=>{if(v.length<32||v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const keySchema=z.object({wallet,idempotencyKey:z.uuid().refine(v=>v===v.toLowerCase())}).strict();
export interface RealmSaleSignedKey{wallet:string;idempotencyKey:string}
export interface RealmSaleSignedInput extends RealmSaleSignedKey{signedTransaction:Uint8Array}
export interface RealmSaleSignedWire extends RealmSaleSignedKey{
 saleId:string;signature:string;signedTransactionHex:string;wireSha256:string;messageSha256:string;acceptedAt:string;
 currentSigningAuthorized:false;relayAuthorized:false;
}
export interface RealmSaleSigned{preparation:RealmSalePreparation;wire:RealmSaleSignedWire|null}
function key(value:unknown):RealmSaleSignedKey{const p=keySchema.safeParse(value);if(!p.success)fail('INVALID_INPUT');return p.data;}
async function preparation(db:DbOrTx,k:RealmSaleSignedKey){
 try{return await getRealmSalePreparation(db,k);}catch(e){if(e instanceof RealmSalePreparationStoreError)fail('SOURCE_CONFLICT');throw e;}
}
function verify(p:RealmSalePreparation,bytes:Uint8Array,code:Code){
 try{return verifyMiningClaimSignedWire({intentBytes:Buffer.from(p.quote.messageHex,'hex'),signedTransaction:bytes,wallet:new PublicKey(p.wallet)});}catch{fail(code);}
}
type Row={wallet:string;idempotency_key:string;sale_id:string;wire_hex:string;signature_hex:string;wire_sha256:string;message_sha256:string;accepted_at:string};
/** Reads are independent of current pause, provider availability or quote expiry.
 * SQL alone does not prove Ed25519: every returned packet is reverified here. */
export async function getRealmSaleSigned(db:DbOrTx,input:RealmSaleSignedKey):Promise<RealmSaleSigned|null>{
 const k=key(input),p=await preparation(db,k);if(!p)return null;
 const rows=await db.execute<Row>(sql`select wallet,idempotency_key,sale_id,encode(signed_transaction,'hex') wire_hex,encode(signature,'hex') signature_hex,wire_sha256,message_sha256,to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') accepted_at from seeker_realm_sale_signed_wires where wallet=${k.wallet} and idempotency_key=${k.idempotencyKey} limit 2`);
 if(rows.length>1)fail('SOURCE_CONFLICT');const r=rows[0];if(!r)return {preparation:p,wire:null};
 if(r.wallet!==k.wallet||r.idempotency_key!==k.idempotencyKey||r.sale_id!==p.saleId||typeof r.wire_hex!=='string'||r.wire_hex.length<132||r.wire_hex.length>2464||!/^(?:[0-9a-f]{2})+$/.test(r.wire_hex))fail('SOURCE_CONFLICT');
 const bytes=Buffer.from(r.wire_hex,'hex'),v=verify(p,bytes,'SOURCE_CONFLICT');
 if(v.wireSha256!==r.wire_sha256||v.messageSha256!==r.message_sha256||v.messageSha256!==p.quote.messageSha256||bytes.subarray(1,65).toString('hex')!==r.signature_hex||typeof r.accepted_at!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(r.accepted_at))fail('SOURCE_CONFLICT');
 return {preparation:p,wire:{...k,saleId:p.saleId,signature:v.signature,signedTransactionHex:r.wire_hex,wireSha256:v.wireSha256,messageSha256:v.messageSha256,acceptedAt:r.accepted_at,currentSigningAuthorized:false,relayAuthorized:false}};
}
/** Persist before any separate delivery path. There is no replacement or release. */
export async function acceptRealmSaleSigned(db:DbOrTx,input:RealmSaleSignedInput):Promise<RealmSaleSignedWire>{
 if(!input||typeof input!=='object'||Object.keys(input).length!==3||!Object.keys(input).every(k=>['wallet','idempotencyKey','signedTransaction'].includes(k)))fail('INVALID_INPUT');
 const k=key({wallet:input.wallet,idempotencyKey:input.idempotencyKey});
 if(!(input.signedTransaction instanceof Uint8Array)||input.signedTransaction.length<66||input.signedTransaction.length>1232)fail('INVALID_INPUT');
 const bytes=Uint8Array.from(input.signedTransaction); // Own all caller bytes before the first await.
 const p=await preparation(db,k);if(!p)fail('NOT_FOUND');const verified=verify(p,bytes,'INVALID_WIRE'),hex=Buffer.from(bytes).toString('hex');
 const old=(await getRealmSaleSigned(db,k))?.wire;if(old){if(old.signedTransactionHex!==hex)fail('SIGNED_CONFLICT');return old;}
 try{await db.execute(sql`insert into seeker_realm_sale_signed_wires(wallet,idempotency_key,signed_transaction) values(${k.wallet},${k.idempotencyKey},${Buffer.from(bytes)}) on conflict(wallet,idempotency_key) do nothing`);}
 catch(e){if(((e as {cause?:{code?:string}}).cause?.code??(e as {code?:string}).code)==='23505')fail('SIGNED_CONFLICT');throw e;}
 const saved=(await getRealmSaleSigned(db,k))?.wire;
 if(!saved||saved.wireSha256!==verified.wireSha256||saved.signedTransactionHex!==hex)fail('SIGNED_CONFLICT');return saved;
}
