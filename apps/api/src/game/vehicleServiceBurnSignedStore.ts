/** D-153.141: commit exact externally signed consent before any separate relay.
 * Original-actor retention survives admission pause and base transfer. No transport.
 * Service consumption and the future global burn fence are separate capabilities. */
import {verifyMiningClaimSignedWire} from '@shardkeep/chain/mining-claim-wire';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {createVehicleServiceBurnPreparations,type VehicleServiceBurnPreparation} from './vehicleServiceBurnPreparations';
export interface VehicleServiceBurnSignedReceipt {
 intentId:string;wallet:string;signature:string;signedTransactionHex:string;
 wireSha256:string;messageSha256:string;acceptedAt:string;
 relayAuthorized:false;broadcastAuthorized:false;serviceAuthorized:false;reservationReleaseAuthorized:false;
}
const fail=(code:string):never=>{throw new HttpError(503,code,code);};
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_service_signed_wires'::regclass) allowed`);if(!r?.allowed)fail('VEHICLE_SERVICE_SIGNED_OWNER');}
function verify(p:VehicleServiceBurnPreparation,bytes:Uint8Array,code:string){try{return verifyMiningClaimSignedWire({intentBytes:Buffer.from(p.messageHex,'hex'),signedTransaction:bytes,wallet:new PublicKey(p.wallet)});}catch{return fail(code);}}
async function read(db:DbOrTx,p:VehicleServiceBurnPreparation):Promise<VehicleServiceBurnSignedReceipt|null>{
 const [row]=await db.execute<{intent_id:string;wallet:string;wire_hex:string;signature_hex:string;wire_sha256:string;message_sha256:string;accepted_at:string}>(sql`select intent_id,wallet,encode(signed_transaction,'hex') wire_hex,encode(signature,'hex') signature_hex,wire_sha256,message_sha256,to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') accepted_at from public.vehicle_service_signed_wires where intent_id=${p.intentId}`);
 if(!row)return null;
 if(row.intent_id!==p.intentId||row.wallet!==p.wallet||typeof row.wire_hex!=='string'||row.wire_hex.length<132||row.wire_hex.length>2464||!/^(?:[0-9a-f]{2})+$/.test(row.wire_hex))fail('VEHICLE_SERVICE_SIGNED_SOURCE');
 const bytes=Buffer.from(row.wire_hex,'hex'),proof=verify(p,bytes,'VEHICLE_SERVICE_SIGNED_SOURCE');
 if(proof.wireSha256!==row.wire_sha256||proof.messageSha256!==p.messageSha256||proof.messageSha256!==row.message_sha256||bytes.subarray(1,65).toString('hex')!==row.signature_hex||typeof row.accepted_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.accepted_at))fail('VEHICLE_SERVICE_SIGNED_SOURCE');
 return {intentId:p.intentId,wallet:p.wallet,signature:proof.signature,signedTransactionHex:row.wire_hex,wireSha256:proof.wireSha256,messageSha256:proof.messageSha256,acceptedAt:row.accepted_at,relayAuthorized:false,broadcastAuthorized:false,serviceAuthorized:false,reservationReleaseAuthorized:false};
}
export function createVehicleServiceBurnSignedStore(db:Db){
 if('rollback'in db)fail('VEHICLE_SERVICE_SIGNED_TOP_LEVEL');const preparations=createVehicleServiceBurnPreparations(db);
 async function preparation(wallet:string,intentId:string){await owner(db);const p=await preparations.get(wallet,intentId);return p??fail('VEHICLE_SERVICE_SIGNED_PREPARATION');}
 async function get(wallet:string,intentId:string){const p=await preparation(wallet,intentId);return read(db,p);}
 async function accept(wallet:string,intentId:string,signedTransaction:Uint8Array):Promise<VehicleServiceBurnSignedReceipt>{
  if(!(signedTransaction instanceof Uint8Array)||signedTransaction.length<66||signedTransaction.length>1232)fail('VEHICLE_SERVICE_SIGNED_INPUT');
  const bytes=Uint8Array.from(signedTransaction),hex=Buffer.from(bytes).toString('hex'); // Copy before any await.
  const p=await preparation(wallet,intentId);verify(p,bytes,'VEHICLE_SERVICE_SIGNED_WIRE');
  return db.transaction(async tx=>{
   await tx.execute(sql`select id from public.vehicle_service_intents where id=${p.intentId} for update`);
   const saved=await read(tx,p);if(saved){if(saved.signedTransactionHex!==hex)fail('VEHICLE_SERVICE_SIGNED_CONFLICT');return saved;}
   await tx.execute(sql`insert into public.vehicle_service_signed_wires(intent_id,signed_transaction) values(${p.intentId},${Buffer.from(bytes)})`);
   const result=await read(tx,p);if(!result||result.signedTransactionHex!==hex)fail('VEHICLE_SERVICE_SIGNED_SOURCE');return result!;
  }); // Top-level transaction resolves only after COMMIT; relay is a separate capability.
 }
 return Object.freeze({get,accept});
}
