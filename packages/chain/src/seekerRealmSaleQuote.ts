/** Finalized sale preparation source. RPC happens before database locks. Quotes
 * remain unsigned facts: a backend must persist/guard them and the program must
 * accept the final transaction atomically. No payment/admission authorization. */
import {createHash} from 'node:crypto';
import {Connection,PublicKey,Message,TransactionMessage,PACKET_DATA_SIZE,SystemProgram,SYSVAR_CLOCK_PUBKEY,type AccountInfo} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import {readFinalizedSeekerTerm,makeSeekerTermRpc,type ReviewedSeekerTermPolicy,type SeekerTermRpc} from './seekerTerms';
import {verifySeekerTermAccounts,type SeekerRawAccount} from './seekerTermAccounts';
import {seekerAuthorityPda,seekerRegistryPda,seekerTermPda,seekerAuctionPda} from './seekerAuctionProtocol';
import {createSeekerRealmAccessSnapshotReader,type SeekerRealmAccessRpc,type SeekerRealmAccessTrust,type SeekerRealmAccessSnapshot} from './seekerRealmAccessSnapshot';
import {REALM_SALE_ACCOUNT_BYTES,realmAccessPda,spotSalesQuotaPda,realmSaleReceiptPda,decodeSpotSalesQuota,
 createRealmSalePurchaseArgs,validateRealmSalePurchaseArgs,realmSaleConfigPda,buildOpenRealmAccessInstruction,buildOpenSpotSalesQuotaInstruction,buildBuyRealmAccessInstruction,
 type RealmSalePurchaseArgs} from './seekerRealmSaleProtocol';
const P=PHASE_E_POLICY.seekerIsland,DAY=BigInt(PHASE_E_MINING_PUBLICATION.daySec);
// RPC/packet work bounds, not game policy. Core term batching remains <=100.
const DEADLINE_MS=60_000,MAX_ACCOUNT_BYTES=8*1024*1024,MAX_BANK_BYTES=16*1024*1024;
export type SeekerRealmSaleQuoteErrorCode='INPUT'|'UNAVAILABLE'|'DEADLINE'|'TERM'|'IDENTITY'|'ACCOUNTS'|'PAUSED'|'UNSOLD'|'REALM'|'NO_QUOTA'|'ALREADY_RECORDED'|'STALE'|'COST'|'INSUFFICIENT_SOL'|'PACKET';
export class SeekerRealmSaleQuoteError extends Error {constructor(readonly code:SeekerRealmSaleQuoteErrorCode){super(`Seeker sale quote refused: ${code}`);this.name='SeekerRealmSaleQuoteError';}}
function need(v:unknown,code:SeekerRealmSaleQuoteErrorCode):asserts v {if(!v)throw new SeekerRealmSaleQuoteError(code);}
function exact(v:object,names:string){need(v&&typeof v==='object'&&!Array.isArray(v),'INPUT');const keys=Reflect.ownKeys(v),wanted=names.split(' ');need(keys.length===wanted.length&&keys.every(k=>typeof k==='string'&&wanted.includes(k)),'INPUT');}
function key(v:PublicKey,zero=false){try{need(v&&typeof v.toBytes==='function'&&typeof v.toBase58==='function','INPUT');const b=v.toBytes();need(b instanceof Uint8Array&&b.length===32,'INPUT');const p=new PublicKey(b);need(p.toBase58()===v.toBase58()&&(zero||!p.equals(PublicKey.default)),'INPUT');return p;}catch{throw new SeekerRealmSaleQuoteError('INPUT');}}
function safe(v:unknown,code:SeekerRealmSaleQuoteErrorCode):number {need(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0,code);return v;}
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
export type SeekerRealmSaleQuoteRpc=SeekerTermRpc & Pick<Connection,'getSlot'|'getLatestBlockhashAndContext'|'getFeeForMessage'|'getMinimumBalanceForRentExemption'|'getBlockHeight'>;
export interface SeekerRealmSaleQuotePolicy {readonly term:ReviewedSeekerTermPolicy;readonly access:SeekerRealmAccessTrust;readonly revision:string}
export interface SeekerRealmSaleQuoteRequest {readonly buyer:PublicKey;readonly spot:number;readonly realm:number}
export interface SeekerRealmSaleQuoteIdentity {readonly saleId:Uint8Array}
export interface SeekerRealmSaleQuoteOptions {readonly deadlineMs?:number}
/** Reuses the bounded finalized transport; no default provider or hidden retry. */
export function makeSeekerRealmSaleQuoteRpc(url:string,signal:AbortSignal):SeekerRealmSaleQuoteRpc {
 return makeSeekerTermRpc(url,signal) as SeekerRealmSaleQuoteRpc;
}
function copyRows(addresses:PublicKey[],rows:(AccountInfo<Buffer>|null)[]):(AccountInfo<Buffer>|null)[]{
 need(addresses.length<=100&&Array.isArray(rows)&&rows.length===addresses.length,'ACCOUNTS');let total=0;
 const copied=rows.map(row=>{if(row===null)return null;need(row&&row.data instanceof Uint8Array&&row.data.length<=MAX_ACCOUNT_BYTES&&typeof row.executable==='boolean','ACCOUNTS');
  total+=row.data.length;need(total<=MAX_BANK_BYTES,'ACCOUNTS');return {...row,owner:key(row.owner,true),lamports:safe(row.lamports,'ACCOUNTS'),data:Buffer.from(row.data)};});
 const seen=new Map<string,AccountInfo<Buffer>|null>();for(const [i,address] of addresses.entries()){const name=key(address).toBase58(),row=copied[i]!;
  if(seen.has(name)){const prior=seen.get(name)!;need(prior===null?row===null:row!==null&&prior.owner.equals(row.owner)&&prior.executable===row.executable&&prior.lamports===row.lamports&&prior.data.equals(row.data),'ACCOUNTS');}
  else seen.set(name,row);
 }return copied;
}
const raw=(address:PublicKey,row:AccountInfo<Buffer>|null|undefined):SeekerRawAccount=>{need(row,'ACCOUNTS');return {address:key(address),owner:key(row.owner,true),executable:row.executable,data:Buffer.from(row.data)};};
export function createSeekerRealmSaleQuoteReader(connect:(signal:AbortSignal)=>SeekerRealmSaleQuoteRpc,input:SeekerRealmSaleQuotePolicy,options:SeekerRealmSaleQuoteOptions={}) {
 need(typeof connect==='function','INPUT');exact(input,'term access revision');need(typeof input.revision==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(input.revision),'INPUT');
 need(options&&typeof options==='object'&&Reflect.ownKeys(options).every(k=>k==='deadlineMs'),'INPUT');const duration=safe(options.deadlineMs??DEADLINE_MS,'INPUT');need(duration>0&&duration<=DEADLINE_MS,'INPUT');
 const p=input.term;exact(p,'programId config round mint prizeOwner prizeAta genesisHash deployment stateProvenance');
 const policy:ReviewedSeekerTermPolicy=Object.freeze({...p,programId:key(p.programId),config:key(p.config),mint:key(p.mint),prizeOwner:key(p.prizeOwner),prizeAta:key(p.prizeAta),genesisHash:key(p.genesisHash),deployment:Object.freeze({...p.deployment})});
 const trust:SeekerRealmAccessTrust=Object.freeze({...input.access,programId:key(input.access.programId),developer:key(input.access.developer),upgradeAuthority:input.access.upgradeAuthority===null?null:key(input.access.upgradeAuthority)});
 const revision=input.revision;need(typeof policy.round==='bigint'&&policy.round>=0n&&policy.round<(1n<<64n),'INPUT');
 need(trust.programId.equals(policy.programId)&&trust.expectedGenesisHash===policy.genesisHash.toBase58()
  &&trust.reviewedProgramDataSha256===policy.deployment.programDataSha256&&(trust.upgradeAuthority?.toBase58()??null)===policy.deployment.upgradeAuthority,'IDENTITY');
 // Constructor validates immutable access trust before any external work.
 createSeekerRealmAccessSnapshotReader(()=>{throw new SeekerRealmSaleQuoteError('UNAVAILABLE');},trust,{deadlineMs:duration});
 return async function prepare(request:SeekerRealmSaleQuoteRequest,identity:SeekerRealmSaleQuoteIdentity){
  let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
  try{
   exact(request,'buyer spot realm');exact(identity,'saleId');const buyer=key(request.buyer),spot=safe(request.spot,'INPUT'),realm=safe(request.realm,'INPUT');
   need(spot<P.totalSpots&&realm<P.realmCount,'INPUT');need(identity.saleId instanceof Uint8Array&&identity.saleId.length===16&&identity.saleId.some(v=>v!==0),'INPUT');const saleId=Buffer.from(identity.saleId);
   realmAccessPda(policy.programId,buyer,realm);realmSaleReceiptPda(policy.programId,buyer,saleId);
   const check=()=>need(!controller.signal.aborted,'DEADLINE');
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new SeekerRealmSaleQuoteError('DEADLINE'));},duration);});
   const task=async()=>{
    const immutable=new Map<string,SeekerRawAccount>();
    const expectedAuctions=Array.from({length:P.totalSpots},(_,i)=>seekerAuctionPda(policy.programId,policy.config,i,policy.round));
    const termConnect=(signal:AbortSignal):SeekerTermRpc=>{
     const rpc=connect(AbortSignal.any([signal,controller.signal]));
     return {getGenesisHash:()=>rpc.getGenesisHash(),getSignaturesForAddress:(...a)=>rpc.getSignaturesForAddress(...a),getTransaction:(...a)=>rpc.getTransaction(...a),getBlock:rpc.getBlock.bind(rpc),
      getMultipleAccountsInfoAndContext:async(addresses,config)=>{
       need(addresses.length<=100,'ACCOUNTS');const response=await rpc.getMultipleAccountsInfoAndContext(addresses,config);check();const rows=copyRows(addresses,response.value);
       if(addresses.length===P.totalSpots){need(addresses.every((a,i)=>a.equals(expectedAuctions[i]!)),'IDENTITY');for(let i=0;i<rows.length;i++)immutable.set(addresses[i]!.toBase58(),raw(addresses[i]!,rows[i]));}
       return {...response,value:rows};
      }};
    };
    let original:Awaited<ReturnType<typeof readFinalizedSeekerTerm>>;
    try{original=await readFinalizedSeekerTerm(termConnect,policy,{deadlineMs:duration});}catch{check();throw new SeekerRealmSaleQuoteError('TERM');}
    check();need(original.deployment.deployedSlot===BigInt(trust.reviewedDeploymentSlot)&&immutable.size===P.totalSpots,'IDENTITY');
    need(original.finality.contextSlot<=BigInt(Number.MAX_SAFE_INTEGER),'ACCOUNTS');let floor=Number(original.finality.contextSlot);
    const originalSpot=original.auctions[spot]!;need(originalSpot.winner!==null,'UNSOLD');need((originalSpot.terms.realmMask&(1<<realm))!==0,'REALM');
    const seller=new PublicKey(originalSpot.winner),auctions=expectedAuctions.map(a=>immutable.get(a.toBase58())!);
    const termProofHash=hash(Buffer.from(json({source:original.source,term:original.term,registryHash:original.registryHash,completedSlot:original.completedSlot,
     auctions:original.auctions.map(a=>({auction:a.terms.auction,termsHash:a.termsHash,winner:a.winner,highBid:a.highBid,settledSlot:a.settledSlot,signature:a.settlement.signature}))})));
    async function admission(d?:bigint){
     // Day is obtained from the actual Clock in the first same-bank read. The
     // initial read can use a separately observed Clock only to choose its PDA;
     // the included actual Clock must match that day before any quote is issued.
     let targetDay=d;
     if(targetDay===undefined){
      const rpc=connect(controller.signal);need(await rpc.getGenesisHash()===trust.expectedGenesisHash,'IDENTITY');check();
      const r=await rpc.getMultipleAccountsInfoAndContext([SYSVAR_CLOCK_PUBKEY],{commitment:'finalized',minContextSlot:floor});check();
      const row=copyRows([SYSVAR_CLOCK_PUBKEY],r.value)[0];need(row&&row.data.length===40,'ACCOUNTS');
      const observed=safe(r.context.slot,'ACCOUNTS');need(observed>=floor,'ACCOUNTS');floor=observed;const now=row.data.readBigInt64LE(32);need(now>0n,'ACCOUNTS');targetDay=now/DAY;
     }
     const quotaAddress=spotSalesQuotaPda(policy.programId,spot,targetDay),extra=[seekerAuthorityPda(policy.programId),policy.config,seekerRegistryPda(policy.programId),
      seekerTermPda(policy.programId,policy.config,policy.round),quotaAddress,buyer,trust.developer];
     let bank:(AccountInfo<Buffer>|null)[]|undefined,bankSlot:number|undefined;const initBalances=new Map<string,bigint>();
     const reader=createSeekerRealmAccessSnapshotReader(signal=>{
      const rpc=connect(AbortSignal.any([signal,controller.signal]));return {getGenesisHash:()=>rpc.getGenesisHash(),getSlot:async()=>{const actual=safe(await rpc.getSlot('finalized'),'ACCOUNTS');need(actual>=floor,'ACCOUNTS');return actual;},
       getMultipleAccountsInfoAndContext:async(addresses,config)=>{
        const all=[...addresses,...extra];need(all.length<=100,'ACCOUNTS');const response=await rpc.getMultipleAccountsInfoAndContext(all,{...config,minContextSlot:Math.max(config.minContextSlot,floor)});check();
        const rows=copyRows(all,response.value);for(const index of [3,5,addresses.length+4]){const row=rows[index];initBalances.set(all[index]!.toBase58(),BigInt(row?.lamports??0));}bank=rows.slice(addresses.length);bankSlot=safe(response.context.slot,'ACCOUNTS');
        return {context:response.context,value:rows.slice(0,addresses.length).map((row,i)=>row===null?null:raw(addresses[i]!,row))};
       }} satisfies SeekerRealmAccessRpc;
     },trust,{deadlineMs:duration});
     let snapshot:SeekerRealmAccessSnapshot;try{snapshot=await reader({wallet:buyer,realm,saleId});}catch(error){check();if(error instanceof SeekerRealmSaleQuoteError)throw error;throw new SeekerRealmSaleQuoteError('ACCOUNTS');}
     check();need(bank&&bankSlot===snapshot.slot&&snapshot.slot>=floor,'ACCOUNTS');floor=snapshot.slot;
     need(snapshot.unixTimestamp/DAY===targetDay,'STALE');need(snapshot.receipt===null,'ALREADY_RECORDED');
     let current:ReturnType<typeof verifySeekerTermAccounts>;
     try{current=verifySeekerTermAccounts({...policy,operatingAt:snapshot.unixTimestamp},{authority:raw(extra[0]!,bank[0]),config:raw(extra[1]!,bank[1]),registry:raw(extra[2]!,bank[2]),term:raw(extra[3]!,bank[3]),auctions});}
     catch{throw new SeekerRealmSaleQuoteError('TERM');}
     need(!current.authority.admissionPaused,'PAUSED');need(current.term===original.term&&current.registryHash===original.registryHash&&current.completedSlot===original.completedSlot
      &&current.auctions[spot]!.winner===originalSpot.winner&&current.auctions[spot]!.termsHash===originalSpot.termsHash,'IDENTITY');
     const q=bank[4]===null||(bank[4]!.owner.equals(SystemProgram.programId)&&!bank[4]!.executable&&bank[4]!.data.length===0)?null:decodeSpotSalesQuota(raw(quotaAddress,bank[4]),{programId:policy.programId,spot,day:targetDay});need(q===null||q.sales<P.paidContractsPerSpotDayMax,'NO_QUOTA');
     const payer=bank[5],developer=bank[6];need(payer&&payer.owner.equals(SystemProgram.programId)&&!payer.executable&&payer.data.length===0,'ACCOUNTS');
     need(developer&&developer.owner.equals(SystemProgram.programId)&&!developer.executable&&developer.data.length===0,'ACCOUNTS');
     const bankHash=hash(Buffer.from(json({snapshot:snapshot.source,extra:bank.map((r,i)=>({address:extra[i]!.toBase58(),exists:r!==null,...r?{owner:r.owner.toBase58(),executable:r.executable,lamports:r.lamports,dataSha256:hash(r.data)}:{}}))})));
     return {snapshot,day:targetDay,payerLamports:BigInt(payer.lamports),quota:q,bankHash,initBalances};
    }
    const first=await admission();check();const validAfter=first.snapshot.unixTimestamp;
    const bounds=[validAfter+BigInt(PHASE_E_SEEKER_SALE.quoteTtlSec),(first.day+1n)*DAY-1n,original.operatingEnd-1n];const validUntil=bounds.reduce((a,b)=>a<b?a:b);
    need(validUntil>validAfter,'STALE');const args=createRealmSalePurchaseArgs({saleId,spot,realm,round:policy.round,day:first.day,seller,developer:trust.developer,
     priorExpiry:first.snapshot.access?.expiresAt??0n,validAfter,validUntil});
    const instructions=[];if(first.snapshot.access===null)instructions.push(buildOpenRealmAccessInstruction(policy.programId,{payer:buyer,wallet:buyer,realm}));
    if(first.quota===null)instructions.push(buildOpenSpotSalesQuotaInstruction(policy.programId,{payer:buyer,spot,day:first.day}));instructions.push(buildBuyRealmAccessInstruction(policy.programId,{buyer,args}));
    const rpc=connect(controller.signal);need(await rpc.getGenesisHash()===trust.expectedGenesisHash,'IDENTITY');check();
    const latest=await rpc.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:floor});check();const blockhashSlot=safe(latest.context.slot,'COST');need(blockhashSlot>=floor,'COST');
    const blockhash=new PublicKey(latest.value.blockhash).toBase58();need(blockhash===latest.value.blockhash&&blockhash!==PublicKey.default.toBase58(),'COST');
    const lastValidBlockHeight=safe(latest.value.lastValidBlockHeight,'COST');const message=new TransactionMessage({payerKey:buyer,recentBlockhash:blockhash,instructions}).compileToLegacyMessage();
    let messageBytes:Buffer;try{messageBytes=Buffer.from(message.serialize());}catch{throw new SeekerRealmSaleQuoteError('PACKET');}
    need(message.header.numRequiredSignatures===1&&message.accountKeys[0]?.equals(buyer)&&messageBytes.length+65<=PACKET_DATA_SIZE,'PACKET');
    const fee=await rpc.getFeeForMessage(Message.from(messageBytes),'finalized');check();const feeSlot=safe(fee.context.slot,'COST');need(feeSlot>=blockhashSlot,'COST');const feeLamports=BigInt(safe(fee.value,'COST'));
    const allocations=[{kind:'receipt' as const,address:realmSaleReceiptPda(policy.programId,buyer,saleId).toBase58(),bytes:REALM_SALE_ACCOUNT_BYTES.RealmSaleReceipt},
     ...first.snapshot.access===null?[{kind:'access' as const,address:realmAccessPda(policy.programId,buyer,realm).toBase58(),bytes:REALM_SALE_ACCOUNT_BYTES.RealmAccess}]:[],
     ...first.quota===null?[{kind:'quota' as const,address:spotSalesQuotaPda(policy.programId,spot,first.day).toBase58(),bytes:REALM_SALE_ACCOUNT_BYTES.SpotSalesQuota}]:[]];
    const rentMeasurements=[];for(const allocation of allocations){const rent=await rpc.getMinimumBalanceForRentExemption(allocation.bytes,'finalized');check();rentMeasurements.push({...allocation,minimumBalanceLamports:BigInt(safe(rent,'COST'))});}
    const currentHeight=safe(await rpc.getBlockHeight('finalized'),'COST');check();need(currentHeight<=lastValidBlockHeight,'COST');
    const costSlot=safe(await rpc.getSlot('finalized'),'COST');check();need(costSlot>=feeSlot,'COST');need(await rpc.getGenesisHash()===trust.expectedGenesisHash,'IDENTITY');check();floor=costSlot;
    const final=await admission(first.day);check();need(final.snapshot.unixTimestamp>=validAfter&&final.snapshot.unixTimestamp<=validUntil,'STALE');
    need((final.snapshot.access===null)===(first.snapshot.access===null)&&(final.snapshot.access?.expiresAt??0n)===args.priorExpiry&&(final.quota===null)===(first.quota===null),'STALE');
    const rents=rentMeasurements.map(r=>{const existingLamports=final.initBalances.get(r.address);need(existingLamports!==undefined,'ACCOUNTS');return Object.freeze({...r,existingLamports,lamports:r.minimumBalanceLamports>existingLamports?r.minimumBalanceLamports-existingLamports:0n});});const rentLamports=rents.reduce((sum,r)=>sum+r.lamports,0n);
    const price=BigInt(P.permitPriceLamports),bps=BigInt(PHASE_E_POLICY.basisPoints),sellerLeg=price*BigInt(P.contractSellerBps)/bps,devLeg=price*BigInt(P.contractDevBps)/bps;
    const paymentDebitLamports=price-(buyer.equals(seller)?sellerLeg:0n)-(buyer.equals(trust.developer)?devLeg:0n);need(paymentDebitLamports>=0n,'COST');
    const requiredLamports=paymentDebitLamports+feeLamports+rentLamports;need(requiredLamports<(1n<<64n),'COST');need(final.payerLamports>=requiredLamports,'INSUFFICIENT_SOL');
    const source=Object.freeze({revision,auctionConfig:policy.config.toBase58(),saleConfig:realmSaleConfigPda(policy.programId).toBase58(),genesisHash:trust.expectedGenesisHash,programId:policy.programId.toBase58(),programDataSha256:trust.reviewedProgramDataSha256,
     reviewedDeploymentSlot:trust.reviewedDeploymentSlot,termProofHash,snapshotHash:final.bankHash,termSlot:Number(original.finality.contextSlot),initialSlot:first.snapshot.slot,blockhashSlot,feeSlot,costSlot,admissionSlot:final.snapshot.slot});
    return Object.freeze({version:1 as const,buyer:buyer.toBase58(),spot,realm,term:original.term,round:policy.round,day:first.day,seller:seller.toBase58(),developer:trust.developer.toBase58(),
     priorExpiry:args.priorExpiry,validAfter,validUntil,get args(){return validateRealmSalePurchaseArgs(args);},blockhash,lastValidBlockHeight,quoteSlot:final.snapshot.slot,unixTimestamp:final.snapshot.unixTimestamp,messageSha256:hash(messageBytes),packetBytes:messageBytes.length+65,rents:Object.freeze(rents),feeLamports,rentLamports,paymentDebitLamports,requiredLamports,payerLamports:final.payerLamports,
     accessExists:final.snapshot.access!==null,quotaExists:final.quota!==null,quotaRemaining:P.paidContractsPerSpotDayMax-(final.quota?.sales??0),get messageBytes(){return Uint8Array.from(messageBytes);},
     source,paymentAuthorized:false as const,admissionAuthorized:false as const});
   };
   return await Promise.race([task(),deadline]);
  }catch(error){if(error instanceof SeekerRealmSaleQuoteError)throw error;throw new SeekerRealmSaleQuoteError('UNAVAILABLE');}
  finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
 };
}
export type SeekerRealmSaleQuote=Awaited<ReturnType<ReturnType<typeof createSeekerRealmSaleQuoteReader>>>;
