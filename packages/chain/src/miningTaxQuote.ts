/** Finalized original-spot KEEP tax quote. This read-only measurement is not
 * signing authority: durable consent and fresh admission remain backend duties. */
import {createHash} from 'node:crypto';
import {Message,PublicKey,type Connection} from '@solana/web3.js';
import {createMiningTaxSnapshotReader,MiningTaxSnapshotError,type MiningTaxSnapshotRpc,type MiningTaxSnapshotTrust,type MiningTaxSnapshotRequest} from './miningTaxSnapshot';
import {buildMiningTaxMessages,quoteMiningTaxMessageCosts,MiningTaxMessageError,type MiningTaxCostCaps,type MiningTaxCostQuote} from './miningTaxMessage';

// Operational work limits, not game tuning or claim quotas.
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000,U64=(1n<<64n)-1n;
type Code='INPUT'|'UNAVAILABLE'|'TIMEOUT'|'BUSY'|'IDENTITY'|'COST'|'STALE';
export class MiningTaxQuoteError extends Error{constructor(readonly code:Code){super(`Mining tax quote refused: ${code}`);this.name='MiningTaxQuoteError';}}
function need(v:unknown,code:Code='INPUT'):asserts v{if(!v)throw new MiningTaxQuoteError(code);}
function exact(v:unknown,names:string){need(v&&typeof v==='object'&&!Array.isArray(v));const fields=names.split(' '),keys=Reflect.ownKeys(v);need(fields.length===keys.length&&keys.every(k=>typeof k==='string'&&fields.includes(k)));}
function safe(v:unknown,code:Code='COST'):number{need(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0,code);return v;}
function key(v:PublicKey){need(v instanceof PublicKey);return new PublicKey(v.toBytes());}
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)).digest('hex');
export type MiningTaxQuoteRpc=MiningTaxSnapshotRpc&Pick<Connection,'getLatestBlockhashAndContext'|'getFeeForMessage'|'getMinimumBalanceForRentExemption'|'getBlockHeight'>;
export interface MiningTaxQuoteRequest extends MiningTaxSnapshotRequest{readonly caps:MiningTaxCostCaps}
export interface MiningTaxQuoteOptions{readonly timeoutMs?:number;readonly maxPending?:number}

export function createMiningTaxQuoteReader(connect:(signal:AbortSignal)=>MiningTaxQuoteRpc,input:MiningTaxSnapshotTrust,options:MiningTaxQuoteOptions={}){
 need(typeof connect==='function');exact(input,'mining seeker');
 need(options&&typeof options==='object'&&!Array.isArray(options)&&Reflect.ownKeys(options).every(k=>k==='timeoutMs'||k==='maxPending'));
 const timeout=safe(options.timeoutMs??MAX_TIMEOUT_MS,'INPUT'),limit=safe(options.maxPending??MAX_PENDING,'INPUT');need(timeout>0&&timeout<=MAX_TIMEOUT_MS&&limit>0&&limit<=MAX_PENDING);
 // Validate exact trust fields before spreading, then retain owned key copies.
 createMiningTaxSnapshotReader(()=>{throw new MiningTaxQuoteError('UNAVAILABLE');},input);
 const m=input.mining,s=input.seeker,trust:MiningTaxSnapshotTrust={mining:{...m,programId:key(m.programId),keepMint:key(m.keepMint),reserveOwner:key(m.reserveOwner)},
  seeker:{...s,programId:key(s.programId),config:key(s.config),mint:key(s.mint),prizeOwner:key(s.prizeOwner),prizeAta:key(s.prizeAta),genesisHash:key(s.genesisHash),deployment:{...s.deployment}}};
 let pending=0;
 return async function quote(value:MiningTaxQuoteRequest){
  exact(value,'wallet round spot caps');exact(value.caps,'maxFeeLamports maxRentLamports maxTotalLamports');
  const request={wallet:key(value.wallet),round:value.round,spot:value.spot},caps=Object.freeze({...value.caps});
  for(const v of Object.values(caps))need(typeof v==='bigint'&&v>=0n&&v<=U64);
  need(pending<limit,'BUSY');pending++;
  const controller=new AbortController();let calls=0,finished=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(finished&&calls===0&&!released){released=true;pending--;}};
  const active=()=>need(!controller.signal.aborted,'TIMEOUT');
  async function call<T>(run:()=>Promise<T>):Promise<T>{active();calls++;try{const v=await run();active();return v;}finally{calls--;release();}}
  const work=async()=>{
   const raw=connect(controller.signal);
   const rpc:MiningTaxQuoteRpc={
    getGenesisHash:()=>call(()=>raw.getGenesisHash()),getSlot:(...a)=>call(()=>raw.getSlot(...a)),
    getMultipleAccountsInfoAndContext:(...a)=>call(()=>raw.getMultipleAccountsInfoAndContext(...a)),
    getSignaturesForAddress:(...a)=>call(()=>raw.getSignaturesForAddress(...a)),
    getTransaction:((...a:Parameters<MiningTaxQuoteRpc['getTransaction']>)=>call(()=>raw.getTransaction(...a))) as MiningTaxQuoteRpc['getTransaction'],
    getBlock:((...a:Parameters<MiningTaxQuoteRpc['getBlock']>)=>call(()=>raw.getBlock(...a))) as MiningTaxQuoteRpc['getBlock'],
    getLatestBlockhashAndContext:(...a)=>call(()=>raw.getLatestBlockhashAndContext(...a)),
    getFeeForMessage:(...a)=>call(()=>raw.getFeeForMessage(...a)),getMinimumBalanceForRentExemption:(...a)=>call(()=>raw.getMinimumBalanceForRentExemption(...a)),
    getBlockHeight:(...a)=>call(()=>raw.getBlockHeight(...a)),
   };
   const read=createMiningTaxSnapshotReader(()=>rpc,trust,{timeoutMs:timeout});
   const first=await read(request);active();
   const latest=await rpc.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:first.slot});
   const blockhashSlot=safe(latest?.context?.slot);need(blockhashSlot>=first.slot,'COST');
   const blockhash=latest?.value?.blockhash;need(typeof blockhash==='string'&&blockhash.length>=32&&blockhash.length<=44,'COST');
   try{need(new PublicKey(blockhash).toBase58()===blockhash&&blockhash!==PublicKey.default.toBase58(),'COST');}catch{throw new MiningTaxQuoteError('COST');}
   const lastValidBlockHeight=safe(latest.value.lastValidBlockHeight),plan=buildMiningTaxMessages(trust.mining,first,{...request,blockhash});
   const measurements:MiningTaxCostQuote[]=[];let floor=blockhashSlot;
   for(const tx of plan.transactions){
    const fee=await rpc.getFeeForMessage(Message.from(tx.messageBytes),'finalized'),feeSlot=safe(fee?.context?.slot);need(feeSlot>=floor,'COST');floor=feeSlot;
    const feeLamports=BigInt(safe(fee.value)),rents=[];
    for(const account of tx.expectedNewAccounts){
     const lamports=BigInt(safe(await rpc.getMinimumBalanceForRentExemption(account.space,'finalized')));
     rents.push(Object.freeze({...account,lamports}));
    }
    measurements.push(Object.freeze({messageSha256:tx.messageSha256,feeLamports,rents:Object.freeze(rents)}));
   }
   const snapshot=await read(request);active();need(snapshot.slot>=floor&&snapshot.chainClock.unixTimestamp>=first.chainClock.unixTimestamp,'STALE');
   const current=buildMiningTaxMessages(trust.mining,snapshot,{...request,blockhash});
   need(current.mode===plan.mode&&current.expectedClaimBaseUnits===plan.expectedClaimBaseUnits&&current.cumulativeBaseUnits===plan.cumulativeBaseUnits
    &&current.dustBaseUnits===plan.dustBaseUnits&&current.transactions.length===plan.transactions.length
    &&current.transactions.every((t,i)=>t.messageSha256===plan.transactions[i]!.messageSha256&&sha(t.expectedNewAccounts)===sha(plan.transactions[i]!.expectedNewAccounts)),'STALE');
   const costs=quoteMiningTaxMessageCosts(current,measurements,caps);
   const blockHeight=safe(await rpc.getBlockHeight('finalized'));need(blockHeight<=lastValidBlockHeight,'COST');
   need(await rpc.getGenesisHash()===trust.mining.expectedGenesisHash,'IDENTITY');
   return Object.freeze({plan:current,snapshot,blockhash,blockhashSlot,lastValidBlockHeight,blockHeight,measurements:Object.freeze(measurements),caps,costs,
    source:Object.freeze({genesisHash:trust.mining.expectedGenesisHash,programId:trust.mining.programId.toBase58(),reviewedDeploymentSlot:trust.mining.reviewedDeploymentSlot,
     reviewedProgramDataSha256:trust.mining.reviewedProgramDataSha256,firstSnapshotSlot:first.slot,snapshotSlot:snapshot.slot,feeSlot:floor,snapshotSha256:sha(snapshot)}),
    signingAuthorized:false as const,broadcastAuthorized:false as const});
  };
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxQuoteError('TIMEOUT'));},timeout);});
  const task=work().catch(error=>{if(error instanceof MiningTaxQuoteError||error instanceof MiningTaxSnapshotError||error instanceof MiningTaxMessageError)throw error;throw new MiningTaxQuoteError('UNAVAILABLE');}).finally(()=>{finished=true;release();});
  try{return await Promise.race([task,deadline]);}finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
export type MiningTaxQuote=Awaited<ReturnType<ReturnType<typeof createMiningTaxQuoteReader>>>;
