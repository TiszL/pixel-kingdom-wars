import {PublicKey} from '@solana/web3.js';
import {MiningClaimContinuationSchema,MiningClaimPrepareRequestSchema,MiningClaimPreparationViewSchema,MiningClaimViewSchema,type MiningClaimContinuation,type MiningClaimPrepareRequest,type MiningClaimPreparationView,type MiningClaimView} from '@shardkeep/shared/miningClaimsApi';
import {verifySignedMiningClaim,type SignedMiningClaim} from './signing';
export type MiningClaimIdentity={origin:string;api:string;cluster:'devnet'|'mainnet-beta';wallet:string};
export type MiningClaimPrepareRefusal={status:number;code:string};
export type MiningClaimStep={signingStarted:boolean;signed:SignedMiningClaim|null;submitAttempted:boolean};
export type MiningClaimOrdered={remainder:MiningClaimStep;held:boolean;continuationRequest:{idempotencyKey:string}|null;continuationAttempted:boolean;continuationRefusal:MiningClaimPrepareRefusal|null;continuationAbsent:boolean;refusedContinuations:{idempotencyKey:string;status:number;code:string}[];continuation:MiningClaimContinuation|null};
export const emptyMiningStep=():MiningClaimStep=>({signingStarted:false,signed:null,submitAttempted:false});
export const emptyMiningOrdered=():MiningClaimOrdered=>({remainder:emptyMiningStep(),held:false,continuationRequest:null,continuationAttempted:false,continuationRefusal:null,continuationAbsent:false,refusedContinuations:[],continuation:null});
export function miningClaimOrdinal(op:MiningClaimOperation):number{return op.preparation?.version===2&&op.preparation.transactions.length===2&&op.claim?.transactions[0]?.landing==='finalized'?1:0;}
export function miningClaimStep(op:MiningClaimOperation,ordinal=miningClaimOrdinal(op)):MiningClaimStep{return ordinal===1?op.ordered!.remainder:op;}
export function withMiningStep(op:MiningClaimOperation,ordinal:number,change:Partial<MiningClaimStep>):MiningClaimOperation{return ordinal===1?{...op,ordered:{...op.ordered!,remainder:{...op.ordered!.remainder,...change}}}:{...op,...change};}
export function continuedMiningOperation(link:MiningClaimContinuation):MiningClaimOperation{return {request:{idempotencyKey:link.childPreparation.idempotencyKey,profile:'ordered-v0'},prepareAttempted:true,prepareRefusal:null,refusalConfirmedAbsent:false,preparation:link.childPreparation,signingStarted:false,signed:null,submitAttempted:false,claim:null,ordered:emptyMiningOrdered()};}
export type MiningClaimOperation={request:MiningClaimPrepareRequest;prepareAttempted:boolean;prepareRefusal:MiningClaimPrepareRefusal|null;refusalConfirmedAbsent:boolean;preparation:MiningClaimPreparationView|null;signingStarted:boolean;signed:SignedMiningClaim|null;submitAttempted:boolean;claim:MiningClaimView|null;ordered?:MiningClaimOrdered};
export type MiningClaimJournal={version:1;identity:MiningClaimIdentity;revision:number;operation:MiningClaimOperation|null;archives:MiningClaimOperation[]};
export const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
export function sameMiningContinuation(a:MiningClaimContinuation,b:MiningClaimContinuation):boolean{const stable=(v:MiningClaimContinuation)=>({...v,parentPreparation:{...v.parentPreparation,serverNow:null},childPreparation:{...v.childPreparation,serverNow:null}});return same(stable(a),stable(b));}
function need(v:unknown,message:string):asserts v{if(!v)throw new Error(message);}
function exact(raw:unknown,keys:readonly string[]):Record<string,unknown>{
 need(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).length===keys.length&&keys.every(k=>Object.hasOwn(raw,k)),'Invalid saved mining claim fields.');return raw as Record<string,unknown>;
}
const PREPARE_REFUSALS:Readonly<Record<string,number>>={INVALID_INPUT:400,INSUFFICIENT_SOL:422,CLAIM_ROOT_PENDING:409,CLAIM_BLOCKHASH_REUSED:409,PHASE_E_DISABLED:503};
export function miningClaimPrepareRefusalDefinitive(status:number,code:string):boolean{return Object.hasOwn(PREPARE_REFUSALS,code)&&PREPARE_REFUSALS[code]===status;}
export function miningClaimArchivableFailure(op:MiningClaimOperation):boolean{return op.claim?.state==='failed'&&(op.preparation?.transactions.length===1||!!op.ordered&&op.claim.transactions[0]?.landing==='failed'&&!op.ordered.remainder.signingStarted&&op.claim.transactions[1]?.signature===null);}
export function miningContinuationRefusalDefinitive(status:number,code:string):boolean{return ['MINING_CLAIM_INVALID_INPUT','MINING_CLAIM_NOT_PREPARED'].includes(code)?status===400:['MINING_CLAIM_NOT_EXPIRED','MINING_CLAIM_SETUP_REQUIRED','MINING_CLAIM_PARENT_SIGNED','MINING_CLAIM_DISABLED'].includes(code)&&status===409;}
function resolved(op:MiningClaimOperation):boolean{if(op.ordered?.held)return false;return !!op.ordered?.continuation||op.claim?.state==='settled'||miningClaimArchivableFailure(op)||op.prepareRefusal!==null&&op.refusalConfirmedAbsent&&op.preparation===null&&op.signed===null&&op.claim===null;}
function sameView(a:MiningClaimPreparationView|MiningClaimView,b:MiningClaimPreparationView|MiningClaimView):boolean{return same({...a,serverNow:null},{...b,serverNow:null});}
function sameOperation(a:MiningClaimOperation,b:MiningClaimOperation):boolean{
 const canonical=(o:MiningClaimOperation)=>({...o,preparation:o.preparation?{...o.preparation,serverNow:null}:null,claim:o.claim?{...o.claim,serverNow:null}:null});
 return same(canonical(a),canonical(b));
}
export function parseMiningClaimIdentity(raw:unknown):MiningClaimIdentity{
 const r=exact(raw,['origin','api','cluster','wallet']);need(typeof r.origin==='string'&&r.origin.length<=2048&&typeof r.api==='string'&&r.api.length<=2048&&(r.cluster==='devnet'||r.cluster==='mainnet-beta'),'Invalid mining claim scope.');
 const origin=new URL(r.origin),api=new URL(r.api);
 need(['http:','https:'].includes(origin.protocol)&&['http:','https:'].includes(api.protocol)&&origin.origin===r.origin&&!api.username&&!api.password&&!api.search&&!api.hash&&api.href.replace(/\/$/,'')===r.api,'Invalid mining claim origin or API scope.');
 need(typeof r.wallet==='string'&&r.wallet.length>=32&&r.wallet.length<=44&&new PublicKey(r.wallet).toBase58()===r.wallet,'Invalid mining claim wallet.');
 return Object.freeze({origin:r.origin,api:r.api,cluster:r.cluster,wallet:r.wallet});
}
function parseOperation(raw:unknown,identity:MiningClaimIdentity):MiningClaimOperation{
 const orderedRaw=raw&&typeof raw==='object'&&Object.hasOwn(raw,'ordered');
 const r=exact(raw,['request','prepareAttempted','prepareRefusal','refusalConfirmedAbsent','preparation','signingStarted','signed','submitAttempted','claim',...(orderedRaw?['ordered']:[])]),request=MiningClaimPrepareRequestSchema.parse(r.request);
 need(typeof r.prepareAttempted==='boolean'&&typeof r.refusalConfirmedAbsent==='boolean'&&typeof r.signingStarted==='boolean'&&typeof r.submitAttempted==='boolean','Invalid mining claim attempt marker.');
 let prepareRefusal:MiningClaimPrepareRefusal|null=null;
 if(r.prepareRefusal!==null){const refusal=exact(r.prepareRefusal,['status','code']);need(r.prepareAttempted&&typeof refusal.status==='number'&&typeof refusal.code==='string'&&miningClaimPrepareRefusalDefinitive(refusal.status,refusal.code),'Invalid original prepare refusal.');prepareRefusal={status:refusal.status,code:refusal.code};}
 need(!r.refusalConfirmedAbsent||prepareRefusal!==null,'Absence recovery requires a definitive original refusal.');
 need((request.profile==='ordered-v0')===!!orderedRaw,'Ordered custody requires explicit original profile.');
 const preparation=r.preparation===null?null:MiningClaimPreparationViewSchema.parse(r.preparation);
 if(preparation)need((preparation.version===2)===(request.profile==='ordered-v0')&&r.prepareAttempted&&preparation.wallet===identity.wallet&&preparation.idempotencyKey===request.idempotencyKey,'Mining claim preparation differs from the original wallet or key.');
 need(!r.signingStarted||preparation!==null,'Signing requires the original reviewed preparation.');
 let signed:SignedMiningClaim|null=null;
 if(r.signed!==null){
  need(preparation&&r.signingStarted,'A signature requires the original signing marker.');const saved=exact(r.signed,['ordinal','wire','signature']),verified=verifySignedMiningClaim(preparation,saved.wire);
  need(verified.ordinal===saved.ordinal&&verified.signature===saved.signature,'Retained mining claim signature identity is invalid.');signed={ordinal:verified.ordinal,wire:verified.wire,signature:verified.signature};
 }
 need(!r.submitAttempted||signed!==null,'Submission requires the exact retained signed wire.');
 let ordered:MiningClaimOrdered|undefined;
 if(orderedRaw){
  const o=exact(r.ordered,['remainder','held','continuationRequest','continuationAttempted','continuationRefusal','continuationAbsent','refusedContinuations','continuation']),step=exact(o.remainder,['signingStarted','signed','submitAttempted']);
  need(typeof step.signingStarted==='boolean'&&typeof step.submitAttempted==='boolean'&&typeof o.held==='boolean'&&typeof o.continuationAttempted==='boolean','Invalid ordered custody marker.');
  let remainderSigned:SignedMiningClaim|null=null;
  if(step.signed!==null){const saved=exact(step.signed,['ordinal','wire','signature']);need(preparation?.version===2&&step.signingStarted,'Remainder signature lacks original consent.');remainderSigned=verifySignedMiningClaim(preparation,saved.wire,1);need(saved.ordinal===1&&saved.signature===remainderSigned.signature,'Remainder signature changed.');}
  need(!step.submitAttempted||remainderSigned,'Remainder relay requires retained bytes.');
  need(!step.signingStarted||preparation?.transactions.length===2,'Remainder needs the original split preparation.');
  const request=o.continuationRequest===null?null:MiningClaimPrepareRequestSchema.parse(o.continuationRequest);
  need(!request?.profile&&(!o.continuationAttempted||request),'Continuation needs a durable independent key.');
  const continuation=o.continuation===null?null:MiningClaimContinuationSchema.parse(o.continuation);
  if(continuation)need(preparation&&o.continuationAttempted&&request?.idempotencyKey===continuation.childPreparation.idempotencyKey&&sameView(preparation,continuation.parentPreparation),'Continuation differs from original custody.');
  need(typeof o.continuationAbsent==='boolean'&&Array.isArray(o.refusedContinuations),'Invalid continuation recovery history.');
  const parseRefusal=(raw:unknown)=>{const r=exact(raw,['status','code']);need(typeof r.status==='number'&&typeof r.code==='string'&&miningContinuationRefusalDefinitive(r.status,r.code),'Invalid continuation refusal.');return {status:r.status,code:r.code};};
  const continuationRefusal=o.continuationRefusal===null?null:parseRefusal(o.continuationRefusal);
  need(!continuationRefusal||o.continuationAttempted,'Continuation refusal requires attempt.');need(!o.continuationAbsent||continuationRefusal,'Unknown recovery alone is not a refusal.');
  const refusedContinuations=o.refusedContinuations.map(raw=>{const a=exact(raw,['idempotencyKey','status','code']),r=MiningClaimPrepareRequestSchema.parse({idempotencyKey:a.idempotencyKey});return {...r,...parseRefusal({status:a.status,code:a.code})};});
  const keys=[...refusedContinuations.map(a=>a.idempotencyKey),...(request?[request.idempotencyKey]:[])];need(new Set(keys).size===keys.length,'Continuation attempt keys cannot be reused.');
  ordered={remainder:{signingStarted:step.signingStarted,signed:remainderSigned,submitAttempted:step.submitAttempted},held:o.held,continuationRequest:request,continuationAttempted:o.continuationAttempted,continuationRefusal,continuationAbsent:o.continuationAbsent,refusedContinuations,continuation};
 }
 const claim=r.claim===null?null:MiningClaimViewSchema.parse(r.claim);
 if(claim){
  need(preparation&&claim.state!=='unknown'&&claim.wallet===identity.wallet&&claim.claimId===preparation.claimId&&claim.transactions.length===preparation.transactions.length,'Only original positive claim recovery is durable.');
  for(const [i,t] of claim.transactions.entries())need(t.ordinal===i&&t.kind===preparation.transactions[i]!.kind,'Claim transaction order differs from the original preparation.');
  for(const wire of [signed,ordered?.remainder.signed])if(wire){const t=claim.transactions[wire.ordinal];need(t&&(t.signature===null||t.signature===wire.signature),'Recovered signature differs from the retained original.');}
  if(claim.settledBaseUnits!==null){const amount=BigInt(claim.settledBaseUnits),cumulative=BigInt(preparation.leaf.cumulativeKeepBaseUnits);need(amount>0n&&amount<=cumulative,'Claim payment exceeds the original allocation.');if(preparation.needsMinerRecords&&preparation.transactions.length===1)need(amount===cumulative,'A new claim record must pay the complete original allocation.');}
 }
 return {request,prepareAttempted:r.prepareAttempted,prepareRefusal,refusalConfirmedAbsent:r.refusalConfirmedAbsent,preparation,signingStarted:r.signingStarted,signed,submitAttempted:r.submitAttempted,claim,...(ordered?{ordered}:{})};
}
export function parseMiningClaimJournal(raw:unknown,identity:MiningClaimIdentity):MiningClaimJournal{
 const r=exact(raw,['version','identity','revision','operation','archives']),owned=parseMiningClaimIdentity(identity);
 need(r.version===1&&same(parseMiningClaimIdentity(r.identity),owned)&&Number.isSafeInteger(r.revision)&&(r.revision as number)>=0&&Array.isArray(r.archives),'Invalid mining claim journal.');
 need(r.archives.length<=(r.revision as number),'Invalid mining claim archive revision.');
 const operation=r.operation===null?null:parseOperation(r.operation,owned),archives=r.archives.map(a=>{const op=parseOperation(a,owned);need(resolved(op),'Only settled, verified single-transaction failures or definitively refused absent mining claims may be archived.');return op;});
 need((r.revision as number)>0||operation===null&&archives.length===0,'Original intent requires a durable revision.');
 const keys=[...archives,...(operation?[operation]:[])].map(op=>op.request.idempotencyKey);need(new Set(keys).size===keys.length,'Original mining claim keys cannot be reused.');
 return {version:1,identity:owned,revision:r.revision as number,operation,archives};
}
function preserveClaim(a:MiningClaimView,b:MiningClaimView):void{
 const rank={unknown:0,prepared:1,retained:2,settled:3,failed:3},splitFailure=a.state==='failed'&&a.transactions.length===2;need(rank[b.state]>=(splitFailure?2:rank[a.state])&&a.transactions.length===b.transactions.length,'Mining claim recovery cannot regress.');
 if(a.state==='settled')need(b.state==='settled'&&a.signature===b.signature&&a.settledBaseUnits===b.settledBaseUnits&&a.landing===b.landing,'Final claim payment changed or disappeared.');
 if(a.state==='failed'&&!splitFailure)need(sameView(a,b),'Verified failed claim receipt changed or disappeared.');
 for(const [i,t] of a.transactions.entries()){
  const next=b.transactions[i]!;need(t.ordinal===next.ordinal&&t.kind===next.kind,'Original claim transaction changed.');
  if(t.signature!==null)need(t.signature===next.signature&&t.acceptedAt===next.acceptedAt,'Retained claim signature changed or disappeared.');
  if(t.landing==='finalized'||t.landing==='failed')need(same(t,next),'Original terminal claim receipt changed or disappeared.');
 }
}
function preserves(a:MiningClaimOperation,b:MiningClaimOperation):void{
 need(same(a.request,b.request),'Original mining claim request changed.');
 for(const key of ['prepareAttempted','refusalConfirmedAbsent','signingStarted','submitAttempted'] as const)need(!a[key]||b[key],'An original mining claim attempt marker cannot clear.');
 if(a.prepareRefusal)need(same(a.prepareRefusal,b.prepareRefusal),'Original mining claim refusal changed or disappeared.');
 if(a.preparation){need(b.preparation&&sameView(a.preparation,b.preparation),'Original mining claim preparation changed or disappeared.');b.preparation=structuredClone(a.preparation);}
 if(a.signed)need(same(a.signed,b.signed),'Original signed mining claim bytes changed or disappeared.');
 if(a.ordered){
  const x=a.ordered,y=b.ordered;need(y,'Ordered custody disappeared.');
  need(!x.held||y.held,'A terminal safety hold cannot clear.');
  for(const k of ['signingStarted','submitAttempted'] as const)need(!x.remainder[k]||y.remainder[k],'Original remainder marker cannot clear.');
  if(x.remainder.signed)need(same(x.remainder.signed,y.remainder.signed),'Original remainder wire changed.');
  const retry=y.refusedContinuations.length===x.refusedContinuations.length+1;
  need(y.refusedContinuations.length>=x.refusedContinuations.length&&y.refusedContinuations.length<=x.refusedContinuations.length+1&&x.refusedContinuations.every((r,i)=>same(r,y.refusedContinuations[i])),'Original refused attempts changed.');
  if(retry)need(x.continuationRequest&&x.continuationRefusal&&x.continuationAbsent&&!x.continuation&&same(y.refusedContinuations.at(-1),{...x.continuationRequest,...x.continuationRefusal})&&y.continuationRequest&&y.continuationRequest.idempotencyKey!==x.continuationRequest.idempotencyKey&&!y.continuationAttempted&&!y.continuationRefusal&&!y.continuationAbsent&&!y.continuation,'Explicit retry requires definitive refusal and checked absence.');
  else{if(x.continuationRequest)need(same(x.continuationRequest,y.continuationRequest),'Original continuation key changed.');need(!x.continuationAttempted||y.continuationAttempted,'Continuation attempt disappeared.');if(x.continuationRefusal)need(same(x.continuationRefusal,y.continuationRefusal),'Continuation refusal changed.');need(!x.continuationAbsent||y.continuationAbsent,'Checked continuation absence disappeared.');}
  if(x.continuation)need(same(x.continuation,y.continuation),'Immutable continuation changed.');
 }
 if(a.claim){need(b.claim,'Original mining claim recovery disappeared.');preserveClaim(a.claim,b.claim);}
}
function assertTransition(old:MiningClaimJournal,next:MiningClaimJournal):void{
 need(next.archives.length>=old.archives.length&&next.archives.length<=old.archives.length+1,'Original mining claim archives cannot disappear.');
 for(const [i,a] of old.archives.entries()){need(sameOperation(a,next.archives[i]!),'An archived original mining claim changed.');next.archives[i]=structuredClone(a);}
 const a=old.operation,b=next.operation;
 if(next.archives.length>old.archives.length){need(a&&resolved(a)&&(a.ordered?.continuation?!a.ordered.held&&same(b,continuedMiningOperation(a.ordered.continuation)):b===null)&&sameOperation(next.archives.at(-1)!,a),'Only the exact resolved original mining claim may be archived.');next.archives[next.archives.length-1]=structuredClone(a);return;}
 if(!a){if(b)need((!b.ordered||same(b.ordered,emptyMiningOrdered()))&&!b.prepareAttempted&&!b.prepareRefusal&&!b.refusalConfirmedAbsent&&!b.preparation&&!b.signingStarted&&!b.signed&&!b.submitAttempted&&!b.claim,'Save original mining claim intent before attempts or evidence.');return;}
 need(b,'Original mining claim intent cannot disappear.');preserves(a,b);
 if(a.ordered&&b.ordered){
  const x=a.ordered,y=b.ordered;
  const admitted=!x.held&&!x.continuationRequest&&!x.continuation&&!a.claim?.transactions.some(t=>t.landing==='failed')&&a.claim?.state!=='settled';
  if(!a.signingStarted&&b.signingStarted||!a.submitAttempted&&b.submitAttempted)need(admitted,'Held or continued original cannot act.');
  if(!x.remainder.signingStarted&&y.remainder.signingStarted)need(admitted&&a.claim?.transactions[0]?.landing==='finalized'&&a.signed&&a.claim.transactions[0].signature===a.signed.signature&&!y.remainder.signed&&!y.remainder.submitAttempted,'Finalized original setup precedes remainder consent.');
  if(!x.remainder.signed&&y.remainder.signed)need(x.remainder.signingStarted,'Save remainder consent before wallet bytes.');
  if(!x.remainder.submitAttempted&&y.remainder.submitAttempted)need(admitted&&x.remainder.signed,'Retain remainder before relay.');
  if(!x.continuationRequest&&y.continuationRequest)need(!x.held&&a.preparation&&!y.continuationAttempted&&!y.continuation,'Save continuation intent before sending.');
  if(!x.continuationAttempted&&y.continuationAttempted)need(x.continuationRequest&&!y.continuation,'Save continuation attempt before its result.');
  if(!x.continuationRefusal&&y.continuationRefusal)need(x.continuationAttempted&&!x.continuation&&!y.continuationAbsent,'Retain original refusal before checking absence.');
  if(!x.continuationAbsent&&y.continuationAbsent)need(x.continuationRefusal&&!x.continuation&&!y.continuation,'Refused absence requires the original refusal.');
  if(!x.continuation&&y.continuation)need(x.continuationAttempted,'Continuation result requires original attempt.');
 }
 if(!a.prepareAttempted&&b.prepareAttempted)need(!b.prepareRefusal&&!b.refusalConfirmedAbsent&&!b.preparation&&!b.signingStarted&&!b.signed&&!b.submitAttempted&&!b.claim,'Persist the original prepare attempt before its result.');
 if(!a.prepareRefusal&&b.prepareRefusal)need(a.prepareAttempted&&!a.preparation&&!a.signed&&!a.claim&&!b.preparation&&!b.signed&&!b.claim&&!b.refusalConfirmedAbsent,'Record only the definitive original prepare refusal.');
 if(!a.refusalConfirmedAbsent&&b.refusalConfirmedAbsent)need(a.prepareRefusal&&!a.preparation&&!a.signed&&!a.claim&&!b.preparation&&!b.signed&&!b.claim,'Confirm original refused absence before archival.');
 if(!a.preparation&&b.preparation)need(a.prepareAttempted,'Persist the original prepare attempt before its result.');
 if(!a.signingStarted&&b.signingStarted)need(a.preparation&&!b.signed&&!b.submitAttempted&&b.claim?.state!=='failed'&&b.claim?.state!=='settled','Persist signing start before receiving wallet bytes; terminal claims cannot sign again.');
 if(!a.signed&&b.signed)need(a.signingStarted,'Persist signing start before receiving wallet bytes.');
 if(!a.submitAttempted&&b.submitAttempted)need(a.signed&&b.claim?.state!=='failed'&&b.claim?.state!=='settled','Persist signed bytes before submission; terminal claims cannot submit again.');
}
export interface MiningClaimStore{
 readonly identity:MiningClaimIdentity;readonly key:string;
 read():Promise<MiningClaimJournal>;
 compareAndSet(revision:number,update:(old:MiningClaimJournal)=>MiningClaimJournal):Promise<MiningClaimJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet. Single-message verified
 * failures and definitive refused absence remain archived as unpaid evidence. */
export class MiningClaimJournalStore implements MiningClaimStore{
 readonly identity:MiningClaimIdentity;readonly key:string;private readonly database:Promise<IDBDatabase>;
 constructor(identity:MiningClaimIdentity,factory:IDBFactory|undefined=globalThis.indexedDB,name='pkw-mining-claim-v1'){
  this.identity=parseMiningClaimIdentity(identity);this.key=JSON.stringify(this.identity);
  this.database=new Promise((resolve,reject)=>{
   if(!factory){reject(new Error('Durable browser storage is unavailable. Mining claims cannot begin.'));return;}
   const request=factory.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('commands');
   request.onerror=()=>reject(request.error??new Error('Cannot open mining claim recovery.'));request.onblocked=()=>reject(new Error('Close older game tabs to open mining claim recovery.'));
   request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
  });void this.database.catch(()=>undefined);
 }
 private async transaction(revision:number|null,update?:(old:MiningClaimJournal)=>MiningClaimJournal):Promise<MiningClaimJournal>{
  if(revision!==null)need(Number.isSafeInteger(revision)&&revision>=0,'Invalid mining claim comparison revision.');
  const db=await this.database;return new Promise((resolve,reject)=>{
   const tx=db.transaction('commands',update?'readwrite':'readonly',update?{durability:'strict'}:undefined),store=tx.objectStore('commands'),read=store.get(this.key);let result:MiningClaimJournal,failure:unknown;
   read.onsuccess=()=>{try{
    const old:MiningClaimJournal=read.result===undefined?{version:1,identity:this.identity,revision:0,operation:null,archives:[]}:parseMiningClaimJournal(read.result,this.identity);
    if(revision!==null)need(revision===old.revision,'Another tab changed the original mining claim. Read its recovery record.');
    if(!update){result=old;return;}need(old.revision<Number.MAX_SAFE_INTEGER,'Mining claim revision exhausted.');
    result=parseMiningClaimJournal({...update(structuredClone(old)),revision:old.revision+1},this.identity);assertTransition(old,result);store.put(result,this.key);
   }catch(error){failure=error;tx.abort();}};
   tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>reject(failure??tx.error??new Error('The original mining claim did not save.'));
  });
 }
 read():Promise<MiningClaimJournal>{return this.transaction(null);}
 compareAndSet(revision:number,update:(old:MiningClaimJournal)=>MiningClaimJournal):Promise<MiningClaimJournal>{return this.transaction(revision,update);}
 async close():Promise<void>{(await this.database).close();}
}
