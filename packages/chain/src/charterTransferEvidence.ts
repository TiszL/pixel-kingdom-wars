/** Original controlled transfer finality. Application-owned loader and reviewed
 * deployment pins only; never an HTTP proof, sale issuer or DB fence release. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {AddressLookupTableAccount,AddressLookupTableProgram,ComputeBudgetProgram,Ed25519Program,MessageV0,PublicKey,TransactionMessage,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import {LOADER,MAX_PROGRAM_BYTES,copyTrust,attestProgram,type CharterCreationEvidenceTrust,type CharterCreationEvidenceRpc,type OwnedAccount} from './charterCreationAccounts';
import {charterClanIdBytes} from './charterProtocol';
import {buildCharterTransferInstruction,charterTransferAccounts,encodeCharterPurposePermit,hashCharterTransferPayload,matchCharterTransferReceipt,transferDisc,type CharterTransferDomain,type CharterTransferTerms,type CharterTransferPermit} from './charterTransferProtocol';
import {verifyCharterTransferSignedWire} from './charterTransferWire';
export interface CharterTransferSaved {readonly domain:CharterTransferDomain;readonly terms:CharterTransferTerms;readonly permit:CharterTransferPermit;readonly policySigner:PublicKey;readonly preparedMessage:Uint8Array;readonly signedTransaction:Uint8Array}
export interface CharterTransferRpc extends CharterCreationEvidenceRpc {getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>}
export class CharterTransferEvidenceError extends Error {readonly fenceReleaseAuthorized=false;constructor(readonly code:string){super('Charter transfer evidence held: '+code);}}
function need(v:unknown,code:string):asserts v {if(!v)throw new CharterTransferEvidenceError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const digest=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function copied(input:CharterTransferSaved|null,id:string,trust:CharterCreationEvidenceTrust){
 need(input&&input.terms.transferId===id,'ORIGINAL');charterClanIdBytes(id);
 need(input.preparedMessage instanceof Uint8Array&&input.preparedMessage.length>0&&input.preparedMessage.length<=1103&&input.signedTransaction instanceof Uint8Array&&input.signedTransaction.length>129&&input.signedTransaction.length<=1232&&input.terms.termsHash instanceof Uint8Array&&input.terms.termsHash.length===32&&input.permit.permitId instanceof Uint8Array&&input.permit.permitId.length===16,'BOUNDS');
 const d=input.domain,domain={economy:new PublicKey(d.economy.toBytes()),craft:new PublicKey(d.craft.toBytes()),buyer:new PublicKey(d.buyer.toBytes()),seller:new PublicKey(d.seller.toBytes()),treasury:new PublicKey(d.treasury.toBytes())};
 const terms={...input.terms,termsHash:Uint8Array.from(input.terms.termsHash)},permit={...input.permit,permitId:Uint8Array.from(input.permit.permitId)},policySigner=new PublicKey(input.policySigner.toBytes());
 need(domain.economy.toBase58()===trust.economy.programId&&domain.craft.toBase58()===trust.craft.programId,'DOMAIN');
 const preparedMessage=Uint8Array.from(input.preparedMessage),signedTransaction=Uint8Array.from(input.signedTransaction);
 const signed=verifyCharterTransferSignedWire({buyer:domain.buyer,seller:domain.seller,intentBytes:preparedMessage,signedTransaction});
 const message=MessageV0.deserialize(preparedMessage);need(message.addressTableLookups.length<=2,'BOUNDS');buildCharterTransferInstruction(domain,terms,permit);
 return {domain,terms,permit,policySigner,preparedMessage,signedTransaction,signed,message};
}
// Copy only bounded fields; never execute a transport-supplied serialize method.
function transaction(raw:VersionedTransactionResponse|null,original:ReturnType<typeof copied>){
 need(raw?.meta&&raw.version===0&&safe(raw.slot),'TRANSACTION');const m=raw.transaction.message;need(m.version===0,'TRANSACTION');
 need(m.staticAccountKeys.length<=32&&m.compiledInstructions.length===3&&m.addressTableLookups.length<=2,'BOUNDS');
 const index=(n:number)=>{need(Number.isInteger(n)&&n>=0&&n<=255,'BOUNDS');return n;};
 need(m.header.numRequiredSignatures===2&&m.header.numReadonlySignedAccounts===0&&safe(m.header.numReadonlyUnsignedAccounts)&&m.header.numReadonlyUnsignedAccounts<=m.staticAccountKeys.length,'TRANSACTION');
 const c=new MessageV0({header:{...m.header},staticAccountKeys:m.staticAccountKeys.map(k=>new PublicKey(k.toBytes())),recentBlockhash:m.recentBlockhash,
  compiledInstructions:m.compiledInstructions.map(ix=>{need(ix.data instanceof Uint8Array&&ix.data.length<=1232&&ix.accountKeyIndexes.length<=32&&safe(ix.programIdIndex),'BOUNDS');return {programIdIndex:index(ix.programIdIndex),accountKeyIndexes:ix.accountKeyIndexes.map(index),data:Uint8Array.from(ix.data)};}),
  addressTableLookups:m.addressTableLookups.map(t=>{need(t.readonlyIndexes.length+t.writableIndexes.length<=32,'BOUNDS');return {accountKey:new PublicKey(t.accountKey.toBytes()),readonlyIndexes:t.readonlyIndexes.map(index),writableIndexes:t.writableIndexes.map(index)};})});
 need(Buffer.from(c.serialize()).equals(Buffer.from(original.preparedMessage)),'TRANSACTION');
 const wire=VersionedTransaction.deserialize(original.signedTransaction);need(raw.transaction.signatures.length===2&&raw.transaction.signatures.every((s,i)=>s===bs58.encode(wire.signatures[i]!)),'SIGNATURE');
 const meta=raw.meta;need(meta.err===null,'FAILED');need(safe(meta.fee)&&meta.preBalances.length<=64&&meta.preBalances.length===meta.postBalances.length&&meta.preBalances.every(safe)&&meta.postBalances.every(safe),'PAYMENT');
 need(meta.loadedAddresses&&meta.loadedAddresses.writable.length+meta.loadedAddresses.readonly.length<=32,'ACCOUNTS');
 return {slot:raw.slot,fee:BigInt(meta.fee),pre:meta.preBalances.map(BigInt),post:meta.postBalances.map(BigInt),loaded:{writable:meta.loadedAddresses.writable.map(k=>new PublicKey(k.toBytes())),readonly:meta.loadedAddresses.readonly.map(k=>new PublicKey(k.toBytes()))}};
}
export function createCharterTransferEvidenceReader<Context=void>(connect:(signal:AbortSignal)=>CharterTransferRpc,inputTrust:CharterCreationEvidenceTrust,load:(id:string,context:Context)=>Promise<CharterTransferSaved|null>,options:{deadlineMs?:number}={}){
 const trust=copyTrust(inputTrust),programs=[trust.economy,trust.craft,trust.core];need(typeof connect==='function'&&typeof load==='function','INPUT');
 const deadline=options.deadlineMs??60000;need(safe(deadline)&&deadline>0&&deadline<=60000,'INPUT');let pending=0;
 return async(id:string,context:Context)=>{
  charterClanIdBytes(id);need(pending<8,'BUSY');pending++;const controller=new AbortController();let done=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;const outstanding=new Set<Promise<unknown>>();
  const release=()=>{if(done&&!released&&outstanding.size===0){released=true;pending--;}};
  const active=()=>need(!controller.signal.aborted,'DEADLINE');
  async function call<T>(fn:()=>Promise<T>){active();const p=Promise.resolve().then(()=>{active();return fn();});outstanding.add(p);try{const r=await p;active();return r;}finally{outstanding.delete(p);release();}}
  const work=(async()=>{
   const original=copied(await call(()=>load(id,context)),id,trust);const rpc=connect(controller.signal);
   need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'DOMAIN');const floor=Math.max(...programs.map(p=>p.reviewedDeploymentSlot));
   const tx=transaction(await call(()=>rpc.getTransaction(original.signed.signature,{commitment:'finalized',maxSupportedTransactionVersion:0})),original);need(tx.slot>floor,'DEPLOYMENT');
   const opening=await call(()=>rpc.getSlot('finalized'));need(safe(opening)&&opening>=tx.slot,'BANK');const a=charterTransferAccounts(original.domain,original.terms,original.permit.permitId);
   const addresses=programs.flatMap(p=>{const key=new PublicKey(p.programId);return [key,PublicKey.findProgramAddressSync([key.toBytes()],LOADER)[0]];});addresses.push(a.transferConfig,a.transferReceipt,...original.message.addressTableLookups.map(t=>t.accountKey));
   const raw=await call(()=>rpc.getMultipleAccountsInfoAndContext(addresses,{commitment:'finalized',minContextSlot:opening}));need(safe(raw.context?.slot)&&raw.context.slot>=opening&&raw.value.length===addresses.length,'BANK');
   const rows=raw.value.map((r,i):OwnedAccount=>{need(r&&r.address.equals(addresses[i]!)&&r.data instanceof Uint8Array&&r.data.length<=(i<6?MAX_PROGRAM_BYTES:9000)&&typeof r.executable==='boolean','ACCOUNT');return {address:new PublicKey(r.address.toBytes()),owner:new PublicKey(r.owner.toBytes()),executable:r.executable,data:Buffer.from(r.data)};});
   programs.forEach((p,i)=>attestProgram(rows[i*2]!,rows[i*2+1]!,p));
   const config=rows[6]!,receipt=rows[7]!;for(const row of [config,receipt])need(row.owner.equals(original.domain.economy)&&!row.executable,'ACCOUNT');
   const cb=config.data;need(cb.length===76&&cb.subarray(0,8).equals(transferDisc('account:CharterTransferConfig'))&&cb[8]===1&&cb.subarray(9,41).equals(a.config.toBuffer())&&cb.subarray(41,73).equals(a.treasury.toBuffer())&&cb.readUInt16LE(73)===PHASE_E_CHARTER_TRANSFER.royaltyBps&&cb[75]===PublicKey.findProgramAddressSync([Buffer.from('charter_transfer_config')],original.domain.economy)[1],'CONFIG');
   const matched=matchCharterTransferReceipt(receipt.data,original.domain,original.terms,original.permit.permitId);
   const tables=rows.slice(8).map(r=>{need(r.owner.equals(AddressLookupTableProgram.programId)&&!r.executable,'ALT');const state=AddressLookupTableAccount.deserialize(r.data);need(state.authority===undefined&&state.deactivationSlot==((1n<<64n)-1n)&&state.lastExtendedSlot<tx.slot,'ALT');return new AddressLookupTableAccount({key:r.address,state});});
   const plan=TransactionMessage.decompile(original.message,{addressLookupTableAccounts:tables});need(plan.instructions.length===3&&original.permit.ed25519Instruction===1,'INSTRUCTION');
   const compute=plan.instructions[0]!,native=plan.instructions[1]!,settle=plan.instructions[2]!;
   need(compute.programId.equals(ComputeBudgetProgram.programId)&&compute.keys.length===0&&compute.data.length===5&&compute.data[0]===2&&compute.data.readUInt32LE(1)>0&&compute.data.readUInt32LE(1)<=1400000,'INSTRUCTION');
   need(native.programId.equals(Ed25519Program.programId)&&native.keys.length===0&&native.data.length===273,'PERMIT');
   const payload=encodeCharterPurposePermit(new PublicKey(trust.expectedGenesisHash),original.domain.economy,1,original.domain.buyer,original.permit,hashCharterTransferPayload(original.domain,original.terms));
   const signature=native.data.subarray(48,112);const expectedNative=Ed25519Program.createInstructionWithPublicKey({publicKey:original.policySigner.toBytes(),signature,message:payload});need(native.data.equals(expectedNative.data),'PERMIT');
   const policyKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),original.policySigner.toBuffer()]),format:'der',type:'spki'});need(verify(null,payload,policyKey,signature),'PERMIT');
   const expected=buildCharterTransferInstruction(original.domain,original.terms,original.permit);
   need(settle.programId.equals(expected.programId)&&settle.data.equals(expected.data)&&settle.keys.length===expected.keys.length&&settle.keys.every((k,i)=>k.pubkey.equals(expected.keys[i]!.pubkey)&&k.isSigner===expected.keys[i]!.isSigner&&k.isWritable===expected.keys[i]!.isWritable),'INSTRUCTION');
   const loaded=original.message.resolveAddressTableLookups(tables);need(['writable','readonly'].every(k=>{const kind=k as 'writable'|'readonly';return loaded[kind].length===tx.loaded[kind].length&&loaded[kind].every((p,i)=>p.equals(tx.loaded[kind][i]!));}),'ALT');
   const keys=[...original.message.staticAccountKeys,...loaded.writable,...loaded.readonly];need(keys.length===tx.pre.length&&new Set(keys.map(k=>k.toBase58())).size===keys.length,'PAYMENT');
   let rent=0n;const increases=new Map<string,bigint>();for(const k of [a.transferReceipt,a.receipt]){const at=keys.findIndex(p=>p.equals(k));need(at>=0,'PAYMENT');const n=tx.post[at]!-tx.pre[at]!;need(n>=0n,'PAYMENT');rent+=n;increases.set(k.toBase58(),n);}
   for(const [i,k]of keys.entries()){const delta=k.equals(a.buyer)?-original.terms.priceLamports-tx.fee-rent:k.equals(a.seller)?BigInt(matched.sellerLamports):k.equals(a.treasury)?BigInt(matched.royaltyLamports):(increases.get(k.toBase58())??0n);need((tx.post[i]! - tx.pre[i]!) === delta,'PAYMENT');}
   need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'DOMAIN');active();
   return Object.freeze({version:1 as const,signature:original.signed.signature,slot:tx.slot,observedSlot:raw.context.slot,receipt:matched,feeLamports:tx.fee.toString(),rentLamports:rent.toString(),wireSha256:original.signed.wireSha256,messageSha256:original.signed.messageSha256,receiptSha256:digest(receipt.data),finalizedTransferObserved:true as const,backendClearanceVerified:false as const,fenceReleaseAuthorized:false as const});
  })();void work.then(()=>{done=true;release();},()=>{done=true;release();});
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new CharterTransferEvidenceError('DEADLINE'));},deadline);})]);}catch(error){if(error instanceof CharterTransferEvidenceError)throw error;throw new CharterTransferEvidenceError('UNAVAILABLE');}finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
