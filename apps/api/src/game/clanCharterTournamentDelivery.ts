/** Sends one exact retained lock wire. No signing, renewal or refund authority. */
import {isDeepStrictEqual} from 'node:util';
import {MessageV0,PublicKey,type SignatureStatus} from '@solana/web3.js';
import {createCharterAdmissionReader} from '@shardkeep/chain/charter-admission';
import {boundedLockWork,readLockBank,verifyLockCurrentBank,emptyLockAccount,verifyCharterLockQuote,verifyCharterLockPacket,type CharterLockQuoteRpc} from '@shardkeep/chain/charter-lock-preparation';
import {verifyCharterLockSignedWire} from '@shardkeep/chain/charter-lock-wire';
import type {CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import type {TournamentOperationState} from '../db/charterTournaments';
import {phaseECharterEnabled} from '../config';
export interface CharterTournamentDeliveryRpc extends CharterLockQuoteRpc {
 getSignatureStatuses(signatures:string[],options:{searchTransactionHistory:true}):Promise<{context:{slot:number};value:(SignatureStatus|null)[]}>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
export interface CharterTournamentDeliveryOptions {
 readonly connect:(signal:AbortSignal)=>CharterTournamentDeliveryRpc;readonly trust:CharterCreationEvidenceTrust;
 readonly expectedCurrentSigner:string;readonly lookupTable:Readonly<{address:string;dataSha256:string}>;readonly timeoutMs?:number;
}
type Reason='NOT_SIGNED'|'PAUSED'|'TRANSPORT_UNAVAILABLE'|'IDENTITY'|'EXPIRED_UNRESOLVED'|'ADMISSION_HELD'|'SOURCE_CONFLICT'|'OBSERVED_TRANSACTION'|'FINALIZED_ERROR_UNVERIFIED'|'SEND_UNCERTAIN'|'TIMEOUT'|'BUSY';
class Held extends Error{constructor(readonly reason:Reason){super(reason);}}
function need(value:unknown,reason:Reason):asserts value{if(!value)throw new Held(reason);}
const slot=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export function createCharterTournamentDelivery(read:(actor:string,id:string)=>Promise<TournamentOperationState>,options:CharterTournamentDeliveryOptions|null){
 let config:CharterTournamentDeliveryOptions|null=null,invalid=false,external:ReturnType<typeof boundedLockWork>|null=null;
 try{if(options){const {connect,...pins}=options;config={...structuredClone(pins),connect:connect.bind(options)};}}catch{invalid=true;}
 return async(actor:string,id:string)=>{
  let state=await read(actor,id);
  const result=(status:'held'|'terminal'|'observed'|'submitted',reason:Reason|null=null)=>({version:1 as const,operationId:id,status,signature:state.signed?.signature??null,reason,operation:state,signingAuthorized:false as const,entryAuthorized:false as const,fenceReleaseAuthorized:false as const});
  if(state.terminal)return result('terminal');if(!state.signed||!state.preparation||!state.attempt)return result('held','NOT_SIGNED');
  if(!phaseECharterEnabled())return result('held','PAUSED');if(invalid||!config)return result('held','TRANSPORT_UNAVAILABLE');
  const configuration=config,original=state,signed=state.signed,attempt=state.attempt,preparation=state.preparation;let sending=false;
  try{
   const quote=verifyCharterLockQuote(attempt.quote),packet=verifyCharterLockPacket({...quote.packetInput,policySignatureHex:preparation.policySignatureHex},preparation.packet);
   need(isDeepStrictEqual(quote.packetInput.original,state.original)&&quote.packetInput.candidateHex===attempt.candidateHex,'SOURCE_CONFLICT');
   const wire=verifyCharterLockSignedWire({intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:Buffer.from(signed.signedTransactionHex,'hex'),leader:new PublicKey(state.original.operation.leader)});
   need(wire.signature===signed.signature&&wire.wireSha256===signed.wireSha256&&wire.messageSha256===signed.messageSha256,'SOURCE_CONFLICT');
   need(isDeepStrictEqual(configuration.trust,quote.observation.source.programs)&&configuration.expectedCurrentSigner===quote.packetInput.policySigner&&isDeepStrictEqual(configuration.lookupTable,quote.packetInput.expectedLookupTable),'IDENTITY');
   external??=boundedLockWork(configuration.timeoutMs);
   return await external(async(call,signal)=>{try{
    const rpc=configuration.connect(signal),admission=createCharterAdmissionReader(()=>({getGenesisHash:()=>call(()=>rpc.getGenesisHash()),getSlot:c=>call(()=>rpc.getSlot(c)),getMultipleAccountsInfoAndContext:(keys,settings)=>call(()=>rpc.getMultipleAccountsInfoAndContext(keys,settings))}),configuration.trust,configuration.expectedCurrentSigner);
    async function observed(minimum:number){
     const response=await call(()=>rpc.getSignatureStatuses([wire.signature],{searchTransactionHistory:true}));
     need(response&&slot(response.context?.slot)&&response.context.slot>=minimum&&Array.isArray(response.value)&&response.value.length===1,'IDENTITY');
     const status=response.value[0];if(status===null)return null;
     need(status&&slot(status.slot)&&status.slot<=response.context.slot&&['processed','confirmed','finalized'].includes(status.confirmationStatus??''),'IDENTITY');
     return status.err===null?result('observed','OBSERVED_TRANSACTION'):result('held','FINALIZED_ERROR_UNVERIFIED');
    }
    need(await call(()=>rpc.getGenesisHash())===configuration.trust.expectedGenesisHash,'IDENTITY');
    const existing=await observed(quote.observation.slot);if(existing)return existing;
    const current=await call(admission),candidate=Buffer.from(attempt.candidateHex,'hex'),expiry=candidate.readBigInt64LE(121);
    need(current.slot>=quote.observation.slot&&current.unixTimestamp<expiry,'EXPIRED_UNRESOLVED');
    const bank=await readLockBank(rpc,configuration.trust,state.original,[candidate.subarray(73,89)],call);verifyLockCurrentBank(bank);
    need(bank.slot>=current.slot&&bank.unixTimestamp<expiry&&emptyLockAccount(bank.rows[15]),'ADMISSION_HELD');let minimum=bank.slot;
    const alt=await call(()=>rpc.getAccountInfoAndContext(new PublicKey(configuration.lookupTable.address),{commitment:'finalized',minContextSlot:minimum})),expected=quote.packetInput.lookupTable;
    need(alt&&slot(alt.context?.slot)&&alt.context.slot>=minimum&&alt.value&&alt.value.owner instanceof PublicKey&&alt.value.owner.toBase58()===expected.owner&&alt.value.executable===false&&alt.value.data instanceof Uint8Array&&Buffer.from(alt.value.data).toString('hex')===expected.dataHex,'IDENTITY');minimum=alt.context.slot;
    const fee=await call(()=>rpc.getFeeForMessage(MessageV0.deserialize(Buffer.from(packet.messageHex,'hex')),'finalized'));
    need(fee&&slot(fee.context?.slot)&&fee.context.slot>=minimum&&slot(fee.value)&&BigInt(fee.value)<=BigInt(quote.costs.networkFeeLamports),'ADMISSION_HELD');minimum=fee.context.slot;
    for(const allocation of quote.costs.allocations){const rent=await call(()=>rpc.getMinimumBalanceForRentExemption(allocation.bytes,'finalized'));need(slot(rent)&&BigInt(rent)<=BigInt(allocation.minimumBalanceLamports),'ADMISSION_HELD');}
    const height=await call(()=>rpc.getBlockHeight({commitment:'finalized',minContextSlot:minimum}));need(slot(height)&&height<=quote.packetInput.lastValidBlockHeight,'EXPIRED_UNRESOLVED');
    need(await call(()=>rpc.getGenesisHash())===configuration.trust.expectedGenesisHash,'IDENTITY');const closing=await observed(minimum);if(closing)return closing;
    state=await read(actor,id);if(state.terminal)return result('terminal');
    need(state.signed?.wireSha256===signed.wireSha256&&state.attempt?.id===attempt.id,'SOURCE_CONFLICT');
    const signature=await call(()=>{need(phaseECharterEnabled(),'PAUSED');sending=true;return rpc.sendRawTransaction(Uint8Array.from(wire.signedTransaction),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:minimum});});
    need(signature===wire.signature,'SEND_UNCERTAIN');return result('submitted');
   }catch(error){if(error instanceof Held)return result('held',error.reason);throw error;}});
  }catch(error){state??=original;const reason=sending?'SEND_UNCERTAIN':error instanceof Held?error.reason:error&&typeof error==='object'&&'code'in error&&error.code==='DEADLINE'?'TIMEOUT':error&&typeof error==='object'&&'code'in error&&error.code==='BUSY'?'BUSY':'ADMISSION_HELD';return result('held',reason);}
 };
}
