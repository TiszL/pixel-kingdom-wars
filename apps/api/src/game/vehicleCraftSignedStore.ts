/** Retain one exact original wallet wire before any future separate transport. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {verifyVehicleRequestSignedWire} from '@shardkeep/chain/vehicle-issuance-wire';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {copyVehicleIssuerRequest,type VehicleIssuerRequest} from '../vehiclePolicyIssuerJournal';
import {assertVehicleRequestSource,createVehicleCraftPreparation,type VehicleCraftPreparationState} from './vehicleCraftPreparation';
export interface VehicleCraftSignedReceipt{
 readonly version:1;readonly wallet:string;readonly idempotencyKey:string;readonly reservationId:string;readonly signature:string;
 readonly signedTransactionHex:string;readonly wireSha256:string;readonly messageSha256:string;readonly acceptedAt:string;
 readonly broadcastAuthorized:false;readonly paymentAuthorized:false;readonly activationAuthorized:false;readonly reservationReleaseAuthorized:false;
}
const fail=(suffix:string):never=>{throw new HttpError(503,'Vehicle request wire held','VEHICLE_REQUEST_SIGNED_'+suffix);};
function verify(p:VehicleCraftPreparationState,bytes:Uint8Array){const saved=p.preparation;if(!saved)fail('PREPARATION');return verifyVehicleRequestSignedWire({original:saved!.issuerReceipt.original,policyAuthority:saved!.issuerReceipt.publicKey,policySignature:saved!.issuerReceipt.signature,recentBlockhash:saved!.quote.blockhash,intentBytes:Buffer.from(saved!.quote.messageHex,'hex'),signedTransaction:bytes});}
async function read(db:DbOrTx,p:VehicleCraftPreparationState):Promise<VehicleCraftSignedReceipt|null>{
 await assertVehicleRequestSource(db);
 const [row]=await db.execute<{wire_hex:string;signature_hex:string;wire_sha256:string;message_sha256:string;accepted_at:string}>(sql`select encode(signed_transaction,'hex') wire_hex,encode(signature,'hex') signature_hex,wire_sha256,message_sha256,to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') accepted_at from public.vehicle_request_signed_wires where reservation_id=${p.reservationId}::uuid`);
 if(!row)return null;if(!/^(?:[0-9a-f]{2}){66,1232}$/.test(row.wire_hex))fail('SOURCE');const bytes=Buffer.from(row.wire_hex,'hex'),proof=verify(p,bytes);
 if(row.wire_sha256!==proof.wireSha256||row.message_sha256!==proof.messageSha256||bytes.subarray(1,65).toString('hex')!==row.signature_hex)fail('SOURCE');
 return {version:1,wallet:p.wallet,idempotencyKey:p.idempotencyKey,reservationId:p.reservationId,signature:proof.signature,signedTransactionHex:row.wire_hex,wireSha256:proof.wireSha256,messageSha256:proof.messageSha256,acceptedAt:z.iso.datetime({precision:6}).parse(row.accepted_at),broadcastAuthorized:false,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false};
}
export function createVehicleCraftSignedStore(db:Db){
 if('rollback'in db)fail('TOP_LEVEL');const preparations=createVehicleCraftPreparation(db);
 async function load(input:VehicleIssuerRequest){const request=copyVehicleIssuerRequest(input),p=await preparations.get(request);if(!p?.preparation)fail('PREPARATION');return p!;}
 async function get(input:VehicleIssuerRequest){return read(db,await load(input));}
 async function accept(input:VehicleIssuerRequest,signedTransaction:Uint8Array):Promise<VehicleCraftSignedReceipt>{
  const request=copyVehicleIssuerRequest(input);if(!(signedTransaction instanceof Uint8Array)||signedTransaction.length<66||signedTransaction.length>1232)fail('INPUT');
  const bytes=Uint8Array.from(signedTransaction),hex=Buffer.from(bytes).toString('hex'),p=await load(request);verify(p,bytes);
  return db.transaction(async tx=>{
   await assertVehicleRequestSource(tx);await tx.execute(sql`select id from public.vehicle_craft_material_reservations where id=${p.reservationId}::uuid for update`);
   const old=await read(tx,p);if(old){if(old.signedTransactionHex!==hex)fail('CONFLICT');return old;}
   await tx.execute(sql`insert into public.vehicle_request_signed_wires(reservation_id,signed_transaction) values(${p.reservationId}::uuid,${Buffer.from(bytes)})`);
   const saved=await read(tx,p);if(!saved||saved.signedTransactionHex!==hex)fail('SOURCE');return saved!;
  }); // Promise resolves after COMMIT; no relay capability exists here.
 }
 return Object.freeze({get,accept});
}
