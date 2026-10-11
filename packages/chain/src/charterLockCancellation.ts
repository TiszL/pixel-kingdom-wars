/** D153.181 original complete exposure only. Generic receipts can close later;
 * absence is meaningful only together with the unchanged original revision/lock.
 * The private API loader and SQL own permanent IDs and complete inventory. */
import {copyTrust,record,ownArray,uuid,safeSlot,type CharterCreationEvidenceTrust,type CharterCreationEvidenceRpc} from './charterCreationAccounts';
import {copyCharterLockOriginal,lockCandidate,verifyLockSource,boundedLockWork,readLockBank,verifyLockCurrentBank,emptyLockAccount,lockPreparationNeed,type CharterLockOriginal,type CharterLockQuote} from './charterLockPreparation';
export interface CharterLockCancellationSaved {readonly original:CharterLockOriginal;readonly inventory:Readonly<{version:1;revision:string;count:number;messages:readonly string[]}>}
export interface CharterLockCancellationObservation extends CharterLockCancellationSaved {
 readonly version:1;readonly slot:number;readonly unixTimestamp:string;readonly outcome:'absent-after-expiry';
 readonly source:CharterLockQuote['observation']['source'];readonly entryAuthorized:false;readonly fenceReleaseAuthorized:false;
}
const need:typeof lockPreparationNeed=lockPreparationNeed;
function copySaved(value:unknown,trust?:CharterCreationEvidenceTrust){
 const s=record(value,'original inventory'),original=copyCharterLockOriginal(s.original,trust),i=record(s.inventory,'version revision count messages');
 need(i.version===1&&safeSlot(i.count)&&i.count<=256&&i.revision===String(i.count),'INVENTORY');
 const messages=ownArray(i.messages,256,'INPUT').map(v=>lockCandidate(original,v).candidate.toString('hex'));
 need(messages.length===i.count&&new Set(messages.map(m=>m.slice(146,178))).size===messages.length,'INVENTORY');
 return Object.freeze({original,inventory:Object.freeze({version:1 as const,revision:String(i.count),count:i.count,messages:Object.freeze(messages)})});
}
export function verifyCharterLockCancellation(value:unknown):CharterLockCancellationObservation{
 const r=record(value,'version original inventory slot unixTimestamp outcome source entryAuthorized fenceReleaseAuthorized');
 need(r.version===1&&r.entryAuthorized===false&&r.fenceReleaseAuthorized===false&&r.outcome==='absent-after-expiry'&&safeSlot(r.slot)&&typeof r.unixTimestamp==='string'&&/^[1-9][0-9]{0,18}$/.test(r.unixTimestamp),'INPUT');
 const saved=copySaved({original:r.original,inventory:r.inventory}),permits=saved.inventory.messages.map(m=>lockCandidate(saved.original,m));
 need(permits.every(p=>p.expiry<BigInt(r.unixTimestamp as string)),'LIVE_PERMIT');
 const source=verifyLockSource(r.source,saved.original,permits.map(p=>p.permitId));
 need([source.programs.economy,source.programs.craft,source.programs.core].every(p=>(r.slot as number)>=p.reviewedDeploymentSlot),'BANK');
 return Object.freeze({version:1,...saved,slot:r.slot,unixTimestamp:r.unixTimestamp,outcome:'absent-after-expiry',source,entryAuthorized:false,fenceReleaseAuthorized:false});
}
export function createCharterLockCancellationReader<Context=void>(connect:(signal:AbortSignal)=>CharterCreationEvidenceRpc,inputTrust:CharterCreationEvidenceTrust,load:(id:string,context:Context)=>Promise<CharterLockCancellationSaved|null>,options:{deadlineMs?:number}={}){
 const trust=copyTrust(inputTrust),run=boundedLockWork(options.deadlineMs);need(typeof connect==='function'&&typeof load==='function','INPUT');
 return async(idInput:string,context:Context):Promise<CharterLockCancellationObservation>=>{
  const id=uuid(idInput,'INPUT');return run(async(call,signal)=>{
   const saved=copySaved(await call(()=>load(id,context)),trust);need(saved.original.operation.id===id,'ORIGINAL');
   const permits=saved.inventory.messages.map(m=>lockCandidate(saved.original,m)),rpc=connect(signal),getSlot=rpc.getSlot.bind(rpc),getGenesis=rpc.getGenesisHash.bind(rpc);
   const bank=await readLockBank(rpc,trust,saved.original,permits.map(p=>p.permitId),call);verifyLockCurrentBank(bank);
   need(permits.every(p=>p.expiry<bank.unixTimestamp),'LIVE_PERMIT');need(bank.rows.slice(15).every(emptyLockAccount),'RECEIPT');
   const closing=await call(()=>getSlot('finalized'));need(safeSlot(closing)&&closing>=bank.slot&&await call(getGenesis)===trust.expectedGenesisHash,'BANK');
   return verifyCharterLockCancellation({version:1,...saved,slot:bank.slot,unixTimestamp:bank.unixTimestamp.toString(),outcome:'absent-after-expiry',source:bank.source,entryAuthorized:false,fenceReleaseAuthorized:false});
  });
 };
}
