/** D153.176 current, exact ordinary-transfer quote and packet. No backend source
 * authority follows from this chain boundary; only the private workflow issues. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AddressLookupTableAccount,AddressLookupTableProgram,ComputeBudgetProgram,Ed25519Program,PublicKey,SYSVAR_CLOCK_PUBKEY,SystemProgram,TransactionMessage,VersionedTransaction,MessageV0} from '@solana/web3.js';
import {PHASE_E_CHARTER_PREPARATION,PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_TRANSFER,PHASE_E_POLICY} from '@shardkeep/shared';
import {copyTrust,copySaved,record,ownArray,address,uuid,safeSlot,attestProgram,verifyCommon,verifyCore,LOADER,MAX_PROGRAM_BYTES,MAX_CORE_BYTES,type OwnedAccount,type CharterCreationSavedRecord,type CharterCreationEvidenceTrust,type CharterCreationEvidenceRpc} from './charterCreationAccounts';
import {decodeSeekerAuthority} from './seekerAuthorityAccount';
import {charterClanIdBytes} from './charterProtocol';
import {charterTransferAccounts,hashCharterTransferPayload,encodeCharterPurposePermit,buildCharterTransferInstruction,transferDisc,CHARTER_TRANSFER_RECEIPT_BYTES,type CharterTransferDomain,type CharterTransferTerms} from './charterTransferProtocol';
import type {CharterCreationQuoteRpc,CharterLookupTable} from './charterCreationPreparation';
export interface CharterTransferOriginal {
 readonly creation:CharterCreationSavedRecord;
 readonly sale:Readonly<{id:string;fenceId:string;seller:string;buyer:string;treasury:string;expectedRevision:number;priceLamports:string;termsHash:string}>;
}
export interface CharterTransferPacketInput {
 readonly original:CharterTransferOriginal;readonly candidateHex:string;readonly policySigner:string;readonly policySignatureHex:string|null;
 readonly lookupTable:CharterLookupTable;readonly expectedLookupTable:Readonly<{address:string;dataSha256:string}>;
 readonly blockhash:string;readonly blockhashSlot:number;readonly lastValidBlockHeight:number;readonly currentBlockHeight:number;
}
export interface CharterTransferPacket {
 readonly version:1;readonly messageHex:string;readonly unsignedTransactionHex:string;readonly messageSha256:string;
 readonly packetBytes:number;readonly nativeInstructionIndex:1;readonly signingAuthorized:false;readonly relayAuthorized:false;
}
export interface CharterTransferQuoteOptions {
 readonly trust:CharterCreationEvidenceTrust;readonly expectedCurrentSigner:string;
 readonly lookupTable:Readonly<{address:string;dataSha256:string}>;
 readonly costLimits:Readonly<{maxNetworkFeeLamports:bigint;maxRentLamports:bigint;maxAdditionalLamports:bigint}>;
}
export type CharterTransferQuoteRpc=CharterCreationQuoteRpc;
export interface CharterTransferQuote {
 readonly version:1;readonly packetInput:Omit<CharterTransferPacketInput,'policySignatureHex'>;
 readonly observation:Readonly<{slot:number;unixTimestamp:string;registryRevision:number;registryLeader:string;lockKind:0;
  policySigner:string;admissionPaused:false;craftPaused:false;
  source:Readonly<{genesisHash:string;programs:CharterCreationEvidenceTrust;
   accounts:readonly Readonly<{address:string;owner:string|null;executable:boolean|null;dataSha256:string|null}>[]}>}>;
 readonly template:CharterTransferPacket;
 readonly costs:Readonly<{priceLamports:string;sellerLamports:string;royaltyLamports:string;networkFeeLamports:string;rentLamports:string;totalLamports:string;
  allocations:readonly Readonly<{kind:'transfer-receipt'|'permit-receipt';address:string;bytes:number;minimumBalanceLamports:string}>[]}>;
 readonly costLimits:Readonly<{maxNetworkFeeLamports:string;maxRentLamports:string;maxAdditionalLamports:string}>;
 readonly context:Readonly<{feeSlot:number;closingSlot:number;closingGenesisHash:string}>;
 readonly signingAuthorized:false;readonly transferAuthorized:false;readonly fenceReleaseAuthorized:false;
}
export class CharterTransferPreparationError extends Error {
 constructor(readonly code:string){super('Charter transfer preparation held: '+code);}
}
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),U64=(1n<<64n)-1n;
export function transferPreparationNeed(v:unknown,code:string):asserts v {if(!v)throw new CharterTransferPreparationError(code);}
const need:typeof transferPreparationNeed=transferPreparationNeed;
function obj(v:unknown,fields:string){return record(v,fields);}
function nat(v:unknown,positive=false):string {need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),'INPUT');const n=BigInt(v);need(n>=(positive?1n:0n)&&n<=U64,'INPUT');return v;}
function hex(v:unknown,bytes:number):string{need(typeof v==='string'&&v.length===bytes*2&&/^[0-9a-f]+$/.test(v),'INPUT');return v;}
function boundedHex(v:unknown,max:number):string{need(typeof v==='string'&&v.length>0&&v.length<=max*2&&v.length%2===0&&/^[0-9a-f]+$/.test(v),'INPUT');return v;}
function num(v:unknown):number{need(safeSlot(v),'INPUT');return v;}
function frozen<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
function checked<T>(f:()=>T):T{try{return f();}catch(e){if(e instanceof CharterTransferPreparationError)throw e;throw new CharterTransferPreparationError('INPUT');}}
/** Internal shared parser for current quote and original cancellation. */
export function copyCharterTransferOriginal(input:unknown,trust?:CharterCreationEvidenceTrust):CharterTransferOriginal{return checked(()=>{
 const r=obj(input,'creation sale'),c=obj(r.creation,'creationIntentId clanId payer metadata chain admissionCommitment issuedPermitIds');
 const chain=record(c.chain,'genesisHash economyProgram craftProgram config craftControl collection collectionAuthority charter asset assetBinding freezeAuthority executor creationReceipt');
 const pins=trust??{expectedGenesisHash:address(chain.genesisHash),economy:{programId:address(chain.economyProgram)},craft:{programId:address(chain.craftProgram)}} as CharterCreationEvidenceTrust;
 const creation=copySaved(c,uuid(c.creationIntentId,'INPUT'),pins),s=obj(r.sale,'id fenceId seller buyer treasury expectedRevision priceLamports termsHash');
 const sale={id:uuid(s.id,'INPUT'),fenceId:uuid(s.fenceId,'INPUT'),seller:address(s.seller),buyer:address(s.buyer),treasury:address(s.treasury),
  expectedRevision:num(s.expectedRevision),priceLamports:nat(s.priceLamports,true),termsHash:hex(s.termsHash,32)};
 need(sale.expectedRevision<0xffffffff,'REVISION');const value={creation,sale};transferParts(value);return frozen(value);
});}
export function transferParts(original:CharterTransferOriginal):{domain:CharterTransferDomain;terms:CharterTransferTerms}{
 const c=original.creation,s=original.sale,domain={economy:new PublicKey(c.chain.economyProgram),craft:new PublicKey(c.chain.craftProgram),seller:new PublicKey(s.seller),buyer:new PublicKey(s.buyer),treasury:new PublicKey(s.treasury)};
 const terms={clanId:c.clanId,transferId:s.id,fenceId:s.fenceId,expectedRevision:s.expectedRevision,priceLamports:BigInt(s.priceLamports),termsHash:Buffer.from(s.termsHash,'hex')};
 buildCharterTransferInstruction(domain,terms,{permitId:new Uint8Array(16),expiry:1n,ed25519Instruction:1});return {domain,terms};
}
export function transferCandidate(original:CharterTransferOriginal,value:unknown){
 const candidate=Buffer.from(hex(value,161),'hex'),{domain,terms}=transferParts(original),permitId=Buffer.from(candidate.subarray(73,89)),expiry=candidate.readBigInt64LE(121);
 need(expiry>0n,'PERMIT');const expected=encodeCharterPurposePermit(new PublicKey(original.creation.chain.genesisHash),domain.economy,1,domain.buyer,{permitId,expiry},hashCharterTransferPayload(domain,terms));
 need(candidate.equals(expected),'PERMIT');return {candidate,permitId,expiry,ed25519Instruction:1};
}
function copyPacket(input:unknown):CharterTransferPacketInput{
 const p=obj(input,'original candidateHex policySigner policySignatureHex lookupTable expectedLookupTable blockhash blockhashSlot lastValidBlockHeight currentBlockHeight');
 const original=copyCharterTransferOriginal(p.original),candidateHex=hex(p.candidateHex,161),policySigner=address(p.policySigner),signature=p.policySignatureHex===null?null:hex(p.policySignatureHex,64);transferCandidate(original,candidateHex);
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
export function buildCharterTransferPacket(input:CharterTransferPacketInput):CharterTransferPacket{return checked(()=>{
 const p=copyPacket(input),{domain,terms}=transferParts(p.original),permit=transferCandidate(p.original,p.candidateHex);
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:PHASE_E_CHARTER_PREPARATION.computeUnitLimit}),
  Ed25519Program.createInstructionWithPublicKey({publicKey:new PublicKey(p.policySigner).toBytes(),signature:p.policySignatureHex===null?new Uint8Array(64):Buffer.from(p.policySignatureHex,'hex'),message:permit.candidate}),buildCharterTransferInstruction(domain,terms,permit)];
 const lookup=new AddressLookupTableAccount({key:new PublicKey(p.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(p.lookupTable.dataHex,'hex'))});
 const message=new TransactionMessage({payerKey:domain.buyer,recentBlockhash:p.blockhash,instructions}).compileToV0Message([lookup]);
 need(message.header.numRequiredSignatures===2&&message.header.numReadonlySignedAccounts===0&&message.staticAccountKeys[0]!.equals(domain.buyer)&&message.staticAccountKeys[1]!.equals(domain.seller)&&message.addressTableLookups.length===1,'PACKET');
 const bytes=message.serialize(),wire=new VersionedTransaction(message).serialize();need(wire.length<=1232,'PACKET');
 return frozen({version:1,messageHex:Buffer.from(bytes).toString('hex'),unsignedTransactionHex:Buffer.from(wire).toString('hex'),messageSha256:sha(bytes),packetBytes:wire.length,nativeInstructionIndex:1,signingAuthorized:false,relayAuthorized:false});
});}
export function verifyCharterTransferPacket(input:CharterTransferPacketInput,value:unknown):CharterTransferPacket{const expected=buildCharterTransferPacket(input);need(isDeepStrictEqual(expected,value),'PACKET');return expected;}

/** One budget retains slots while an ignored abort is still in flight. */
export function boundedTransferWork(deadlineMs:number=PHASE_E_CHARTER_PREPARATION.timeoutMs){
 need(safeSlot(deadlineMs)&&deadlineMs>0&&deadlineMs<=PHASE_E_CHARTER_PREPARATION.timeoutMs,'INPUT');let pending=0;
 return async<T>(operation:(call:<V>(fn:()=>Promise<V>)=>Promise<V>,signal:AbortSignal)=>Promise<T>):Promise<T>=>{
  need(pending<PHASE_E_CHARTER_PREPARATION.maxPending,'BUSY');pending++;const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let done=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(done&&!released&&outstanding.size===0){released=true;pending--;}};const active=()=>need(!controller.signal.aborted,'DEADLINE');
  async function call<V>(fn:()=>Promise<V>){active();const p=Promise.resolve().then(()=>{active();return fn();});outstanding.add(p);try{const v=await p;active();return v;}finally{outstanding.delete(p);release();}}
  const work=Promise.resolve().then(()=>operation(call,controller.signal));void work.then(()=>{done=true;release();},()=>{done=true;release();});
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new CharterTransferPreparationError('DEADLINE'));},deadlineMs);})]);}
  catch(e){if(e instanceof CharterTransferPreparationError)throw e;throw new CharterTransferPreparationError('UNAVAILABLE');}
  finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
type Call=<V>(fn:()=>Promise<V>)=>Promise<V>;
export interface TransferBank {original:CharterTransferOriginal;trust:CharterCreationEvidenceTrust;rows:readonly (OwnedAccount|null)[];slot:number;unixTimestamp:bigint;source:CharterTransferQuote['observation']['source']}
export async function readTransferBank(rpc:CharterCreationEvidenceRpc,trust:CharterCreationEvidenceTrust,original:CharterTransferOriginal,permitId:Uint8Array|null,call:Call):Promise<TransferBank>{
 const genesis=rpc.getGenesisHash.bind(rpc),slot=rpc.getSlot.bind(rpc),multiple=rpc.getMultipleAccountsInfoAndContext.bind(rpc);
 need(await call(genesis)===trust.expectedGenesisHash,'DOMAIN');const opening=await call(()=>slot('finalized'));
 const programs=[trust.economy,trust.craft,trust.core],floor=Math.max(...programs.map(p=>p.reviewedDeploymentSlot));need(safeSlot(opening)&&opening>=floor,'BANK');
 const {domain,terms}=transferParts(original),a=charterTransferAccounts(domain,terms,permitId??new Uint8Array(16)),c=original.creation.chain;
 const addresses=programs.flatMap(p=>{const key=new PublicKey(p.programId);return [key,PublicKey.findProgramAddressSync([key.toBytes()],LOADER)[0]];});
 addresses.push(a.authority,a.config,a.craftControl,a.charter,new PublicKey(c.creationReceipt),a.assetBinding,a.asset,a.collection,SYSVAR_CLOCK_PUBKEY,a.transferConfig,a.transferReceipt);
 if(permitId)addresses.push(a.receipt);
 const response=await call(()=>multiple(addresses,{commitment:'finalized',minContextSlot:opening}));need(safeSlot(response.context?.slot)&&response.context.slot>=opening,'BANK');
 const values=ownArray(response.value,addresses.length,'ACCOUNTS');need(values.length===addresses.length,'ACCOUNTS');
 const rows=values.map((value,i):OwnedAccount|null=>{
  if(value===null&&i>=16)return null;
  const row=record(value,'address owner executable data');need(row.address instanceof PublicKey&&row.address.equals(addresses[i]!)&&row.owner instanceof PublicKey&&typeof row.executable==='boolean'&&row.data instanceof Uint8Array&&row.data.length<=(i<6?MAX_PROGRAM_BYTES:MAX_CORE_BYTES),'ACCOUNTS');
  return {address:new PublicKey(row.address.toBytes()),owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)};
 });
 programs.forEach((p,i)=>attestProgram(rows[i*2]!,rows[i*2+1]!,p));const time=verifyCommon(rows[7]!,rows[8]!,rows[14]!,original.creation,response.context.slot);
 const config=rows[15]!,expected=Buffer.concat([transferDisc('account:CharterTransferConfig'),Buffer.of(1),a.config.toBuffer(),a.treasury.toBuffer(),Buffer.alloc(2),Buffer.of(PublicKey.findProgramAddressSync([Buffer.from('charter_transfer_config')],domain.economy)[1])]);expected.writeUInt16LE(PHASE_E_CHARTER_TRANSFER.royaltyBps,73);
 need(config.owner.equals(domain.economy)&&!config.executable&&config.data.equals(expected),'CONFIG');
 const source={genesisHash:trust.expectedGenesisHash,programs:trust,accounts:rows.map((r,i)=>({address:addresses[i]!.toBase58(),owner:r?.owner.toBase58()??null,executable:r?.executable??null,dataSha256:r?sha(r.data):null}))};
 return {original,trust,rows,slot:response.context.slot,unixTimestamp:time,source:frozen(source)};
}
export function emptyTransferAccount(row:OwnedAccount|null|undefined){return row==null||(!row.executable&&row.owner.equals(SystemProgram.programId)&&row.data.length===0);}
export function verifyTransferCurrentBank(bank:TransferBank){
 const {original,rows,unixTimestamp}=bank,c=original.creation.chain,s=original.sale,{domain}=transferParts(original),key=(s:string)=>new PublicKey(s).toBuffer();
 const b=(program:string,seed:string,...tail:Buffer[])=>Buffer.of(PublicKey.findProgramAddressSync([Buffer.from(seed),...tail],new PublicKey(program))[1]);
 const u32=(n:number)=>{const r=Buffer.alloc(4);r.writeUInt32LE(n);return r;},i64=(n:bigint)=>{const r=Buffer.alloc(8);r.writeBigInt64LE(n);return r;};
 const clan=charterClanIdBytes(original.creation.clanId),intent=charterClanIdBytes(original.creation.creationIntentId),r=rows[9]!;
 need(r.data.length===280,'PROFILE');const permit=r.data.subarray(255,271),created=r.data.readBigInt64LE(271);
 need(created>0n&&created<=unixTimestamp&&original.creation.issuedPermitIds.includes(permit.toString('hex')),'PROFILE');
 const exact=(row:OwnedAccount,name:string,parts:Buffer[])=>need(row.owner.equals(domain.economy)&&!row.executable&&row.data.equals(Buffer.concat([transferDisc('account:'+name),Buffer.of(1),...parts])),'PROFILE');
 exact(r,'ClanCharter',[key(c.config),clan,key(c.asset),key(c.collection),key(s.seller),u32(s.expectedRevision),Buffer.of(1,0),Buffer.alloc(16),intent,Buffer.from(original.creation.metadata.hash,'hex'),Buffer.from(original.creation.admissionCommitment,'hex'),permit,i64(created),b(c.economyProgram,'charter',clan)]);
 exact(rows[10]!,'CharterCreationReceipt',[intent,clan,key(c.charter),key(c.asset),key(original.creation.payer),permit,b(c.economyProgram,'charter_creation',intent)]);
 exact(rows[11]!,'CharterAssetBinding',[key(c.asset),clan,key(c.charter),b(c.economyProgram,'charter_asset',key(c.asset))]);
 verifyCore(rows[12]!,rows[13]!,{...original.creation,payer:s.seller});
}
export function verifyTransferSource(value:unknown,original:CharterTransferOriginal,permitId:Uint8Array|null):CharterTransferQuote['observation']['source']{
 const r=obj(value,'genesisHash programs accounts'),trust=copyTrust(r.programs);need(r.genesisHash===original.creation.chain.genesisHash&&trust.expectedGenesisHash===r.genesisHash&&trust.economy.programId===original.creation.chain.economyProgram&&trust.craft.programId===original.creation.chain.craftProgram,'DOMAIN');
 const accounts=ownArray(r.accounts,18,'INPUT').map(value=>{const a=obj(value,'address owner executable dataSha256');need(a.executable===null||typeof a.executable==='boolean','INPUT');need((a.owner===null)===(a.executable===null)&&(a.owner===null)===(a.dataSha256===null),'INPUT');return {address:address(a.address),owner:a.owner===null?null:address(a.owner),executable:a.executable as boolean|null,dataSha256:a.dataSha256===null?null:hex(a.dataSha256,32)};});
 const {domain,terms}=transferParts(original),a=charterTransferAccounts(domain,terms,permitId??new Uint8Array(16));
 const expected=[trust.economy,trust.craft,trust.core].flatMap(p=>{const k=new PublicKey(p.programId);return [k,PublicKey.findProgramAddressSync([k.toBytes()],LOADER)[0]];});
 expected.push(a.authority,a.config,a.craftControl,a.charter,new PublicKey(original.creation.chain.creationReceipt),a.assetBinding,a.asset,a.collection,SYSVAR_CLOCK_PUBKEY,a.transferConfig,a.transferReceipt);if(permitId)expected.push(a.receipt);
 need(accounts.length===expected.length&&accounts.every((r,i)=>r.address===expected[i]!.toBase58()&&(i>=16||r.owner!==null)),'ACCOUNTS');return frozen({genesisHash:trust.expectedGenesisHash,programs:trust,accounts});
}
export function verifyCharterTransferQuote(value:unknown):CharterTransferQuote{return checked(()=>{
 const q=obj(value,'version packetInput observation template costs costLimits context signingAuthorized transferAuthorized fenceReleaseAuthorized');need(q.version===1&&q.signingAuthorized===false&&q.transferAuthorized===false&&q.fenceReleaseAuthorized===false,'INPUT');
 const raw=obj(q.packetInput,'original candidateHex policySigner lookupTable expectedLookupTable blockhash blockhashSlot lastValidBlockHeight currentBlockHeight');
 const packet=copyPacket({...raw,policySignatureHex:null}),{policySignatureHex:_signature,...packetInput}=packet,original=packet.original;
 const template=verifyCharterTransferPacket(packet,q.template),ob=obj(q.observation,'slot unixTimestamp registryRevision registryLeader lockKind policySigner admissionPaused craftPaused source');
 const observedSlot=num(ob.slot),time=nat(ob.unixTimestamp,true),permit=transferCandidate(original,packet.candidateHex);
 need(ob.registryRevision===original.sale.expectedRevision&&ob.registryLeader===original.sale.seller&&ob.lockKind===0&&ob.policySigner===packet.policySigner&&ob.admissionPaused===false&&ob.craftPaused===false,'PROFILE');
 need(permit.expiry===BigInt(time)+BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec)&&packet.lookupTable.slot>=observedSlot,'PERMIT');
 const observation={slot:observedSlot,unixTimestamp:time,registryRevision:original.sale.expectedRevision,registryLeader:original.sale.seller,lockKind:0 as const,policySigner:packet.policySigner,admissionPaused:false as const,craftPaused:false as const,source:verifyTransferSource(ob.source,original,permit.permitId)};
 need([observation.source.programs.economy,observation.source.programs.craft,observation.source.programs.core].every(p=>observedSlot>=p.reviewedDeploymentSlot),'BANK');
 const limits=obj(q.costLimits,'maxNetworkFeeLamports maxRentLamports maxAdditionalLamports'),costLimits={maxNetworkFeeLamports:nat(limits.maxNetworkFeeLamports),maxRentLamports:nat(limits.maxRentLamports),maxAdditionalLamports:nat(limits.maxAdditionalLamports)};
 const cost=obj(q.costs,'priceLamports sellerLamports royaltyLamports networkFeeLamports rentLamports totalLamports allocations');
 const {domain,terms}=transferParts(original),a=charterTransferAccounts(domain,terms,permit.permitId),royalty=terms.priceLamports*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/BigInt(PHASE_E_POLICY.basisPoints);
 const specs=[{kind:'transfer-receipt' as const,address:a.transferReceipt.toBase58(),bytes:CHARTER_TRANSFER_RECEIPT_BYTES},{kind:'permit-receipt' as const,address:a.receipt.toBase58(),bytes:107}];
 const allocations=ownArray(cost.allocations,2,'INPUT').map((v,i)=>{const r=obj(v,'kind address bytes minimumBalanceLamports'),expected=specs[i]!;need(r.kind===expected.kind&&r.address===expected.address&&r.bytes===expected.bytes,'COST');return {...expected,minimumBalanceLamports:nat(r.minimumBalanceLamports)};});need(allocations.length===2,'COST');
 const network=nat(cost.networkFeeLamports),rent=allocations.reduce((n,r)=>n+BigInt(r.minimumBalanceLamports),0n),total=terms.priceLamports+BigInt(network)+rent;
 need(cost.priceLamports===original.sale.priceLamports&&cost.sellerLamports===(terms.priceLamports-royalty).toString()&&cost.royaltyLamports===royalty.toString()&&cost.rentLamports===rent.toString()&&cost.totalLamports===total.toString(),'COST');
 need(BigInt(network)<=BigInt(costLimits.maxNetworkFeeLamports)&&rent<=BigInt(costLimits.maxRentLamports)&&BigInt(network)+rent<=BigInt(costLimits.maxAdditionalLamports)&&total<=U64,'COST');
 const ctx=obj(q.context,'feeSlot closingSlot closingGenesisHash'),context={feeSlot:num(ctx.feeSlot),closingSlot:num(ctx.closingSlot),closingGenesisHash:address(ctx.closingGenesisHash)};
 need(context.feeSlot>=packet.blockhashSlot&&context.closingSlot>=Math.max(context.feeSlot,packet.lookupTable.slot,observedSlot)&&context.closingGenesisHash===original.creation.chain.genesisHash,'BANK');
 return frozen({version:1,packetInput,observation,template,costs:{priceLamports:original.sale.priceLamports,sellerLamports:(terms.priceLamports-royalty).toString(),royaltyLamports:royalty.toString(),networkFeeLamports:network,rentLamports:rent.toString(),totalLamports:total.toString(),allocations},costLimits,context,signingAuthorized:false,transferAuthorized:false,fenceReleaseAuthorized:false});
});}
/** Application pins and provider methods are captured once. Fresh quotes do not
 * authorize an issuer: the workflow must first persist the source-checked attempt. */
export function createCharterTransferQuoteReader(connect:(signal:AbortSignal)=>CharterTransferQuoteRpc,options:CharterTransferQuoteOptions){
 need(typeof connect==='function','INPUT');const o=obj(options,'trust expectedCurrentSigner lookupTable costLimits'),trust=copyTrust(o.trust),expectedCurrentSigner=address(o.expectedCurrentSigner);
 const p=obj(o.lookupTable,'address dataSha256'),pin=frozen({address:address(p.address),dataSha256:hex(p.dataSha256,32)}),l=obj(o.costLimits,'maxNetworkFeeLamports maxRentLamports maxAdditionalLamports');
 const limit=(v:unknown)=>{need(typeof v==='bigint'&&v>=0n&&v<=U64,'COST');return v.toString();};
 const costLimits=frozen({maxNetworkFeeLamports:limit(l.maxNetworkFeeLamports),maxRentLamports:limit(l.maxRentLamports),maxAdditionalLamports:limit(l.maxAdditionalLamports)}),run=boundedTransferWork();
 return async(originalInput:CharterTransferOriginal,permitIdInput:Uint8Array):Promise<CharterTransferQuote>=>{
  const original=copyCharterTransferOriginal(originalInput,trust);need(permitIdInput instanceof Uint8Array&&permitIdInput.length===16,'PERMIT');const permitId=Buffer.from(permitIdInput);
  return run(async(call,signal)=>{
   const rpc=connect(signal),getAlt=rpc.getAccountInfoAndContext.bind(rpc),getBlock=rpc.getLatestBlockhashAndContext.bind(rpc),getFee=rpc.getFeeForMessage.bind(rpc),getRent=rpc.getMinimumBalanceForRentExemption.bind(rpc),getHeight=rpc.getBlockHeight.bind(rpc),getSlot=rpc.getSlot.bind(rpc),getGenesis=rpc.getGenesisHash.bind(rpc);
   const bank=await readTransferBank(rpc,trust,original,permitId,call);verifyTransferCurrentBank(bank);need(emptyTransferAccount(bank.rows[16])&&emptyTransferAccount(bank.rows[17]),'RECEIPT');
   const authority=decodeSeekerAuthority(original.creation.chain.economyProgram,original.creation.chain.genesisHash,bank.rows[6]!);
   need(!authority.admissionPaused&&bank.rows[8]!.data[137]===0&&authority.currentPolicyKey===expectedCurrentSigner,'POLICY');
   const {domain,terms}=transferParts(original),a=charterTransferAccounts(domain,terms,permitId),candidateHex=encodeCharterPurposePermit(new PublicKey(trust.expectedGenesisHash),domain.economy,1,domain.buyer,{permitId,expiry:bank.unixTimestamp+BigInt(PHASE_E_CHARTER_ADMISSION.v1.issuedPermitTtlSec)},hashCharterTransferPayload(domain,terms)).toString('hex');
   const alt=await call(()=>getAlt(new PublicKey(pin.address),{commitment:'finalized',minContextSlot:bank.slot}));need(safeSlot(alt.context?.slot)&&alt.context.slot>=bank.slot,'ALT');
   const raw=obj(alt.value,'owner executable data');need(raw.owner instanceof PublicKey&&raw.data instanceof Uint8Array&&raw.data.length<=8248,'ALT');
   const lookupTable={address:pin.address,owner:raw.owner.toBase58(),executable:raw.executable as boolean,dataHex:Buffer.from(raw.data).toString('hex'),slot:alt.context.slot};
   const block=await call(()=>getBlock({commitment:'finalized',minContextSlot:lookupTable.slot}));need(safeSlot(block.context?.slot)&&block.context.slot>=lookupTable.slot,'BLOCKHASH');
   const value=obj(block.value,'blockhash lastValidBlockHeight'),packetInput={original,candidateHex,policySigner:expectedCurrentSigner,lookupTable,expectedLookupTable:pin,blockhash:address(value.blockhash),blockhashSlot:block.context.slot,lastValidBlockHeight:num(value.lastValidBlockHeight),currentBlockHeight:0};
   const template=buildCharterTransferPacket({...packetInput,policySignatureHex:null}),fee=await call(()=>getFee(VersionedTransaction.deserialize(Buffer.from(template.unsignedTransactionHex,'hex')).message as MessageV0,'finalized'));
   need(safeSlot(fee.context?.slot)&&fee.context.slot>=packetInput.blockhashSlot&&safeSlot(fee.value),'COST');const networkFeeLamports=BigInt(fee.value!);
   const allocations=[];for(const spec of [{kind:'transfer-receipt' as const,address:a.transferReceipt.toBase58(),bytes:CHARTER_TRANSFER_RECEIPT_BYTES},{kind:'permit-receipt' as const,address:a.receipt.toBase58(),bytes:107}]){const rent=await call(()=>getRent(spec.bytes,'finalized'));need(safeSlot(rent),'COST');allocations.push({...spec,minimumBalanceLamports:BigInt(rent).toString()});}
   packetInput.currentBlockHeight=num(await call(()=>getHeight({commitment:'finalized',minContextSlot:fee.context.slot})));
   const closingSlot=num(await call(()=>getSlot('finalized'))),closingGenesisHash=await call(getGenesis),rent=allocations.reduce((n,a)=>n+BigInt(a.minimumBalanceLamports),0n),royalty=terms.priceLamports*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/BigInt(PHASE_E_POLICY.basisPoints);
   return verifyCharterTransferQuote({version:1,packetInput,template,observation:{slot:bank.slot,unixTimestamp:bank.unixTimestamp.toString(),registryRevision:original.sale.expectedRevision,registryLeader:original.sale.seller,lockKind:0,policySigner:expectedCurrentSigner,admissionPaused:false,craftPaused:false,source:bank.source},
    costs:{priceLamports:original.sale.priceLamports,sellerLamports:(terms.priceLamports-royalty).toString(),royaltyLamports:royalty.toString(),networkFeeLamports:networkFeeLamports.toString(),rentLamports:rent.toString(),totalLamports:(terms.priceLamports+networkFeeLamports+rent).toString(),allocations},costLimits,context:{feeSlot:fee.context.slot,closingSlot,closingGenesisHash},signingAuthorized:false,transferAuthorized:false,fenceReleaseAuthorized:false});
  });
 };
}
