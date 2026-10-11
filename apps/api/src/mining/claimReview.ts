/** Fresh original-only pre-wallet review. A ready observation grants no signature
 * or delivery authority; relay independently repeats current admission. */
import {VersionedMessage} from '@solana/web3.js';
import {phaseEMiningEnabled} from '../config';
import type {Db} from '../db/client';
import {createMiningClaimAssessment,MiningClaimAdmissionError} from './claimAdmission';
import {miningClaimSetupBinding,hasMiningClaimContinuation} from './claimContinuationStore';
import type {MiningClaimPreparationSources} from './claimPreparation';
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000;
const valid=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export function createMiningClaimReview(db:Db,sources:MiningClaimPreparationSources){
 const assess=createMiningClaimAssessment(db,sources,false);
 const pending=new Map<string,Promise<unknown>>(),timeout=sources.timeoutMs??MAX_TIMEOUT_MS,now=sources.now??(()=>new Date());
 if(!valid(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)throw Error('Invalid mining review timeout');
 return async(input:{wallet:string;claimId:string;ordinal:number})=>{
  const key=`${input.wallet}:${input.claimId}:${input.ordinal}`;if(pending.has(key))throw new MiningClaimAdmissionError('SOURCE_UNAVAILABLE');if(pending.size>=MAX_PENDING)throw new MiningClaimAdmissionError('SOURCE_UNAVAILABLE');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const alive=()=>{if(controller.signal.aborted)throw new MiningClaimAdmissionError('SOURCE_UNAVAILABLE');};
  const work=(async()=>{
   const admitted=await assess(input);alive();const p=admitted.preparation,rpc=sources.quoteSource(controller.signal);
   if(await rpc.getGenesisHash()!==p.header.genesisHash)throw new MiningClaimAdmissionError('SOURCE_UNAVAILABLE');alive();
   const fee=await rpc.getFeeForMessage(VersionedMessage.deserialize(Buffer.from(p.transactions[input.ordinal]!.messageHex,'hex')),'finalized');alive();
   if(!valid(fee.context?.slot)||fee.context.slot<admitted.snapshotSlot||!valid(fee.value)||BigInt(fee.value)>BigInt(p.transactions[input.ordinal]!.feeLamports))throw new MiningClaimAdmissionError('SOURCE_UNAVAILABLE');
   const blockHeight=await rpc.getBlockHeight({commitment:'finalized',minContextSlot:fee.context.slot});alive();
   if(!valid(blockHeight)||blockHeight>p.lastValidBlockHeight)throw new MiningClaimAdmissionError('EXPIRED');
   const finalSlot=await rpc.getSlot('finalized');alive();if(!valid(finalSlot)||finalSlot<fee.context.slot||await rpc.getGenesisHash()!==p.header.genesisHash)throw new MiningClaimAdmissionError('SOURCE_UNAVAILABLE');alive();
   if(await hasMiningClaimContinuation(db,input.wallet,input.claimId))throw new MiningClaimAdmissionError('CONTINUED');alive();
   if(!phaseEMiningEnabled())throw new MiningClaimAdmissionError('DISABLED');
   const at=now();if(!(at instanceof Date)||!Number.isFinite(+at)||+at<Date.parse(p.preparedAt)||+at>=Date.parse(p.expiresAt))throw new MiningClaimAdmissionError('EXPIRED');
   return {...input,version:1 as const,status:'ready' as const,messageSha256:p.transactions[input.ordinal]!.messageSha256,blockhash:p.blockhash,preparedAt:p.preparedAt,expiresAt:p.expiresAt,observedAt:at.toISOString(),snapshotSlot:admitted.snapshotSlot,blockHeight,lastValidBlockHeight:p.lastValidBlockHeight,
    setup:admitted.setup?miningClaimSetupBinding(admitted.setup):null,currentSigningAuthorized:false as const,relayAuthorized:false as const,settlementAuthorized:false as const};
  })();
  const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningClaimAdmissionError('SOURCE_UNAVAILABLE'));},timeout);})]).finally(()=>{if(timer)clearTimeout(timer);});
  pending.set(key,reply);void work.then(()=>{controller.abort();pending.delete(key);},()=>{controller.abort();pending.delete(key);});return reply;
 };
}
