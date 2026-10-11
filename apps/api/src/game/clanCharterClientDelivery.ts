/** Explicit delivery of already retained wallet bytes; no signing or renewal. */
import {isDeepStrictEqual} from 'node:util';
import {MessageV0,PublicKey,type SignatureStatus} from '@solana/web3.js';
import {CharterDeliverySchema,type CharterClient,type CharterDelivery} from '@shardkeep/shared/charterApi';
import {createCharterAdmissionReader} from '@shardkeep/chain/charter-admission';
import {boundedTransferWork,readTransferBank,verifyTransferCurrentBank,emptyTransferAccount,verifyCharterTransferQuote,type CharterTransferQuoteRpc} from '@shardkeep/chain/charter-transfer-preparation';
import type {CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import {createClanCharterSalesStore} from '../db/charterSales';
import type {Db} from '../db/client';
import {phaseECharterEnabled} from '../config';
export interface CharterClientDeliveryRpc extends CharterTransferQuoteRpc {
 getSignatureStatuses(signatures:string[],options:{searchTransactionHistory:true}):Promise<{context:{slot:number};value:(SignatureStatus|null)[]}>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
export interface CharterClientDeliveryOptions {
 readonly connect:(signal:AbortSignal)=>CharterClientDeliveryRpc;readonly trust:CharterCreationEvidenceTrust;
 readonly expectedCurrentSigner:string;readonly lookupTable:Readonly<{address:string;dataSha256:string}>;readonly timeoutMs?:number;
}
type Reason=NonNullable<CharterDelivery['reason']>;
class Held extends Error {constructor(readonly reason:Reason){super(reason);}}
function need(value:unknown,reason:Reason):asserts value{if(!value)throw new Held(reason);}
const slot=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export function createCharterClientDelivery(db:Db,read:(actor:string,kind:'creation'|'sale',id:string)=>Promise<CharterClient>,options:CharterClientDeliveryOptions|null){
 const sales=createClanCharterSalesStore(db);let configuration:CharterClientDeliveryOptions|null=null,invalid=false;
 try{if(options){const {connect,...pins}=options;configuration={...structuredClone(pins),connect:connect.bind(options)};}}catch{invalid=true;}
 let external:ReturnType<typeof boundedTransferWork>|null=null;
 const result=(original:CharterClient,status:CharterDelivery['status'],reason:CharterDelivery['reason']=null)=>CharterDeliverySchema.parse({version:1,actor:original.actor,kind:original.kind,key:original.key,status,signature:original.wire?.signature??null,reason,original});
 return async(actor:string,kind:'creation'|'sale',id:string):Promise<CharterDelivery>=>{
  let original=await read(actor,kind,id);
  if(original.state.terminal)return result(original,'terminal');
  if(!original.wire||!original.signing)return result(original,'held','NOT_SIGNED');
  if(!phaseECharterEnabled())return result(original,'held','PAUSED');
  if(invalid||!configuration)return result(original,'held','TRANSPORT_UNAVAILABLE');
  const config=configuration,saved=original,signing=original.signing,wire=original.wire;
  // These independently installed pins must equal the original quote. A
  // response or a current configuration change cannot appoint a new network.
  if(!isDeepStrictEqual(config.trust,signing.deployment)||config.expectedCurrentSigner!==signing.policy.signer||!isDeepStrictEqual(config.lookupTable,signing.lookupPin))return result(original,'held','IDENTITY');
  let sending=false;
  try{
   external??=boundedTransferWork(config.timeoutMs);
   return await external(async(call,signal)=>{
    try{
    const rpc=config.connect(signal),admission=createCharterAdmissionReader(()=>({
     getGenesisHash:()=>call(()=>rpc.getGenesisHash()),getSlot:c=>call(()=>rpc.getSlot(c)),
     getMultipleAccountsInfoAndContext:(keys,settings)=>call(()=>rpc.getMultipleAccountsInfoAndContext(keys,settings)),
    }),config.trust,config.expectedCurrentSigner);
    async function observed(minimum:number){
     const response=await call(()=>rpc.getSignatureStatuses([wire.signature],{searchTransactionHistory:true}));
     need(response&&slot(response.context?.slot)&&response.context.slot>=minimum&&Array.isArray(response.value)&&response.value.length===1,'IDENTITY');
     const status=response.value[0];if(status===null)return null;
     need(status&&slot(status.slot)&&status.slot<=response.context.slot&&['processed','confirmed','finalized'].includes(status.confirmationStatus??''),'IDENTITY');
     return status.err===null?result(original,'observed','OBSERVED_TRANSACTION'):result(original,'held','FINALIZED_ERROR_UNVERIFIED');
    }
    // An observed transaction is recovered by the original terminal workflow;
    // neither error nor absence grants permission to refund or replace it.
    need(await call(()=>rpc.getGenesisHash())===signing.deployment.expectedGenesisHash,'IDENTITY');
    const existing=await observed(signing.observedSlot);if(existing)return existing;
    const current=await call(admission),expiry=Buffer.from(signing.policy.candidateHex,'hex').readBigInt64LE(121);
    need(current.slot>=signing.observedSlot&&current.unixTimestamp<expiry,'EXPIRED_UNRESOLVED');
    let minimum=current.slot;
    if(kind==='sale'){
     const state=await sales.read(actor,id);need(state.attempt&&state.preparation&&state.signed?.wireSha256===wire.wireSha256,'SOURCE_CONFLICT');
     if(state.terminal){original=await read(actor,kind,id);return result(original,'terminal');}
     const quote=verifyCharterTransferQuote(state.attempt.quote),permit=Buffer.from(signing.policy.candidateHex,'hex').subarray(73,89);
     const bank=await readTransferBank(rpc,config.trust,quote.packetInput.original,permit,call);verifyTransferCurrentBank(bank);
     need(bank.slot>=minimum&&bank.unixTimestamp<expiry&&emptyTransferAccount(bank.rows[16])&&emptyTransferAccount(bank.rows[17]),'ADMISSION_HELD');minimum=bank.slot;
    }
    const alt=await call(()=>rpc.getAccountInfoAndContext(new PublicKey(signing.lookupPin.address),{commitment:'finalized',minContextSlot:minimum}));
    need(alt&&slot(alt.context?.slot)&&alt.context.slot>=minimum&&alt.value&&alt.value.owner instanceof PublicKey
     &&alt.value.owner.toBase58()===signing.lookupTable.owner&&alt.value.executable===false&&alt.value.data instanceof Uint8Array
     &&alt.value.data.length===signing.lookupTable.dataHex.length/2&&Buffer.from(alt.value.data).toString('hex')===signing.lookupTable.dataHex,'IDENTITY');minimum=alt.context.slot;
    const fee=await call(()=>rpc.getFeeForMessage(MessageV0.deserialize(Buffer.from(signing.packet.messageHex,'hex')),'finalized'));
    need(fee&&slot(fee.context?.slot)&&fee.context.slot>=minimum&&slot(fee.value)&&BigInt(fee.value)<=BigInt(signing.costs.networkFeeLamports),'ADMISSION_HELD');minimum=fee.context.slot;
    for(const allocation of signing.costs.allocations){const rent=await call(()=>rpc.getMinimumBalanceForRentExemption(allocation.bytes,'finalized'));need(slot(rent)&&BigInt(rent)<=BigInt(allocation.minimumBalanceLamports),'ADMISSION_HELD');}
    const height=await call(()=>rpc.getBlockHeight({commitment:'finalized',minContextSlot:minimum}));need(slot(height)&&height<=signing.lastValidBlockHeight,'EXPIRED_UNRESOLVED');
    need(await call(()=>rpc.getGenesisHash())===signing.deployment.expectedGenesisHash,'IDENTITY');
    const closing=await observed(minimum);if(closing)return closing;
    original=await read(actor,kind,id);
    if(original.state.terminal)return result(original,'terminal');
    need(original.wire?.wireSha256===wire.wireSha256&&original.signing?.attemptId===signing.attemptId,'SOURCE_CONFLICT');
    const signature=await call(()=>{
     need(phaseECharterEnabled(),'PAUSED');sending=true;
     return rpc.sendRawTransaction(Buffer.from(wire.signedTransaction,'base64'),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:minimum});
    });
    need(signature===wire.signature,'SEND_UNCERTAIN');return result(original,'submitted');
    }catch(error){
     // Preserve our bounded public classification before the shared transport
     // wrapper deliberately converts unknown exceptions into UNAVAILABLE.
     if(error instanceof Held)return result(original,'held',error.reason);
     throw error;
    }
   });
  }catch(error){
   // Never launch a compensating action after an uncertain transport outcome.
   // The original remains usable even if a concurrent status read fails.
   const reason=sending?'SEND_UNCERTAIN':error instanceof Held?error.reason:
    error&&typeof error==='object'&&'code'in error&&error.code==='DEADLINE'?'TIMEOUT':error&&typeof error==='object'&&'code'in error&&error.code==='BUSY'?'BUSY':'ADMISSION_HELD';
   return result(original??saved,'held',reason);
  }
 };
}
