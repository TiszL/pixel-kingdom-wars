/** Existing-clan registration: original source custody, one purpose-5 candidate,
 * sign-only bytes and finalized same-clan cutover. No funded creation authority. */
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {MessageV0,PublicKey,SystemProgram,type SignatureStatus} from '@solana/web3.js';
import {z} from 'zod';
import {PHASE_E_CHARTER_ADMISSION} from '@shardkeep/shared';
import {createCharterAdmissionReader} from '@shardkeep/chain/charter-admission';
import {encodeCharterRegistrationPermit,hashCharterRegistrationPayload} from '@shardkeep/chain/charter-protocol';
import {createCharterCreationQuoteReader,verifyCharterCreationQuote,buildCharterCreationPacket,verifyCharterCreationPacket,
 type CharterCreationQuoteOptions,type CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import {createCharterCreationCancellationReader} from '@shardkeep/chain/charter-creation-cancellation';
import {verifyCharterCreationSignedWire} from '@shardkeep/chain/charter-creation-wire';
import {boundedTransferWork} from '@shardkeep/chain/charter-transfer-preparation';
import type {CharterCreationEvidenceRpc,CharterCreationEvidenceTrust} from '@shardkeep/chain/charter-creation-evidence';
import type {Db} from '../db/client';
import {createClanCharterMigrationsStore,type MigrationState,type MigrationConfiguration} from '../db/charterMigrations';
import type {TypedCharterIssuer} from './clanCharterCreationPreparation';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
export interface CharterMigrationDeliveryRpc extends CharterCreationQuoteRpc {
 getSignatureStatuses(signatures:string[],options:{searchTransactionHistory:true}):Promise<{context:{slot:number};value:(SignatureStatus|null)[]}>;
 sendRawTransaction(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
export interface CharterMigrationDeliveryOptions {
 readonly connect:(signal:AbortSignal)=>CharterMigrationDeliveryRpc;readonly trust:CharterCreationEvidenceTrust;
 readonly expectedCurrentSigner:string;readonly lookupTable:Readonly<{address:string;dataSha256:string}>;
}
export interface CharterMigrationWorkflowOptions {
 readonly newMigration?:MigrationConfiguration|null;
 readonly chain?:(CharterCreationQuoteOptions&{connect:(signal:AbortSignal)=>CharterCreationQuoteRpc})|null;
 readonly issuer?:TypedCharterIssuer|null;
 readonly recovery?:Readonly<{connect:(signal:AbortSignal)=>CharterCreationEvidenceRpc;trust:CharterCreationEvidenceTrust}>|null;
 readonly delivery?:CharterMigrationDeliveryOptions|null;readonly monotonicNow?:()=>number;readonly timeoutMs?:number;
}
const uuid=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
const request=z.object({clanId:uuid,idempotencyKey:uuid}).strict();
const address=z.string().refine(v=>{try{const p=new PublicKey(v);return p.toBase58()===v&&!p.equals(PublicKey.default);}catch{return false;}});
const noAuthority={signingAuthorized:false,relayAuthorized:false,migrationAuthorized:false,fenceReleaseAuthorized:false} as const;
function fail(suffix:string,status=503):never {throw new HttpError(status,'Clan Charter migration is unresolved; keep the original request','CLAN_CHARTER_MIGRATION_'+suffix);}
function translate(error:unknown):never {if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_MIGRATION_'))throw error;return fail('HELD');}
export function migrationOperationQuote(state:MigrationState){if(!state.attempt)return fail('HELD');const q=verifyCharterCreationQuote(state.attempt.quote);
 if(!isDeepStrictEqual(q.packetInput.original,state.original)||q.packetInput.candidateHex!==state.attempt.candidateHex||q.packetInput.policySigner!==state.attempt.policySigner)return fail('HELD');return q;}
export function migrationOperationPacket(state:MigrationState){if(!state.preparation)return fail('HELD');const {candidateHex,...rest}=migrationOperationQuote(state).packetInput;
 return verifyCharterCreationPacket({...rest,candidate:Buffer.from(candidateHex,'hex'),policySignature:Buffer.from(state.preparation.policySignatureHex,'hex')},state.preparation.packet);}
type Reason='NOT_SIGNED'|'PAUSED'|'TRANSPORT_UNAVAILABLE'|'IDENTITY'|'EXPIRED_UNRESOLVED'|'ADMISSION_HELD'|'SOURCE_CONFLICT'|'OBSERVED_TRANSACTION'|'FINALIZED_ERROR_UNVERIFIED'|'SEND_UNCERTAIN'|'TIMEOUT'|'BUSY';
class Held extends Error {constructor(readonly reason:Reason){super(reason);}}
function need(v:unknown,reason:Reason):asserts v {if(!v)throw new Held(reason);}
const slot=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export function createClanCharterMigrationWorkflow(db:Db,options:CharterMigrationWorkflowOptions={}){
 if('rollback'in db)return fail('TOP_LEVEL');const store=createClanCharterMigrationsStore(db);
 let configuration:MigrationConfiguration|null=null,chain:CharterMigrationWorkflowOptions['chain']=null,issuer:TypedCharterIssuer|null=null,
  recovery:CharterMigrationWorkflowOptions['recovery']=null,delivery:CharterMigrationDeliveryOptions|null=null,invalid=false;
 try{configuration=options.newMigration?structuredClone(options.newMigration):null;
  if(options.chain){const {connect,...pins}=options.chain;chain={...structuredClone(pins),connect:connect.bind(options.chain)};}
  if(options.issuer)issuer={issueOnce:options.issuer.issueOnce.bind(options.issuer),lookup:options.issuer.lookup.bind(options.issuer)};
  if(options.recovery)recovery={trust:structuredClone(options.recovery.trust),connect:options.recovery.connect.bind(options.recovery)};
  if(options.delivery){const {connect,...pins}=options.delivery;delivery={...structuredClone(pins),connect:connect.bind(options.delivery)};}
 }catch{invalid=true;}
 const now=options.monotonicNow??(()=>performance.now()),external=boundedTransferWork(options.timeoutMs);
 let quoter:ReturnType<typeof createCharterCreationQuoteReader>|undefined;
 function quoteService(){if(invalid||!chain)return fail('CONFIGURATION');if(!quoter){const {connect,...pins}=chain;quoter=createCharterCreationQuoteReader(connect,pins);}return quoter;}
 function clock(){const start=now();if(!Number.isFinite(start)||start<0)return fail('STALE');let previous=start;return ()=>{const current=now();if(!Number.isFinite(current)||current<previous||current-start>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');previous=current;return current-start;};}
 const read=(actor:string,id:string)=>store.read(actor,id),readByKey=(actor:string,key:string)=>store.readByKey(actor,key);
 async function create(actor:string,raw:unknown){const parsed=request.safeParse(raw);if(!address.safeParse(actor).success||!parsed.success)return fail('INPUT',400);const prior=await store.readByKey(actor,parsed.data.idempotencyKey);
  if(prior){if(prior.request.clanId!==parsed.data.clanId)return fail('CONFLICT',409);return prior;}
  if(!phaseECharterEnabled()||!configuration||invalid||!chain||!issuer||!recovery)return fail('DISABLED');quoteService();
  if(configuration.domain.genesisHash!==chain.trust.expectedGenesisHash||configuration.domain.economyProgram!==chain.trust.economy.programId||configuration.domain.craftProgram!==chain.trust.craft.programId||!isDeepStrictEqual(recovery.trust,chain.trust))return fail('CONFIGURATION');
  return store.create(actor,parsed.data,configuration);
 }
 function receipt(state:MigrationState,input:unknown){const v=z.object({requestId:uuid,publicKey:address,message:z.instanceof(Uint8Array),signature:z.instanceof(Uint8Array)}).strict().parse(input);
  if(!state.attempt||v.message.length!==161||v.signature.length!==64||v.requestId!==state.attempt.id||v.publicKey!==state.attempt.policySigner||Buffer.from(v.message).toString('hex')!==state.attempt.candidateHex)return fail('ISSUER');
  const {candidateHex,...rest}=migrationOperationQuote(state).packetInput,policySignatureHex=Buffer.from(v.signature).toString('hex');return {policySignatureHex,packet:buildCharterCreationPacket({...rest,candidate:Buffer.from(candidateHex,'hex'),policySignature:Buffer.from(policySignatureHex,'hex')})};
 }
 async function recoverAttempt(actor:string,state:MigrationState){if(state.terminal||state.preparation||!state.attempt||!issuer)return state;
  const lookup=issuer.lookup,value=await external((call,signal)=>call(()=>lookup(state.attempt!.id,signal)));return value===null?state:store.retainPreparation(actor,state.id,state.attempt.id,receipt(state,value));}
 async function recoverPreparation(actor:string,id:string){try{return await recoverAttempt(actor,await read(actor,id));}catch(e){return translate(e);}}
 async function prepare(actor:string,id:string){try{
  const state=await read(actor,id);if(state.terminal||state.preparation)return state;if(state.attempt)return await recoverAttempt(actor,state);
  if(invalid||!chain||!issuer||!phaseECharterEnabled())return fail('HELD');const configured=chain,quoteReader=quoteService(),elapsed=clock();
  const observed=await external(async(call,signal)=>{const rpc=configured.connect(signal);return call(createCharterAdmissionReader(()=>({getGenesisHash:()=>call(()=>rpc.getGenesisHash()),getSlot:c=>call(()=>rpc.getSlot(c)),getMultipleAccountsInfoAndContext:(keys,settings)=>call(()=>rpc.getMultipleAccountsInfoAndContext(keys,settings))}),configured.trust,configured.expectedCurrentSigner));});elapsed();
  const o=state.original,c=o.chain,k=(field:keyof typeof c)=>new PublicKey(c[field]),expiry=observed.unixTimestamp+BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec);
  if(expiry<=observed.unixTimestamp||expiry>=(1n<<63n))return fail('HELD');
  const candidate=encodeCharterRegistrationPermit({genesisHash:k('genesisHash'),programId:k('economyProgram'),kind:5,permitId:randomBytes(16),wallet:new PublicKey(actor),expiry,
   payloadHash:hashCharterRegistrationPayload({config:k('config'),craftProgram:k('craftProgram'),craftControl:k('craftControl'),collection:k('collection'),collectionAuthority:k('collectionAuthority'),charter:k('charter'),asset:k('asset'),assetBinding:k('assetBinding'),freezeAuthority:k('freezeAuthority'),executor:k('executor'),creationReceipt:k('creationReceipt'),clanId:o.clanId,leader:new PublicKey(actor),creationIntentId:o.creationIntentId,metadataHash:Buffer.from(o.metadata.hash,'hex'),admissionCommitment:Buffer.from(o.admissionCommitment,'hex')})});
  const quote=await quoteReader(o,candidate);elapsed();if(!phaseECharterEnabled())return fail('HELD');const committed=await store.beginAttempt(actor,id,quote,{elapsedMs:elapsed()});
  if(committed.attempt?.candidateHex!==quote.packetInput.candidateHex)return await recoverAttempt(actor,committed);
  if(committed.terminal||committed.preparation)return committed;elapsed();if(!phaseECharterEnabled())return fail('HELD');
  const issue=issuer.issueOnce,value=await external((call,signal)=>call(()=>{elapsed();if(!phaseECharterEnabled())return fail('HELD');return issue({kind:'charter-registration-v1',requestId:committed.attempt!.id,message:Buffer.from(committed.attempt!.candidateHex,'hex')},signal);}));
  return await store.retainPreparation(actor,id,committed.attempt!.id,receipt(committed,value));
 }catch(e){return translate(e);}}
 async function retainSigned(actor:string,id:string,bytes:Uint8Array){try{const state=await read(actor,id);if(!(bytes instanceof Uint8Array)||bytes.length<=65||bytes.length>1232)return fail('SIGNED_INPUT',400);
  const packet=migrationOperationPacket(state),wire=verifyCharterCreationSignedWire({wallet:new PublicKey(actor),intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:Uint8Array.from(bytes)});
  return await store.retainSigned(actor,id,{signedTransactionHex:Buffer.from(wire.signedTransaction).toString('hex'),signature:wire.signature,wireSha256:wire.wireSha256,messageSha256:wire.messageSha256});
 }catch(e){return translate(e);}}
 async function recover(actor:string,id:string){const state=await read(actor,id);if(state.terminal)return state;if(invalid||!recovery)return fail('HELD');const configured=recovery;
  try{if(state.attempt){const q=migrationOperationQuote(state);if(!isDeepStrictEqual(q.observation.source.programs,[configured.trust.economy,configured.trust.craft,configured.trust.core]))return fail('HELD');}
   const observation=await external(async(call,signal)=>{const rpc=configured.connect(signal),reader=createCharterCreationCancellationReader(()=>({getGenesisHash:()=>call(()=>rpc.getGenesisHash()),getSlot:c=>call(()=>rpc.getSlot(c)),getMultipleAccountsInfoAndContext:(keys,settings)=>call(()=>rpc.getMultipleAccountsInfoAndContext(keys,settings))}),configured.trust,async requested=>requested===id?{original:state.original,permitInventory:{...state.inventory,messages:state.inventory.messages.map(hex=>Buffer.from(hex,'hex'))}}:null);return call(()=>reader(id));});
   return observation.outcome==='minted'?await store.complete(actor,id,observation):await store.cancel(actor,id,observation);
  }catch(e){return translate(e);}
 }
 async function deliver(actor:string,id:string){let state=await read(actor,id);
  const result=(status:'held'|'terminal'|'observed'|'submitted',reason:Reason|null=null)=>({version:1 as const,migrationId:id,status,signature:state.signed?.signature??null,reason,migration:state,...noAuthority});
  if(state.terminal)return result('terminal');if(!state.signed||!state.preparation||!state.attempt)return result('held','NOT_SIGNED');
  if(!phaseECharterEnabled())return result('held','PAUSED');if(invalid||!delivery)return result('held','TRANSPORT_UNAVAILABLE');const configured=delivery,wireSaved=state.signed,attempt=state.attempt;let sending=false;
  try{const q=migrationOperationQuote(state),packet=migrationOperationPacket(state),wire=verifyCharterCreationSignedWire({wallet:new PublicKey(actor),intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:Buffer.from(wireSaved.signedTransactionHex,'hex')});
   need(wire.signature===wireSaved.signature&&wire.wireSha256===wireSaved.wireSha256&&wire.messageSha256===wireSaved.messageSha256,'SOURCE_CONFLICT');
   need(isDeepStrictEqual(q.observation.source.programs,[configured.trust.economy,configured.trust.craft,configured.trust.core])&&q.context.closingGenesisHash===configured.trust.expectedGenesisHash&&q.packetInput.policySigner===configured.expectedCurrentSigner&&isDeepStrictEqual(q.packetInput.expectedLookupTable,configured.lookupTable),'IDENTITY');const elapsed=clock(),expiry=Buffer.from(attempt.candidateHex,'hex').readBigInt64LE(121);
   return await external(async(call,signal)=>{try{const rpc=configured.connect(signal),admission=createCharterAdmissionReader(()=>({getGenesisHash:()=>call(()=>rpc.getGenesisHash()),getSlot:c=>call(()=>rpc.getSlot(c)),getMultipleAccountsInfoAndContext:(keys,settings)=>call(()=>rpc.getMultipleAccountsInfoAndContext(keys,settings))}),configured.trust,configured.expectedCurrentSigner);
    async function observed(minimum:number){const response=await call(()=>rpc.getSignatureStatuses([wire.signature],{searchTransactionHistory:true}));need(response&&slot(response.context?.slot)&&response.context.slot>=minimum&&Array.isArray(response.value)&&response.value.length===1,'IDENTITY');const status=response.value[0];if(status===null)return null;need(status&&slot(status.slot)&&status.slot<=response.context.slot&&['processed','confirmed','finalized'].includes(status.confirmationStatus??''),'IDENTITY');return status.err===null?result('observed','OBSERVED_TRANSACTION'):result('held','FINALIZED_ERROR_UNVERIFIED');}
    async function absent(minimum:number){const keys=q.costs.allocations.map(a=>new PublicKey(a.address)),response=await call(()=>rpc.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized',minContextSlot:minimum}));need(response&&slot(response.context?.slot)&&response.context.slot>=minimum&&Array.isArray(response.value)&&response.value.length===keys.length,'IDENTITY');
     need(response.value.every((row,i)=>row===null||row.address instanceof PublicKey&&row.address.equals(keys[i]!)&&row.owner instanceof PublicKey&&row.owner.equals(SystemProgram.programId)&&row.executable===false&&row.data instanceof Uint8Array&&row.data.length===0),'ADMISSION_HELD');return response.context.slot;}
    need(await call(()=>rpc.getGenesisHash())===configured.trust.expectedGenesisHash,'IDENTITY');const first=await observed(q.observation.slot);if(first)return first;
    const current=await call(admission);need(current.slot>=q.observation.slot&&current.unixTimestamp<expiry,'EXPIRED_UNRESOLVED');let minimum=await absent(current.slot);
    const alt=await call(()=>rpc.getAccountInfoAndContext(new PublicKey(configured.lookupTable.address),{commitment:'finalized',minContextSlot:minimum})),expected=q.packetInput.lookupTable;
    need(alt&&slot(alt.context?.slot)&&alt.context.slot>=minimum&&alt.value&&alt.value.owner.toBase58()===expected.owner&&alt.value.executable===false&&alt.value.data instanceof Uint8Array&&Buffer.from(alt.value.data).toString('hex')===expected.dataHex,'IDENTITY');minimum=alt.context.slot;
    const fee=await call(()=>rpc.getFeeForMessage(MessageV0.deserialize(Buffer.from(packet.messageHex,'hex')),'finalized'));need(fee&&slot(fee.context?.slot)&&fee.context.slot>=minimum&&slot(fee.value)&&BigInt(fee.value)<=q.costs.networkFeeLamports,'ADMISSION_HELD');minimum=fee.context.slot;
    for(const a of q.costs.allocations){const rent=await call(()=>rpc.getMinimumBalanceForRentExemption(a.bytes,'finalized'));need(slot(rent)&&BigInt(rent)<=a.minimumBalanceLamports,'ADMISSION_HELD');}
    const height=await call(()=>rpc.getBlockHeight({commitment:'finalized',minContextSlot:minimum}));need(slot(height)&&height<=q.packetInput.lastValidBlockHeight,'EXPIRED_UNRESOLVED');const closing=await observed(minimum);if(closing)return closing;
    const prior=state;state=await read(actor,id);if(state.terminal)return result('terminal');need(state.signed?.wireSha256===wireSaved.wireSha256&&state.attempt?.id===attempt.id&&isDeepStrictEqual(state.original,prior.original),'SOURCE_CONFLICT');
    elapsed();const latest=await call(admission);elapsed();need(latest.slot>=minimum&&latest.unixTimestamp<expiry,'EXPIRED_UNRESOLVED');minimum=await absent(latest.slot);elapsed();
    const signature=await call(()=>{elapsed();need(phaseECharterEnabled(),'PAUSED');sending=true;return rpc.sendRawTransaction(Uint8Array.from(wire.signedTransaction),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:minimum});});need(signature===wire.signature,'SEND_UNCERTAIN');return result('submitted');
   }catch(e){if(e instanceof Held)return result('held',e.reason);throw e;}});
  }catch(e){const reason=sending?'SEND_UNCERTAIN':e instanceof Held?e.reason:e&&typeof e==='object'&&'code'in e&&e.code==='DEADLINE'?'TIMEOUT':e&&typeof e==='object'&&'code'in e&&e.code==='BUSY'?'BUSY':'ADMISSION_HELD';return result('held',reason);}
 }
 return Object.freeze({create,read,readByKey,prepare,recoverPreparation,retainSigned,recover,cancel:recover,deliver});
}
export type CharterMigrationWorkflow=ReturnType<typeof createClanCharterMigrationWorkflow>;
