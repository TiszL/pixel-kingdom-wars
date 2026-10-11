/** One finalized 12-account bank proves only a paid ordinary win/loss under
 * the reviewed original craft ABI. Core mint absence is never an outcome.
 * A won-unminted original keeps its entitlement; no refund or retry authority. */
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {vehicleId,vehiclePda,VEHICLE_VRF_QUEUE} from './vehicleIssuanceProtocol';
import {need,safe,fields,copyTrust,attest,LOADER,normalizeVehicleIssuanceOriginal,verifyVehicleIssuanceTerminalAccounts,VehicleIssuanceEvidenceError,type VehicleIssuanceEvidenceRpc,type VehicleIssuanceTrust,type VehicleIssuanceRawAccount,type VehicleIssuanceTerminalEvidence} from './vehicleIssuanceAccounts';
export {normalizeVehicleIssuanceOriginal,VehicleIssuanceEvidenceError} from './vehicleIssuanceAccounts';
export type {VehicleIssuanceTrust,VehicleIssuanceProgramTrust,VehicleIssuanceEvidenceRpc,VehicleIssuanceRawAccount,VehicleIssuanceTerminalEvidence} from './vehicleIssuanceAccounts';
export type {VehicleIssuanceOriginal} from './vehicleIssuanceProtocol';
const DEADLINE_MS=60_000,MAX_PENDING=8;
export function createVehicleIssuanceTerminalReader(connect:(signal:AbortSignal)=>VehicleIssuanceEvidenceRpc,inputTrust:VehicleIssuanceTrust,loadSaved:(rootId:string)=>Promise<unknown>,options:{deadlineMs?:number}={}){
 need(typeof connect==='function'&&typeof loadSaved==='function');const trust=copyTrust(inputTrust),settings=fields(options,'','deadlineMs'),deadline=settings.deadlineMs??DEADLINE_MS;need(safe(deadline)&&deadline>0&&deadline<=DEADLINE_MS);
 const programs=[trust.craft,trust.provider,trust.core],floor=Math.max(...programs.map(p=>p.reviewedDeploymentSlot));let pending=0;
 return async(rootId:string):Promise<VehicleIssuanceTerminalEvidence>=>{
 rootId=vehicleId(rootId);need(pending<MAX_PENDING,'BUSY');pending++;const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let done=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
 const active=()=>need(!controller.signal.aborted,'DEADLINE'),release=()=>{if(done&&!released&&outstanding.size===0){released=true;pending--;}};
 async function call<T>(fn:()=>Promise<T>):Promise<T>{active();const task=Promise.resolve().then(()=>{active();return fn();});outstanding.add(task);try{const result=await task;active();return result;}finally{outstanding.delete(task);release();}}
 const work=(async()=>{
  const original=normalizeVehicleIssuanceOriginal(await call(()=>loadSaved(rootId)));need(original.rootId===rootId&&original.genesisHash===trust.expectedGenesisHash,'ORIGINAL');
  const rpc=connect(controller.signal);need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');const opening=await call(()=>rpc.getSlot('finalized'));need(safe(opening)&&opening>=floor,'DEPLOYMENT');
  const addresses=programs.flatMap(p=>{const id=new PublicKey(p.programId);return [id,PublicKey.findProgramAddressSync([id.toBuffer()],LOADER)[0]];});
  addresses.push(vehiclePda('vehicle_control')[0],vehiclePda('vehicle_root',rootId)[0],vehiclePda('vehicle_attempt',original.attemptId)[0],vehiclePda('vehicle_permit',original.permitId)[0],new PublicKey(VEHICLE_VRF_QUEUE),SYSVAR_CLOCK_PUBKEY);
  const caps=[36,8*1024*1024,36,8*1024*1024,36,8*1024*1024,189,170,557,170,65536,40];
  const response=await call(()=>rpc.getMultipleAccountsInfoAndContext(addresses.map(a=>new PublicKey(a.toBytes())),{commitment:'finalized',minContextSlot:opening}));
  need(response&&safe(response.context?.slot)&&response.context.slot>=opening&&Array.isArray(response.value)&&response.value.length===addresses.length,'ACCOUNTS');
  const slot=response.context.slot,rows=response.value.map((v,i):VehicleIssuanceRawAccount=>{const row=fields(v,'address owner executable data');need(row.address instanceof PublicKey&&row.owner instanceof PublicKey&&typeof row.executable==='boolean'&&row.data instanceof Uint8Array&&row.data.length<=caps[i]!,'ACCOUNTS');const address=new PublicKey(row.address.toBytes());need(address.equals(addresses[i]!),'IDENTITY');return {address,owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)};});
  const closing=await call(()=>rpc.getSlot('finalized'));need(safe(closing)&&closing>=slot,'ACCOUNTS');need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');
  programs.forEach((p,i)=>attest(rows[i*2]!,rows[i*2+1]!,p));active();return verifyVehicleIssuanceTerminalAccounts(rows,original,slot,trust);
 })();
 void work.then(()=>{done=true;release();},()=>{done=true;release();});
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new VehicleIssuanceEvidenceError('DEADLINE'));},deadline);})]);}
 catch(error){if(error instanceof VehicleIssuanceEvidenceError)throw error;throw new VehicleIssuanceEvidenceError('UNAVAILABLE');}
 finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
 };
}
