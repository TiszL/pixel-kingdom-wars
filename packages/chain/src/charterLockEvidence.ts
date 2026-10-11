/** D153.181 finalized exact signed transition. A generic permit receipt is
 * closeable; current absence never disproves a historical successful transition.
 * Current-state match is separate from proof and grants no entry/release rights. */
import {createHash} from 'node:crypto';
import {AddressLookupTableAccount,MessageV0,PublicKey,type VersionedTransactionResponse} from '@solana/web3.js';
import {copyTrust,record,uuid,safeSlot,type CharterCreationEvidenceTrust,type CharterCreationEvidenceRpc} from './charterCreationAccounts';
import {copyCharterLockOriginal,buildCharterLockPacket,lockCandidate,lockParts,boundedLockWork,readLockBank,verifyLockCurrentBank,lockPreparationNeed,type CharterLockPacketInput,type CharterLockOriginal} from './charterLockPreparation';
import {verifyCharterLockSignedWire} from './charterLockWire';
import {seekerPermitReceiptPda} from './seekerAuctionProtocol';
export interface CharterLockSaved {readonly packetInput:CharterLockPacketInput;readonly signedTransactionHex:string}
export interface CharterLockRpc extends CharterCreationEvidenceRpc {getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>}
export interface CharterLockEvidence {
 readonly version:1;readonly original:CharterLockOriginal;readonly signature:string;readonly slot:number;readonly observedSlot:number;
 readonly priorRevision:number;readonly revision:number;readonly action:'set'|'clear';readonly lockId:string;readonly leader:string;
 readonly feeLamports:string;readonly rentLamports:string;readonly wireSha256:string;readonly messageSha256:string;
 readonly finalizedTransitionObserved:true;readonly currentStateMatchesResult:boolean;readonly entryAuthorized:false;readonly fenceReleaseAuthorized:false;
}
const need:typeof lockPreparationNeed=lockPreparationNeed;
function saved(value:unknown,id:string,trust:CharterCreationEvidenceTrust){
 const s=record(value,'packetInput signedTransactionHex'),p=record(s.packetInput,'original candidateHex policySigner policySignatureHex lookupTable expectedLookupTable blockhash blockhashSlot lastValidBlockHeight currentBlockHeight');
 const original=copyCharterLockOriginal(p.original,trust);need(original.operation.id===id&&p.policySignatureHex!==null,'ORIGINAL');
 // The packet compiler first bounds and owns every field, verifies the real policy
 // signature and canonical instruction; retain only its owned message thereafter.
 const packet=buildCharterLockPacket({...p,original} as unknown as CharterLockPacketInput);
 need(typeof s.signedTransactionHex==='string'&&s.signedTransactionHex.length<=2464&&/^[0-9a-f]+$/.test(s.signedTransactionHex)&&s.signedTransactionHex.length%2===0,'WIRE');
 const wire=Buffer.from(s.signedTransactionHex,'hex'),signed=verifyCharterLockSignedWire({leader:new PublicKey(original.operation.leader),intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:wire});
 const lookup=record(p.lookupTable,'address owner executable dataHex slot'),pin=record(p.expectedLookupTable,'address dataSha256');
 return {original,packet,signed,wire,message:MessageV0.deserialize(Buffer.from(packet.messageHex,'hex')),permit:lockCandidate(original,p.candidateHex),
  lookup:{address:new PublicKey(lookup.address as string),data:Buffer.from(lookup.dataHex as string,'hex'),hash:pin.dataSha256 as string}};
}
function transaction(raw:VersionedTransactionResponse|null,original:ReturnType<typeof saved>){
 need(raw?.meta&&raw.version===0&&safeSlot(raw.slot),'TRANSACTION');const m=raw.transaction.message;need(m.version===0,'TRANSACTION');
 need(m.staticAccountKeys.length<=32&&m.compiledInstructions.length===3&&m.addressTableLookups.length===1,'BOUNDS');
 const index=(n:number)=>{need(Number.isInteger(n)&&n>=0&&n<=255,'BOUNDS');return n;};
 need(m.header.numRequiredSignatures===1&&m.header.numReadonlySignedAccounts===0&&safeSlot(m.header.numReadonlyUnsignedAccounts)&&m.header.numReadonlyUnsignedAccounts<=m.staticAccountKeys.length,'TRANSACTION');
 const c=new MessageV0({header:{...m.header},staticAccountKeys:m.staticAccountKeys.map(k=>new PublicKey(k.toBytes())),recentBlockhash:m.recentBlockhash,
 compiledInstructions:m.compiledInstructions.map(ix=>{need(ix.data instanceof Uint8Array&&ix.data.length<=1232&&ix.accountKeyIndexes.length<=32,'BOUNDS');return {programIdIndex:index(ix.programIdIndex),accountKeyIndexes:ix.accountKeyIndexes.map(index),data:Uint8Array.from(ix.data)};}),
 addressTableLookups:m.addressTableLookups.map(t=>{need(t.readonlyIndexes.length+t.writableIndexes.length<=32,'BOUNDS');return {accountKey:new PublicKey(t.accountKey.toBytes()),readonlyIndexes:t.readonlyIndexes.map(index),writableIndexes:t.writableIndexes.map(index)};})});
 need(Buffer.from(c.serialize()).equals(Buffer.from(original.packet.messageHex,'hex')),'TRANSACTION');
 need(raw.transaction.signatures.length===1&&raw.transaction.signatures[0]===original.signed.signature,'SIGNATURE');
 const meta=raw.meta;need(meta.err===null,'FAILED');need(safeSlot(meta.fee)&&meta.preBalances.length<=64&&meta.preBalances.length===meta.postBalances.length&&meta.preBalances.every(safeSlot)&&meta.postBalances.every(safeSlot),'PAYMENT');
 need(meta.loadedAddresses&&meta.loadedAddresses.writable.length+meta.loadedAddresses.readonly.length<=32,'ACCOUNTS');
 return {slot:raw.slot,fee:BigInt(meta.fee),pre:meta.preBalances.map(BigInt),post:meta.postBalances.map(BigInt),loaded:{writable:meta.loadedAddresses.writable.map(k=>new PublicKey(k.toBytes())),readonly:meta.loadedAddresses.readonly.map(k=>new PublicKey(k.toBytes()))}};
}
export function createCharterLockEvidenceReader<Context=void>(connect:(signal:AbortSignal)=>CharterLockRpc,inputTrust:CharterCreationEvidenceTrust,load:(id:string,context:Context)=>Promise<CharterLockSaved|null>,options:{deadlineMs?:number}={}){
 const trust=copyTrust(inputTrust),run=boundedLockWork(options.deadlineMs);need(typeof connect==='function'&&typeof load==='function','INPUT');
 return async(idInput:string,context:Context):Promise<CharterLockEvidence>=>{
  const id=uuid(idInput,'INPUT');return run(async(call,signal)=>{
   const original=saved(await call(()=>load(id,context)),id,trust),rpc=connect(signal),getTx=rpc.getTransaction.bind(rpc),getGenesis=rpc.getGenesisHash.bind(rpc),multiple=rpc.getMultipleAccountsInfoAndContext.bind(rpc);
   need(await call(getGenesis)===trust.expectedGenesisHash,'DOMAIN');
   const tx=transaction(await call(()=>getTx(original.signed.signature,{commitment:'finalized',maxSupportedTransactionVersion:0})),original);
   need(tx.slot>Math.max(trust.economy.reviewedDeploymentSlot,trust.craft.reviewedDeploymentSlot,trust.core.reviewedDeploymentSlot),'DEPLOYMENT');
   const bank=await readLockBank(rpc,trust,original.original,[],call);need(bank.slot>=tx.slot,'BANK');
   const alt=await call(()=>multiple([original.lookup.address],{commitment:'finalized',minContextSlot:bank.slot}));need(safeSlot(alt.context?.slot)&&alt.context.slot>=bank.slot&&alt.value.length===1,'BANK');
   const row=alt.value[0];need(row&&row.address.equals(original.lookup.address)&&!row.executable&&row.data instanceof Uint8Array&&row.data.length<=8248,'ALT');
   // Exact fresh bytes equal the immutable table independently validated by the
   // compiler. Transport-loaded addresses cannot substitute a different table.
   const tableOwner=new PublicKey('AddressLookupTab1e1111111111111111111111111');need(row.owner.equals(tableOwner)&&createHash('sha256').update(row.data).digest('hex')===original.lookup.hash&&Buffer.from(row.data).equals(original.lookup.data),'ALT');
   const state=AddressLookupTableAccount.deserialize(original.lookup.data);need(state.lastExtendedSlot<tx.slot,'ALT');
   const loaded=original.message.resolveAddressTableLookups([new AddressLookupTableAccount({key:original.lookup.address,state})]);
   need((['writable','readonly'] as const).every(k=>loaded[k].length===tx.loaded[k].length&&loaded[k].every((p,i)=>p.equals(tx.loaded[k][i]!))),'ALT');
   const keys=[...original.message.staticAccountKeys,...loaded.writable,...loaded.readonly],{economy,leader}=lockParts(original.original),receipt=seekerPermitReceiptPda(economy,original.permit.permitId);
   need(keys.length===tx.pre.length&&new Set(keys.map(k=>k.toBase58())).size===keys.length,'PAYMENT');const ri=keys.findIndex(k=>k.equals(receipt));need(ri>=0,'PAYMENT');const rent=tx.post[ri]!-tx.pre[ri]!;need(rent>=0n,'PAYMENT');
   for(const [i,k]of keys.entries())need((tx.post[i]! - tx.pre[i]!) ===(k.equals(leader)?-tx.fee-rent:k.equals(receipt)?rent:0n),'PAYMENT');
   let currentStateMatchesResult=false;const operation=original.original.operation;
   try {verifyLockCurrentBank({...bank,original:{...original.original,operation:{...operation,expectedRevision:operation.expectedRevision+1,action:operation.action==='set'?'clear':'set'}}});currentStateMatchesResult=true;}catch{/* Historical proof survives later state, without admission rights. */}
   need(await call(getGenesis)===trust.expectedGenesisHash,'DOMAIN');
   return Object.freeze({version:1,original:original.original,signature:original.signed.signature,slot:tx.slot,observedSlot:bank.slot,priorRevision:operation.expectedRevision,revision:operation.expectedRevision+1,action:operation.action,lockId:operation.lockId,leader:operation.leader,feeLamports:tx.fee.toString(),rentLamports:rent.toString(),wireSha256:original.signed.wireSha256,messageSha256:original.signed.messageSha256,finalizedTransitionObserved:true,currentStateMatchesResult,entryAuthorized:false,fenceReleaseAuthorized:false});
  });
 };
}
