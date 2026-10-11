/** Application-owned trusted finalized evidence composition. No provider defaults,
 * signer, relay, persistence, terminal-failure proof or journal-clearing authority. */
import {isDeepStrictEqual} from 'node:util';
import {Message,MessageV0,PublicKey,SYSVAR_CLOCK_PUBKEY,type VersionedTransactionResponse,type CompiledInstruction} from '@solana/web3.js';
import {ACCOUNT_SIZE,MINT_SIZE,getAssociatedTokenAddressSync} from '@solana/spl-token';
import bs58 from 'bs58';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {createMiningTaxSnapshotReader,type MiningTaxSnapshot,type MiningTaxSnapshotTrust,type MiningTaxSnapshotRpc} from './miningTaxSnapshot';
import {buildMiningTaxMessages,type MiningTaxMessageInput,type MiningTaxCostCaps} from './miningTaxMessage';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
import {verifyMiningTaxReceipt,MiningTaxReceiptError,type MiningTaxReceiptEvidence} from './miningTaxReceipt';
import {readFinalizedHistoricalSeekerTerm,type SeekerTermRpc} from './seekerTerms';
import {seekerAuthorityPda,seekerAuctionPda,seekerRegistryPda,seekerTermPda} from './seekerAuctionProtocol';
import {SEEKER_TERM_ACCOUNT_BYTES} from './seekerTermAccounts';
import {MINING_ACCOUNT_BYTES,miningConfigPda,miningEpochPda,type MiningRawAccount} from './miningProgramProtocol';
import {MINING_TAX_ACCOUNT_BYTES,miningTermTaxPoolPda,miningTaxSpotCursorPda,miningTaxEpochReceiptPda} from './miningTaxProtocol';
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000,MAX_PROGRAM_DATA=8*1024*1024,U64=(1n<<64n)-1n;
type Code='INPUT'|'BUSY'|'TIMEOUT'|'UNAVAILABLE'|'IDENTITY'|'TRANSACTION'|'ACCOUNTS'|'EVENT'|'PAYMENT'|'COST_CAP'|'FAILED_OBSERVATION';
export class MiningTaxReceiptReaderError extends Error{readonly journalClearingAuthorized=false;constructor(readonly code:Code){super(`Finalized mining tax evidence unavailable: ${code}`);this.name='MiningTaxReceiptReaderError';}}
function need(v:unknown,code:Code='INPUT'):asserts v{if(!v)throw new MiningTaxReceiptReaderError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function exact(v:unknown,names:string){need(v&&typeof v==='object'&&!Array.isArray(v));const keys=Reflect.ownKeys(v),fields=names.split(' ');need(keys.length===fields.length&&keys.every(k=>typeof k==='string'&&fields.includes(k)));}
function key(v:PublicKey){need(v instanceof PublicKey);return new PublicKey(v.toBytes());}
function signature(v:unknown):string{need(typeof v==='string'&&v.length>0&&v.length<=88,'TRANSACTION');const bytes=bs58.decode(v);need(bytes.length===64&&bytes.some(n=>n!==0)&&bs58.encode(bytes)===v,'TRANSACTION');return v;}
/** Retained DB facts are ordinary bounded data, never caller-branded authority. */
function copiedFacts(value:unknown):unknown{
 let nodes=0,strings=0;const parents=new Set<object>();
 const copy=(v:unknown,depth:number):unknown=>{
  need(++nodes<=20_000&&depth<=12);
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){strings+=v.length;need(v.length<=4096&&strings<=2*1024*1024);return v;}
  if(typeof v==='number'){need(Number.isSafeInteger(v));return v;}
  if(typeof v==='bigint'){need(v>=-U64&&v<=U64);return v;}
  need(v&&typeof v==='object'&&!parents.has(v));parents.add(v);let out:unknown;
  if(Array.isArray(v)){need(v.length<=100&&Object.keys(v).length===v.length);out=v.map(x=>copy(x,depth+1));}
  else{need(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);const fields=Reflect.ownKeys(v);need(fields.length<=128&&fields.every(k=>typeof k==='string'));out=Object.fromEntries(fields.map(k=>{const d=Object.getOwnPropertyDescriptor(v,k)!;need('value' in d);return [k,copy(d.value,depth+1)];}));}
  parents.delete(v);return out;
 };return copy(value,0);
}
export type MiningTaxReceiptReaderRpc=MiningTaxSnapshotRpc;
export interface MiningTaxReceiptReaderRequest{readonly snapshot:MiningTaxSnapshot;readonly plan:MiningTaxMessageInput;readonly blockhashContextSlot:number;readonly caps:MiningTaxCostCaps;/** Ordered exact planner prefix; a setup transaction alone never proves payment. */readonly signedTransactions:readonly Uint8Array[]}
export interface MiningTaxReceiptReaderOptions{readonly timeoutMs?:number;readonly maxPending?:number}

/** Own the real raw message fields before invoking any serializer. Original
 * settlements may be valid v0/batched transactions; tax intent is exact legacy. */
function copyTransaction(tx:VersionedTransactionResponse|null,tax?:{signature:string;messageBytes:Uint8Array}):VersionedTransactionResponse{
 need(tx&&tx.meta&&tx.transaction,'UNAVAILABLE');need(safe(tx.slot)&&(tx.blockTime===null||tx.blockTime===undefined||safe(tx.blockTime)),'TRANSACTION');
 const raw=tx.transaction.message,meta=tx.meta;need(raw&&(raw.version==='legacy'||raw.version===0)&&(tx.version===undefined||tx.version===raw.version),'TRANSACTION');
 const keys=raw.version==='legacy'?raw.accountKeys:raw.staticAccountKeys;need(Array.isArray(keys)&&keys.length>0&&keys.length<=256,'TRANSACTION');
 const header=raw.header;need(header&&[header.numRequiredSignatures,header.numReadonlySignedAccounts,header.numReadonlyUnsignedAccounts].every(n=>safe(n)&&n<=keys.length)&&header.numRequiredSignatures>0&&header.numRequiredSignatures<=18,'TRANSACTION');
 need(typeof raw.recentBlockhash==='string'&&raw.recentBlockhash.length>=32&&raw.recentBlockhash.length<=44,'TRANSACTION');const blockhash=new PublicKey(raw.recentBlockhash);need(blockhash.toBase58()===raw.recentBlockhash,'TRANSACTION');
 const index=(v:number)=>{need(safe(v)&&v<256,'TRANSACTION');return v;},accountKeys=keys.map(key),ownedHeader={numRequiredSignatures:header.numRequiredSignatures,numReadonlySignedAccounts:header.numReadonlySignedAccounts,numReadonlyUnsignedAccounts:header.numReadonlyUnsignedAccounts};
 let message:Message|MessageV0;
 if(raw.version==='legacy'){
  need(Array.isArray(raw.instructions)&&raw.instructions.length>0&&raw.instructions.length<=128,'TRANSACTION');
  const instructions=raw.instructions.map((ix:CompiledInstruction)=>{need(ix&&typeof ix.data==='string'&&ix.data.length<=1683&&Array.isArray(ix.accounts)&&ix.accounts.length<=256,'TRANSACTION');return {programIdIndex:index(ix.programIdIndex),accounts:ix.accounts.map(index),data:ix.data};});
  message=new Message({header:ownedHeader,accountKeys,recentBlockhash:blockhash.toBase58(),instructions});
 }else{
  need(Array.isArray(raw.compiledInstructions)&&raw.compiledInstructions.length>0&&raw.compiledInstructions.length<=128&&Array.isArray(raw.addressTableLookups)&&raw.addressTableLookups.length<=32,'TRANSACTION');
  const compiledInstructions=raw.compiledInstructions.map(ix=>{need(ix.data instanceof Uint8Array&&ix.data.length<=1232&&Array.isArray(ix.accountKeyIndexes)&&ix.accountKeyIndexes.length<=256,'TRANSACTION');return {programIdIndex:index(ix.programIdIndex),accountKeyIndexes:ix.accountKeyIndexes.map(index),data:Uint8Array.from(ix.data)};});
  const addressTableLookups=raw.addressTableLookups.map(a=>{need(Array.isArray(a.writableIndexes)&&a.writableIndexes.length<=256&&Array.isArray(a.readonlyIndexes)&&a.readonlyIndexes.length<=256,'TRANSACTION');return {accountKey:key(a.accountKey),writableIndexes:a.writableIndexes.map(index),readonlyIndexes:a.readonlyIndexes.map(index)};});
  message=new MessageV0({header:ownedHeader,staticAccountKeys:accountKeys,recentBlockhash:blockhash.toBase58(),compiledInstructions,addressTableLookups});
 }
 need(Array.isArray(tx.transaction.signatures)&&tx.transaction.signatures.length===header.numRequiredSignatures,'TRANSACTION');const signatures=tx.transaction.signatures.map(signature),bytes=message.serialize();need(bytes.length+1+64*signatures.length<=1232,'TRANSACTION');
 if(tax)need(message.version==='legacy'&&signatures.length===1&&signatures[0]===tax.signature&&Buffer.from(bytes).equals(Buffer.from(tax.messageBytes)),'TRANSACTION');
 need(meta.err!==undefined,'UNAVAILABLE');need(meta.err===null,tax?'FAILED_OBSERVATION':'UNAVAILABLE');
 let loadedAddresses: {writable:PublicKey[];readonly:PublicKey[]}|undefined;
 if(meta.loadedAddresses){need(Array.isArray(meta.loadedAddresses.writable)&&Array.isArray(meta.loadedAddresses.readonly)&&meta.loadedAddresses.writable.length+meta.loadedAddresses.readonly.length+keys.length<=256,'TRANSACTION');loadedAddresses={writable:meta.loadedAddresses.writable.map(key),readonly:meta.loadedAddresses.readonly.map(key)};}
 const base={slot:tx.slot,blockTime:tx.blockTime??null,version:message.version,transaction:{message,signatures}};
 if(!tax)return {...base,meta:{err:null,fee:0,preBalances:[],postBalances:[],...(loadedAddresses?{loadedAddresses}:{})}};
 need(safe(meta.fee)&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===keys.length&&meta.postBalances.length===keys.length&&meta.preBalances.every(safe)&&meta.postBalances.every(safe),'TRANSACTION');
 const tokenBalances=(rows:typeof meta.preTokenBalances)=>{need(Array.isArray(rows)&&rows.length<=2,'UNAVAILABLE');return rows.map(b=>{need(b&&safe(b.accountIndex)&&b.accountIndex<keys.length&&typeof b.mint==='string'&&b.mint.length<=44&&typeof b.owner==='string'&&b.owner.length<=44&&typeof b.programId==='string'&&b.programId.length<=44&&b.uiTokenAmount&&typeof b.uiTokenAmount.amount==='string'&&b.uiTokenAmount.amount.length<=20&&safe(b.uiTokenAmount.decimals),'TRANSACTION');return {accountIndex:b.accountIndex,mint:b.mint,owner:b.owner,programId:b.programId,uiTokenAmount:{amount:b.uiTokenAmount.amount,decimals:b.uiTokenAmount.decimals,uiAmount:null}};});};
 need(Array.isArray(meta.innerInstructions)&&meta.innerInstructions.length<=11,'UNAVAILABLE');let count=0;
 const innerInstructions=(meta.innerInstructions as {index:number;instructions:CompiledInstruction[]}[]).map(g=>{need(g&&safe(g.index)&&g.index<message.compiledInstructions.length&&Array.isArray(g.instructions)&&count+g.instructions.length<=80,'TRANSACTION');count+=g.instructions.length;return {index:g.index,instructions:g.instructions.map(ix=>{need(ix&&typeof ix.data==='string'&&ix.data.length<=700&&Array.isArray(ix.accounts)&&ix.accounts.length<=40&&(ix as typeof ix&{stackHeight?:unknown}).stackHeight===2,'TRANSACTION');return {programIdIndex:index(ix.programIdIndex),accounts:ix.accounts.map(index),data:ix.data,stackHeight:2};})};});
 need(Array.isArray(meta.logMessages)&&meta.logMessages.length<=512&&meta.logMessages.every(s=>typeof s==='string'&&s.length<=2048)&&meta.logMessages.reduce((n,s)=>n+s.length,0)<=65536,'UNAVAILABLE');
 return {...base,meta:{err:null,fee:meta.fee,preBalances:[...meta.preBalances],postBalances:[...meta.postBalances],preTokenBalances:tokenBalances(meta.preTokenBalances),postTokenBalances:tokenBalances(meta.postTokenBalances),innerInstructions,logMessages:[...meta.logMessages],...(loadedAddresses?{loadedAddresses}:{})}};
}
function immutableTerm(term:MiningTaxSnapshot['term']){const {authority:_authority,finality:_finality,...immutable}=term;return immutable;}
export function createMiningTaxReceiptReader(connect:(signal:AbortSignal)=>MiningTaxReceiptReaderRpc,inputTrust:MiningTaxSnapshotTrust,options:MiningTaxReceiptReaderOptions={}){
 need(typeof connect==='function');createMiningTaxSnapshotReader(()=>{throw new MiningTaxReceiptReaderError('UNAVAILABLE');},inputTrust);
 need(options&&typeof options==='object'&&!Array.isArray(options)&&Reflect.ownKeys(options).every(k=>k==='timeoutMs'||k==='maxPending'));const timeout=options.timeoutMs??MAX_TIMEOUT_MS,limit=options.maxPending??MAX_PENDING;need(safe(timeout)&&timeout>0&&timeout<=MAX_TIMEOUT_MS&&safe(limit)&&limit>0&&limit<=MAX_PENDING);
 const m=inputTrust.mining,s=inputTrust.seeker,trust:MiningTaxSnapshotTrust={mining:{...m,programId:key(m.programId),keepMint:key(m.keepMint),reserveOwner:key(m.reserveOwner)},seeker:{...s,programId:key(s.programId),config:key(s.config),mint:key(s.mint),prizeOwner:key(s.prizeOwner),prizeAta:key(s.prizeAta),genesisHash:key(s.genesisHash),deployment:{...s.deployment}}};
 let pending=0;
 return async function read(value:MiningTaxReceiptReaderRequest){
  let snapshot:MiningTaxSnapshot,input:MiningTaxMessageInput,caps:MiningTaxCostCaps,blockhashContextSlot:number,planned:ReturnType<typeof buildMiningTaxMessages>,signed:ReturnType<typeof verifyMiningClaimSignedWire>[];
  try{
   exact(value,'snapshot plan blockhashContextSlot caps signedTransactions');exact(value.plan,'wallet round spot blockhash');exact(value.caps,'maxFeeLamports maxRentLamports maxTotalLamports');
   snapshot=copiedFacts(value.snapshot) as MiningTaxSnapshot;input={...value.plan,wallet:key(value.plan.wallet)};caps={...value.caps};blockhashContextSlot=value.blockhashContextSlot;
   need(safe(blockhashContextSlot)&&blockhashContextSlot>=trust.mining.reviewedDeploymentSlot);for(const n of Object.values(caps))need(typeof n==='bigint'&&n>=0n&&n<=U64);
   planned=buildMiningTaxMessages(trust.mining,snapshot,input);need(Array.isArray(value.signedTransactions)&&value.signedTransactions.length>0&&value.signedTransactions.length<=planned.transactions.length);
   signed=value.signedTransactions.map((wire,i)=>verifyMiningClaimSignedWire({intentBytes:planned.transactions[i]!.messageBytes,signedTransaction:wire,wallet:input.wallet}));
   need(Array.isArray(snapshot.term.auctions)&&snapshot.term.auctions.length===PHASE_E_POLICY.seekerIsland.totalSpots);snapshot.term.auctions.forEach(a=>signature(a.settlement.signature));
  }catch{throw new MiningTaxReceiptReaderError('INPUT');}
  need(pending<limit,'BUSY');pending++;
  const controller=new AbortController();let calls=0,finished=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(finished&&calls===0&&!released){released=true;pending--;}};const active=()=>need(!controller.signal.aborted,'TIMEOUT');
  async function call<T,R=T>(run:()=>Promise<T>,copy:(v:T)=>R=(v=>v as unknown as R)):Promise<R>{active();calls++;try{const v=await run();active();return copy(v);}finally{calls--;release();}}
  const work=async()=>{
   const raw=connect(controller.signal),p=trust.mining.programId,config=miningConfigPda(p),term=seekerTermPda(p,trust.seeker.config,input.round),registry=seekerRegistryPda(p),auction=seekerAuctionPda(p,trust.seeker.config,input.spot,input.round),pool=miningTermTaxPoolPda(p,term),cursor=miningTaxSpotCursorPda(p,pool,input.spot),ata=getAssociatedTokenAddressSync(trust.mining.keepMint,input.wallet),pd=new PublicKey(trust.seeker.deployment.programDataAddress);
   const common=[config,getAssociatedTokenAddressSync(trust.mining.keepMint,config,true),getAssociatedTokenAddressSync(trust.mining.keepMint,trust.mining.reserveOwner,true),trust.mining.keepMint,p,pd,seekerAuthorityPda(p),SYSVAR_CLOCK_PUBKEY];
   const capsByAddress=new Map<string,number>(common.map((a,i)=>[a.toBase58(),[MINING_ACCOUNT_BYTES.EconomyConfig,ACCOUNT_SIZE,ACCOUNT_SIZE,MINT_SIZE,36,MAX_PROGRAM_DATA,SEEKER_TERM_ACCOUNT_BYTES.SeekerAuthority,40][i]!]));
   capsByAddress.set(trust.seeker.config.toBase58(),SEEKER_TERM_ACCOUNT_BYTES.AuctionConfig);capsByAddress.set(registry.toBase58(),SEEKER_TERM_ACCOUNT_BYTES.SeekerRegistry);capsByAddress.set(term.toBase58(),SEEKER_TERM_ACCOUNT_BYTES.SeekerTerm);
   snapshot.term.auctions.forEach(a=>capsByAddress.set(a.terms.auction,SEEKER_TERM_ACCOUNT_BYTES.Auction));
   capsByAddress.set(pool.toBase58(),MINING_TAX_ACCOUNT_BYTES.MiningTaxPool);capsByAddress.set(cursor.toBase58(),MINING_TAX_ACCOUNT_BYTES.MiningTaxSpot);capsByAddress.set(ata.toBase58(),ACCOUNT_SIZE);
   const epochAddresses=snapshot.epochs.flatMap(e=>{const epoch=miningEpochPda(p,e.day),accrual=miningTaxEpochReceiptPda(p,epoch);capsByAddress.set(epoch.toBase58(),MINING_ACCOUNT_BYTES.MiningEpochReceipt);capsByAddress.set(accrual.toBase58(),MINING_TAX_ACCOUNT_BYTES.MiningTaxAccrual);return [epoch,accrual];});
   let provenanceClock=-1n;
   const rpc:MiningTaxReceiptReaderRpc={
    getGenesisHash:()=>call(()=>raw.getGenesisHash(),v=>{need(v===trust.mining.expectedGenesisHash,'IDENTITY');return v;}),getSlot:c=>call(()=>raw.getSlot(c),v=>{need(safe(v),'ACCOUNTS');return v;}),
    getMultipleAccountsInfoAndContext:async(keys,opts)=>{
     need(Array.isArray(keys)&&keys.length<=100,'ACCOUNTS');const addresses=keys.map(key);
     return call(()=>raw.getMultipleAccountsInfoAndContext(addresses.map(key),opts),r=>{
      need(r&&safe(r.context?.slot)&&Array.isArray(r.value)&&r.value.length===addresses.length,'ACCOUNTS');const slot=r.context.slot;
      const value=addresses.map((address,i)=>{const row=r.value[i];if(row===null)return null;const cap=capsByAddress.get(address.toBase58());need(row&&cap!==undefined&&row.data instanceof Uint8Array&&row.data.length<=cap&&typeof row.executable==='boolean','ACCOUNTS');const copy={...row,owner:key(row.owner),data:Buffer.from(row.data)};if(address.equals(SYSVAR_CLOCK_PUBKEY)&&copy.data.length===40){const time=copy.data.readBigInt64LE(32);if(time>provenanceClock)provenanceClock=time;}return copy;});return {context:{slot},value};
     });
    },
    // Complete exact original signature hints prevent incidental address history
    // and archive-block fallback from becoming an unbounded retry dependency.
    getSignaturesForAddress:async()=>{throw new MiningTaxReceiptReaderError('UNAVAILABLE');},getBlock:(async()=>{throw new MiningTaxReceiptReaderError('UNAVAILABLE');}) as SeekerTermRpc['getBlock'],
    getTransaction:((signature:string)=>call(()=>raw.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0}),tx=>copyTransaction(tx))) as SeekerTermRpc['getTransaction'],
   };
   const hints=new Map(snapshot.term.auctions.map(a=>[a.terms.spotId,a.settlement.signature]));
   const current=await readFinalizedHistoricalSeekerTerm(()=>rpc,{...trust.seeker,round:input.round},{settlementSignatures:hints,deadlineMs:timeout});active();
   need(current.deployment.deployedSlot===BigInt(trust.mining.reviewedDeploymentSlot)&&isDeepStrictEqual(immutableTerm(current),immutableTerm(snapshot.term)),'IDENTITY');
   const originalClock=provenanceClock;need(originalClock>=snapshot.chainClock.unixTimestamp,'ACCOUNTS');
   const transactions:VersionedTransactionResponse[]=[];
   for(const [i,wire] of signed.entries())transactions.push(await call(()=>raw.getTransaction(wire.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}),tx=>copyTransaction(tx,{signature:wire.signature,messageBytes:planned.transactions[i]!.messageBytes})));
   const before=await rpc.getSlot('finalized'),floor=Math.max(snapshot.slot,blockhashContextSlot,Number(current.finality.contextSlot),...transactions.map(tx=>tx.slot));need(before>=floor,'ACCOUNTS');
   const addresses=[...new Map([...common,trust.seeker.config,registry,term,auction,pool,cursor,ata,...epochAddresses].map(a=>[a.toBase58(),a])).values()];
   const response=await rpc.getMultipleAccountsInfoAndContext(addresses,{commitment:'finalized',minContextSlot:before});need(response.context.slot>=before,'ACCOUNTS');
   const rows:MiningRawAccount[]=response.value.flatMap((r,i)=>r?[{address:addresses[i]!,owner:r.owner,executable:r.executable,data:Buffer.from(r.data)}]:[]),clock=rows.find(r=>r.address.equals(SYSVAR_CLOCK_PUBKEY));need(clock&&clock.data.length===40&&Buffer.from(clock.data).readBigInt64LE(32)>=originalClock,'ACCOUNTS');
   need(await rpc.getSlot('finalized')>=response.context.slot,'ACCOUNTS');await rpc.getGenesisHash();active();
   const bank={commitment:'finalized' as const,genesisHash:trust.mining.expectedGenesisHash,slot:response.context.slot,accounts:rows};
   const evidence:MiningTaxReceiptEvidence[]=transactions.map((transaction,i)=>({commitment:'finalized',genesisHash:trust.mining.expectedGenesisHash,signedTransaction:signed[i]!.signedTransaction,transaction,bank}));
   const receipt=await verifyMiningTaxReceipt(trust.mining,{snapshot,plan:input,blockhashContextSlot,caps,evidence});active();
   return Object.freeze({...receipt,source:Object.freeze({...receipt.source,trust:'trusted-finalized-rpc-reviewed-program' as const,originalTermContextSlot:Number(current.finality.contextSlot),observedAccountSlot:bank.slot,observedClockUnixTimestamp:Buffer.from(clock.data).readBigInt64LE(32).toString()}),finalityAuthenticated:true as const,signingAuthorized:false as const,broadcastAuthorized:false as const,journalClearingAuthorized:false as const});
  };
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxReceiptReaderError('TIMEOUT'));},timeout);});
  const task=work().catch(error=>{if(error instanceof MiningTaxReceiptReaderError)throw error;if(error instanceof MiningTaxReceiptError)throw new MiningTaxReceiptReaderError(error.code);throw new MiningTaxReceiptReaderError(controller.signal.aborted?'TIMEOUT':'UNAVAILABLE');}).finally(()=>{finished=true;release();});
  try{return await Promise.race([task,deadline]);}finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}
export type MiningTaxFinalizedReceipt=Awaited<ReturnType<ReturnType<typeof createMiningTaxReceiptReader>>>;
