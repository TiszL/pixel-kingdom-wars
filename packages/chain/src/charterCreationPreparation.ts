/** Exact Charter v0 preparation and retained quote validation. No issuer, relay,
 * wallet signature, funding permission or live configuration is supplied here. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Ed25519Program,
  PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, type MessageV0 } from '@solana/web3.js';
import { PHASE_E_CHARTER_PREPARATION, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { createCharterAdmissionReader } from './charterAdmission';
import { address, copyTrust, copyOriginal, record, ownArray, safeSlot, LOADER } from './charterCreationAccounts';
import { charterClanIdBytes, decodeCharterRegistrationPermit, hashCharterRegistrationPayload } from './charterProtocol';
import { seekerAuthorityPda, seekerPermitReceiptPda } from './seekerAuctionProtocol';
import type { CharterAdmissionObservation } from './charterAdmission';
import type { CharterCreationEvidenceRpc, CharterCreationEvidenceTrust } from './charterCreationEvidence';
import type { CharterCreationCancellationSavedRecord } from './charterCreationCancellation';
export type CharterPreparationOriginal = CharterCreationCancellationSavedRecord['original'];
export interface CharterLookupTable {
 readonly address: string; readonly owner: string; readonly executable: boolean; readonly dataHex: string; readonly slot: number;
}
export interface CharterPacketInput {
 readonly original: CharterPreparationOriginal; readonly candidate: Uint8Array; readonly policySigner: string;
 readonly policySignature: Uint8Array | null;
 readonly lookupTable: CharterLookupTable; readonly expectedLookupTable: Readonly<{address:string;dataSha256:string}>;
 readonly blockhash: string; readonly blockhashSlot: number; readonly lastValidBlockHeight: number; readonly currentBlockHeight: number;
}
export interface CharterCreationPacket {
 readonly version: 1; readonly messageHex: string; readonly unsignedTransactionHex: string; readonly messageSha256: string;
 readonly packetBytes: number; readonly nativeInstructionIndex: 1;
 readonly signingAuthorized: false; readonly relayAuthorized: false; readonly mintAuthorized: false;
}
export interface CharterCreationQuoteRpc extends CharterCreationEvidenceRpc {
 getAccountInfoAndContext(address:PublicKey,options:{commitment:'finalized';minContextSlot:number}):Promise<{
  context:{slot:number};value:{owner:PublicKey;executable:boolean;data:Uint8Array}|null}>;
 getLatestBlockhashAndContext(options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:{blockhash:string;lastValidBlockHeight:number}}>;
 getFeeForMessage(message:MessageV0,commitment:'finalized'):Promise<{context:{slot:number};value:number|null}>;
 getMinimumBalanceForRentExemption(bytes:number,commitment:'finalized'):Promise<number>;
 getBlockHeight(options:{commitment:'finalized';minContextSlot:number}):Promise<number>;
}
export interface CharterCreationQuoteOptions {
 readonly trust: CharterCreationEvidenceTrust; readonly expectedCurrentSigner: string;
 readonly lookupTable: Readonly<{address:string;dataSha256:string}>;
 /** Operator's explicit reviewed-byte-to-cost-profile mapping, not RPC proof. */
 readonly coreCostProfile: Readonly<{version:1;profile:'mpl-core-0.15.2-charter-pfd-seq-none';reviewedProgramDataSha256:string}>;
 readonly costLimits: Readonly<{maxNetworkFeeLamports:bigint;maxRentLamports:bigint;maxTotalLamports:bigint}>;
}
export interface CharterCreationQuote {
 readonly version:1; readonly packetInput:Omit<CharterPacketInput,'candidate'|'policySignature'> & {readonly candidateHex:string};
 readonly observation:CharterAdmissionObservation; readonly template:CharterCreationPacket;
 readonly costs:Readonly<{allocations:readonly Readonly<{kind:string;address:string;bytes:number;minimumBalanceLamports:bigint}>[];
  networkFeeLamports:bigint;rentLamports:bigint;coreCreateFeeLamports:bigint;totalLamports:bigint}>;
 readonly coreCostProfile:CharterCreationQuoteOptions['coreCostProfile'];
 readonly costLimits:CharterCreationQuoteOptions['costLimits'];
 readonly context:Readonly<{feeSlot:number;closingSlot:number;closingGenesisHash:string}>;
 readonly signingAuthorized:false; readonly mintAuthorized:false; readonly paymentAuthorized:false;
}
export class CharterCreationPreparationError extends Error {
 constructor(readonly code:string){super('Charter preparation refused: '+code);this.name='CharterCreationPreparationError';}
}
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const U64_MAX = (1n << 64n) - 1n;
const sha = (bytes:Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function need(value:unknown,code:string):asserts value { if(!value)throw new CharterCreationPreparationError(code); }
function checked<T>(code:string,read:()=>T):T {
 try{return read();}catch(error){if(error instanceof CharterCreationPreparationError)throw error;throw new CharterCreationPreparationError(code);}
}
function object(value:unknown,fields:string,code:string){return checked(code,()=>record(value,fields));}
function key(value:unknown,code:string){return checked(code,()=>address(value));}
function hex(value:unknown,maxBytes:number,code:string,exact=false):string {
 need(typeof value==='string'&&value.length>0&&value.length<=maxBytes*2&&value.length%2===0&&/^[0-9a-f]+$/.test(value),code);
 need(!exact||value.length===maxBytes*2,code);return value;
}
function integer(value:unknown,code:string):number {need(safeSlot(value),code);return value;}
function unsigned(value:unknown,code:string,positive=false):bigint {
 need(typeof value==='bigint'||(typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)),code);
 const n=BigInt(value);need(n>=(positive?1n:0n)&&n<=U64_MAX,code);return n;
}
function signed(value:unknown,code:string):bigint {
 need(typeof value==='bigint'||(typeof value==='string'&&/^(0|-?[1-9][0-9]{0,18})$/.test(value)),code);
 const n=BigInt(value);need(n>=-(1n<<63n)&&n<(1n<<63n),code);return n;
}
function copyOriginalPins(value:unknown):CharterPreparationOriginal {
 return checked('IDENTITY',()=>{
  const r=record(value,'creationIntentId clanId payer metadata chain admissionCommitment');
  const c=record(r.chain,'genesisHash economyProgram craftProgram config craftControl collection collectionAuthority charter asset assetBinding freezeAuthority executor creationReceipt');
  // copyOriginal validates all original PDAs/metadata. Only the three domain
  // fields are consumed from this argument; these are equality pins, not a
  // fabricated deployment attestation or caller authorization.
  const domain={expectedGenesisHash:address(c.genesisHash),economy:{programId:address(c.economyProgram)},craft:{programId:address(c.craftProgram)}};
  need(new Set([domain.economy.programId,domain.craft.programId,CORE.toBase58()]).size===3,'IDENTITY');
  return copyOriginal(r,r.creationIntentId as string,domain as CharterCreationEvidenceTrust);
 });
}
function copyCandidate(value:unknown,original:CharterPreparationOriginal):Buffer {
 return checked('IDENTITY',()=>{
  need(value instanceof Uint8Array&&value.byteLength===161,'IDENTITY');const bytes=Buffer.from(value),p=decodeCharterRegistrationPermit(bytes),c=original.chain;
  const k=(s:string)=>new PublicKey(s);
  const payload=hashCharterRegistrationPayload({config:k(c.config),craftProgram:k(c.craftProgram),craftControl:k(c.craftControl),collection:k(c.collection),collectionAuthority:k(c.collectionAuthority),
   charter:k(c.charter),asset:k(c.asset),assetBinding:k(c.assetBinding),freezeAuthority:k(c.freezeAuthority),executor:k(c.executor),creationReceipt:k(c.creationReceipt),
   clanId:original.clanId,leader:k(original.payer),creationIntentId:original.creationIntentId,metadataHash:Buffer.from(original.metadata.hash,'hex'),admissionCommitment:Buffer.from(original.admissionCommitment,'hex')});
  need(p.genesisHash.toBase58()===c.genesisHash&&p.programId.toBase58()===c.economyProgram&&p.wallet.toBase58()===original.payer&&Buffer.from(p.payloadHash).equals(payload),'IDENTITY');return bytes;
 });
}
function copyPin(value:unknown){const p=object(value,'address dataSha256','LOOKUP');return Object.freeze({address:key(p.address,'LOOKUP'),dataSha256:hex(p.dataSha256,32,'LOOKUP',true)});}
function copyLookup(value:unknown,pin:CharterPacketInput['expectedLookupTable']):CharterLookupTable {
 return checked('LOOKUP',()=>{
  const r=object(value,'address owner executable dataHex slot','LOOKUP');
  const row=Object.freeze({address:key(r.address,'LOOKUP'),owner:key(r.owner,'LOOKUP'),executable:r.executable as boolean,dataHex:hex(r.dataHex,56+256*32,'LOOKUP'),slot:integer(r.slot,'LOOKUP')});
  const bytes=Buffer.from(row.dataHex,'hex');
  need(row.address===pin.address&&row.owner===AddressLookupTableProgram.programId.toBase58()&&row.executable===false&&sha(bytes)===pin.dataSha256,'LOOKUP');
  need(bytes.length>=56&&(bytes.length-56)%32===0&&bytes.readUInt32LE(0)===1&&bytes.readBigUInt64LE(4)===U64_MAX
   &&bytes.readBigUInt64LE(12)<BigInt(row.slot)&&bytes[21]===0&&bytes[20]!<=(bytes.length-56)/32,'LOOKUP');
  const table=AddressLookupTableAccount.deserialize(bytes);
  need(table.authority===undefined&&table.addresses.length>0&&table.addresses.length<=256
   &&new Set(table.addresses.map(k=>k.toBase58())).size===table.addresses.length,'LOOKUP');return row;
 });
}
function copyPacketInput(value:unknown):CharterPacketInput {
 const r=object(value,'original candidate policySigner policySignature lookupTable expectedLookupTable blockhash blockhashSlot lastValidBlockHeight currentBlockHeight','INPUT');
 const original=copyOriginalPins(r.original),candidate=copyCandidate(r.candidate,original),policySigner=key(r.policySigner,'SIGNATURE');
 let signature:Buffer|null=null;
 if(r.policySignature!==null){
  need(r.policySignature instanceof Uint8Array&&r.policySignature.byteLength===64,'SIGNATURE');signature=Buffer.from(r.policySignature);
  const publicKey=createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(policySigner).toBuffer()])});
  need(verify(null,candidate,publicKey,signature),'SIGNATURE');
 }
 const expectedLookupTable=copyPin(r.expectedLookupTable),lookupTable=copyLookup(r.lookupTable,expectedLookupTable);
 const blockhash=key(r.blockhash,'BLOCKHASH'),blockhashSlot=integer(r.blockhashSlot,'BLOCKHASH'),lastValidBlockHeight=integer(r.lastValidBlockHeight,'BLOCKHASH'),currentBlockHeight=integer(r.currentBlockHeight,'BLOCKHASH');
 need(blockhashSlot>=lookupTable.slot&&currentBlockHeight<=lastValidBlockHeight,'BLOCKHASH');
 return {original,candidate,policySigner,policySignature:signature,expectedLookupTable,lookupTable,blockhash,blockhashSlot,lastValidBlockHeight,currentBlockHeight};
}
function keys(original:CharterPreparationOriginal,candidate:Uint8Array){
 const c=original.chain,k=(s:string)=>new PublicKey(s),economy=k(c.economyProgram);
 const all=[k(original.payer),seekerAuthorityPda(economy),k(c.config),k(c.charter),k(c.assetBinding),k(c.creationReceipt),
  seekerPermitReceiptPda(economy,candidate.subarray(73,89)),k(c.executor),k(c.craftProgram),k(c.craftControl),k(c.asset),k(c.collection),k(c.collectionAuthority),k(c.freezeAuthority),
  CORE,SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId,economy];
 need(new Set(all.map(k=>k.toBase58())).size===18,'IDENTITY');
 return all.map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:[0,3,4,5,6,10,11].includes(i)}));
}
function packet(input:CharterPacketInput):CharterCreationPacket {
 return checked('PACKET',()=>{
  const o=input.original,p=decodeCharterRegistrationPermit(input.candidate),n=Buffer.alloc(26);Buffer.from(p.permitId).copy(n);n.writeBigInt64LE(p.expiry,16);n.writeUInt16LE(1,24);
  const str=(s:string)=>{const b=Buffer.from(s),size=Buffer.alloc(4);size.writeUInt32LE(b.length);return Buffer.concat([size,b]);};
  const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_CHARTER_PREPARATION.computeUnitLimit}),
   Ed25519Program.createInstructionWithPublicKey({publicKey:new PublicKey(input.policySigner).toBytes(),message:input.candidate,signature:input.policySignature??new Uint8Array(64)}),
   new TransactionInstruction({programId:new PublicKey(o.chain.economyProgram),keys:keys(o,input.candidate),data:Buffer.concat([
    createHash('sha256').update('global:register_charter').digest().subarray(0,8),charterClanIdBytes(o.clanId),charterClanIdBytes(o.creationIntentId),Buffer.from(o.admissionCommitment,'hex'),str(o.metadata.name),str(o.metadata.uri),n])})];
  const lookup=new AddressLookupTableAccount({key:new PublicKey(input.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(input.lookupTable.dataHex,'hex'))});
  const message=new TransactionMessage({payerKey:new PublicKey(o.payer),recentBlockhash:input.blockhash,instructions}).compileToV0Message([lookup]);
  need(message.header.numRequiredSignatures===1&&message.addressTableLookups.length===1,'PACKET');
  const bytes=Buffer.from(message.serialize()),wire=Buffer.from(new VersionedTransaction(message).serialize());need(wire.length<=1232,'PACKET');
  need(Buffer.from(VersionedTransaction.deserialize(wire).serialize()).equals(wire),'PACKET');
  return Object.freeze({version:1,messageHex:bytes.toString('hex'),unsignedTransactionHex:wire.toString('hex'),messageSha256:sha(bytes),packetBytes:wire.length,nativeInstructionIndex:1,
   signingAuthorized:false,relayAuthorized:false,mintAuthorized:false});
 });
}
export function buildCharterCreationPacket(input:CharterPacketInput):CharterCreationPacket {return packet(copyPacketInput(input));}
export function verifyCharterCreationPacket(input:CharterPacketInput,value:unknown):CharterCreationPacket {
 const expected=buildCharterCreationPacket(input),r=object(value,'version messageHex unsignedTransactionHex messageSha256 packetBytes nativeInstructionIndex signingAuthorized relayAuthorized mintAuthorized','PACKET');
 for(const field of Object.keys(expected) as (keyof CharterCreationPacket)[])need(r[field]===expected[field],'PACKET');return expected;
}
function copyLimits(value:unknown):CharterCreationQuoteOptions['costLimits'] {
 const r=object(value,'maxNetworkFeeLamports maxRentLamports maxTotalLamports','COST');
 return Object.freeze({maxNetworkFeeLamports:unsigned(r.maxNetworkFeeLamports,'COST',true),maxRentLamports:unsigned(r.maxRentLamports,'COST',true),maxTotalLamports:unsigned(r.maxTotalLamports,'COST',true)});
}
function copyProfile(value:unknown,coreHash:string):CharterCreationQuoteOptions['coreCostProfile'] {
 const r=object(value,'version profile reviewedProgramDataSha256','COST_PROFILE');
 need(r.version===1&&r.profile==='mpl-core-0.15.2-charter-pfd-seq-none'&&hex(r.reviewedProgramDataSha256,32,'COST_PROFILE',true)===coreHash,'COST_PROFILE');
 return Object.freeze({version:1,profile:r.profile,reviewedProgramDataSha256:coreHash});
}
function allocationPlan(original:CharterPreparationOriginal,candidate:Uint8Array){
 const c=original.chain;
 return [
  {kind:'charter',address:c.charter,bytes:280},{kind:'assetBinding',address:c.assetBinding,bytes:90},{kind:'creationReceipt',address:c.creationReceipt,bytes:154},
  {kind:'permitReceipt',address:seekerPermitReceiptPda(new PublicKey(c.economyProgram),candidate.subarray(73,89)).toBase58(),bytes:107},
  {kind:'asset',address:c.asset,bytes:137+Buffer.byteLength(original.metadata.name)+Buffer.byteLength(original.metadata.uri)},
 ];
}
function copyObservation(value:unknown,original:CharterPreparationOriginal,signer:string):CharterAdmissionObservation {
 const code='IDENTITY',r=object(value,'version domain authority craftControl expectedCurrentSigner currentSignerObserved slot unixTimestamp source transactionProofVerified mintAuthorized paymentAuthorized signingAuthorized activationAuthorized refundAuthorized reservationReleaseAuthorized',code);
 need(r.version===1&&r.currentSignerObserved===true&&r.expectedCurrentSigner===signer,code);
 for(const field of ['transactionProofVerified','mintAuthorized','paymentAuthorized','signingAuthorized','activationAuthorized','refundAuthorized','reservationReleaseAuthorized'])need(r[field]===false,code);
 const d=object(r.domain,'genesisHash economyProgram craftProgram',code),c=original.chain;
 need(d.genesisHash===c.genesisHash&&d.economyProgram===c.economyProgram&&d.craftProgram===c.craftProgram,code);
 const a=object(r.authority,'address currentPolicyKey previousPolicyKey previousValidUntil admissionPaused',code),control=object(r.craftControl,'address admissionPaused',code);
 need(a.address===seekerAuthorityPda(new PublicKey(c.economyProgram)).toBase58()&&a.currentPolicyKey===signer&&a.admissionPaused===false&&control.address===c.craftControl&&control.admissionPaused===false,code);
 const source=object(r.source,'trust stateProvenance genesisHash programs accounts',code);
 need(source.trust==='trusted-finalized-rpc-reviewed-program'&&source.genesisHash===c.genesisHash,code);
 const supplied=checked(code,()=>ownArray(source.programs,3,'INPUT'));need(supplied.length===3,code);
 const trust=checked(code,()=>copyTrust({expectedGenesisHash:source.genesisHash,stateProvenance:source.stateProvenance,economy:supplied[0],craft:supplied[1],core:supplied[2]}));
 need(trust.economy.programId===c.economyProgram&&trust.craft.programId===c.craftProgram,code);
 const programs=Object.freeze([trust.economy,trust.craft,trust.core]),slot=integer(r.slot,code),unixTimestamp=signed(r.unixTimestamp,code);
 need(unixTimestamp>=0n&&programs.every(p=>p.reviewedDeploymentSlot<=slot),code);
 const addresses=programs.flatMap(p=>[p.programId,PublicKey.findProgramAddressSync([new PublicKey(p.programId).toBuffer()],LOADER)[0].toBase58()]);
 addresses.push(a.address as string,c.config,c.craftControl,SYSVAR_CLOCK_PUBKEY.toBase58());
 const rows=checked(code,()=>ownArray(source.accounts,10,'INPUT'));need(rows.length===10,code);
 const accounts=Object.freeze(rows.map((v,i)=>{
  const row=object(v,'address owner executable dataSha256',code);
  need(row.address===addresses[i]&&row.owner===(i<6?LOADER.toBase58():i<8?c.economyProgram:i===8?c.craftProgram:'Sysvar1111111111111111111111111111111111111')&&row.executable===(i<6&&i%2===0),code);
  const hash=hex(row.dataSha256,32,code,true);if(i<6&&i%2===1)need(hash===programs[(i-1)/2]!.reviewedProgramDataSha256,code);
  return Object.freeze({address:row.address as string,owner:row.owner as string,executable:row.executable as boolean,dataSha256:hash});
 }));
 const previousPolicyKey=a.previousPolicyKey===null?null:key(a.previousPolicyKey,code),previousValidUntil=signed(a.previousValidUntil,code);
 need(previousValidUntil>=0n&&(previousPolicyKey===null?previousValidUntil===0n:previousPolicyKey!==signer),code);
 return Object.freeze({version:1,domain:Object.freeze({genesisHash:c.genesisHash,economyProgram:c.economyProgram,craftProgram:c.craftProgram}),
  authority:Object.freeze({address:a.address as string,currentPolicyKey:signer,previousPolicyKey,previousValidUntil,admissionPaused:false}),
  craftControl:Object.freeze({address:c.craftControl,admissionPaused:false}),expectedCurrentSigner:signer,currentSignerObserved:true,slot,unixTimestamp,
  source:Object.freeze({trust:'trusted-finalized-rpc-reviewed-program',stateProvenance:trust.stateProvenance,genesisHash:c.genesisHash,programs,accounts}),
  transactionProofVerified:false,mintAuthorized:false,paymentAuthorized:false,signingAuthorized:false,activationAuthorized:false,refundAuthorized:false,reservationReleaseAuthorized:false});
}
/** Pure structural and cryptographic consistency of retained review evidence.
 * This does not authenticate caller-supplied history or grant current authority. */
export function verifyCharterCreationQuote(value:unknown):CharterCreationQuote {
 const r=object(value,'version packetInput observation template costs coreCostProfile costLimits context signingAuthorized mintAuthorized paymentAuthorized','INPUT');
 need(r.version===1&&r.signingAuthorized===false&&r.mintAuthorized===false&&r.paymentAuthorized===false,'INPUT');
 const i=object(r.packetInput,'original candidateHex policySigner lookupTable expectedLookupTable blockhash blockhashSlot lastValidBlockHeight currentBlockHeight','INPUT');
 const candidateHex=hex(i.candidateHex,161,'IDENTITY',true),{candidateHex:_hex,...savedInput}=i;
 const input=copyPacketInput({...savedInput,candidate:Buffer.from(candidateHex,'hex'),policySignature:null});
 const {candidate:_,policySignature:__,...pins}=input;
 const packetInput=Object.freeze({...pins,candidateHex}),template=verifyCharterCreationPacket(input,r.template as CharterCreationPacket),observation=copyObservation(r.observation,input.original,input.policySigner);
 need(input.lookupTable.slot>=observation.slot&&input.blockhashSlot>=observation.slot,'BLOCKHASH');
 const expiry=decodeCharterRegistrationPermit(input.candidate).expiry;
 need(expiry>observation.unixTimestamp&&expiry-observation.unixTimestamp<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),'EXPIRED');
 const context=object(r.context,'feeSlot closingSlot closingGenesisHash','COST');
 const feeSlot=integer(context.feeSlot,'COST'),closingSlot=integer(context.closingSlot,'COST');
 need(feeSlot>=input.blockhashSlot&&closingSlot>=feeSlot&&context.closingGenesisHash===input.original.chain.genesisHash,'COST');
 const coreCostProfile=copyProfile(r.coreCostProfile,observation.source.programs[2]!.reviewedProgramDataSha256),costLimits=copyLimits(r.costLimits);
 const costs=object(r.costs,'allocations networkFeeLamports rentLamports coreCreateFeeLamports totalLamports','COST'),plan=allocationPlan(input.original,input.candidate);
 const rows=checked('COST',()=>ownArray(costs.allocations,5,'INPUT'));need(rows.length===5,'COST');
 const allocations=Object.freeze(rows.map((row,j)=>{const a=object(row,'kind address bytes minimumBalanceLamports','COST'),expected=plan[j]!;
  need(a.kind===expected.kind&&a.address===expected.address&&a.bytes===expected.bytes,'COST');const minimumBalanceLamports=unsigned(a.minimumBalanceLamports,'COST');
  need(minimumBalanceLamports<=BigInt(Number.MAX_SAFE_INTEGER),'COST');return Object.freeze({...expected,minimumBalanceLamports});}));
 const networkFeeLamports=unsigned(costs.networkFeeLamports,'COST'),rentLamports=unsigned(costs.rentLamports,'COST'),coreCreateFeeLamports=unsigned(costs.coreCreateFeeLamports,'COST'),totalLamports=unsigned(costs.totalLamports,'COST');
 need(networkFeeLamports<=BigInt(Number.MAX_SAFE_INTEGER)&&rentLamports===allocations.reduce((n,a)=>n+a.minimumBalanceLamports,0n)&&coreCreateFeeLamports===BigInt(PHASE_E_CHARTER_PREPARATION.coreCreateFeeLamports)
  &&totalLamports===networkFeeLamports+rentLamports+coreCreateFeeLamports&&networkFeeLamports<=costLimits.maxNetworkFeeLamports&&rentLamports<=costLimits.maxRentLamports&&totalLamports<=costLimits.maxTotalLamports,'COST');
 return Object.freeze({version:1,packetInput,observation,template,coreCostProfile,costLimits,context:Object.freeze({feeSlot,closingSlot,closingGenesisHash:input.original.chain.genesisHash}),
  costs:Object.freeze({allocations,networkFeeLamports,rentLamports,coreCreateFeeLamports,totalLamports}),signingAuthorized:false,mintAuthorized:false,paymentAuthorized:false});
}
/** One bounded finalized review. Application-owned options are copied once;
 * original pins and candidate are copied before opening any provider await. */
export function createCharterCreationQuoteReader(connect:(signal:AbortSignal)=>CharterCreationQuoteRpc,options:CharterCreationQuoteOptions){
 need(typeof connect==='function','INPUT');
 const opts=object(options,'trust expectedCurrentSigner lookupTable coreCostProfile costLimits','INPUT');
 const trust=checked('INPUT',()=>copyTrust(opts.trust)),expectedCurrentSigner=key(opts.expectedCurrentSigner,'INPUT'),pin=copyPin(opts.lookupTable);
 const coreCostProfile=copyProfile(opts.coreCostProfile,trust.core.reviewedProgramDataSha256),costLimits=copyLimits(opts.costLimits);
 let pending=0;
 return async(originalInput:CharterPreparationOriginal,candidateInput:Uint8Array):Promise<CharterCreationQuote>=>{
  const original=copyOriginalPins(originalInput),candidate=copyCandidate(candidateInput,original);
  need(original.chain.genesisHash===trust.expectedGenesisHash&&original.chain.economyProgram===trust.economy.programId&&original.chain.craftProgram===trust.craft.programId,'IDENTITY');
  need(pending<PHASE_E_CHARTER_PREPARATION.maxPending,'BUSY');pending++;
  const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let done=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(done&&!released&&outstanding.size===0){released=true;pending--;}};
  const active=()=>need(!controller.signal.aborted,'DEADLINE');
  async function call<T>(operation:()=>Promise<T>):Promise<T>{
   active();const work=Promise.resolve().then(()=>{active();return operation();});outstanding.add(work);
   try{const value=await work;active();return value;}finally{outstanding.delete(work);release();}
  }
  const work=(async()=>{
   const rpc=connect(controller.signal);
   // The established admission bank validates reviewed deployments, authority,
   // config, control and Clock. Wrap each stage in this operation's deadline;
   // its independent budget cannot start later RPC after our abort.
   const admission=createCharterAdmissionReader(()=>({
    getGenesisHash:()=>call(()=>rpc.getGenesisHash()),getSlot:c=>call(()=>rpc.getSlot(c)),
    getMultipleAccountsInfoAndContext:(keys,settings)=>call(()=>rpc.getMultipleAccountsInfoAndContext(keys,settings)),
   }),trust,expectedCurrentSigner);
   const observation=await call(admission),expiry=decodeCharterRegistrationPermit(candidate).expiry;
   need(expiry>observation.unixTimestamp&&expiry-observation.unixTimestamp<=BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),'EXPIRED');
   const alt=await call(()=>rpc.getAccountInfoAndContext(new PublicKey(pin.address),{commitment:'finalized',minContextSlot:observation.slot}));
   need(alt&&safeSlot(alt.context?.slot)&&alt.context.slot>=observation.slot,'LOOKUP');
   const raw=object(alt.value,'owner executable data','LOOKUP');
   need(raw.owner instanceof PublicKey&&raw.data instanceof Uint8Array&&raw.data.byteLength<=56+256*32,'LOOKUP');
   // Detach raw ALT bytes immediately, before the blockhash provider can yield.
   const lookupTable=copyLookup({address:pin.address,owner:raw.owner.toBase58(),executable:raw.executable,dataHex:Buffer.from(raw.data).toString('hex'),slot:alt.context.slot},pin);
   const block=await call(()=>rpc.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:lookupTable.slot}));
   need(block&&safeSlot(block.context?.slot)&&block.context.slot>=lookupTable.slot,'BLOCKHASH');
   const blockValue=object(block.value,'blockhash lastValidBlockHeight','BLOCKHASH'),blockhash=key(blockValue.blockhash,'BLOCKHASH'),lastValidBlockHeight=integer(blockValue.lastValidBlockHeight,'BLOCKHASH'),blockhashSlot=block.context.slot;
   // A zero height is used only to compile the fee template. The actual final
   // finalized height is retained and checked before returning any quote.
   const input:CharterPacketInput={original,candidate,policySigner:expectedCurrentSigner,policySignature:null,lookupTable,expectedLookupTable:pin,blockhash,blockhashSlot,lastValidBlockHeight,currentBlockHeight:0};
   const template=buildCharterCreationPacket(input),fee=await call(()=>rpc.getFeeForMessage(VersionedTransaction.deserialize(Buffer.from(template.unsignedTransactionHex,'hex')).message as MessageV0,'finalized'));
   need(fee&&safeSlot(fee.context?.slot)&&fee.context.slot>=blockhashSlot&&typeof fee.value==='number'&&Number.isSafeInteger(fee.value)&&fee.value>=0,'COST');
   const feeSlot=fee.context.slot,networkFeeLamports=BigInt(fee.value);
   const allocations=[] as {kind:string;address:string;bytes:number;minimumBalanceLamports:bigint}[];
   for(const item of allocationPlan(original,candidate)){
    const rent=await call(()=>rpc.getMinimumBalanceForRentExemption(item.bytes,'finalized'));
    need(typeof rent==='number'&&Number.isSafeInteger(rent)&&rent>=0,'COST');allocations.push({...item,minimumBalanceLamports:BigInt(rent)});
   }
   const rentLamports=allocations.reduce((n,a)=>n+a.minimumBalanceLamports,0n),coreCreateFeeLamports=BigInt(PHASE_E_CHARTER_PREPARATION.coreCreateFeeLamports),totalLamports=networkFeeLamports+rentLamports+coreCreateFeeLamports;
   need(totalLamports<=U64_MAX&&networkFeeLamports<=costLimits.maxNetworkFeeLamports&&rentLamports<=costLimits.maxRentLamports&&totalLamports<=costLimits.maxTotalLamports,'COST');
   const currentBlockHeight=integer(await call(()=>rpc.getBlockHeight({commitment:'finalized',minContextSlot:Math.max(blockhashSlot,feeSlot)})),'BLOCKHASH');
   need(currentBlockHeight<=lastValidBlockHeight,'BLOCKHASH');
   const closingSlot=integer(await call(()=>rpc.getSlot('finalized')),'COST'),closingGenesisHash=await call(()=>rpc.getGenesisHash());
   need(closingSlot>=Math.max(blockhashSlot,feeSlot,lookupTable.slot,observation.slot)&&closingGenesisHash===trust.expectedGenesisHash,'IDENTITY');
   active();
   const {candidate:_,policySignature:__,...packetInput}=input;
   return verifyCharterCreationQuote({version:1,packetInput:{...packetInput,currentBlockHeight,candidateHex:candidate.toString('hex')},observation,template,coreCostProfile,costLimits,
    context:{feeSlot,closingSlot,closingGenesisHash},costs:{allocations,networkFeeLamports,rentLamports,coreCreateFeeLamports,totalLamports},signingAuthorized:false,mintAuthorized:false,paymentAuthorized:false});
  })();
  void work.then(()=>{done=true;release();},()=>{done=true;release();});
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new CharterCreationPreparationError('DEADLINE'));},PHASE_E_CHARTER_PREPARATION.timeoutMs);})]);}
  catch(error){if(error instanceof CharterCreationPreparationError)throw error;throw new CharterCreationPreparationError('UNAVAILABLE');}
  finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
 };
}
