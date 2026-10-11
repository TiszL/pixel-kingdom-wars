/** Private original-only dispatch/quote retention. No API mount or transport.
 * Only the inserting committed attempt may dispatch issueOnce. Every reopened
 * attempt uses lookup, even when a crash preceded the original issuer call. */
import {isDeepStrictEqual} from 'node:util';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {verifyVehicleIssuanceQuote,type VehicleIssuanceQuote,type VehicleIssuanceQuoteInput} from '@shardkeep/chain/vehicle-issuance-quote';
import {VEHICLE_CRAFT_PROGRAM} from '@shardkeep/chain/vehicle-issuance-protocol';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {createVehicleCraftMaterials,type VehicleCraftMaterialRecord} from './vehicleCraftMaterials';
import {VEHICLE_ISSUER_PURPOSE,copyVehicleIssuerRequest,copyVehicleIssuerAttempt,vehicleIssuerAttemptFromMaterial,vehicleIssuerReceipt,type VehicleIssuerRequest,type VehicleIssuerAttempt,type VehicleIssuerReceipt} from '../vehiclePolicyIssuerJournal';
export interface VehicleCraftPreparationDependencies{
 readonly enabled?:()=>boolean;
 readonly issuer?:Readonly<{publicKey:string;issueOnce:(request:VehicleIssuerRequest,signal:AbortSignal)=>Promise<VehicleIssuerReceipt>;lookup:(request:VehicleIssuerRequest,signal:AbortSignal)=>Promise<VehicleIssuerReceipt|null>}>;
 readonly quote?:(input:VehicleIssuanceQuoteInput,signal:AbortSignal)=>Promise<VehicleIssuanceQuote>;
 readonly timeoutMs?:number;readonly monotonicNow?:()=>number;
}
export interface VehicleCraftPreparationState{
 readonly version:1;readonly wallet:string;readonly idempotencyKey:string;readonly reservationId:string;
 readonly attempt:Readonly<{record:VehicleIssuerAttempt;recordedAt:string}>;
 readonly preparation:Readonly<{issuerReceipt:VehicleIssuerReceipt;quote:VehicleIssuanceQuote;recordedAt:string}>|null;
 readonly signingAuthorized:false;readonly broadcastAuthorized:false;readonly paymentAuthorized:false;readonly activationAuthorized:false;readonly reservationReleaseAuthorized:false;
}
const noAuthority={signingAuthorized:false,broadcastAuthorized:false,paymentAuthorized:false,activationAuthorized:false,reservationReleaseAuthorized:false} as const;
const timestamp=z.iso.datetime({precision:6}),signature=z.string().regex(/^[0-9a-f]{128}$/);
const artifact=z.object({version:z.literal(1),issuerReceipt:z.object({attempt:z.unknown(),signatureHex:signature}).strict(),quote:z.unknown()}).strict();
const receiptSchema=z.object({version:z.literal(1),purpose:z.literal(VEHICLE_ISSUER_PURPOSE),wallet:z.string(),idempotencyKey:z.string(),publicKey:z.string(),original:z.unknown(),material:z.unknown(),message:z.instanceof(Uint8Array),signature:z.instanceof(Uint8Array),paymentAuthorized:z.literal(false),activationAuthorized:z.literal(false),reservationReleaseAuthorized:z.literal(false)}).strict();
const MAX_AGE_MS=60_000,MAX_PENDING=8; // Operational resource bounds, not game tuning.
const fail=(suffix:string):never=>{throw new HttpError(503,'Vehicle request preparation held','VEHICLE_REQUEST_'+suffix);};
export async function assertVehicleRequestSource(db:DbOrTx){await db.execute(sql`select public.shardkeep_vehicle_request_source()`);}
function domain(material:VehicleCraftMaterialRecord){return {purpose:VEHICLE_ISSUER_PURPOSE,genesisHash:material.original.genesisHash,craftProgram:VEHICLE_CRAFT_PROGRAM as typeof VEHICLE_CRAFT_PROGRAM};}
function checkedAttempt(value:unknown,material:VehicleCraftMaterialRecord,request:VehicleIssuerRequest){
 const a=copyVehicleIssuerAttempt(value as VehicleIssuerAttempt,domain(material)).attempt;
 // A paid terminal never erases an already retained original. New first
 // dispatch separately requires status held, both in TS and under its SQL lock.
 const expected=vehicleIssuerAttemptFromMaterial({...material,status:'held',terminal:null},request,a.publicKey,domain(material));
 if(!isDeepStrictEqual(a,expected))fail('BINDING');return a;
}
function checkedReceipt(value:unknown,a:VehicleIssuerAttempt):VehicleIssuerReceipt{
 const v=receiptSchema.parse(value),saved=vehicleIssuerReceipt({attempt:a,signatureHex:Buffer.from(v.signature).toString('hex')});
 if(!saved||v.wallet!==a.wallet||v.idempotencyKey!==a.idempotencyKey||v.publicKey!==a.publicKey||!isDeepStrictEqual(v.original,a.original)||!isDeepStrictEqual(v.material,a.material)||Buffer.from(v.message).toString('hex')!==a.messageHex)fail('RECEIPT');return saved!;
}
function expectedQuote(receipt:VehicleIssuerReceipt):VehicleIssuanceQuoteInput{return {original:receipt.original,policyAuthority:receipt.publicKey,policySignature:receipt.signature};}
async function readState(db:DbOrTx,material:VehicleCraftMaterialRecord,request:VehicleIssuerRequest):Promise<VehicleCraftPreparationState|null>{
 await assertVehicleRequestSource(db);
 const [row]=await db.execute<{actor_wallet:string;idempotency_key:string;policy_authority:string;record:unknown;recorded_at:string;preparation:unknown|null;prepared_at:string|null}>(sql`select a.actor_wallet,a.idempotency_key,a.policy_authority,a.record,to_char(a.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') recorded_at,p.record preparation,to_char(p.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') prepared_at from public.vehicle_request_issuance_attempts a left join public.vehicle_request_preparations p on p.reservation_id=a.reservation_id where a.reservation_id=${material.id}::uuid`);
 if(!row)return null;const attempt=checkedAttempt(row.record,material,request);
 if(row.actor_wallet!==request.wallet||row.idempotency_key!==request.idempotencyKey||row.policy_authority!==attempt.publicKey)fail('BINDING');
 let preparation:VehicleCraftPreparationState['preparation']=null;
 if(row.preparation!==null){const p=artifact.parse(row.preparation);if(!isDeepStrictEqual(checkedAttempt(p.issuerReceipt.attempt,material,request),attempt))fail('BINDING');
  const receipt=vehicleIssuerReceipt({attempt,signatureHex:p.issuerReceipt.signatureHex});if(!receipt)fail('RECEIPT');
  const quote=verifyVehicleIssuanceQuote(p.quote,expectedQuote(receipt!));preparation={issuerReceipt:receipt!,quote,recordedAt:timestamp.parse(row.prepared_at)};
 }
 return {version:1,...request,reservationId:material.id,attempt:{record:attempt,recordedAt:timestamp.parse(row.recorded_at)},preparation,...noAuthority};
}
export function createVehicleCraftPreparation(db:Db,dependencies:VehicleCraftPreparationDependencies={}){
 if('rollback'in db)fail('TOP_LEVEL');
 const materials=createVehicleCraftMaterials(db),enabled=dependencies.enabled??(()=>false),issuer=dependencies.issuer;
 const key=issuer?.publicKey,issue=issuer?.issueOnce.bind(issuer),lookup=issuer?.lookup.bind(issuer),quote=dependencies.quote;
 const now=dependencies.monotonicNow??(()=>performance.now()),timeout=dependencies.timeoutMs??MAX_AGE_MS;
 if(!Number.isSafeInteger(timeout)||timeout<=0||timeout>MAX_AGE_MS)fail('CONFIGURATION');let pending=0;
 async function load(request:VehicleIssuerRequest){await assertVehicleRequestSource(db);return await materials.read(request.wallet,request.idempotencyKey)??fail('MATERIAL');}
 async function get(input:VehicleIssuerRequest){const request=copyVehicleIssuerRequest(input),material=await load(request);return readState(db,material,request);}
 async function prepare(input:VehicleIssuerRequest,outer:AbortSignal):Promise<VehicleCraftPreparationState>{
  const request=copyVehicleIssuerRequest(input);if(outer.aborted)fail('ABORTED');if(pending>=MAX_PENDING)fail('BUSY');
  const started=now();if(!Number.isFinite(started)||started<0)fail('STALE');let previous=started;pending++;
  const controller=new AbortController(),signal=AbortSignal.any([outer,controller.signal]);let outstanding=0,done=false,released=false;
  const release=()=>{if(done&&outstanding===0&&!released){released=true;pending--;}};
  const active=()=>{if(signal.aborted)fail('ABORTED');const sample=now();if(!Number.isFinite(sample)||sample<previous||sample-started>timeout)fail('STALE');previous=sample;};
  async function track<T>(call:()=>Promise<T>){active();outstanding++;try{const value=await call();active();return value;}finally{outstanding--;release();}}
  let abort!:()=>void;const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(new HttpError(503,'Vehicle request preparation held','VEHICLE_REQUEST_ABORTED'));signal.addEventListener('abort',abort,{once:true});});
  const timer=setTimeout(()=>controller.abort(),timeout);
  const work=(async()=>{
   const material=await load(request);active();const old=await readState(db,material,request);active();if(old?.preparation)return old;
   if(!issue||!lookup||!quote||!key)fail('UNCONFIGURED');
   let inserted=false,state=old;
   if(!state){
    if(!enabled()||material.status!=='held')fail('DISABLED');
    const attempt=vehicleIssuerAttemptFromMaterial(material,request,key!,domain(material));
    const committed=await db.transaction(async tx=>{
     await assertVehicleRequestSource(tx);await tx.execute(sql`select id from public.vehicle_craft_material_reservations where id=${material.id}::uuid for update`);
     const prior=await readState(tx,material,request);if(prior)return {state:prior,inserted:false};
     active();if(!enabled())fail('DISABLED');
     await tx.execute(sql`insert into public.vehicle_request_issuance_attempts(reservation_id,actor_wallet,idempotency_key,policy_authority,record) values(${material.id}::uuid,${request.wallet},${request.idempotencyKey}::uuid,${key},${JSON.stringify(attempt)}::jsonb)`);
     const saved=await readState(tx,material,request);if(!saved)fail('SOURCE');active();return {state:saved!,inserted:true};
    });state=committed.state;inserted=committed.inserted;active();
   }
   if(state!.preparation)return state!;
   // Transaction is committed and released before any issuer/provider work.
   const receipt=await track(()=>inserted?issue!(request,signal):lookup!(request,signal));if(!receipt)fail('ISSUER_PENDING');
   const checked=checkedReceipt(receipt,state!.attempt.record),quoted=verifyVehicleIssuanceQuote(await track(()=>quote!(expectedQuote(checked),signal)),expectedQuote(checked));active();
   const record={version:1,issuerReceipt:{attempt:state!.attempt.record,signatureHex:Buffer.from(checked.signature).toString('hex')},quote:quoted};
   return db.transaction(async tx=>{
    await assertVehicleRequestSource(tx);await tx.execute(sql`select id from public.vehicle_craft_material_reservations where id=${material.id}::uuid for update`);
    const first=await readState(tx,material,request);if(first?.preparation)return first;if(!first||!isDeepStrictEqual(first.attempt.record,state!.attempt.record))fail('SOURCE');
    active();await tx.execute(sql`insert into public.vehicle_request_preparations(reservation_id,record) values(${material.id}::uuid,${JSON.stringify(record)}::jsonb)`);
    const saved=await readState(tx,material,request);if(!saved?.preparation)fail('SOURCE');active();return saved!;
   });
  })();
  void work.then(()=>{done=true;release();},()=>{done=true;release();});
  try{return await Promise.race([work,stopped]);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
 }
 return Object.freeze({get,prepare});
}
