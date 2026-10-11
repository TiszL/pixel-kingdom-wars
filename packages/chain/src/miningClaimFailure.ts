/** Historical failed execution of an exact retained claimant transaction.
 * No expiry/status inference, payment receipt, signing or relay authority. */
import {Message,MessageV0,PublicKey} from '@solana/web3.js';
import {isFailedSolanaExecution} from './solanaFailedExecution';
import {buildMiningClaimMessages} from './miningClaimMessage';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
import {createMiningClaimSnapshotReader,MiningClaimSnapshotError} from './miningClaimSnapshot';
import type {MiningClaimReceiptReader,MiningClaimReceiptRequest,MiningClaimReceiptTrust} from './miningClaimReceipt';

import {copyMiningClaimFormat,miningClaimV0Accounts,verifyMiningClaimV0Rpc,attestMiningClaimLookup,type MiningClaimFormat} from './miningClaimFormat';

type Code='INPUT'|'UNAVAILABLE'|'TRANSACTION'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS';
export class MiningClaimFailureError extends Error{constructor(readonly code:Code){super(`Mining claim failure refused: ${code}`);this.name='MiningClaimFailureError';}}
function need(v:unknown,code:Code):asserts v{if(!v)throw new MiningClaimFailureError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const MAX_KEYS=32,MAX_INSTRUCTIONS=3,MAX_BASE58_PACKET=1683,U64=(1n<<64n)-1n;
function address(v:unknown):string{
 need(typeof v==='string'&&v.length>=32&&v.length<=44,'TRANSACTION');
 try{need(new PublicKey(v).toBase58()===v,'TRANSACTION');return v;}catch{throw new MiningClaimFailureError('TRANSACTION');}
}
function amount(v:unknown):string{
 need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),'TRANSACTION');need(BigInt(v)<=U64,'TRANSACTION');return v;
}
function tokenRows(v:unknown,keyCount:number):Map<number,string>{
 need(Array.isArray(v)&&v.length<=2,'TRANSACTION');const out=new Map<number,string>();
 for(const row of v){
  need(row&&safe(row.accountIndex)&&row.accountIndex<keyCount&&!out.has(row.accountIndex),'TRANSACTION');
  const mint=address(row.mint),owner=row.owner===undefined?'':address(row.owner),program=row.programId===undefined?'':address(row.programId),ui=row.uiTokenAmount;
  need(ui&&safe(ui.decimals)&&ui.decimals<=255,'TRANSACTION');out.set(row.accountIndex,[mint,owner,program,ui.decimals,amount(ui.amount)].join(':'));
 }return out;
}
export function createMiningClaimFailureVerifier(reader:MiningClaimReceiptReader,inputTrust:MiningClaimReceiptTrust){
 const trust={...inputTrust,programId:new PublicKey(inputTrust.programId.toBytes()),keepMint:new PublicKey(inputTrust.keepMint.toBytes()),reserveOwner:new PublicKey(inputTrust.reserveOwner.toBytes())};
 const identity={programId:trust.programId,keepMint:trust.keepMint,reserveOwner:trust.reserveOwner};
 createMiningClaimSnapshotReader(reader,trust);
 return async function verify(request:MiningClaimReceiptRequest){
  try{
   need(request&&Object.keys(request).sort().join(',')===(request.format===undefined?'blockhashContextSlot,kind,plan,signature,signedTransaction,sourceHash':'blockhashContextSlot,format,kind,plan,signature,signedTransaction,sourceHash'),'INPUT');
   need(safe(request.blockhashContextSlot)&&request.blockhashContextSlot>=trust.reviewedDeploymentSlot&&typeof request.sourceHash==='string'&&/^[0-9a-f]{64}$/.test(request.sourceHash),'INPUT');
   let planned,signed,format:MiningClaimFormat|undefined;
   try{format=request.format===undefined?undefined:copyMiningClaimFormat(request.format,identity);need(!format||format.blockhashContextSlot===request.blockhashContextSlot,'INPUT');planned=buildMiningClaimMessages(identity,request.plan,format);const selected=planned.transactions.find(t=>t.kind===request.kind);need(selected,'INPUT');signed=verifyMiningClaimSignedWire({intentBytes:selected.messageBytes,signedTransaction:request.signedTransaction,wallet:request.plan.wallet,...(format?{format}:{})});}catch{throw new MiningClaimFailureError('INPUT');}
   need(request.signature===signed.signature,'INPUT');
   const selected=planned.transactions.find(t=>t.kind===request.kind)!,signature=signed.signature,sourceHash=request.sourceHash,kind=selected.kind,contextFloor=request.blockhashContextSlot;
   const wallet=new PublicKey(planned.wallet),intent=Buffer.from(selected.messageBytes),expected=format?MessageV0.deserialize(intent):Message.from(intent);
   const keys=format?miningClaimV0Accounts(expected as MessageV0,format).keys:(expected as Message).accountKeys;
   need(await reader.getGenesisHash()===trust.expectedGenesisHash,'IDENTITY');
   const tx=await reader.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});need(tx,'UNAVAILABLE');
   need(tx.meta&&safe(tx.slot)&&tx.slot>trust.reviewedDeploymentSlot&&tx.slot>=contextFloor&&safe(tx.blockTime),'TRANSACTION');
   const transactionSlot=tx.slot,blockTime=tx.blockTime,meta=tx.meta,m=tx.transaction?.message;
   if(format){try{verifyMiningClaimV0Rpc(tx,intent,signature,format);}catch{throw new MiningClaimFailureError('TRANSACTION');}}else{
   need(m&&m.version==='legacy'&&(tx.version===undefined||tx.version==='legacy'),'TRANSACTION');
   // Raw fields are bounded before any base58 decoder. Reconstruct an owned
   // Message instead of invoking provider-controlled compiled/serialize methods.
   need(Array.isArray(m.accountKeys)&&m.accountKeys.length>0&&m.accountKeys.length<=MAX_KEYS
    &&Array.isArray(m.instructions)&&m.instructions.length>0&&m.instructions.length<=MAX_INSTRUCTIONS
    &&typeof m.recentBlockhash==='string'&&m.recentBlockhash.length>=32&&m.recentBlockhash.length<=44,'TRANSACTION');
   for(const ix of m.instructions)need(ix&&typeof ix.data==='string'&&ix.data.length<=MAX_BASE58_PACKET
    &&Array.isArray(ix.accounts)&&ix.accounts.length<=MAX_KEYS&&Array.from(ix.accounts).every(i=>safe(i)&&i<m.accountKeys.length)
    &&safe(ix.programIdIndex)&&ix.programIdIndex<m.accountKeys.length,'TRANSACTION');
   need(m.header&&safe(m.header.numRequiredSignatures)&&safe(m.header.numReadonlySignedAccounts)&&safe(m.header.numReadonlyUnsignedAccounts)
    &&m.header.numRequiredSignatures===1&&m.header.numReadonlySignedAccounts===0&&m.header.numReadonlyUnsignedAccounts<m.accountKeys.length,'TRANSACTION');
   const rpcKeys=m.accountKeys.map(k=>{need(k instanceof PublicKey,'TRANSACTION');return new PublicKey(k.toBytes());});
   need(new Set(rpcKeys.map(k=>k.toBase58())).size===rpcKeys.length,'TRANSACTION');
   const copy=new Message({header:{numRequiredSignatures:m.header.numRequiredSignatures,numReadonlySignedAccounts:m.header.numReadonlySignedAccounts,numReadonlyUnsignedAccounts:m.header.numReadonlyUnsignedAccounts},accountKeys:rpcKeys,recentBlockhash:address(m.recentBlockhash),instructions:m.instructions.map(ix=>({programIdIndex:ix.programIdIndex,accounts:[...ix.accounts],data:ix.data}))});
   need(copy.serialize().equals(intent)&&Array.isArray(tx.transaction.signatures)&&tx.transaction.signatures.length===1&&tx.transaction.signatures[0]===signature,'TRANSACTION');
   need(!meta.loadedAddresses||(Array.isArray(meta.loadedAddresses.writable)&&Array.isArray(meta.loadedAddresses.readonly)&&meta.loadedAddresses.writable.length===0&&meta.loadedAddresses.readonly.length===0),'TRANSACTION');
   }
   need(isFailedSolanaExecution(meta.err,expected.compiledInstructions.length,keys.length),'TRANSACTION');
   need(safe(meta.fee)&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===keys.length&&meta.postBalances.length===keys.length
    &&Array.from(meta.preBalances).every(safe)&&Array.from(meta.postBalances).every(safe),'TRANSACTION');
   // These canonical messages have no durable nonce: failed execution rolls
   // account changes back, while the claimant may still have paid the tx fee.
   need(meta.preBalances.every((pre,i)=>BigInt(pre)-BigInt(meta.postBalances[i]!)===(i===0?BigInt(meta.fee):0n)),'TRANSACTION');
   if(meta.preTokenBalances!==undefined||meta.postTokenBalances!==undefined){
    const pre=tokenRows(meta.preTokenBalances,keys.length),post=tokenRows(meta.postTokenBalances,keys.length);
    need(pre.size===post.size&&[...pre].every(([index,value])=>post.get(index)===value),'TRANSACTION');
   }
   // Ignore logs/CPI: apparently successful inner work preceding meta.err was
   // rolled back. Current cursor values are also not transaction outcome proof.
   if(format){try{await attestMiningClaimLookup(reader,format,transactionSlot);}catch{throw new MiningClaimFailureError('ACCOUNTS');}}
   const snapshot=await createMiningClaimSnapshotReader({getGenesisHash:()=>reader.getGenesisHash(),getSlot:c=>reader.getSlot(c),getMultipleAccountsInfoAndContext:(keys,options)=>reader.getMultipleAccountsInfoAndContext(keys,{...options,minContextSlot:Math.max(options.minContextSlot,transactionSlot)})},trust,{claimantAccountPolicy:'historical'})({wallet,sequence:planned.sequence,day:planned.day});
   need(snapshot.slot>=transactionSlot&&snapshot.root.root===planned.root&&snapshot.root.totalCumulative===planned.totalCumulative&&snapshot.epoch.sourceHash===sourceHash,'ACCOUNTS');
   return Object.freeze({version:1 as const,kind,wallet:planned.wallet,day:planned.day.toString(),sequence:planned.sequence.toString(),root:planned.root,signature,
    slot:transactionSlot,blockTime,observedAccountSlot:snapshot.slot,originalMessageSha256:signed.messageSha256,signedTransactionSha256:signed.wireSha256,
    source:Object.freeze({trust:'trusted-finalized-rpc-reviewed-program' as const,genesisHash:trust.expectedGenesisHash,programId:trust.programId.toBase58(),configAddress:snapshot.backing.config.address,sourceHash,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256}),
    outcome:'failed' as const,paymentAuthorized:false as const});
  }catch(error){if(error instanceof MiningClaimFailureError)throw error;if(error instanceof MiningClaimSnapshotError)throw new MiningClaimFailureError(error.code==='IDENTITY'||error.code==='DEPLOYMENT'?error.code:error.code==='UNAVAILABLE'?'UNAVAILABLE':'ACCOUNTS');throw new MiningClaimFailureError('UNAVAILABLE');}
 };
}
export type MiningClaimFailureReceipt=Awaited<ReturnType<ReturnType<typeof createMiningClaimFailureVerifier>>>;
