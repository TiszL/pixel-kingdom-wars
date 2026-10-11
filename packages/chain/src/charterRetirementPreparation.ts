/** Current exact retirement quote and packet. Terminal consent never proves
 * backend liability clearance or authorizes database dissolution. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AddressLookupTableAccount,AddressLookupTableProgram,ComputeBudgetProgram,Ed25519Program,PublicKey,SYSVAR_CLOCK_PUBKEY,SystemProgram,TransactionMessage,VersionedTransaction,MessageV0} from '@solana/web3.js';
import {PHASE_E_CHARTER_PREPARATION,PHASE_E_CHARTER_ADMISSION} from '@shardkeep/shared';
import {copyTrust,copySaved,record,ownArray,address,uuid,safeSlot,attestProgram,verifyCommon,verifyCore,LOADER,MAX_PROGRAM_BYTES,MAX_CORE_BYTES,type OwnedAccount,type CharterCreationSavedRecord,type CharterCreationEvidenceTrust,type CharterCreationEvidenceRpc} from './charterCreationAccounts';
import {decodeSeekerAuthority} from './seekerAuthorityAccount';
import {charterClanIdBytes} from './charterProtocol';
import {transferDisc} from './charterTransferProtocol';
import {hashCharterRetirementPayload,encodeCharterRetirementPermit,buildCharterRetirementInstruction,charterRetirementReceiptPda,type CharterRetirementTerms} from './charterRetirementProtocol';
import {seekerAuthorityPda,seekerPermitReceiptPda} from './seekerAuctionProtocol';
import type {CharterCreationQuoteRpc,CharterLookupTable} from './charterCreationPreparation';
export interface CharterRetirementOriginal {
 readonly creation:CharterCreationSavedRecord;
 readonly retirement:Readonly<{id:string;fenceId:string;clanId:string;leader:string;expectedRevision:number;clearanceHash:string}>;
}
export interface CharterRetirementPacketInput {
 readonly original:CharterRetirementOriginal;readonly candidateHex:string;readonly policySigner:string;readonly policySignatureHex:string|null;
 readonly lookupTable:CharterLookupTable;readonly expectedLookupTable:Readonly<{address:string;dataSha256:string}>;
 readonly blockhash:string;readonly blockhashSlot:number;readonly lastValidBlockHeight:number;readonly currentBlockHeight:number;
}
export interface CharterRetirementPacket {
 readonly version:1;readonly messageHex:string;readonly unsignedTransactionHex:string;readonly messageSha256:string;
 readonly packetBytes:number;readonly nativeInstructionIndex:1;readonly signingAuthorized:false;readonly relayAuthorized:false;
}
export interface CharterRetirementQuoteOptions {
 readonly trust:CharterCreationEvidenceTrust;readonly expectedCurrentSigner:string;
 readonly lookupTable:Readonly<{address:string;dataSha256:string}>;
 readonly costLimits:Readonly<{maxNetworkFeeLamports:bigint;maxRentLamports:bigint;maxAdditionalLamports:bigint}>;
}
export type CharterRetirementQuoteRpc=CharterCreationQuoteRpc;
export interface CharterRetirementQuote {
 readonly version:1;readonly packetInput:Omit<CharterRetirementPacketInput,'policySignatureHex'>;
 readonly observation:Readonly<{slot:number;unixTimestamp:string;registryRevision:number;registryLeader:string;lockKind:0;lockId:string;
  policySigner:string;admissionPaused:false;craftPaused:false;
  source:Readonly<{genesisHash:string;programs:CharterCreationEvidenceTrust;
   accounts:readonly Readonly<{address:string;owner:string|null;executable:boolean|null;dataSha256:string|null}>[]}>}>;
 readonly template:CharterRetirementPacket;
 readonly costs:Readonly<{networkFeeLamports:string;rentLamports:string;totalLamports:string;
  allocations:readonly Readonly<{kind:'permit-receipt'|'retirement-receipt';address:string;bytes:number;minimumBalanceLamports:string}>[]}>;
 readonly costLimits:Readonly<{maxNetworkFeeLamports:string;maxRentLamports:string;maxAdditionalLamports:string}>;
 readonly context:Readonly<{feeSlot:number;closingSlot:number;closingGenesisHash:string}>;
 readonly signingAuthorized:false;readonly retirementAuthorized:false;readonly fenceReleaseAuthorized:false;
}
export class CharterRetirementPreparationError extends Error {
 constructor(readonly code:string){super('Charter retirement preparation held: '+code);}
}
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),U64=(1n<<64n)-1n;
export function retirementPreparationNeed(v:unknown,code:string):asserts v {if(!v)throw new CharterRetirementPreparationError(code);}
const need:typeof retirementPreparationNeed=retirementPreparationNeed;
function obj(v:unknown,fields:string){return record(v,fields);}
function nat(v:unknown,positive=false):string {need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),'INPUT');const n=BigInt(v);need(n>=(positive?1n:0n)&&n<=U64,'INPUT');return v;}
function hex(v:unknown,bytes:number):string{need(typeof v==='string'&&v.length===bytes*2&&/^[0-9a-f]+$/.test(v),'INPUT');return v;}
function boundedHex(v:unknown,max:number):string{need(typeof v==='string'&&v.length>0&&v.length<=max*2&&v.length%2===0&&/^[0-9a-f]+$/.test(v),'INPUT');return v;}
function num(v:unknown):number{need(safeSlot(v),'INPUT');return v;}
function frozen<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
function checked<T>(f:()=>T):T{try{return f();}catch(e){if(e instanceof CharterRetirementPreparationError)throw e;throw new CharterRetirementPreparationError('INPUT');}}
/** Internal shared parser for current quote and original cancellation. */
export function copyCharterRetirementOriginal(input:unknown,trust?:CharterCreationEvidenceTrust):CharterRetirementOriginal{return checked(()=>{
 const r=obj(input,'creation retirement'),c=obj(r.creation,'creationIntentId clanId payer metadata chain admissionCommitment issuedPermitIds');
 const chain=record(c.chain,'genesisHash economyProgram craftProgram config craftControl collection collectionAuthority charter asset assetBinding freezeAuthority executor creationReceipt');
 const pins=trust??{expectedGenesisHash:address(chain.genesisHash),economy:{programId:address(chain.economyProgram)},craft:{programId:address(chain.craftProgram)}} as CharterCreationEvidenceTrust;
 const creation=copySaved(c,uuid(c.creationIntentId,'INPUT'),pins),o=obj(r.retirement,'id fenceId clanId leader expectedRevision clearanceHash');
 const retirement={id:uuid(o.id,'INPUT'),fenceId:uuid(o.fenceId,'INPUT'),clanId:uuid(o.clanId,'INPUT'),leader:address(o.leader),expectedRevision:num(o.expectedRevision),clearanceHash:hex(o.clearanceHash,32)};
 need(retirement.expectedRevision<0xffffffff&&retirement.clanId===creation.clanId,'REVISION');const value={creation,retirement};retirementParts(value);return frozen(value);
});}
export function retirementParts(original:CharterRetirementOriginal){
 const c=original.creation,o=original.retirement,economy=new PublicKey(c.chain.economyProgram),craft=new PublicKey(c.chain.craftProgram),leader=new PublicKey(o.leader);
 const terms:CharterRetirementTerms={clanId:c.clanId,retirementId:o.id,fenceId:o.fenceId,expectedRevision:o.expectedRevision,clearanceHash:Buffer.from(o.clearanceHash,'hex')};
 buildCharterRetirementInstruction(economy,craft,leader,terms,{permitId:new Uint8Array(16),expiry:1n,ed25519Instruction:1});return {economy,craft,leader,terms};
}
export function retirementCandidate(original:CharterRetirementOriginal,value:unknown){
 const candidate=Buffer.from(hex(value,161),'hex'),{economy,craft,leader,terms}=retirementParts(original),permitId=Buffer.from(candidate.subarray(73,89)),expiry=candidate.readBigInt64LE(121);
 need(expiry>0n,'PERMIT');const expected=encodeCharterRetirementPermit(new PublicKey(original.creation.chain.genesisHash),economy,leader,{permitId,expiry},hashCharterRetirementPayload(economy,craft,leader,terms));
 need(candidate.equals(expected),'PERMIT');return {candidate,permitId,expiry,ed25519Instruction:1};
}
function copyPacket(input:unknown):CharterRetirementPacketInput{
 const p=obj(input,'original candidateHex policySigner policySignatureHex lookupTable expectedLookupTable blockhash blockhashSlot lastValidBlockHeight currentBlockHeight');
 const original=copyCharterRetirementOriginal(p.original),candidateHex=hex(p.candidateHex,161),policySigner=address(p.policySigner),signature=p.policySignatureHex===null?null:hex(p.policySignatureHex,64);retirementCandidate(original,candidateHex);
 const row=obj(p.lookupTable,'address owner executable dataHex slot'),pin=obj(p.expectedLookupTable,'address dataSha256');
 const lookupTable={address:address(row.address),owner:address(row.owner),executable:row.executable as boolean,dataHex:boundedHex(row.dataHex,8248),slot:num(row.slot)},expectedLookupTable={address:address(pin.address),dataSha256:hex(pin.dataSha256,32)};
 need(lookupTable.owner===AddressLookupTableProgram.programId.toBase58()&&lookupTable.executable===false&&lookupTable.address===expectedLookupTable.address&&sha(Buffer.from(lookupTable.dataHex,'hex'))===expectedLookupTable.dataSha256,'ALT');
 const state=AddressLookupTableAccount.deserialize(Buffer.from(lookupTable.dataHex,'hex'));
 need(state.authority===undefined&&state.deactivationSlot===U64&&state.lastExtendedSlot<lookupTable.slot&&state.addresses.length<=256,'ALT');
 const blockhash=address(p.blockhash),blockhashSlot=num(p.blockhashSlot),lastValidBlockHeight=num(p.lastValidBlockHeight),currentBlockHeight=num(p.currentBlockHeight);
 need(blockhashSlot>=lookupTable.slot&&currentBlockHeight<=lastValidBlockHeight,'BLOCKHASH');
 if(signature!==null){const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(policySigner).toBuffer()]),format:'der',type:'spki'});need(verify(null,Buffer.from(candidateHex,'hex'),key,Buffer.from(signature,'hex')),'SIGNATURE');}
 return frozen({original,candidateHex,policySigner,policySignatureHex:signature,lookupTable,expectedLookupTable,blockhash,blockhashSlot,lastValidBlockHeight,currentBlockHeight});
}
export function buildCharterRetirementPacket(input:CharterRetirementPacketInput):CharterRetirementPacket{return checked(()=>{
 const p=copyPacket(input),{economy,craft,leader,terms}=retirementParts(p.original),permit=retirementCandidate(p.original,p.candidateHex);
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_CHARTER_PREPARATION.computeUnitLimit}),
  Ed25519Program.createInstructionWithPublicKey({publicKey:new PublicKey(p.policySigner).toBytes(),signature:p.policySignatureHex===null?new Uint8Array(64):Buffer.from(p.policySignatureHex,'hex'),message:permit.candidate}),buildCharterRetirementInstruction(economy,craft,leader,terms,permit)];
 const lookup=new AddressLookupTableAccount({key:new PublicKey(p.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(p.lookupTable.dataHex,'hex'))});
 const message=new TransactionMessage({payerKey:leader,recentBlockhash:p.blockhash,instructions}).compileToV0Message([lookup]);
 need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&message.staticAccountKeys[0]!.equals(leader)&&message.addressTableLookups.length===1,'PACKET');
 const bytes=message.serialize(),wire=new VersionedTransaction(message).serialize();need(wire.length<=1232,'PACKET');
 return frozen({version:1,messageHex:Buffer.from(bytes).toString('hex'),unsignedTransactionHex:Buffer.from(wire).toString('hex'),messageSha256:sha(bytes),packetBytes:wire.length,nativeInstructionIndex:1,signingAuthorized:false,relayAuthorized:false});
});}
export function verifyCharterRetirementPacket(input:CharterRetirementPacketInput,value:unknown):CharterRetirementPacket{const expected=buildCharterRetirementPacket(input);need(isDeepStrictEqual(expected,value),'PACKET');return expected;}

import {boundedTransferWork} from './charterTransferPreparation';
/** Reuse the reviewed deadline/pending budget while preserving retirement refusal
 * reasons inside its callback; arbitrary transport failures stay unavailable. */
export function boundedRetirementWork(deadlineMs?:number){
 const run=boundedTransferWork(deadlineMs);
 return async<T>(operation:(call:Call,signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  const result=await run(async(call,signal)=>{try{return {value:await operation(call,signal)};}catch(error){if(error instanceof CharterRetirementPreparationError)return {error};throw error;}});
  if('error' in result)throw result.error;return result.value;
 };
}
type Call=<V>(fn:()=>Promise<V>)=>Promise<V>;
export interface RetirementBank {original:CharterRetirementOriginal;trust:CharterCreationEvidenceTrust;rows:readonly (OwnedAccount|null)[];slot:number;unixTimestamp:bigint;source:CharterRetirementQuote['observation']['source']}
export function retirementBankAddresses(trust:CharterCreationEvidenceTrust,original:CharterRetirementOriginal,permitIds:readonly Uint8Array[]){
 const programs=[trust.economy,trust.craft,trust.core],c=original.creation.chain,economy=new PublicKey(c.economyProgram);
 const addresses=programs.flatMap(p=>{const key=new PublicKey(p.programId);return [key,PublicKey.findProgramAddressSync([key.toBytes()],LOADER)[0]];});
 addresses.push(seekerAuthorityPda(economy),...[c.config,c.craftControl,c.charter,c.creationReceipt,c.assetBinding,c.asset,c.collection].map(p=>new PublicKey(p)),SYSVAR_CLOCK_PUBKEY);
 addresses.push(charterRetirementReceiptPda(economy,original.creation.clanId));
 addresses.push(...permitIds.map(id=>seekerPermitReceiptPda(economy,id)));return addresses;
}
export async function readRetirementBank(rpc:CharterCreationEvidenceRpc,trust:CharterCreationEvidenceTrust,original:CharterRetirementOriginal,permitIds:readonly Uint8Array[],call:Call):Promise<RetirementBank>{
 const genesis=rpc.getGenesisHash.bind(rpc),slot=rpc.getSlot.bind(rpc),multiple=rpc.getMultipleAccountsInfoAndContext.bind(rpc);
 need(await call(genesis)===trust.expectedGenesisHash,'DOMAIN');const opening=await call(()=>slot('finalized'));
 const programs=[trust.economy,trust.craft,trust.core],floor=Math.max(...programs.map(p=>p.reviewedDeploymentSlot));need(safeSlot(opening)&&opening>=floor,'BANK');
 const addresses=retirementBankAddresses(trust,original,permitIds),response=await call(()=>multiple(addresses,{commitment:'finalized',minContextSlot:opening}));need(safeSlot(response.context?.slot)&&response.context.slot>=opening,'BANK');
 const values=ownArray(response.value,addresses.length,'ACCOUNTS');need(values.length===addresses.length,'ACCOUNTS');
 const rows=values.map((value,i):OwnedAccount|null=>{
  if(value===null&&i>=15)return null;
  const row=record(value,'address owner executable data');need(row.address instanceof PublicKey&&row.address.equals(addresses[i]!)&&row.owner instanceof PublicKey&&typeof row.executable==='boolean'&&row.data instanceof Uint8Array&&row.data.length<=(i<6?MAX_PROGRAM_BYTES:MAX_CORE_BYTES),'ACCOUNTS');
  return {address:new PublicKey(row.address.toBytes()),owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)};
 });
 programs.forEach((p,i)=>attestProgram(rows[i*2]!,rows[i*2+1]!,p));const time=verifyCommon(rows[7]!,rows[8]!,rows[14]!,original.creation,response.context.slot);
 const source={genesisHash:trust.expectedGenesisHash,programs:trust,accounts:rows.map((r,i)=>({address:addresses[i]!.toBase58(),owner:r?.owner.toBase58()??null,executable:r?.executable??null,dataSha256:r?sha(r.data):null}))};
 return {original,trust,rows,slot:response.context.slot,unixTimestamp:time,source:frozen(source)};
}
export function emptyRetirementAccount(row:OwnedAccount|null|undefined){return row==null||(!row.executable&&row.owner.equals(SystemProgram.programId)&&row.data.length===0);}
export function verifyRetirementCurrentBank(bank:RetirementBank,retired=false){
 const {original,rows,unixTimestamp}=bank,c=original.creation.chain,s=original.retirement,{economy}=retirementParts(original),key=(s:string)=>new PublicKey(s).toBuffer();
 const b=(program:string,seed:string,...tail:Buffer[])=>Buffer.of(PublicKey.findProgramAddressSync([Buffer.from(seed),...tail],new PublicKey(program))[1]);
 const u32=(n:number)=>{const r=Buffer.alloc(4);r.writeUInt32LE(n);return r;},i64=(n:bigint)=>{const r=Buffer.alloc(8);r.writeBigInt64LE(n);return r;};
 const clan=charterClanIdBytes(original.creation.clanId),intent=charterClanIdBytes(original.creation.creationIntentId),r=rows[9]!;
 need(r.data.length===280,'PROFILE');const permit=r.data.subarray(255,271),created=r.data.readBigInt64LE(271);
 need(created>0n&&created<=unixTimestamp&&original.creation.issuedPermitIds.includes(permit.toString('hex')),'PROFILE');
 const exact=(row:OwnedAccount,name:string,parts:Buffer[])=>need(row.owner.equals(economy)&&!row.executable&&row.data.equals(Buffer.concat([transferDisc('account:'+name),Buffer.of(1),...parts])),'PROFILE');
 exact(r,'ClanCharter',[key(c.config),clan,key(c.asset),key(c.collection),key(s.leader),u32(s.expectedRevision+(retired?1:0)),Buffer.of(retired?2:1,0),Buffer.alloc(16),intent,Buffer.from(original.creation.metadata.hash,'hex'),Buffer.from(original.creation.admissionCommitment,'hex'),permit,i64(created),b(c.economyProgram,'charter',clan)]);
 exact(rows[10]!,'CharterCreationReceipt',[intent,clan,key(c.charter),key(c.asset),key(original.creation.payer),permit,b(c.economyProgram,'charter_creation',intent)]);
 exact(rows[11]!,'CharterAssetBinding',[key(c.asset),clan,key(c.charter),b(c.economyProgram,'charter_asset',key(c.asset))]);
 verifyCore(rows[12]!,rows[13]!,{...original.creation,payer:s.leader});
}
export function verifyRetirementSource(value:unknown,original:CharterRetirementOriginal,permitIds:readonly Uint8Array[]):CharterRetirementQuote['observation']['source']{
 const r=obj(value,'genesisHash programs accounts'),trust=copyTrust(r.programs);need(r.genesisHash===original.creation.chain.genesisHash&&trust.expectedGenesisHash===r.genesisHash&&trust.economy.programId===original.creation.chain.economyProgram&&trust.craft.programId===original.creation.chain.craftProgram,'DOMAIN');
 const expected=retirementBankAddresses(trust,original,permitIds),accounts=ownArray(r.accounts,expected.length,'INPUT').map(value=>{const a=obj(value,'address owner executable dataSha256');need(a.executable===null||typeof a.executable==='boolean','INPUT');need((a.owner===null)===(a.executable===null)&&(a.owner===null)===(a.dataSha256===null),'INPUT');return {address:address(a.address),owner:a.owner===null?null:a.owner===SystemProgram.programId.toBase58()?a.owner:address(a.owner),executable:a.executable as boolean|null,dataSha256:a.dataSha256===null?null:hex(a.dataSha256,32)};});
 need(accounts.length===expected.length&&accounts.every((r,i)=>r.address===expected[i]!.toBase58()&&(i>=15||r.owner!==null)),'ACCOUNTS');return frozen({genesisHash:trust.expectedGenesisHash,programs:trust,accounts});
}
export function verifyCharterRetirementQuote(value:unknown):CharterRetirementQuote{return checked(()=>{
 const q=obj(value,'version packetInput observation template costs costLimits context signingAuthorized retirementAuthorized fenceReleaseAuthorized');need(q.version===1&&q.signingAuthorized===false&&q.retirementAuthorized===false&&q.fenceReleaseAuthorized===false,'INPUT');
 const raw=obj(q.packetInput,'original candidateHex policySigner lookupTable expectedLookupTable blockhash blockhashSlot lastValidBlockHeight currentBlockHeight');
 const packet=copyPacket({...raw,policySignatureHex:null}),{policySignatureHex:_signature,...packetInput}=packet,original=packet.original;
 const template=verifyCharterRetirementPacket(packet,q.template),ob=obj(q.observation,'slot unixTimestamp registryRevision registryLeader lockKind lockId policySigner admissionPaused craftPaused source');
 const observedSlot=num(ob.slot),time=nat(ob.unixTimestamp,true),permit=retirementCandidate(original,packet.candidateHex);
 const lockKind=0 as const,lockId='0'.repeat(32);
 need(ob.registryRevision===original.retirement.expectedRevision&&ob.registryLeader===original.retirement.leader&&ob.lockKind===lockKind&&ob.lockId===lockId&&ob.policySigner===packet.policySigner&&ob.admissionPaused===false&&ob.craftPaused===false,'PROFILE');
 need(permit.expiry===BigInt(time)+BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec)&&packet.lookupTable.slot>=observedSlot,'PERMIT');
 const observation={slot:observedSlot,unixTimestamp:time,registryRevision:original.retirement.expectedRevision,registryLeader:original.retirement.leader,lockKind,lockId,policySigner:packet.policySigner,admissionPaused:false as const,craftPaused:false as const,source:verifyRetirementSource(ob.source,original,[permit.permitId])};
 need([observation.source.programs.economy,observation.source.programs.craft,observation.source.programs.core].every(p=>observedSlot>=p.reviewedDeploymentSlot),'BANK');
 const limits=obj(q.costLimits,'maxNetworkFeeLamports maxRentLamports maxAdditionalLamports'),costLimits={maxNetworkFeeLamports:nat(limits.maxNetworkFeeLamports),maxRentLamports:nat(limits.maxRentLamports),maxAdditionalLamports:nat(limits.maxAdditionalLamports)};
 const cost=obj(q.costs,'networkFeeLamports rentLamports totalLamports allocations');
 const {economy}=retirementParts(original),receipt=seekerPermitReceiptPda(economy,permit.permitId);
 const specs=[{kind:'retirement-receipt' as const,address:charterRetirementReceiptPda(economy,original.creation.clanId).toBase58(),bytes:250},{kind:'permit-receipt' as const,address:receipt.toBase58(),bytes:107}];
 const allocations=ownArray(cost.allocations,2,'INPUT').map((v,i)=>{const r=obj(v,'kind address bytes minimumBalanceLamports'),expected=specs[i]!;need(r.kind===expected.kind&&r.address===expected.address&&r.bytes===expected.bytes,'COST');return {...expected,minimumBalanceLamports:nat(r.minimumBalanceLamports)};});need(allocations.length===2,'COST');
 const network=nat(cost.networkFeeLamports),rent=allocations.reduce((n,r)=>n+BigInt(r.minimumBalanceLamports),0n),total=BigInt(network)+rent;
 need(cost.rentLamports===rent.toString()&&cost.totalLamports===total.toString(),'COST');
 need(BigInt(network)<=BigInt(costLimits.maxNetworkFeeLamports)&&rent<=BigInt(costLimits.maxRentLamports)&&BigInt(network)+rent<=BigInt(costLimits.maxAdditionalLamports)&&total<=U64,'COST');
 const ctx=obj(q.context,'feeSlot closingSlot closingGenesisHash'),context={feeSlot:num(ctx.feeSlot),closingSlot:num(ctx.closingSlot),closingGenesisHash:address(ctx.closingGenesisHash)};
 need(context.feeSlot>=packet.blockhashSlot&&context.closingSlot>=Math.max(context.feeSlot,packet.lookupTable.slot,observedSlot)&&context.closingGenesisHash===original.creation.chain.genesisHash,'BANK');
 return frozen({version:1,packetInput,observation,template,costs:{networkFeeLamports:network,rentLamports:rent.toString(),totalLamports:total.toString(),allocations},costLimits,context,signingAuthorized:false,retirementAuthorized:false,fenceReleaseAuthorized:false});
});}
/** Application pins and provider methods are captured once. Fresh quotes do not
 * authorize an issuer: the workflow must first persist the source-checked attempt. */
export function createCharterRetirementQuoter(connect:(signal:AbortSignal)=>CharterRetirementQuoteRpc,options:CharterRetirementQuoteOptions){
 need(typeof connect==='function','INPUT');const o=obj(options,'trust expectedCurrentSigner lookupTable costLimits'),trust=copyTrust(o.trust),expectedCurrentSigner=address(o.expectedCurrentSigner);
 const p=obj(o.lookupTable,'address dataSha256'),pin=frozen({address:address(p.address),dataSha256:hex(p.dataSha256,32)}),l=obj(o.costLimits,'maxNetworkFeeLamports maxRentLamports maxAdditionalLamports');
 const limit=(v:unknown)=>{need(typeof v==='bigint'&&v>=0n&&v<=U64,'COST');return v.toString();};
 const costLimits=frozen({maxNetworkFeeLamports:limit(l.maxNetworkFeeLamports),maxRentLamports:limit(l.maxRentLamports),maxAdditionalLamports:limit(l.maxAdditionalLamports)}),run=boundedRetirementWork();
 return async(originalInput:CharterRetirementOriginal,permitIdInput:Uint8Array):Promise<CharterRetirementQuote>=>{
  const original=copyCharterRetirementOriginal(originalInput,trust);need(permitIdInput instanceof Uint8Array&&permitIdInput.length===16,'PERMIT');const permitId=Buffer.from(permitIdInput);
  return run(async(call,signal)=>{
   const rpc=connect(signal),getAlt=rpc.getAccountInfoAndContext.bind(rpc),getBlock=rpc.getLatestBlockhashAndContext.bind(rpc),getFee=rpc.getFeeForMessage.bind(rpc),getRent=rpc.getMinimumBalanceForRentExemption.bind(rpc),getHeight=rpc.getBlockHeight.bind(rpc),getSlot=rpc.getSlot.bind(rpc),getGenesis=rpc.getGenesisHash.bind(rpc);
   const bank=await readRetirementBank(rpc,trust,original,[permitId],call);verifyRetirementCurrentBank(bank);need(bank.rows.slice(15).every(emptyRetirementAccount),'RECEIPT');
   const authority=decodeSeekerAuthority(original.creation.chain.economyProgram,original.creation.chain.genesisHash,bank.rows[6]!);
   need(!authority.admissionPaused&&bank.rows[8]!.data[137]===0&&authority.currentPolicyKey===expectedCurrentSigner,'POLICY');
   const {economy,craft,leader,terms}=retirementParts(original),receipt=seekerPermitReceiptPda(economy,permitId),candidateHex=encodeCharterRetirementPermit(new PublicKey(trust.expectedGenesisHash),economy,leader,{permitId,expiry:bank.unixTimestamp+BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec)},hashCharterRetirementPayload(economy,craft,leader,terms)).toString('hex');
   const alt=await call(()=>getAlt(new PublicKey(pin.address),{commitment:'finalized',minContextSlot:bank.slot}));need(safeSlot(alt.context?.slot)&&alt.context.slot>=bank.slot,'ALT');
   const raw=obj(alt.value,'owner executable data');need(raw.owner instanceof PublicKey&&raw.data instanceof Uint8Array&&raw.data.length<=8248,'ALT');
   const lookupTable={address:pin.address,owner:raw.owner.toBase58(),executable:raw.executable as boolean,dataHex:Buffer.from(raw.data).toString('hex'),slot:alt.context.slot};
   const block=await call(()=>getBlock({commitment:'finalized',minContextSlot:lookupTable.slot}));need(safeSlot(block.context?.slot)&&block.context.slot>=lookupTable.slot,'BLOCKHASH');
   const value=obj(block.value,'blockhash lastValidBlockHeight'),packetInput={original,candidateHex,policySigner:expectedCurrentSigner,lookupTable,expectedLookupTable:pin,blockhash:address(value.blockhash),blockhashSlot:block.context.slot,lastValidBlockHeight:num(value.lastValidBlockHeight),currentBlockHeight:0};
   const template=buildCharterRetirementPacket({...packetInput,policySignatureHex:null}),fee=await call(()=>getFee(VersionedTransaction.deserialize(Buffer.from(template.unsignedTransactionHex,'hex')).message as MessageV0,'finalized'));
   need(safeSlot(fee.context?.slot)&&fee.context.slot>=packetInput.blockhashSlot&&safeSlot(fee.value),'COST');const networkFeeLamports=BigInt(fee.value!);
   const allocations=[];for(const spec of [{kind:'retirement-receipt' as const,address:charterRetirementReceiptPda(economy,original.creation.clanId).toBase58(),bytes:250},{kind:'permit-receipt' as const,address:receipt.toBase58(),bytes:107}]){const rent=await call(()=>getRent(spec.bytes,'finalized'));need(safeSlot(rent),'COST');allocations.push({...spec,minimumBalanceLamports:BigInt(rent).toString()});}
   packetInput.currentBlockHeight=num(await call(()=>getHeight({commitment:'finalized',minContextSlot:fee.context.slot})));
   const closingSlot=num(await call(()=>getSlot('finalized'))),closingGenesisHash=await call(getGenesis),rent=allocations.reduce((n,a)=>n+BigInt(a.minimumBalanceLamports),0n);
   return verifyCharterRetirementQuote({version:1,packetInput,template,observation:{slot:bank.slot,unixTimestamp:bank.unixTimestamp.toString(),registryRevision:original.retirement.expectedRevision,registryLeader:original.retirement.leader,lockKind:0,lockId:'0'.repeat(32),policySigner:expectedCurrentSigner,admissionPaused:false,craftPaused:false,source:bank.source},
    costs:{networkFeeLamports:networkFeeLamports.toString(),rentLamports:rent.toString(),totalLamports:(networkFeeLamports+rent).toString(),allocations},costLimits,context:{feeSlot:fee.context.slot,closingSlot,closingGenesisHash},signingAuthorized:false,retirementAuthorized:false,fenceReleaseAuthorized:false});
  });
 };
}
