/** Durable original retirement delivery and independently observed reconciliation. */
import {isDeepStrictEqual} from 'node:util';
import {MessageV0,PublicKey,type SignatureStatus} from '@solana/web3.js';
import {PHASE_E_CHARTER_ADMISSION} from '@shardkeep/shared';
import {createCharterAdmissionReader} from '@shardkeep/chain/charter-admission';
import {boundedRetirementWork,readRetirementBank,verifyRetirementCurrentBank,emptyRetirementAccount,type CharterRetirementQuoteRpc} from '@shardkeep/chain/charter-retirement-preparation';
import {createCharterRetirementReader,type CharterRetirementRpc} from '@shardkeep/chain/charter-retirement-evidence';
import {createCharterRetirementCancellationReader} from '@shardkeep/chain/charter-retirement-cancellation';
import {verifyCharterRetirementSignedWire} from '@shardkeep/chain/charter-retirement-wire';
import type {CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import type {Db} from '../db/client';
import {createClanCharterRetirementsStore,type RetirementState} from '../db/charterRetirements';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {createClanCharterRetirementPreparation,charterRetirementPreparationView,retirementOperationQuote,retirementOperationPacket,type CharterRetirementPreparationOptions} from './clanCharterRetirementPreparation';
export interface CharterRetirementDeliveryRpc extends CharterRetirementQuoteRpc {
 getSignatureStatuses(signatures:string[],options:{searchTransactionHistory:true}):Promise<{context:{slot:number};value:(SignatureStatus|null)[]}>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
export interface CharterRetirementDeliveryOptions {
 readonly connect:(signal:AbortSignal)=>CharterRetirementDeliveryRpc;readonly trust:CharterCreationEvidenceTrust;
 readonly expectedCurrentSigner:string;readonly lookupTable:Readonly<{address:string;dataSha256:string}>;readonly timeoutMs?:number;
}
export interface CharterRetirementWorkflowOptions extends CharterRetirementPreparationOptions {
 readonly recovery?:Readonly<{connect:(signal:AbortSignal)=>CharterRetirementRpc;trust:CharterCreationEvidenceTrust}>|null;
 readonly delivery?:CharterRetirementDeliveryOptions|null;
}
type Reason='NOT_SIGNED'|'PAUSED'|'TRANSPORT_UNAVAILABLE'|'IDENTITY'|'EXPIRED_UNRESOLVED'|'ADMISSION_HELD'|'SOURCE_CONFLICT'|'OBSERVED_TRANSACTION'|'FINALIZED_ERROR_UNVERIFIED'|'SEND_UNCERTAIN'|'TIMEOUT'|'BUSY';
class Held extends Error {constructor(readonly reason:Reason){super(reason);}}
function need(value:unknown,reason:Reason):asserts value {if(!value)throw new Held(reason);}
const slot=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function unavailable():never {throw new HttpError(503,'Charter retirement is unresolved; keep the original request','CLAN_CHARTER_RETIREMENT_HELD');}
type OriginalContext={actor:string;state:RetirementState};
export function createClanCharterRetirementWorkflow(db:Db,options:CharterRetirementWorkflowOptions={}){
 const preparation=createClanCharterRetirementPreparation(db,options),store=createClanCharterRetirementsStore(db);
 let recovery:CharterRetirementWorkflowOptions['recovery']=null,delivery:CharterRetirementDeliveryOptions|null=null,invalid=false;
 try{if(options.recovery){recovery={trust:structuredClone(options.recovery.trust),connect:options.recovery.connect.bind(options.recovery)};}
  if(options.delivery){const {connect,...pins}=options.delivery;delivery={...structuredClone(pins),connect:connect.bind(options.delivery)};}}
 catch{invalid=true;}
 const now=options.monotonicNow??(()=>performance.now());
 let finality:ReturnType<typeof createCharterRetirementReader<OriginalContext>>|undefined,cancellation:ReturnType<typeof createCharterRetirementCancellationReader<OriginalContext>>|undefined;
 let external:ReturnType<typeof boundedRetirementWork>|undefined;
 function original(id:string,context:OriginalContext){const state=context.state;if(state.original.retirement.id!==id||state.original.retirement.leader!==context.actor)unavailable();return state;}
 function readers(){
  if(invalid||!recovery)unavailable();const configuration=recovery;
  finality??=createCharterRetirementReader(configuration.connect,configuration.trust,async(id,context)=>{
   const state=original(id,context);if(!state.signed||!state.preparation)return null;const quote=retirementOperationQuote(state);
   if(!isDeepStrictEqual(quote.observation.source.programs,configuration.trust))unavailable();
   return {packetInput:{...quote.packetInput,policySignatureHex:state.preparation.policySignatureHex},signedTransactionHex:state.signed.signedTransactionHex};
  });
  cancellation??=createCharterRetirementCancellationReader(configuration.connect,configuration.trust,async(id,context)=>{
   const state=original(id,context);if(state.attempt&&!isDeepStrictEqual(retirementOperationQuote(state).observation.source.programs,configuration.trust))unavailable();
   return {original:state.original,inventory:state.inventory};
  });
  return {finality,cancellation};
 }
 async function recover(actor:string,id:string){
  const state=await store.read(actor,id);if(state.terminal)return charterRetirementPreparationView(state);
  const context={actor,state},reader=readers();
  // Failed/null transaction lookup is not absence. The separate complete-inventory
  // reader must still prove expiry, receipt absence and the original active state.
  if(state.signed){let evidence;try{evidence=await reader.finality(id,context);}catch{/* independently prove cancellation below */}
   if(evidence)return charterRetirementPreparationView(await store.complete(actor,id,evidence));}
  try{return charterRetirementPreparationView(await store.cancel(actor,id,await reader.cancellation(id,context)));}
  catch(error){if(error instanceof HttpError)throw error;return unavailable();}
 }
 async function deliver(actor:string,id:string){
  let state=await store.read(actor,id);
  const result=(status:'held'|'terminal'|'observed'|'submitted',reason:Reason|null=null)=>({version:1 as const,retirementId:id,status,signature:state.signed?.signature??null,reason,operation:charterRetirementPreparationView(state),signingAuthorized:false as const,relayAuthorized:false as const,retirementAuthorized:false as const,fenceReleaseAuthorized:false as const});
  if(state.terminal)return result('terminal');if(!state.signed||!state.preparation||!state.attempt)return result('held','NOT_SIGNED');
  if(!phaseECharterEnabled())return result('held','PAUSED');if(invalid||!delivery)return result('held','TRANSPORT_UNAVAILABLE');
  const configuration=delivery,signed=state.signed,attempt=state.attempt;let sending=false;
  try{
   const quote=retirementOperationQuote(state),packet=retirementOperationPacket(state),wire=verifyCharterRetirementSignedWire({intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:Buffer.from(signed.signedTransactionHex,'hex'),leader:new PublicKey(state.original.retirement.leader)});
   need(wire.signature===signed.signature&&wire.wireSha256===signed.wireSha256&&wire.messageSha256===signed.messageSha256,'SOURCE_CONFLICT');
   need(isDeepStrictEqual(configuration.trust,quote.observation.source.programs)&&configuration.expectedCurrentSigner===quote.packetInput.policySigner&&isDeepStrictEqual(configuration.lookupTable,quote.packetInput.expectedLookupTable),'IDENTITY');
   const started=now();let previous=started;need(Number.isFinite(started)&&started>=0,'ADMISSION_HELD');
   function fresh(){const current=now();need(Number.isFinite(current)&&current>=previous&&current-started<=PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs,'ADMISSION_HELD');previous=current;}
   external??=boundedRetirementWork(configuration.timeoutMs);
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
    const candidate=Buffer.from(attempt.candidateHex,'hex'),expiry=candidate.readBigInt64LE(121),permits=[candidate.subarray(73,89)];
    const bank=await readRetirementBank(rpc,configuration.trust,state.original,permits,call);verifyRetirementCurrentBank(bank);
    need(bank.slot>=quote.observation.slot&&bank.unixTimestamp<expiry&&bank.rows.slice(15).every(emptyRetirementAccount),'EXPIRED_UNRESOLVED');let minimum=bank.slot;
    const alt=await call(()=>rpc.getAccountInfoAndContext(new PublicKey(configuration.lookupTable.address),{commitment:'finalized',minContextSlot:minimum})),expected=quote.packetInput.lookupTable;
    need(alt&&slot(alt.context?.slot)&&alt.context.slot>=minimum&&alt.value&&alt.value.owner.toBase58()===expected.owner&&alt.value.executable===false&&alt.value.data instanceof Uint8Array&&Buffer.from(alt.value.data).toString('hex')===expected.dataHex,'IDENTITY');minimum=alt.context.slot;
    const fee=await call(()=>rpc.getFeeForMessage(MessageV0.deserialize(Buffer.from(packet.messageHex,'hex')),'finalized'));
    need(fee&&slot(fee.context?.slot)&&fee.context.slot>=minimum&&slot(fee.value)&&BigInt(fee.value)<=BigInt(quote.costs.networkFeeLamports),'ADMISSION_HELD');minimum=fee.context.slot;
    for(const allocation of quote.costs.allocations){const rent=await call(()=>rpc.getMinimumBalanceForRentExemption(allocation.bytes,'finalized'));need(slot(rent)&&BigInt(rent)<=BigInt(allocation.minimumBalanceLamports),'ADMISSION_HELD');}
    const height=await call(()=>rpc.getBlockHeight({commitment:'finalized',minContextSlot:minimum}));need(slot(height)&&height<=quote.packetInput.lastValidBlockHeight,'EXPIRED_UNRESOLVED');
    const closing=await observed(minimum);if(closing)return closing;
    const originalState=state;state=await store.read(actor,id);if(state.terminal)return result('terminal');
    need(state.signed?.wireSha256===signed.wireSha256&&state.attempt?.id===attempt.id&&isDeepStrictEqual(state.original,originalState.original),'SOURCE_CONFLICT');
    // Fresh policy/Clock and current original are observed after all prior awaits.
    // The bounded slot remains occupied until every actual RPC settles.
    fresh();const current=await call(admission);fresh();need(current.slot>=minimum&&current.unixTimestamp<expiry,'EXPIRED_UNRESOLVED');
    const latest=await readRetirementBank(rpc,configuration.trust,state.original,permits,call);verifyRetirementCurrentBank(latest);fresh();
    need(latest.slot>=current.slot&&latest.unixTimestamp<expiry&&latest.rows.slice(15).every(emptyRetirementAccount),'ADMISSION_HELD');
    const signature=await call(()=>{fresh();need(phaseECharterEnabled(),'PAUSED');sending=true;return rpc.sendRawTransaction(Uint8Array.from(wire.signedTransaction),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:latest.slot});});
    need(signature===wire.signature,'SEND_UNCERTAIN');return result('submitted');
   }catch(error){if(error instanceof Held)return result('held',error.reason);throw error;}});
  }catch(error){const reason=sending?'SEND_UNCERTAIN':error instanceof Held?error.reason:error&&typeof error==='object'&&'code'in error&&error.code==='DEADLINE'?'TIMEOUT':error&&typeof error==='object'&&'code'in error&&error.code==='BUSY'?'BUSY':'ADMISSION_HELD';return result('held',reason);}
 }
 return Object.freeze({...preparation,deliver,recover,cancel:recover});
}
