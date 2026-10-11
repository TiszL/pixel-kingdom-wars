/** Private vehicle-only policy capability. No startup, route, wallet or broadcast. */
import {PublicKey} from '@solana/web3.js';
import {createVehicleIssuanceAdmissionReader} from '@shardkeep/chain/vehicle-issuance-admission';
import type {VehicleIssuanceTrust,VehicleIssuanceEvidenceRpc} from '@shardkeep/chain/vehicle-issuance-evidence';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {VEHICLE_CRAFT_PROGRAM} from '@shardkeep/chain/vehicle-issuance-protocol';
import type {VehicleCraftMaterialRecord} from './game/vehicleCraftMaterials';
import {VEHICLE_ISSUER_PURPOSE,VehicleIssuerError,vehicleIssuerNeed,copyVehicleIssuerRequest,copyVehicleIssuerDomain,vehicleIssuerAttemptFromMaterial,vehicleIssuerReceipt,openVehicleIssuerJournal,type VehicleIssuerRequest,type VehicleIssuerReceipt} from './vehiclePolicyIssuerJournal';
export type {VehicleIssuerRequest,VehicleIssuerReceipt} from './vehiclePolicyIssuerJournal';
export interface VehiclePolicyIssuerOptions{
 readonly journalFile:string;
 readonly trust:VehicleIssuanceTrust;
 readonly connect:(signal:AbortSignal)=>VehicleIssuanceEvidenceRpc;
 /** A committed, guarded D211 read capability; never a caller's source object. */
 readonly material:Readonly<{read:(wallet:string,idempotencyKey:string)=>Promise<VehicleCraftMaterialRecord|null>}>;
 /** Dedicated local key capability. Synchronous signing only, never sending. */
 readonly signer:Readonly<{publicKey:string;sign:(message:Uint8Array)=>Uint8Array}>;
 readonly timeoutMs?:number;readonly monotonicNow?:()=>number;
}
// Same operational bounds as the accepted finalized vehicle reader; these do
// not grant an economic quota or extend an original permit's on-chain expiry.
const MAX_AGE_MS=60_000,MAX_PENDING=8;
export async function createVehiclePolicyIssuer(options:VehiclePolicyIssuerOptions){
 const trust=structuredClone(options.trust),connect=options.connect,publicKey=options.signer.publicKey,sign=options.signer.sign.bind(options.signer),materialRead=options.material.read.bind(options.material);
 vehicleIssuerNeed(typeof connect==='function'&&typeof sign==='function'&&typeof materialRead==='function','CONFIGURATION');
 const key=new PublicKey(publicKey);vehicleIssuerNeed(key.toBase58()===publicKey&&!key.equals(PublicKey.default),'CONFIGURATION');
 const domain=copyVehicleIssuerDomain({purpose:VEHICLE_ISSUER_PURPOSE,genesisHash:trust.expectedGenesisHash,craftProgram:VEHICLE_CRAFT_PROGRAM});
 const now=options.monotonicNow??(()=>performance.now()),timeout=options.timeoutMs??MAX_AGE_MS;
 vehicleIssuerNeed(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=MAX_AGE_MS&&typeof now==='function','CONFIGURATION');
 // Validate source pins and key configuration without any network call.
 createVehicleIssuanceAdmissionReader(connect,trust,publicKey,{deadlineMs:timeout});
 const journal=await openVehicleIssuerJournal(options.journalFile,domain),lifetime=new AbortController();let pending=0;
 async function run<T>(outer:AbortSignal,operation:(active:()=>void,signal:AbortSignal,track:<V>(call:()=>Promise<V>)=>Promise<V>)=>Promise<T>):Promise<T>{
  vehicleIssuerNeed(!lifetime.signal.aborted&&!outer.aborted,'ABORTED');vehicleIssuerNeed(pending<MAX_PENDING,'BUSY');
  const started=now();vehicleIssuerNeed(Number.isFinite(started)&&started>=0,'STALE');let previous=started;
  const controller=new AbortController(),signal=AbortSignal.any([outer,lifetime.signal,controller.signal]);pending++;
  let outstanding=0,done=false,released=false;
  const release=()=>{if(done&&outstanding===0&&!released){released=true;pending--;}};
  const active=()=>{vehicleIssuerNeed(!signal.aborted,'ABORTED');const sample=now();vehicleIssuerNeed(Number.isFinite(sample)&&sample>=previous&&sample-started<=timeout,'STALE');previous=sample;};
  async function track<V>(call:()=>Promise<V>){active();outstanding++;try{const value=await call();active();return value;}finally{outstanding--;release();}}
  let abort!:()=>void;const interrupted=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new VehicleIssuerError('ABORTED'));signal.addEventListener('abort',abort,{once:true});});
  const timer=setTimeout(()=>controller.abort(),timeout),work=Promise.resolve().then(()=>{active();return operation(active,signal,track);});
  void work.then(()=>{done=true;release();},()=>{done=true;release();});
  try{return await Promise.race([work,interrupted]);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
 }
 async function issueOnce(input:VehicleIssuerRequest,signal:AbortSignal):Promise<VehicleIssuerReceipt>{
  const request=copyVehicleIssuerRequest(input);
  return run(signal,async(active,ownSignal,track)=>{
   // Historical signature recovery needs neither fresh material hydration nor
   // the current policy key/provider. A pending attempt is permanently held.
   const prior=await journal.read(request);active();
   if(prior){const receipt=vehicleIssuerReceipt(prior);vehicleIssuerNeed(receipt,'PENDING');return receipt;}
   const saved=await track(()=>materialRead(request.wallet,request.idempotencyKey));active();vehicleIssuerNeed(saved,'MATERIAL_MISSING');
   const attempt=vehicleIssuerAttemptFromMaterial(saved,request,publicKey,domain);
   const committed=await journal.begin(attempt);active();
   if(!committed.inserted){const receipt=vehicleIssuerReceipt(committed.entry);vehicleIssuerNeed(receipt,'PENDING');return receipt;}
   // Pending is already fsynced. No policy call or signature occurs before it.
   const read=createVehicleIssuanceAdmissionReader(internalSignal=>{
    const rpc=connect(AbortSignal.any([ownSignal,internalSignal]));
    return {getGenesisHash:()=>track(()=>rpc.getGenesisHash()),getSlot:commitment=>track(()=>rpc.getSlot(commitment)),getMultipleAccountsInfoAndContext:(addresses,settings)=>track(()=>rpc.getMultipleAccountsInfoAndContext(addresses,settings))};
   },trust,publicKey,{deadlineMs:timeout});
   const observed=await read(attempt.original,ownSignal);active();
   vehicleIssuerNeed(observed.originalHash===attempt.original.originalHash&&observed.policyAuthority===publicKey&&observed.genesisHash===domain.genesisHash,'ADMISSION');
   const expiry=BigInt(attempt.original.permitExpiry),chainNow=BigInt(observed.unixTimestamp);
   vehicleIssuerNeed(expiry>chainNow&&expiry-chainNow<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),'EXPIRY');
   // No await from final active check through synchronous local signing.
   const signature=sign(Buffer.from(attempt.messageHex,'hex'));active();
   vehicleIssuerNeed(signature instanceof Uint8Array&&signature.byteLength===64,'SIGNATURE');
   const signatureHex=Buffer.from(signature).toString('hex');vehicleIssuerReceipt({attempt,signatureHex});
   const receipt=await journal.complete(request,signatureHex);active();return receipt;
  });
 }
 async function lookup(input:VehicleIssuerRequest,signal:AbortSignal):Promise<VehicleIssuerReceipt|null>{
  const request=copyVehicleIssuerRequest(input);return run(signal,async active=>{const entry=await journal.read(request);active();return entry?vehicleIssuerReceipt(entry):null;});
 }
 return Object.freeze({issueOnce,lookup,close:async()=>{lifetime.abort();await journal.close();}});
}
