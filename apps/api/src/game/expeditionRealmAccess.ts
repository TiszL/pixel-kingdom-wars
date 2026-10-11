/** B4q: one finalized realm-access observation before game locks. This supplies
 * only wallet/destination coverage; base, vehicle, route and tax-term admission
 * remain separate. No sale receipt, current seller, payment or signing is used. */
import {PublicKey} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {createSeekerRealmAccessSnapshotReader,SeekerRealmAccessSnapshotError,
 type SeekerRealmAccessRpc,type SeekerRealmAccessTrust,type SeekerRealmAccessSnapshot} from '@shardkeep/chain/seeker-realm-access-snapshot';
import {realmAccessPda,realmSaleConfigPda} from '@shardkeep/chain/seeker-realm-sale';
type Code='INPUT'|'UNAVAILABLE'|'SOURCE'|'NO_COVERAGE'|'EXPIRED'|'STALE'|'CONSUMED';
export class ExpeditionRealmAccessError extends Error{
 constructor(readonly code:Code){super(`Expedition realm access refused: ${code}`);this.name='ExpeditionRealmAccessError';}
}
function need(value:unknown,code:Code):asserts value{if(!value)throw new ExpeditionRealmAccessError(code);}
export interface ExpeditionRealmAccessRequest {readonly wallet:string;readonly realm:number}
export interface ExpeditionRealmAccessObservation {
 readonly version:1;readonly wallet:string;readonly realm:number;readonly accessAddress:string;readonly configAddress:string;readonly expiresAt:string;
 readonly finality:Readonly<{commitment:'finalized';contextSlot:string;observedAt:string;chainUnixTimestamp:string}>;
 readonly source:SeekerRealmAccessSnapshot['source'];
}
export interface ExpeditionRealmAccessReader {readCoverage(departureAt:string):Promise<ExpeditionRealmAccessObservation>}
// Rechecks accept only the actual owned result of this server prefetch. JSON or
// a persisted historical receipt cannot manufacture a new admission capability.
const observations=new WeakMap<ExpeditionRealmAccessObservation,ExpeditionRealmAccessRequest>();
function request(value:ExpeditionRealmAccessRequest):ExpeditionRealmAccessRequest{
 need(value&&typeof value==='object'&&!Array.isArray(value)&&Reflect.ownKeys(value).length===2&&Object.hasOwn(value,'wallet')&&Object.hasOwn(value,'realm'),'INPUT');
 const {wallet,realm}=value;need(typeof wallet==='string'&&wallet.length>=32&&wallet.length<=44&&Number.isSafeInteger(realm)&&realm>=0&&realm<PHASE_E_POLICY.seekerIsland.realmCount,'INPUT');
 try{const key=new PublicKey(wallet);need(key.toBase58()===wallet&&!key.equals(PublicKey.default),'INPUT');}catch{throw new ExpeditionRealmAccessError('INPUT');}
 return Object.freeze({wallet,realm});
}
function instant(value:string):number{
 need(typeof value==='string'&&value.length===24,'INPUT');const ms=Date.parse(value);
 need(Number.isSafeInteger(ms)&&ms>=0&&new Date(ms).toISOString()===value,'INPUT');return ms;
}
function freshAt(observedAt:string,chainUnixTimestamp:string,departureAt:string):number{
 const at=instant(departureAt),age=at-instant(observedAt);
 need(age>=0&&age<=PHASE_E_SEEKER_AUCTION.observationMaxAgeMs&&BigInt(at)>=BigInt(chainUnixTimestamp)*1000n,'STALE');return at;
}
/** Revalidate after the last lock wait using the actual final departure time.
 * There is no network call, clock read, observation refresh or return-time test. */
export function assertExpeditionRealmAccessAtDeparture(proof:ExpeditionRealmAccessObservation,input:ExpeditionRealmAccessRequest,departureAt:string):ExpeditionRealmAccessObservation{
 const expected=observations.get(proof),actor=request(input);need(expected&&actor.wallet===expected.wallet&&actor.realm===expected.realm,'SOURCE');
 const at=freshAt(proof.finality.observedAt,proof.finality.chainUnixTimestamp,departureAt);
 need(BigInt(at)<BigInt(proof.expiresAt)*1000n,'EXPIRED');return proof;
}
export async function prefetchExpeditionRealmAccessReader(connect:(signal:AbortSignal)=>SeekerRealmAccessRpc,trust:SeekerRealmAccessTrust,
 input:ExpeditionRealmAccessRequest,options:{readonly clock?:()=>Date}={}):Promise<ExpeditionRealmAccessReader>{
 const actor=request(input);need(typeof connect==='function'&&options&&typeof options==='object'&&!Array.isArray(options)&&Reflect.ownKeys(options).every(k=>k==='clock'),'INPUT');
 const clock=options.clock??(()=>new Date());need(typeof clock==='function','INPUT');
 // Capture the original server observation BEFORE RPC; a slow provider or lock
 // wait cannot obtain a fabricated fresh timestamp. Copy the mutable Date too.
 let observedAt:string,read:ReturnType<typeof createSeekerRealmAccessSnapshotReader>,expected:{genesis:string;program:string;developer:string;deploymentSlot:number;programHash:string;upgrader:string|null;config:string;access:string};
 try{
  const observed=clock();need(observed instanceof Date&&Number.isFinite(observed.getTime()),'INPUT');observedAt=new Date(observed.getTime()).toISOString();instant(observedAt);
  read=createSeekerRealmAccessSnapshotReader(connect,trust);
  expected={genesis:trust.expectedGenesisHash,program:trust.programId.toBase58(),developer:trust.developer.toBase58(),deploymentSlot:trust.reviewedDeploymentSlot,
   programHash:trust.reviewedProgramDataSha256,upgrader:trust.upgradeAuthority?.toBase58()??null,
   config:realmSaleConfigPda(trust.programId).toBase58(),access:realmAccessPda(trust.programId,new PublicKey(actor.wallet),actor.realm).toBase58()};
 }catch{throw new ExpeditionRealmAccessError('INPUT');}
 let snapshot:SeekerRealmAccessSnapshot;
 try{snapshot=await read({wallet:new PublicKey(actor.wallet),realm:actor.realm});}
 catch(error){if(error instanceof SeekerRealmAccessSnapshotError)throw new ExpeditionRealmAccessError(error.code==='UNAVAILABLE'||error.code==='DEADLINE'?'UNAVAILABLE':'SOURCE');throw new ExpeditionRealmAccessError('UNAVAILABLE');}
 const s=snapshot.source,a=snapshot.access;
 need(snapshot.wallet===actor.wallet&&snapshot.realm===actor.realm&&!snapshot.receiptRequested&&snapshot.receipt===null&&s.accounts.length===5
  &&s.genesisHash===expected.genesis&&s.programId===expected.program&&s.reviewedDeploymentSlot===expected.deploymentSlot&&s.reviewedProgramDataSha256===expected.programHash&&s.upgradeAuthority===expected.upgrader
  &&snapshot.config.address===expected.config&&snapshot.config.developer===expected.developer&&s.accounts[3]!.address===expected.access,'SOURCE');
 let proof:ExpeditionRealmAccessObservation|null=null;
 if(a!==null){
  need(snapshot.accessState==='initialized'&&a.address===expected.access&&a.config===expected.config&&a.wallet===actor.wallet&&a.realm===actor.realm&&snapshot.expiresAt===a.expiresAt,'SOURCE');
  proof=Object.freeze({version:1 as const,...actor,accessAddress:a.address,configAddress:a.config,expiresAt:a.expiresAt.toString(),
   finality:Object.freeze({commitment:'finalized' as const,contextSlot:String(snapshot.slot),observedAt,chainUnixTimestamp:snapshot.unixTimestamp.toString()}),
   source:Object.freeze({...s,accounts:Object.freeze(s.accounts.map(row=>Object.freeze({...row})))})});
  observations.set(proof,actor);
 }else need(snapshot.accessState==='absent'||snapshot.accessState==='uninitialized','SOURCE');
 let consumed=false;
 return Object.freeze({async readCoverage(departureAt:string):Promise<ExpeditionRealmAccessObservation>{
  need(!consumed,'CONSUMED');consumed=true;
  // A stale absent-account observation is not evidence of current no coverage.
  if(!proof){freshAt(observedAt,snapshot.unixTimestamp.toString(),departureAt);throw new ExpeditionRealmAccessError('NO_COVERAGE');}
  return assertExpeditionRealmAccessAtDeparture(proof,actor,departureAt);
 }});
}
