/** D153.176 original complete-exposure inventory only. Receipt presence is never
 * cancellation; unknown histories stay fenced and cannot reopen issuance. */
import {isDeepStrictEqual} from 'node:util';
import {PHASE_E_CHARTER_TRANSFER,PHASE_E_POLICY} from '@shardkeep/shared';
import {copyTrust,record,ownArray,uuid,safeSlot,type CharterCreationEvidenceTrust,type CharterCreationEvidenceRpc} from './charterCreationAccounts';
import {copyCharterTransferOriginal,transferCandidate,transferParts,verifyTransferSource,boundedTransferWork,readTransferBank,verifyTransferCurrentBank,emptyTransferAccount,transferPreparationNeed,CharterTransferPreparationError,type CharterTransferOriginal} from './charterTransferPreparation';
import {matchCharterTransferReceipt} from './charterTransferProtocol';
export interface CharterTransferCancellationSaved {
 readonly original:CharterTransferOriginal;
 readonly inventory:Readonly<{version:1;revision:string;count:number;messages:readonly string[]}>;
}
export interface CharterTransferCancellationObservation {
 readonly version:1;readonly original:CharterTransferOriginal;
 readonly inventory:CharterTransferCancellationSaved['inventory'];readonly slot:number;readonly unixTimestamp:string;
 readonly outcome:'absent-after-expiry'|'receipt-present';
 readonly receipt:Readonly<{transferId:string;fenceId:string;clanId:string;seller:string;buyer:string;treasury:string;priceLamports:string;
  sellerLamports:string;royaltyLamports:string;priorRevision:number;revision:number;termsHash:string;acceptedAt:string}>|null;
 readonly source:Readonly<{genesisHash:string;programs:CharterCreationEvidenceTrust;
  accounts:readonly Readonly<{address:string;owner:string|null;executable:boolean|null;dataSha256:string|null}>[]}>;
 readonly fenceReleaseAuthorized:false;readonly transferAuthorized:false;
}
export class CharterTransferCancellationError extends Error{constructor(readonly code:string){super('Charter transfer cancellation held: '+code);}}
const need:typeof transferPreparationNeed=transferPreparationNeed;
function copySaved(value:unknown,trust?:CharterCreationEvidenceTrust){
 const saved=record(value,'original inventory'),original=copyCharterTransferOriginal(saved.original,trust),i=record(saved.inventory,'version revision count messages');
 need(i.version===1&&safeSlot(i.count)&&i.count<=256&&i.revision===String(i.count),'INVENTORY');
 const messages=ownArray(i.messages,256,'INPUT').map(v=>transferCandidate(original,v).candidate.toString('hex'));
 need(messages.length===i.count&&new Set(messages.map(m=>m.slice(146,178))).size===messages.length,'INVENTORY');
 return Object.freeze({original,inventory:Object.freeze({version:1 as const,revision:String(i.count),count:i.count,messages:Object.freeze(messages)})});
}
function translated(e:unknown):never{if(e instanceof CharterTransferCancellationError)throw e;throw new CharterTransferCancellationError(e instanceof CharterTransferPreparationError?e.code:'INPUT');}
export function verifyCharterTransferCancellation(value:unknown):CharterTransferCancellationObservation{try{
 const r=record(value,'version original inventory slot unixTimestamp outcome receipt source fenceReleaseAuthorized transferAuthorized');
 need(r.version===1&&r.fenceReleaseAuthorized===false&&r.transferAuthorized===false&&safeSlot(r.slot)&&typeof r.unixTimestamp==='string'&&/^[1-9][0-9]{0,18}$/.test(r.unixTimestamp),'INPUT');
 const {original,inventory}=copySaved({original:r.original,inventory:r.inventory}),time=BigInt(r.unixTimestamp),source=verifyTransferSource(r.source,original,null);
 need([source.programs.economy,source.programs.craft,source.programs.core].every(p=>(r.slot as number)>=p.reviewedDeploymentSlot),'BANK');
 let receipt:CharterTransferCancellationObservation['receipt']=null;
 if(r.outcome==='absent-after-expiry'){
  need(r.receipt===null&&inventory.messages.every(m=>transferCandidate(original,m).expiry<time),'LIVE_PERMIT');
 }else{
  need(r.outcome==='receipt-present'&&inventory.count>0,'RECEIPT');const t=record(r.receipt,'transferId fenceId clanId seller buyer treasury priceLamports sellerLamports royaltyLamports priorRevision revision termsHash acceptedAt');
  need(typeof t.acceptedAt==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(t.acceptedAt)&&BigInt(t.acceptedAt)<=time,'RECEIPT');
  const s=original.sale,royalty=BigInt(s.priceLamports)*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/BigInt(PHASE_E_POLICY.basisPoints);
  receipt={transferId:s.id,fenceId:s.fenceId,clanId:original.creation.clanId,seller:s.seller,buyer:s.buyer,treasury:s.treasury,priceLamports:s.priceLamports,sellerLamports:(BigInt(s.priceLamports)-royalty).toString(),royaltyLamports:royalty.toString(),priorRevision:s.expectedRevision,revision:s.expectedRevision+1,termsHash:s.termsHash,acceptedAt:t.acceptedAt};
  need(isDeepStrictEqual(receipt,r.receipt),'RECEIPT');Object.freeze(receipt);
 }
 return Object.freeze({version:1,original,inventory,slot:r.slot,unixTimestamp:r.unixTimestamp,outcome:r.outcome as CharterTransferCancellationObservation['outcome'],receipt,source,fenceReleaseAuthorized:false,transferAuthorized:false});
}catch(e){return translated(e);}}
export function createCharterTransferCancellationReader<Context=void>(connect:(signal:AbortSignal)=>CharterCreationEvidenceRpc,inputTrust:CharterCreationEvidenceTrust,
 load:(id:string,context:Context)=>Promise<CharterTransferCancellationSaved|null>,options:{deadlineMs?:number}={}){
 const trust=copyTrust(inputTrust),run=boundedTransferWork(options.deadlineMs);need(typeof connect==='function'&&typeof load==='function','INPUT');
 return async(idInput:string,context:Context):Promise<CharterTransferCancellationObservation>=>{try{
  const id=uuid(idInput,'INPUT');return await run(async(call,signal)=>{
   const saved=copySaved(await call(()=>load(id,context)),trust);need(saved.original.sale.id===id,'ORIGINAL');
   const rpc=connect(signal),getSlot=rpc.getSlot.bind(rpc),getGenesis=rpc.getGenesisHash.bind(rpc),bank=await readTransferBank(rpc,trust,saved.original,null,call);
   let receipt:CharterTransferCancellationObservation['receipt']=null;
   if(emptyTransferAccount(bank.rows[16])){
    verifyTransferCurrentBank(bank);need(saved.inventory.messages.every(m=>transferCandidate(saved.original,m).expiry<bank.unixTimestamp),'LIVE_PERMIT');
   }else{
    const row=bank.rows[16]!,{domain,terms}=transferParts(saved.original);need(row.owner.equals(domain.economy)&&!row.executable,'RECEIPT');
    for(const message of saved.inventory.messages){try{receipt=matchCharterTransferReceipt(row.data,domain,terms,transferCandidate(saved.original,message).permitId);break;}catch{/* Only a complete original inventory candidate may match. */}}
    need(receipt&&BigInt(receipt.acceptedAt)<=bank.unixTimestamp,'RECEIPT');
   }
   const closing=await call(()=>getSlot('finalized'));need(safeSlot(closing)&&closing>=bank.slot&&await call(getGenesis)===trust.expectedGenesisHash,'BANK');
   return verifyCharterTransferCancellation({version:1,...saved,slot:bank.slot,unixTimestamp:bank.unixTimestamp.toString(),outcome:receipt?'receipt-present':'absent-after-expiry',receipt,source:bank.source,fenceReleaseAuthorized:false,transferAuthorized:false});
  });
 }catch(e){return translated(e);}};
}
