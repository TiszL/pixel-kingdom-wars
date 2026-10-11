/** Private original-wire delivery. No signer, replacement, scheduler, material
 * consumption, release or public mount. A committed dispatch is recovery-only. */
import bs58 from 'bs58';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {createVehicleIssuanceCurrent} from '@shardkeep/chain/vehicle-issuance-current';
import {createVehicleIssuanceRequestReceiptReader,verifyVehicleIssuanceRequestReceipt,type VehicleIssuanceRequestReceipt} from '@shardkeep/chain/vehicle-issuance-request-receipt';
import type {VehicleIssuanceQuote} from '@shardkeep/chain/vehicle-issuance-quote';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {copyVehicleIssuerRequest,type VehicleIssuerRequest} from '../vehiclePolicyIssuerJournal';
import {createVehicleCraftMaterials} from './vehicleCraftMaterials';
import {createVehicleCraftPreparation} from './vehicleCraftPreparation';
import {createVehicleCraftSignedStore,type VehicleCraftSignedReceipt} from './vehicleCraftSignedStore';
export interface VehicleCraftDeliveryDependencies{
 readonly enabled?:()=>boolean;
 readonly current?:Readonly<{connect:Parameters<typeof createVehicleIssuanceCurrent>[0];trust:Parameters<typeof createVehicleIssuanceCurrent>[1];deadlineMs?:number}>;
 readonly receipt?:Readonly<{connect:Parameters<typeof createVehicleIssuanceRequestReceiptReader>[0];trust:Parameters<typeof createVehicleIssuanceRequestReceiptReader>[1];deadlineMs?:number}>;
 readonly timeoutMs?:number;readonly monotonicNow?:()=>number;
}
export interface VehicleCraftDeliveryState{
 readonly version:1;readonly wallet:string;readonly idempotencyKey:string;readonly reservationId:string;readonly signature:string;
 readonly status:'held'|'unknown'|'submitted'|'finalized'|'reverted';
 readonly reason:null|'DISABLED'|'PROVIDER_UNAVAILABLE'|'PROOF_UNAVAILABLE'|'CURRENT_HELD'|'SEND_UNCERTAIN'|'ABORTED'|'BUSY';
 readonly dispatch:Readonly<{originalHash:string;messageSha256:string;wireSha256:string;recordedAt:string}>|null;
 readonly acknowledgement:Readonly<{recordedAt:string}>|null;
 readonly receipt:Readonly<{proof:VehicleIssuanceRequestReceipt;recordedAt:string}>|null;
 readonly signingAuthorized:false;readonly broadcastAuthorized:false;readonly paymentAuthorized:false;readonly activationAuthorized:false;readonly reservationReleaseAuthorized:false;
}
interface Artifacts{request:VehicleIssuerRequest;reservationId:string;quote:VehicleIssuanceQuote;signedTransaction:Uint8Array;wire:VehicleCraftSignedReceipt}
const flags={signingAuthorized:false,broadcastAuthorized:false,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false} as const;
const timestamp=z.iso.datetime({precision:6}),MAX_PENDING=8,MAX_MS=60_000; // Operational bounds only.
const fail=(suffix:string):never=>{throw new HttpError(503,'Original vehicle delivery held','VEHICLE_DELIVERY_'+suffix);};
const source=async(db:DbOrTx)=>{await db.execute(sql`select public.shardkeep_vehicle_delivery_source()`);};
const saved=(a:Artifacts)=>({quote:a.quote,signedTransaction:Uint8Array.from(a.signedTransaction)});
function checkedReceipt(value:unknown,a:Artifacts){const p=verifyVehicleIssuanceRequestReceipt(value,saved(a));if(p.wallet!==a.request.wallet||p.idempotencyKey!==a.request.idempotencyKey||p.signature!==a.wire.signature)fail('BINDING');return p;}
async function readState(db:DbOrTx,a:Artifacts):Promise<VehicleCraftDeliveryState>{
 await source(db);
 const [r]=await db.execute<{dispatch:Record<string,unknown>|null;acknowledgement:Record<string,unknown>|null;receipt:unknown|null;receipt_at:string|null}>(sql`select
 (select jsonb_build_object('actor',d.actor_wallet,'key',d.idempotency_key,'originalHash',d.original_hash,'messageSha256',d.message_sha256,'wireSha256',d.wire_sha256,'signatureHex',encode(d.signature,'hex'),'recordedAt',to_char(d.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) from public.vehicle_request_dispatches d where d.reservation_id=${a.reservationId}::uuid) dispatch,
 (select jsonb_build_object('signatureHex',encode(x.signature,'hex'),'recordedAt',to_char(x.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) from public.vehicle_request_dispatch_acknowledgements x where x.reservation_id=${a.reservationId}::uuid) acknowledgement,
 (select p.record from public.vehicle_request_delivery_receipts p where p.reservation_id=${a.reservationId}::uuid) receipt,
 (select to_char(p.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from public.vehicle_request_delivery_receipts p where p.reservation_id=${a.reservationId}::uuid) receipt_at`);
 if(!r)fail('SOURCE');let dispatch:VehicleCraftDeliveryState['dispatch']=null,acknowledgement:VehicleCraftDeliveryState['acknowledgement']=null,receipt:VehicleCraftDeliveryState['receipt']=null;
 const signatureHex=Buffer.from(a.signedTransaction.subarray(1,65)).toString('hex'),d=r!.dispatch,x=r!.acknowledgement;
 if(d){if(d.actor!==a.request.wallet||d.key!==a.request.idempotencyKey||d.originalHash!==a.quote.originalHash||d.messageSha256!==a.wire.messageSha256||d.wireSha256!==a.wire.wireSha256||d.signatureHex!==signatureHex)fail('BINDING');dispatch={originalHash:a.quote.originalHash,messageSha256:a.wire.messageSha256,wireSha256:a.wire.wireSha256,recordedAt:timestamp.parse(d.recordedAt)};}
 if(x){if(!dispatch||x.signatureHex!==signatureHex)fail('BINDING');acknowledgement={recordedAt:timestamp.parse(x.recordedAt)};}
 if(r!.receipt!==null)receipt={proof:checkedReceipt(r!.receipt,a),recordedAt:timestamp.parse(r!.receipt_at)};
 return {version:1,...a.request,reservationId:a.reservationId,signature:a.wire.signature,status:receipt?(receipt.proof.outcome==='request_succeeded'?'finalized':'reverted'):acknowledgement?'submitted':dispatch?'unknown':'held',reason:null,dispatch,acknowledgement,receipt,...flags};
}
const reason=(state:VehicleCraftDeliveryState,value:VehicleCraftDeliveryState['reason']):VehicleCraftDeliveryState=>state.receipt?state:{...state,reason:value};
export function createVehicleCraftDelivery(db:Db,dependencies:VehicleCraftDeliveryDependencies={}){
 if('rollback'in db)fail('TOP_LEVEL');
 const preparations=createVehicleCraftPreparation(db),wires=createVehicleCraftSignedStore(db),materials=createVehicleCraftMaterials(db),enabled=dependencies.enabled??(()=>false);
 const timeout=dependencies.timeoutMs??MAX_MS,now=dependencies.monotonicNow??(()=>performance.now());if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_MS)fail('CONFIGURATION');let pending=0;
 async function load(input:VehicleIssuerRequest):Promise<Artifacts>{
  const request=copyVehicleIssuerRequest(input);await source(db);const p=await preparations.get(request);if(!p?.preparation)fail('NOT_PREPARED');const wire=await wires.get(request);if(!wire)fail('NOT_SIGNED');
  return {request,reservationId:p!.reservationId,quote:p!.preparation!.quote,signedTransaction:Buffer.from(wire!.signedTransactionHex,'hex'),wire:wire!};
 }
 async function loadCurrent(input:VehicleIssuerRequest){
  if(!enabled())fail('DISABLED');const a=await load(input),state=await readState(db,a);if(state.receipt)fail('TERMINAL');
  const material=await materials.read(a.request.wallet,a.request.idempotencyKey);if(material?.status!=='held')fail('MATERIAL');if(!enabled())fail('DISABLED');return saved(a);
 }
 // Reader instances persist for this service's lifetime, preserving their own
 // actual ignored-RPC/send capacity even after the public promise times out.
 const current=dependencies.current?createVehicleIssuanceCurrent(dependencies.current.connect,dependencies.current.trust,loadCurrent,{deadlineMs:dependencies.current.deadlineMs??timeout}):null;
 const receiptReader=dependencies.receipt?createVehicleIssuanceRequestReceiptReader(dependencies.receipt.connect,dependencies.receipt.trust,async ref=>saved(await load(ref)),{deadlineMs:dependencies.receipt.deadlineMs??timeout}):null;
 async function get(input:VehicleIssuerRequest){const a=await load(input);return readState(db,a);}
 async function persistReceipt(a:Artifacts,value:unknown,active:()=>void){
  const proof=checkedReceipt(value,a);return db.transaction(async tx=>{
   await source(tx);await tx.execute(sql`select id from public.vehicle_craft_material_reservations where id=${a.reservationId}::uuid for update`);
   const old=await readState(tx,a);if(old.receipt)return old;active();await tx.execute(sql`insert into public.vehicle_request_delivery_receipts(reservation_id,record) values(${a.reservationId}::uuid,${JSON.stringify(proof)}::jsonb)`);const out=await readState(tx,a);active();return out;
  });
 }
 async function run(input:VehicleIssuerRequest,outer:AbortSignal,mode:'deliver'|'recover'):Promise<VehicleCraftDeliveryState>{
  const a=await load(input),old=await readState(db,a);if(old.receipt)return old;if(outer.aborted)return reason(old,'ABORTED');if(pending>=MAX_PENDING)return reason(old,'BUSY');
  const started=now();if(!Number.isFinite(started)||started<0)fail('CLOCK');let previous=started,outstanding=0,done=false,released=false,sending=false;pending++;
  const controller=new AbortController(),signal=AbortSignal.any([outer,controller.signal]);
  const release=()=>{if(done&&outstanding===0&&!released){released=true;pending--;}};
  const active=()=>{const sample=now();if(signal.aborted||!Number.isFinite(sample)||sample<previous||sample-started>=timeout)fail('ABORTED');previous=sample;};
  async function call<T>(fn:()=>Promise<T>){active();outstanding++;try{const result=await fn();active();return result;}finally{outstanding--;release();}}
  let abort!:()=>void;const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(new HttpError(503,'Original vehicle delivery held','VEHICLE_DELIVERY_ABORTED'));signal.addEventListener('abort',abort,{once:true});});const timer=setTimeout(()=>controller.abort(),timeout);
  async function recoverOnly(state:VehicleCraftDeliveryState){if(state.receipt)return state;if(!receiptReader)return reason(state,'PROVIDER_UNAVAILABLE');const proof=await call(()=>receiptReader(a.request,signal));return proof?persistReceipt(a,proof,active):reason(state,'PROOF_UNAVAILABLE');}
  const work=(async()=>{try{
   if(mode==='recover'||old.dispatch)return recoverOnly(old);
   if(!enabled())return reason(old,'DISABLED');if(!current)return reason(old,'PROVIDER_UNAVAILABLE');
   const review=await call(()=>current.review(a.request,signal));
   const committed=await db.transaction(async tx=>{
    await source(tx);await tx.execute(sql`select id from public.vehicle_craft_material_reservations where id=${a.reservationId}::uuid for update`);const state=await readState(tx,a);
    if(state.receipt||state.dispatch)return {state,inserted:false};active();if(!enabled())fail('DISABLED');
    await tx.execute(sql`insert into public.vehicle_request_dispatches(reservation_id) values(${a.reservationId}::uuid)`);const out=await readState(tx,a);active();return {state:out,inserted:true};
   });
   if(!committed.inserted)return recoverOnly(committed.state);
   // The marker has committed. This unique call alone owns send; even a crash
   // before the next line leaves every future call strictly recovery-only.
   active();sending=true;const ack=await call(()=>current.send(a.request,review,signal));
   if(ack.signature!==a.wire.signature||ack.wireSha256!==a.wire.wireSha256||ack.messageSha256!==a.wire.messageSha256)fail('ACKNOWLEDGEMENT');
   return db.transaction(async tx=>{await source(tx);await tx.execute(sql`select id from public.vehicle_craft_material_reservations where id=${a.reservationId}::uuid for update`);const state=await readState(tx,a);if(state.acknowledgement)return state;
    active();await tx.execute(sql`insert into public.vehicle_request_dispatch_acknowledgements(reservation_id,signature) values(${a.reservationId}::uuid,${Buffer.from(bs58.decode(ack.signature))})`);const out=await readState(tx,a);active();return out;});
  }catch(error){
   if(error&&typeof error==='object'&&'code'in error&&error.code==='OBSERVED_TRANSACTION')return recoverOnly(await readState(db,a));
   throw error;
  }})();
  void work.then(()=>{done=true;release();},()=>{done=true;release();});
  try{return await Promise.race([work,stopped]);}catch(error){
   const state=await readState(db,a);if(state.receipt)return state;
   const code=error&&typeof error==='object'&&'code'in error?error.code:null;
   return reason(state,signal.aborted?'ABORTED':code==='BUSY'?'BUSY':sending?'SEND_UNCERTAIN':mode==='recover'?'PROOF_UNAVAILABLE':'CURRENT_HELD');
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
 }
 return Object.freeze({get,deliver:(ref:VehicleIssuerRequest,signal:AbortSignal)=>run(ref,signal,'deliver'),recover:(ref:VehicleIssuerRequest,signal:AbortSignal)=>run(ref,signal,'recover')});
}
