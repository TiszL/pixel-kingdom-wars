/** Historical claimant receipts from a trusted finalized RPC and pinned reviewed
 * executable. Preparation supplies instruction authority; no signing or relay. */
import {Message,MessageV0,PublicKey,SystemProgram,type VersionedTransactionResponse} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {TOKEN} from '@shardkeep/shared';
import bs58 from 'bs58';
import {buildMiningClaimMessages,type MiningClaimMessageInput} from './miningClaimMessage';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
import {createMiningClaimSnapshotReader,MiningClaimSnapshotError,type MiningClaimSnapshotReader,type MiningClaimSnapshotTrust} from './miningClaimSnapshot';

import {copyMiningClaimFormat,miningClaimV0Accounts,verifyMiningClaimV0Rpc,attestMiningClaimLookup,type MiningClaimFormat} from './miningClaimFormat';

type Code='INPUT'|'UNAVAILABLE'|'TRANSACTION'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS'|'PAYMENT';
export class MiningClaimReceiptError extends Error{constructor(readonly code:Code){super(`Mining claim receipt refused: ${code}`);this.name='MiningClaimReceiptError';}}
function need(v:unknown,code:Code):asserts v{if(!v)throw new MiningClaimReceiptError(code);}
const slot=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
// A 1,232-byte packet expands to at most 1,683 base58 characters.
const U64=(1n<<64n)-1n,MAX_KEYS=32,MAX_INNER=32,MAX_BASE58_PACKET_CHARS=1683;
function amount(v:unknown):bigint{need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),'PAYMENT');const n=BigInt(v);need(n<=U64,'PAYMENT');return n;}
export interface MiningClaimReceiptReader extends MiningClaimSnapshotReader {
 getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>;
}
export type MiningClaimReceiptTrust=MiningClaimSnapshotTrust;
export interface MiningClaimReceiptRequest {
 readonly signature:string;readonly signedTransaction:Uint8Array;readonly plan:MiningClaimMessageInput;
 readonly format?:MiningClaimFormat;
 readonly kind:'combined'|'setup'|'claim';readonly blockhashContextSlot:number;readonly sourceHash:string;
}
export function createMiningClaimReceiptVerifier(reader:MiningClaimReceiptReader,inputTrust:MiningClaimReceiptTrust){
 const trust={...inputTrust,programId:new PublicKey(inputTrust.programId.toBytes()),keepMint:new PublicKey(inputTrust.keepMint.toBytes()),reserveOwner:new PublicKey(inputTrust.reserveOwner.toBytes())};
 const identity={programId:trust.programId,keepMint:trust.keepMint,reserveOwner:trust.reserveOwner};
 // Validate configured authority at factory construction, before any request.
 createMiningClaimSnapshotReader(reader,trust);
 return async function verify(request:MiningClaimReceiptRequest){
  try{
   need(request&&Object.keys(request).sort().join(',')===(request.format===undefined?'blockhashContextSlot,kind,plan,signature,signedTransaction,sourceHash':'blockhashContextSlot,format,kind,plan,signature,signedTransaction,sourceHash'),'INPUT');
   need(slot(request.blockhashContextSlot)&&request.blockhashContextSlot>=trust.reviewedDeploymentSlot&&typeof request.sourceHash==='string'&&/^[0-9a-f]{64}$/.test(request.sourceHash),'INPUT');
   let format:MiningClaimFormat|undefined;try{format=request.format===undefined?undefined:copyMiningClaimFormat(request.format,identity);need(!format||format.blockhashContextSlot===request.blockhashContextSlot,'INPUT');}catch{throw new MiningClaimReceiptError('INPUT');}
   const planned=buildMiningClaimMessages(identity,request.plan,format),selected=planned.transactions.find(t=>t.kind===request.kind);need(selected,'INPUT');
   let signed;try{signed=verifyMiningClaimSignedWire({intentBytes:selected.messageBytes,signedTransaction:request.signedTransaction,wallet:request.plan.wallet,...(format?{format}:{})});}catch{throw new MiningClaimReceiptError('INPUT');}
   need(request.signature===signed.signature,'INPUT');
   const signature=signed.signature,sourceHash=request.sourceHash,kind=selected.kind,blockhashContextSlot=request.blockhashContextSlot;
   const wallet=new PublicKey(planned.wallet),leaf={...request.plan.leaf},needsAta=request.plan.needsAta,needsMinerRecords=request.plan.needsMinerRecords;
   const message=format?MessageV0.deserialize(selected.messageBytes):Message.from(selected.messageBytes),strings=(format?miningClaimV0Accounts(message as MessageV0,format).keys:(message as Message).accountKeys).map(k=>k.toBase58());need(strings.length<=MAX_KEYS&&new Set(strings).size===strings.length,'INPUT');
   const at=(i:number)=>{need(Number.isInteger(i)&&i>=0&&i<strings.length,'TRANSACTION');return strings[i]!;};
   need(await reader.getGenesisHash()===trust.expectedGenesisHash,'IDENTITY');
   const tx=await reader.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});need(tx,'UNAVAILABLE');
   need(tx.meta&&tx.meta.err===null&&slot(tx.slot)&&tx.slot>trust.reviewedDeploymentSlot&&tx.slot>=blockhashContextSlot&&slot(tx.blockTime),'TRANSACTION');
   const transactionSlot=tx.slot,blockTime=tx.blockTime,meta=tx.meta,rpcMessage=tx.transaction?.message;
   if(format){try{verifyMiningClaimV0Rpc(tx,selected.messageBytes,signature,format);}catch{throw new MiningClaimReceiptError('TRANSACTION');}}else{
   need(rpcMessage&&rpcMessage.version==='legacy'&&(tx.version===undefined||tx.version==='legacy'),'TRANSACTION');
   // Legacy compiledInstructions base58-decodes data inside its getter, and
   // serialize decodes recentBlockhash. Bound their raw fields before either.
   need(Array.isArray(rpcMessage.accountKeys)&&rpcMessage.accountKeys.length<=MAX_KEYS
    &&Array.isArray(rpcMessage.instructions)&&rpcMessage.instructions.length>0&&rpcMessage.instructions.length<=3
    &&typeof rpcMessage.recentBlockhash==='string'&&rpcMessage.recentBlockhash.length>=32&&rpcMessage.recentBlockhash.length<=44,'TRANSACTION');
   for(const ix of rpcMessage.instructions)need(ix&&typeof ix.data==='string'&&ix.data.length<=MAX_BASE58_PACKET_CHARS
    &&Array.isArray(ix.accounts)&&ix.accounts.length<=MAX_KEYS&&Array.from(ix.accounts).every(i=>Number.isInteger(i)&&i>=0&&i<rpcMessage.accountKeys.length)
    &&Number.isInteger(ix.programIdIndex)&&ix.programIdIndex>=0&&ix.programIdIndex<rpcMessage.accountKeys.length,'TRANSACTION');
   const compiledInstructions=rpcMessage.compiledInstructions;
   for(const ix of compiledInstructions)need(ix.data instanceof Uint8Array&&ix.data.length<=1232&&Array.isArray(ix.accountKeyIndexes)&&ix.accountKeyIndexes.length<=MAX_KEYS,'TRANSACTION');
   need(Buffer.from(rpcMessage.serialize()).equals(Buffer.from(selected.messageBytes))&&Array.isArray(tx.transaction.signatures)&&tx.transaction.signatures.length===1&&tx.transaction.signatures[0]===signature,'TRANSACTION');
   need(!meta.loadedAddresses||(Array.isArray(meta.loadedAddresses.writable)&&Array.isArray(meta.loadedAddresses.readonly)&&meta.loadedAddresses.writable.length===0&&meta.loadedAddresses.readonly.length===0),'TRANSACTION');
   }
   need(slot(meta.fee)&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===strings.length&&meta.postBalances.length===strings.length&&Array.from(meta.preBalances).every(slot)&&Array.from(meta.postBalances).every(slot),'TRANSACTION');
   const fee=BigInt(meta.fee),preLamports=meta.preBalances.map(n=>BigInt(n)),postLamports=meta.postBalances.map(n=>BigInt(n));
   const balances=(which:'preTokenBalances'|'postTokenBalances')=>{
    const source=meta[which];need(Array.isArray(source)&&source.length<=2,'PAYMENT');const out=new Map<string,{owner:string;amount:bigint}>();
    for(const b of source){const address=at(b.accountIndex);need(!out.has(address)&&b.mint===trust.keepMint.toBase58()&&b.programId===TOKEN_PROGRAM_ID.toBase58()&&typeof b.owner==='string'&&b.owner.length<=44&&b.uiTokenAmount?.decimals===TOKEN.decimals,'PAYMENT');out.set(address,{owner:b.owner,amount:amount(b.uiTokenAmount.amount)});}return out;
   };
   const pre=balances('preTokenBalances'),post=balances('postTokenBalances');
   need(Array.isArray(meta.innerInstructions)&&meta.innerInstructions.length<=3,'TRANSACTION');
   const groups=new Set<number>();let count=0;
   const inner=meta.innerInstructions.map(group=>{
    need(Number.isInteger(group.index)&&group.index>=0&&group.index<message.compiledInstructions.length&&!groups.has(group.index)&&Array.isArray(group.instructions),'TRANSACTION');groups.add(group.index);
    need(count+group.instructions.length<=MAX_INNER,'TRANSACTION');count+=group.instructions.length;
    return {index:group.index,instructions:group.instructions.map(ix=>{
     // Current RPC exposes stackHeight although pinned web3's compiled type does
     // not declare it. Missing/null depth is insufficient attribution evidence.
     need(typeof ix.data==='string'&&ix.data.length<=700&&Array.isArray(ix.accounts)&&ix.accounts.length<=MAX_KEYS&&(ix as typeof ix&{stackHeight?:unknown}).stackHeight===2,'TRANSACTION');
     const data=bs58.decode(ix.data);need(data.length<=512&&bs58.encode(data)===ix.data,'TRANSACTION');return {program:at(ix.programIdIndex),accounts:ix.accounts.map(at),data:Buffer.from(data)};
    })};
   });
   // Everything above is copied/normalized before the next asynchronous read.
   // Reuse the full fourteen-account validator with a transaction-slot floor.
   if(format){try{await attestMiningClaimLookup(reader,format,transactionSlot);}catch{throw new MiningClaimReceiptError('ACCOUNTS');}}
   const snapshot=await createMiningClaimSnapshotReader({getGenesisHash:()=>reader.getGenesisHash(),getSlot:c=>reader.getSlot(c),getMultipleAccountsInfoAndContext:(keys,options)=>reader.getMultipleAccountsInfoAndContext(keys,{...options,minContextSlot:Math.max(options.minContextSlot,transactionSlot)})},trust,{claimantAccountPolicy:'historical'})({wallet,sequence:planned.sequence,day:planned.day});
   need(snapshot.slot>=transactionSlot&&snapshot.root.root===planned.root&&snapshot.root.totalCumulative===planned.totalCumulative&&snapshot.epoch.sourceHash===sourceHash,'ACCOUNTS');
   // Permanent cursors must survive. A later ATA closure is compatible with the
   // exact historical post-balances/CPI below and must not erase that receipt.
   const miner=snapshot.minerClaim,renown=snapshot.renownRecord;need(miner&&renown,'ACCOUNTS');
   const vault=snapshot.backing.config.miningVault,ata=snapshot.claimantAta.address,config=snapshot.backing.config.address,mint=trust.keepMint.toBase58(),token=TOKEN_PROGRAM_ID.toBase58();
   const claimIndex=kind==='setup'?-1:message.compiledInstructions.length-1;
   const expectedTokens=kind==='setup'?(needsAta?[ata]:[]):[vault,ata];
   need(post.size===expectedTokens.length&&[...post.keys()].every(a=>expectedTokens.includes(a))&&[...pre.keys()].every(a=>expectedTokens.includes(a)),'PAYMENT');
   for(const [address,b] of [...pre,...post])need(b.owner===(address===vault?config:planned.wallet),'PAYMENT');
   let paid=0n;
   if(kind!=='setup'){
    need(pre.has(vault)&&post.has(vault)&&post.has(ata),'PAYMENT');
    if(!pre.has(ata))need(kind==='combined'&&needsAta&&postLamports[strings.indexOf(ata)]!>0n,'PAYMENT');
    paid=pre.get(vault)!.amount-post.get(vault)!.amount;
    need(paid>0n&&paid<=leaf.cumulativeKeep&&post.get(ata)!.amount-(pre.get(ata)?.amount??0n)===paid,'PAYMENT');
    if(kind==='combined'&&needsMinerRecords)need(paid===leaf.cumulativeKeep,'PAYMENT');
    need(snapshot.root.claimsCount>0n&&miner.claimedTotal>=leaf.cumulativeKeep&&miner.lastSequence>=leaf.sequence&&renown.renownTotal>=leaf.cumulativeRenown&&renown.daysAttested>=leaf.cumulativeDays&&renown.lastSequence>=leaf.sequence,'ACCOUNTS');
   }else if(needsAta){
    need(post.has(ata),'PAYMENT');if(!pre.has(ata))need(postLamports[strings.indexOf(ata)]!>0n,'PAYMENT');
    need(post.get(ata)!.amount===(pre.get(ata)?.amount??0n),'PAYMENT');
   }
   // A missing pre-token row means uninitialized, not unfunded. Only exact
   // scoped create or prefunded transfer/allocate/assign/initialize evidence
   // below admits that ATA, with the payer charged only the observed shortfall.
   const newAccounts=new Map(selected.expectedNewAccounts.map(a=>[a.address,a])),rentByAddress=new Map<string,bigint>();let rent=0n;
   strings.forEach((address,i)=>{if(i===0)return;const delta=postLamports[i]!-preLamports[i]!;if(newAccounts.has(address)){need(delta>=0n,'PAYMENT');rentByAddress.set(address,delta);rent+=delta;}else need(delta===0n,'PAYMENT');});
   need(preLamports[0]!-postLamports[0]! ===fee+rent,'PAYMENT');
   let transfers=0,ataInitialized=false;
   const creation=new Map<string,{created:boolean;allocated:boolean;assigned:boolean;transferred:boolean;moved:bigint}>();
   for(const group of inner){const top=at(message.compiledInstructions[group.index]!.programIdIndex),ataGroup=top===ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();let sizeRead=false,immutableOwner=false;
    for(const ix of group.instructions){
     if(group.index===claimIndex){
      need(ix.program===token&&++transfers===1&&ix.data.length===10&&ix.data[0]===12&&ix.data.readBigUInt64LE(1)===paid&&ix.data[9]===TOKEN.decimals&&ix.accounts.join(',')===[vault,mint,ata,config].join(','),'PAYMENT');
     }else if(ix.program===SystemProgram.programId.toBase58()){
      need(ataGroup||top===trust.programId.toBase58(),'TRANSACTION');need(ix.data.length>=4,'PAYMENT');const tag=ix.data.readUInt32LE(0),target=ix.accounts[tag===0||tag===2?1:0],account=target?newAccounts.get(target):undefined;
      need(target&&account&&(ataGroup?target===ata&&sizeRead&&!ataInitialized:target!==ata),'PAYMENT');
      const owner=ataGroup?token:trust.programId.toBase58(),state=creation.get(target)??{created:false,allocated:false,assigned:false,transferred:false,moved:0n};creation.set(target,state);
      if(tag===0){need(!state.created&&!state.transferred&&!state.allocated&&!state.assigned&&ix.accounts.join(',')===[planned.wallet,target].join(',')&&ix.data.length===52&&ix.data.readBigUInt64LE(12)===BigInt(account.space)&&new PublicKey(ix.data.subarray(20)).toBase58()===owner&&preLamports[strings.indexOf(target)]===0n,'PAYMENT');state.created=true;state.moved=ix.data.readBigUInt64LE(4);}
      else if(tag===2){need(!state.created&&!state.transferred&&!state.allocated&&!state.assigned&&ix.accounts.join(',')===[planned.wallet,target].join(',')&&ix.data.length===12&&ix.data.readBigUInt64LE(4)>0n,'PAYMENT');state.transferred=true;state.moved=ix.data.readBigUInt64LE(4);}
      else if(tag===8){need(!state.created&&!state.allocated&&!state.assigned&&ix.accounts.join(',')===target&&ix.data.length===12&&ix.data.readBigUInt64LE(4)===BigInt(account.space)&&preLamports[strings.indexOf(target)]!>0n,'PAYMENT');state.allocated=true;}
      else if(tag===1){need(!state.created&&state.allocated&&!state.assigned&&ix.accounts.join(',')===target&&ix.data.length===36&&new PublicKey(ix.data.subarray(4)).toBase58()===owner,'PAYMENT');state.assigned=true;}
      else need(false,'PAYMENT');
     }else{
      need(ataGroup&&ix.program===token,'TRANSACTION');const tag=ix.data[0],state=creation.get(ata);
      if(tag===21){need(!sizeRead&&!state&&!ataInitialized&&ix.accounts.join(',')===mint&&(ix.data.length===1||ix.data.length===3&&ix.data.readUInt16LE(1)===7),'PAYMENT');sizeRead=true;}
      else if(tag===22){need(!immutableOwner&&!ataInitialized&&state&&(state.created||state.allocated&&state.assigned)&&ix.accounts.join(',')===ata&&ix.data.length===1,'PAYMENT');immutableOwner=true;}
      else{need(tag===18&&!ataInitialized&&immutableOwner&&state&&(state.created||state.allocated&&state.assigned)&&!pre.has(ata)&&ix.accounts.join(',')===[ata,mint].join(',')&&ix.data.length===33&&ix.data.subarray(1).equals(wallet.toBuffer()),'PAYMENT');ataInitialized=true;}
     }
    }
   }
   for(const [target,state] of creation)need((state.created||state.allocated&&state.assigned)&&state.moved===(rentByAddress.get(target)??0n)&&(target!==ata||ataInitialized),'PAYMENT');
   for(const [target,rent] of rentByAddress)if(rent>0n)need(creation.has(target),'PAYMENT');
   if(expectedTokens.includes(ata)&&!pre.has(ata))need(ataInitialized,'PAYMENT');
   need(transfers===(kind==='setup'?0:1),'PAYMENT');
   return Object.freeze({version:1 as const,kind,wallet:planned.wallet,day:planned.day.toString(),sequence:planned.sequence.toString(),root:planned.root,paidKeepBaseUnits:paid.toString(),
    signature,slot:transactionSlot,blockTime,observedAccountSlot:snapshot.slot,originalMessageSha256:signed.messageSha256,signedTransactionSha256:signed.wireSha256,
    source:Object.freeze({trust:'trusted-finalized-rpc-reviewed-program' as const,genesisHash:trust.expectedGenesisHash,programId:trust.programId.toBase58(),configAddress:config,sourceHash,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256}),
    currentClaimedTotal:miner.claimedTotal.toString(),currentGlobalClaimedTotal:snapshot.backing.config.totalClaimed.toString(),currentMinerSequence:miner.lastSequence.toString(),currentRenownTotal:renown.renownTotal.toString(),currentDaysAttested:renown.daysAttested.toString(),currentRenownSequence:renown.lastSequence.toString(),currentClaimsAuthorized:false as const});
  }catch(error){if(error instanceof MiningClaimReceiptError)throw error;if(error instanceof MiningClaimSnapshotError)throw new MiningClaimReceiptError(error.code==='IDENTITY'||error.code==='DEPLOYMENT'?error.code:error.code==='UNAVAILABLE'?'UNAVAILABLE':'ACCOUNTS');throw new MiningClaimReceiptError('UNAVAILABLE');}
 };
}
export type MiningClaimReceipt=Awaited<ReturnType<ReturnType<typeof createMiningClaimReceiptVerifier>>>;
