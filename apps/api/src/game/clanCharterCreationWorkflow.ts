/** D153.170 private original-payer composition; public runtime wiring is held. */
import {CLANS} from '@shardkeep/shared';
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {charterAssetPda,charterConfigPda,charterCreationPda,charterExecutorPda,charterFreezePda,charterMintPda,charterPda,hashCharterMetadata} from '@shardkeep/chain/charter-protocol';
import {createCharterCreationQuoteReader,type CharterCreationPacket,type CharterCreationQuoteOptions,type CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import {z} from 'zod';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {phaseECharterEnabled} from '../config';
import {requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {createClanCharterCustodyEpochs} from './clanCharterCustodyEpochs';
import {createCharterCreationReservations,type CharterCreationDomain} from './clanCharterCreationReservations';
import {createCharterCreationPreparation,type TypedCharterIssuer} from './clanCharterCreationPreparation';
import {createCharterCreationPolicyAdmission} from './clanCharterCreationPolicyAdmission';
import {createCharterCreationSignedStore} from './clanCharterCreationSignedStore';
import {createCharterCreationTerminal,type CharterCreationTerminalOptions} from './clanCharterCreationTerminal';
import {captureCharterCreationConsent,type CharterCreationConsent} from './clanCharterCreationConsent';
export const CharterCreationRequestSchema=z.object({creationIntentId:z.uuid().refine(v=>v===v.toLowerCase()),baseId:z.uuid().refine(v=>v===v.toLowerCase()),
 name:z.string().min(CLANS.nameMinLen).max(CLANS.nameMaxLen).regex(/^[A-Za-z0-9 ._-]+$/).refine(v=>v.trim()===v),
 tag:z.string().min(CLANS.tagMinLen).max(CLANS.tagMaxLen).regex(/^[A-Z0-9]+$/),inviteMode:z.enum(['open','invite'])}).strict();
export type CharterCreationRequest=z.infer<typeof CharterCreationRequestSchema>;
export interface CharterCreationWorkflowOptions {
 readonly newCreation?:Readonly<{domain:CharterCreationDomain;metadataUriPrefix:string}>|null;
 readonly chain?:(CharterCreationQuoteOptions&{readonly connect:(signal:AbortSignal)=>CharterCreationQuoteRpc})|null;
 readonly recovery?:CharterCreationTerminalOptions['chain'];
 readonly issuer?:TypedCharterIssuer|null;
 readonly finalizedDeedReader?:FinalizedDeedReader|null;
 readonly deedCollection?:string|null;
 readonly monotonicNow?:()=>number;
}
export interface CharterCreationWorkflowState {
 readonly version:1;readonly wallet:string;readonly creationIntentId:string;readonly request:CharterCreationRequest;
 readonly status:'funded'|'admitted'|'issuing'|'prepared'|'signed'|'activated'|'cancelled_unpaid'|'refunded';
 readonly original:Readonly<{reservationId:string;clanId:string;baseId:string;clan:Readonly<{name:string;tag:string;inviteMode:'open'|'invite'}>;
  price:Readonly<{shards:string}>;metadata:Readonly<{name:string;uri:string;hash:string}>}>;
 readonly policy:Readonly<{permitId:string;expiry:string;signer:string}>|null;
 readonly preparation:Readonly<{attemptId:string;packet:CharterCreationPacket;blockhash:string;lastValidBlockHeight:number;
  costs:Readonly<{networkFeeLamports:string;rentLamports:string;coreCreateFeeLamports:string;totalLamports:string}>}>|null;
 readonly signed:Readonly<{signature:string;wireSha256:string;messageSha256:string;acceptedAt:string}>|null;
 readonly terminal:Readonly<{state:'activated'|'cancelled_unpaid'|'refunded';terminalId:string;terminalTransactionId:string|null;
  refundTransactionId:string|null;refundDestinationBaseId:string|null}>|null;
 readonly signingAuthorized:false;readonly relayAuthorized:false;readonly reservationReleaseAuthorized:false;
 readonly mintAuthorized:false;readonly paymentAuthorized:false;readonly activationAuthorized:false;readonly refundAuthorized:false;
}
const address=z.string().min(32).max(44).refine(value=>{try{const key=new PublicKey(value);return !key.equals(PublicKey.default)&&key.toBase58()===value;}catch{return false;}});
const domainSchema=z.object({genesisHash:address,economyProgram:address,craftProgram:address}).strict();
// D153.170 technical v0 packet budget: a shared ten-static-key ALT leaves a
// maximum1228-byte packet for name24 + this prefix256 + clan UUID36. D166 still
// verifies the actual configured table and packet limit before issuing bytes.
const newCreationSchema=z.object({domain:domainSchema,metadataUriPrefix:z.string().min(1).max(256).refine(value=>{
 try{const url=new URL(value);return Buffer.byteLength(value)<=256&&value.startsWith('https://')&&url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}
})}).strict();
const noAuthority={signingAuthorized:false,relayAuthorized:false,reservationReleaseAuthorized:false,mintAuthorized:false,
 paymentAuthorized:false,activationAuthorized:false,refundAuthorized:false} as const;
function unknown():never{throw new HttpError(404,'Charter creation not found','CLAN_CHARTER_WORKFLOW_UNKNOWN');}
function refused(code:string,status=503,id?:string):never{throw new HttpError(status,'Charter creation is unavailable; keep the original request','CLAN_CHARTER_WORKFLOW_'+code,
 id?{creationIntentId:id,status:'held',...noAuthority}:undefined);}
function requestFor(c:CharterCreationConsent):CharterCreationRequest{return {creationIntentId:c.creationIntentId,baseId:c.funding.baseId,...c.clan};}
function matches(c:CharterCreationConsent,input:CharterCreationRequest){const saved=requestFor(c);return Object.keys(saved).every(key=>saved[key as keyof typeof saved]===input[key as keyof typeof saved]);}
function sameOriginal(a:CharterCreationConsent,b:CharterCreationConsent){return JSON.stringify(a)===JSON.stringify(b);}
export function createCharterCreationWorkflow(db:Db,options:CharterCreationWorkflowOptions={}){
 if('rollback'in db)return refused('TOP_LEVEL');
 // Detach application-owned pins once. Invalid current setup must not destroy
 // providerless historical reads; new operations validate it only when needed.
 let newCreation:unknown=null,chain:CharterCreationWorkflowOptions['chain']=null,configurationInvalid=false,issuer:TypedCharterIssuer|null=null;
 try{newCreation=options.newCreation==null?null:structuredClone(options.newCreation);}catch{configurationInvalid=true;}
 try{if(options.chain){const {connect,...pins}=options.chain;chain={...structuredClone(pins),connect:connect.bind(options.chain)};}}catch{configurationInvalid=true;}
 try{if(options.issuer)issuer={issueOnce:options.issuer.issueOnce.bind(options.issuer),lookup:options.issuer.lookup.bind(options.issuer)};}catch{configurationInvalid=true;}
 let recovery:CharterCreationTerminalOptions['chain']|undefined;
 try{if(options.recovery!==undefined)recovery=options.recovery===null?null:{trust:structuredClone(options.recovery.trust),connect:options.recovery.connect.bind(options.recovery)};}catch{configurationInvalid=true;recovery=null;}
 const clock=options.monotonicNow,reader=options.finalizedDeedReader??null,collection=options.deedCollection??null;
 const reservations=createCharterCreationReservations(db,{newCreationDomain:null}),custody=createClanCharterCustodyEpochs(db);
 const policies=createCharterCreationPolicyAdmission(db,{chain:null}),preparations=createCharterCreationPreparation(db,{chain:null,issuer:null});
 const signed=createCharterCreationSignedStore(db),terminals=createCharterCreationTerminal(db,{chain:null});
 // Preserve each boundary's pending-work budget across requests, including
 // uncertain issuance and lookup recovery. Construct current-config services
 // lazily so original history remains independent of today's provider setup.
 let configuredPolicy:ReturnType<typeof createCharterCreationPolicyAdmission>|undefined,
  configuredPreparation:ReturnType<typeof createCharterCreationPreparation>|undefined,
  configuredTerminal:ReturnType<typeof createCharterCreationTerminal>|undefined;
 function policyService(){return configuredPolicy??=createCharterCreationPolicyAdmission(db,{chain:chain??null,...(clock?{monotonicNow:clock}:{})});}
 function preparationService(){return configuredPreparation??=createCharterCreationPreparation(db,{chain:chain??null,issuer,...(clock?{monotonicNow:clock}:{})});}
 function terminalService(){return configuredTerminal??=createCharterCreationTerminal(db,{chain:recovery===undefined?(chain?{connect:chain.connect,trust:chain.trust}:null):recovery});}
 function identity(wallet:string,id:string){if(!address.safeParse(wallet).success||!z.uuid().safeParse(id).success)return refused('INPUT',400);}
 function translate(error:unknown,id?:string):never{
  if(error instanceof HttpError){
   if(error.code?.startsWith('CLAN_CHARTER_WORKFLOW_'))throw error;
   if(/^CLAN_CHARTER_[A-Z_]*PAYER$/.test(error.code??'')||error.code==='BASE_NOT_OWNED')return unknown();
   if(error.code==='CLAN_CHARTER_CREATION_CONSENT_CONFLICT')return refused('CONFLICT',409);
   if(['CLAN_CHARTER_SIGNED_INPUT','CLAN_CHARTER_SIGNED_WIRE','CLAN_CHARTER_SIGNED_CONFLICT'].includes(error.code??''))return refused('SIGNED_INPUT',400,id);
  }
  return refused('HELD',503,id);
 }
 async function existing(wallet:string,id:string){
  identity(wallet,id);try{return await reservations.read(wallet,id);}catch(error){return translate(error);}
 }
 async function original(wallet:string,id:string){return (await existing(wallet,id))??unknown();}
 async function read(wallet:string,id:string):Promise<CharterCreationWorkflowState>{
  const saved=await original(wallet,id),c=saved.consent;
  try{
   let policy=await policies.read(wallet,id),preparation=await preparations.read(wallet,id);
   const wire=await signed.get(wallet,id),terminal=await terminals.read(wallet,id);
   if(terminal&&terminal.state!==saved.state){
    // Terminal proof may have committed after both earlier reads. Those stages
    // are now immutable: reread once without requiring local preparation for
    // authentic private terminal histories that never retained a packet.
    policy=await policies.read(wallet,id);preparation=await preparations.read(wallet,id);
   }
   // A concurrent higher stage may commit between these independent historical
   // reads. Its immutable backing wins; a single reread supplies a newly retained
   // signed packet. Never return a mixture or hide damaged source as absence.
   if(wire&&!preparation?.preparation)preparation=await preparations.read(wallet,id);
   if(preparation){if(!sameOriginal(preparation.admission.original.consent,c))return refused('HELD',503,id);policy=preparation.admission;}
   if(policy&&!sameOriginal(policy.original.consent,c))return refused('HELD',503,id);
   if(wire&&(!preparation?.preparation||wire.attemptId!==preparation.attempt.id||wire.messageSha256!==preparation.preparation.packet.messageSha256))return refused('HELD',503,id);
   if(terminal&&!sameOriginal(terminal.consent,c))return refused('HELD',503,id);
   if(saved.state!=='reserved'&&(!terminal||terminal.state!==saved.state)){
    // cancelled_unpaid may legitimately advance to refunded between reads.
    if(!(saved.state==='cancelled_unpaid'&&terminal?.state==='refunded'))return refused('HELD',503,id);
   }
   const quote=preparation?.attempt.quote,packet=preparation?.preparation?.packet;
   return Object.freeze({version:1,wallet,creationIntentId:id,request:requestFor(c),
    status:terminal?.state??(wire?'signed':packet?'prepared':preparation?'issuing':policy?'admitted':'funded'),
    original:{reservationId:c.reservationId,clanId:c.clanId,baseId:c.funding.baseId,clan:c.clan,price:{shards:c.price.shards},metadata:c.metadata},
    policy:policy?{permitId:policy.candidate.permitId,expiry:policy.candidate.expiry.toString(),signer:policy.policy.currentSigner}:null,
    preparation:preparation&&packet&&quote?{attemptId:preparation.attempt.id,packet,blockhash:quote.packetInput.blockhash,lastValidBlockHeight:quote.packetInput.lastValidBlockHeight,
     costs:{networkFeeLamports:quote.costs.networkFeeLamports.toString(),rentLamports:quote.costs.rentLamports.toString(),coreCreateFeeLamports:quote.costs.coreCreateFeeLamports.toString(),totalLamports:quote.costs.totalLamports.toString()}}:null,
    signed:wire?{signature:wire.signature,wireSha256:wire.wireSha256,messageSha256:wire.messageSha256,acceptedAt:wire.acceptedAt}:null,
    terminal:terminal?{state:terminal.state,terminalId:terminal.terminalId,terminalTransactionId:terminal.terminalTransactionId,refundTransactionId:terminal.refundTransactionId,refundDestinationBaseId:terminal.refundDestinationBaseId}:null,
    ...noAuthority});
  }catch(error){return translate(error,id);}
 }
 async function fund(wallet:string,raw:unknown):Promise<CharterCreationWorkflowState>{
  const parsed=CharterCreationRequestSchema.safeParse(raw);if(!parsed.success)return refused('INPUT',400);const input=parsed.data,id=input.creationIntentId;
  const prior=await existing(wallet,id);
  if(prior){if(!matches(prior.consent,input))return refused('CONFLICT',409);return read(wallet,id);}
  if(!phaseECharterEnabled())return refused('DISABLED');
  const configured=newCreationSchema.safeParse(newCreation);
  if(configurationInvalid||!configured.success)return refused('CONFIGURATION');
  const domain=configured.data.domain;
  if(chain)try{
   // The existing constructor validates reviewed deployment, signer, ALT and
   // cost pins synchronously; its returned transport is never invoked here.
   const {connect,...pins}=chain;createCharterCreationQuoteReader(connect,pins);
   if(chain.trust.expectedGenesisHash!==domain.genesisHash||chain.trust.economy.programId!==domain.economyProgram||chain.trust.craft.programId!==domain.craftProgram)return refused('CONFIGURATION');
  }catch{return refused('CONFIGURATION');}
  try{
   // Remote deed refresh is outside every mutation transaction. The enrolled
   // accepted epoch and B6l writer recheck exact custody again under their locks.
   await requireFreshBaseAuthority(db,wallet,input.baseId,reader,collection);
   const epoch=await custody.enroll(wallet,input.baseId);
   if(epoch.authority!=='current'||epoch.ownerWallet!==wallet)return refused('HELD');
   const clanId=randomUUID(),reservationId=randomUUID(),economy=new PublicKey(domain.economyProgram),craft=new PublicKey(domain.craftProgram),asset=charterMintPda(craft,clanId);
   const metadata={name:input.name,uri:configured.data.metadataUriPrefix+clanId},craftPda=(seed:string)=>PublicKey.findProgramAddressSync([Buffer.from(seed)],craft)[0].toBase58();
   const consent=captureCharterCreationConsent({version:1,creationIntentId:id,clanId,reservationId,payer:wallet,
    funding:{baseId:input.baseId,deedAssetId:epoch.deedAssetId,ownershipEpoch:{id:epoch.id,evidenceCommitment:epoch.evidenceCommitment}},
    clan:{name:input.name,tag:input.tag,inviteMode:input.inviteMode},price:{source:'CLANS.createCostShards',version:1,shards:String(CLANS.createCostShards)},
    metadata:{...metadata,hash:hashCharterMetadata(metadata).toString('hex')},chain:{...domain,config:charterConfigPda(economy).toBase58(),craftControl:craftPda('charter_control'),
     collection:craftPda('charter_collection'),collectionAuthority:craftPda('charter_collection_authority'),charter:charterPda(economy,clanId).toBase58(),asset:asset.toBase58(),
     assetBinding:charterAssetPda(economy,asset).toBase58(),freezeAuthority:charterFreezePda(craft,clanId).toBase58(),executor:charterExecutorPda(economy,clanId).toBase58(),creationReceipt:charterCreationPda(economy,id).toBase58()}});
   try{await createCharterCreationReservations(db,{newCreationDomain:domain}).reserve(wallet,consent);}
   catch(error){
    // Concurrent same-request callers choose provisional random UUIDs before
    // B6l's payer lock. Only the committed original may win; compare player
    // intent, never replace the original metadata/price/epoch/domain or IDs.
    if(error instanceof HttpError&&error.code==='CLAN_CHARTER_CREATION_CONSENT_CONFLICT'){
     const winner=await original(wallet,id);if(matches(winner.consent,input))return read(wallet,id);
    }
    throw error;
   }
   return read(wallet,id);
  }catch(error){return translate(error);}
 }
 async function prepare(wallet:string,id:string){
  const saved=await original(wallet,id);
  try{
   if(saved.state!=='reserved')return read(wallet,id);
   const old=await preparations.read(wallet,id);if(old?.preparation)return read(wallet,id);
   if(old){await preparationService().recover(wallet,id);return read(wallet,id);}
   if(!(await policies.read(wallet,id)))await policyService().admit(wallet,id);
   await preparationService().prepare(wallet,id);return read(wallet,id);
  }catch(error){return translate(error,id);}
 }
 async function recoverPreparation(wallet:string,id:string){await original(wallet,id);try{await preparationService().recover(wallet,id);return read(wallet,id);}catch(error){return translate(error,id);}}
 async function retainSigned(wallet:string,id:string,bytes:Uint8Array){
  if(!(bytes instanceof Uint8Array)||bytes.length<=65||bytes.length>1232)return refused('SIGNED_INPUT',400);
  const copied=Uint8Array.from(bytes);await original(wallet,id);
  try{await signed.accept(wallet,id,copied);return read(wallet,id);}catch(error){return translate(error,id);}
 }
 async function recover(wallet:string,id:string){
  await original(wallet,id);
  try{if(!(await terminals.read(wallet,id)))await terminalService().recover(wallet,id);return read(wallet,id);}
  catch(error){return translate(error,id);}
 }
 async function claimRefund(wallet:string,id:string,destinationBaseId?:string){
  const saved=await original(wallet,id);
  if(destinationBaseId!==undefined&&!z.uuid().safeParse(destinationBaseId).success)return refused('INPUT',400);
  try{
   const terminal=await terminals.read(wallet,id);if(terminal?.state==='refunded')return read(wallet,id);
   if(!terminal||terminal.state!=='cancelled_unpaid')return refused('HELD',503,id);
   try{await requireFreshBaseAuthority(db,wallet,destinationBaseId??saved.consent.funding.baseId,reader,collection);}catch{return refused('HELD',503,id);}
   await terminals.claimRefund(wallet,id,destinationBaseId);return read(wallet,id);
  }catch(error){return translate(error,id);}
 }
 return Object.freeze({fund,read,prepare,recoverPreparation,retainSigned,recover,claimRefund});
}
export type CharterCreationWorkflowProvider=ReturnType<typeof createCharterCreationWorkflow>;
