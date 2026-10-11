/** Pure public projections of already audited service records. No network, DB,
 * signing, publication, deployment attestation or send authority is exposed. */
import {MiningClaimStatusViewSchema,MiningClaimPreparationViewSchema,MiningClaimPreparationEnvelopeSchema,MiningClaimViewSchema,type MiningClaimStatusView,type MiningClaimPreparationView,type MiningClaimPreparationEnvelope,type MiningClaimView} from '@shardkeep/shared/miningClaimsApi';
import {decodeMiningAllocationLeaf,decodeMiningAllocationProof} from '@shardkeep/chain/mining-allocation';
import type {MiningClaimStatus} from './claimStatus';
import type {MiningClaimPreparation} from './claimPreparationStore';
import type {MiningClaimSigned} from './claimSignedStore';
import type {MiningClaimFailure} from './claimFailure';
import type {MiningClaimSettlement} from './claimSettlement';
export class MiningClaimHttpViewError extends Error{readonly code='SOURCE_CONFLICT';constructor(){super('Mining claim public source conflict');this.name='MiningClaimHttpViewError';}}
function need(v:unknown):asserts v{if(!v)throw new MiningClaimHttpViewError();}
function project<T>(fn:()=>T):T{try{return fn();}catch{throw new MiningClaimHttpViewError();}}
function hex(v:string,min:number,max:number):void{need(typeof v==='string'&&v.length>=min&&v.length<=max&&/^(?:[0-9a-f]{2})+$/.test(v));}
export function toMiningClaimStatusView(s:MiningClaimStatus,serverNow:string,identity?:{programId:string;keepMint:string;ordered?:1}):MiningClaimStatusView{
 return project(()=>MiningClaimStatusViewSchema.parse({features:{claims:{version:1,receipts:1,...(identity?.ordered?{ordered:1}:{})}},wallet:s.wallet,program:'shardkeep-economy',programId:identity?.programId??null,keepMint:identity?.keepMint??null,
  state:s.state,reason:s.reason??null,rootSequence:s.sequence??null,cumulativeKeepBaseUnits:s.cumulativeKeepBaseUnits??null,claimedBaseUnits:s.alreadyClaimedBaseUnits??null,claimableBaseUnits:s.amountBaseUnits??null,decimals:s.decimals,
  observedSlot:s.observedSlot??null,chainUnixTimestamp:s.chainUnixTimestamp??null,claimableAfterUnixTimestamp:s.claimableAfterUnixTimestamp??null,needsAta:s.needsAta??null,needsMinerRecords:s.needsMinerRecords??null,
  preparationAllowed:s.preparationAllowed,claimSubmissionAuthorized:s.claimSubmissionAuthorized,serverNow}));
}
export function toMiningClaimPreparationView(p:MiningClaimPreparation,serverNow:string):MiningClaimPreparationView{
 return project(()=>{
  hex(p.leafHex,130,130);hex(p.proofHex,8,1320);need(Array.isArray(p.transactions)&&p.transactions.length>=1&&p.transactions.length<=2);
  const leaf=decodeMiningAllocationLeaf(Buffer.from(p.leafHex,'hex')),proof=decodeMiningAllocationProof(Buffer.from(p.proofHex,'hex')),h=p.header;
  return MiningClaimPreparationViewSchema.parse({version:p.format?2:1,...(p.format?{format:p.format}:{}),wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,quoteId:p.claimId,quoteVersion:p.quoteVersion,rootSequence:h.sequence,day:h.day,root:h.root,totalCumulativeBaseUnits:h.totalCumulative,
   identity:{genesisHash:h.genesisHash,programId:h.programId,configAddress:h.configAddress,keepMint:h.keepMint,reserveOwner:h.reserveOwner},
   leaf:{wallet:leaf.wallet,rootSequence:leaf.sequence.toString(),cumulativeKeepBaseUnits:leaf.cumulativeKeep.toString(),cumulativeRenown:leaf.cumulativeRenown.toString(),cumulativeDays:leaf.cumulativeDays.toString()},
   proof:proof.map(n=>({hash:Buffer.from(n.hash).toString('hex'),sumBaseUnits:n.sum.toString(),isLeft:n.isLeft})),needsAta:p.needsAta,needsMinerRecords:p.needsMinerRecords,
   fees:{feeLamports:p.feeLamports,rentLamports:p.rentLamports,totalLamports:p.totalLamports,payerBalanceLamports:p.payerBalanceLamports},
   transactions:p.transactions.map((t,ordinal)=>{hex(t.messageHex,2,2334);return {ordinal,kind:t.kind,version:p.format?'v0':'legacy',message:Buffer.from(t.messageHex,'hex').toString('base64'),lookupTables:p.format?[p.format.lookupTable]:[],feePayer:p.wallet,blockhash:p.blockhash,lastValidBlockHeight:p.lastValidBlockHeight,feeLamports:t.feeLamports,rentLamports:t.rentLamports};}),
   preparedAt:p.preparedAt,expiresAt:p.expiresAt,serverNow,state:p.state,currentSigningAuthorized:p.currentSigningAuthorized,claimSubmissionAuthorized:p.claimSubmissionAuthorized});
 });
}
export function toMiningClaimPreparationEnvelope(input:{wallet:string;idempotencyKey:string;preparation:MiningClaimPreparation|null;serverNow:string}):MiningClaimPreparationEnvelope{
 return project(()=>MiningClaimPreparationEnvelopeSchema.parse({wallet:input.wallet,idempotencyKey:input.idempotencyKey,status:input.preparation?'prepared':'unknown',receipt:input.preparation?toMiningClaimPreparationView(input.preparation,input.serverNow):null,serverNow:input.serverNow}));
}
export function toMiningClaimView(input:{wallet:string;claimId:string;signed:MiningClaimSigned|null;settlements:readonly MiningClaimSettlement[];failures?:readonly MiningClaimFailure[];serverNow:string}):MiningClaimView{
 return project(()=>{
  const {signed,settlements}=input,failures=input.failures??[];need(Array.isArray(settlements)&&settlements.length<=2&&Array.isArray(failures)&&failures.length<=2);
  const base={version:1,wallet:input.wallet,claimId:input.claimId,serverNow:input.serverNow,claimSubmissionAuthorized:false};
  if(!signed){need(settlements.length===0&&failures.length===0);return MiningClaimViewSchema.parse({...base,state:'unknown',landing:'pending',signature:null,settledBaseUnits:null,transactions:[]});}
  const p=signed.preparation,view=toMiningClaimPreparationView(p,input.serverNow);need(p.wallet===input.wallet&&p.claimId===input.claimId&&Array.isArray(signed.wires)&&signed.wires.length<=p.transactions.length);
  const seen=new Set<number>();for(const w of signed.wires){need(Number.isInteger(w.ordinal)&&w.ordinal>=0&&w.ordinal<p.transactions.length&&!seen.has(w.ordinal));seen.add(w.ordinal);need(w.wallet===p.wallet&&w.claimId===p.claimId&&w.kind===p.transactions[w.ordinal]!.kind&&w.messageSha256===p.transactions[w.ordinal]!.messageSha256&&w.claimSubmissionAuthorized===false);}
  seen.clear();for(const s of settlements){need(Number.isInteger(s.ordinal)&&s.ordinal>=0&&s.ordinal<p.transactions.length&&!seen.has(s.ordinal));seen.add(s.ordinal);const w=signed.wires.find(w=>w.ordinal===s.ordinal),r=s.receipt,h=p.header;
   need(w&&s.wallet===p.wallet&&s.claimId===p.claimId&&s.signature===w.signature&&s.claimFinalized===true&&r.wallet===p.wallet&&r.signature===w.signature&&r.kind===w.kind&&r.root===h.root&&r.sequence===h.sequence&&r.day===h.day&&r.source.sourceHash===h.sourceHash
    &&r.source.genesisHash===h.genesisHash&&r.source.programId===h.programId&&r.source.configAddress===h.configAddress&&r.originalMessageSha256===w.messageSha256&&r.signedTransactionSha256===w.wireSha256&&r.currentClaimsAuthorized===false);
   need(typeof r.paidKeepBaseUnits==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(r.paidKeepBaseUnits));const paid=BigInt(r.paidKeepBaseUnits),cumulative=BigInt(view.leaf.cumulativeKeepBaseUnits);
   need(r.kind==='setup'?paid===0n:paid>0n&&paid<=cumulative);if(r.kind==='combined'&&p.needsMinerRecords)need(paid===cumulative);
  }
  for(const f of failures){need(Number.isInteger(f.ordinal)&&f.ordinal>=0&&f.ordinal<p.transactions.length&&!seen.has(f.ordinal));seen.add(f.ordinal);
   const w=signed.wires.find(w=>w.ordinal===f.ordinal),r=f.receipt,h=p.header;
   need(w&&f.wallet===p.wallet&&f.claimId===p.claimId&&f.signature===w.signature&&f.claimFailed===true&&r.wallet===p.wallet&&r.signature===w.signature&&r.kind===w.kind&&r.root===h.root&&r.sequence===h.sequence&&r.day===h.day
    &&r.source.sourceHash===h.sourceHash&&r.source.genesisHash===h.genesisHash&&r.source.programId===h.programId&&r.source.configAddress===h.configAddress&&r.originalMessageSha256===w.messageSha256&&r.signedTransactionSha256===w.wireSha256&&r.outcome==='failed'&&r.paymentAuthorized===false);
  }
  const transactions=p.transactions.map((t,ordinal)=>{const w=signed.wires.find(w=>w.ordinal===ordinal),s=settlements.find(s=>s.ordinal===ordinal),f=failures.find(f=>f.ordinal===ordinal);return {ordinal,kind:t.kind,signature:w?.signature??null,landing:s?'finalized':f?'failed':'pending',settledBaseUnits:s?.receipt.paidKeepBaseUnits??null,acceptedAt:w?.acceptedAt??null,settledAt:s?.settledAt??f?.verifiedAt??null};});
  const payment=transactions.find(t=>t.kind!=='setup'&&t.landing==='finalized'),signedTxs=transactions.filter(t=>t.signature!==null);
  const failed=!payment&&signedTxs.every(t=>t.landing!=='pending')?signedTxs.filter(t=>t.landing==='failed').at(-1):undefined,last=payment??failed??signedTxs.at(-1);
  return MiningClaimViewSchema.parse({...base,state:payment?'settled':failed?'failed':last?'retained':'prepared',landing:payment?'finalized':failed?'failed':'pending',signature:last?.signature??null,settledBaseUnits:payment?.settledBaseUnits??null,transactions});
 });
}
