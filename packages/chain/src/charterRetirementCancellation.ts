/** Original complete exposure only. Absence requires the permanent retirement
 * receipt and every exposed permit absent, with the original active revision.
 * The private API loader and SQL own permanent IDs and complete inventory. */
import {copyTrust,record,ownArray,uuid,safeSlot,type CharterCreationEvidenceTrust,type CharterCreationEvidenceRpc} from './charterCreationAccounts';
import {copyCharterRetirementOriginal,retirementCandidate,verifyRetirementSource,boundedRetirementWork,readRetirementBank,verifyRetirementCurrentBank,emptyRetirementAccount,retirementPreparationNeed,type CharterRetirementOriginal,type CharterRetirementQuote} from './charterRetirementPreparation';
export interface CharterRetirementCancellationSaved {readonly original:CharterRetirementOriginal;readonly inventory:Readonly<{version:1;revision:string;count:number;messages:readonly string[]}>}
export interface CharterRetirementCancellationObservation extends CharterRetirementCancellationSaved {
 readonly version:1;readonly slot:number;readonly unixTimestamp:string;readonly outcome:'absent-after-expiry';
 readonly source:CharterRetirementQuote['observation']['source'];readonly retirementAuthorized:false;readonly fenceReleaseAuthorized:false;
}
const need:typeof retirementPreparationNeed=retirementPreparationNeed;
function copySaved(value:unknown,trust?:CharterCreationEvidenceTrust){
 const s=record(value,'original inventory'),original=copyCharterRetirementOriginal(s.original,trust),i=record(s.inventory,'version revision count messages');
 need(i.version===1&&safeSlot(i.count)&&i.count<=1&&i.revision===String(i.count),'INVENTORY');
 const messages=ownArray(i.messages,1,'INPUT').map(v=>retirementCandidate(original,v).candidate.toString('hex'));
 need(messages.length===i.count&&new Set(messages.map(m=>m.slice(146,178))).size===messages.length,'INVENTORY');
 return Object.freeze({original,inventory:Object.freeze({version:1 as const,revision:String(i.count),count:i.count,messages:Object.freeze(messages)})});
}
export function verifyCharterRetirementCancellation(value:unknown):CharterRetirementCancellationObservation{
 const r=record(value,'version original inventory slot unixTimestamp outcome source retirementAuthorized fenceReleaseAuthorized');
 need(r.version===1&&r.retirementAuthorized===false&&r.fenceReleaseAuthorized===false&&r.outcome==='absent-after-expiry'&&safeSlot(r.slot)&&typeof r.unixTimestamp==='string'&&/^[1-9][0-9]{0,18}$/.test(r.unixTimestamp),'INPUT');
 const saved=copySaved({original:r.original,inventory:r.inventory}),permits=saved.inventory.messages.map(m=>retirementCandidate(saved.original,m));
 need(permits.every(p=>p.expiry<BigInt(r.unixTimestamp as string)),'LIVE_PERMIT');
 const source=verifyRetirementSource(r.source,saved.original,permits.map(p=>p.permitId));
 need([source.programs.economy,source.programs.craft,source.programs.core].every(p=>(r.slot as number)>=p.reviewedDeploymentSlot),'BANK');
 return Object.freeze({version:1,...saved,slot:r.slot,unixTimestamp:r.unixTimestamp,outcome:'absent-after-expiry',source,retirementAuthorized:false,fenceReleaseAuthorized:false});
}
export function createCharterRetirementCancellationReader<Context=void>(connect:(signal:AbortSignal)=>CharterCreationEvidenceRpc,inputTrust:CharterCreationEvidenceTrust,load:(id:string,context:Context)=>Promise<CharterRetirementCancellationSaved|null>,options:{deadlineMs?:number}={}){
 const trust=copyTrust(inputTrust),run=boundedRetirementWork(options.deadlineMs);need(typeof connect==='function'&&typeof load==='function','INPUT');
 return async(idInput:string,context:Context):Promise<CharterRetirementCancellationObservation>=>{
  const id=uuid(idInput,'INPUT');return run(async(call,signal)=>{
   const saved=copySaved(await call(()=>load(id,context)),trust);need(saved.original.retirement.id===id,'ORIGINAL');
   const permits=saved.inventory.messages.map(m=>retirementCandidate(saved.original,m)),rpc=connect(signal),getSlot=rpc.getSlot.bind(rpc),getGenesis=rpc.getGenesisHash.bind(rpc);
   const bank=await readRetirementBank(rpc,trust,saved.original,permits.map(p=>p.permitId),call);verifyRetirementCurrentBank(bank);
   need(permits.every(p=>p.expiry<bank.unixTimestamp),'LIVE_PERMIT');need(bank.rows.slice(15).every(emptyRetirementAccount),'RECEIPT');
   const closing=await call(()=>getSlot('finalized'));need(safeSlot(closing)&&closing>=bank.slot&&await call(getGenesis)===trust.expectedGenesisHash,'BANK');
   return verifyCharterRetirementCancellation({version:1,...saved,slot:bank.slot,unixTimestamp:bank.unixTimestamp.toString(),outcome:'absent-after-expiry',source:bank.source,retirementAuthorized:false,fenceReleaseAuthorized:false});
  });
 };
}
