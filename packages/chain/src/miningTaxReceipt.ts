/** Pure historical KEEP-tax evidence checks. The caller must independently obtain
 * finalized transaction/bank evidence and the original reviewed term snapshot.
 * Matching supplied facts is not RPC authentication or journal-clearing authority. */
import {createHash} from 'node:crypto';
import type {Idl} from '@coral-xyz/anchor';
import { anchorRuntime as anchorPkg } from './anchorRuntime';
import {Message,PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY,type VersionedTransactionResponse,type CompiledInstruction} from '@solana/web3.js';
import {ACCOUNT_SIZE,AccountLayout,ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {TOKEN} from '@shardkeep/shared';
import bs58 from 'bs58';
import idl from './idl/shardkeep_economy.json' with {type:'json'};
import {buildMiningTaxMessages,type MiningTaxMessageInput,type MiningTaxCostCaps} from './miningTaxMessage';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
import {createMiningBackingSnapshotReader,type MiningBackingTrust} from './miningBackingSnapshot';
import {miningConfigPda,miningEpochPda,type MiningRawAccount} from './miningProgramProtocol';
import {decodeMiningTaxPool,decodeMiningTaxSpot,decodeMiningTaxAccrual,miningTermTaxPoolPda,miningTaxSpotCursorPda,miningTaxEpochReceiptPda,type MiningTaxTermIdentity} from './miningTaxProtocol';
import {seekerAuctionConfigPda,seekerAuctionPda,seekerRegistryPda} from './seekerAuctionProtocol';
import {SEEKER_TERM_ACCOUNT_BYTES,type VerifiedSeekerAuction} from './seekerTermAccounts';
import type {MiningTaxSnapshot} from './miningTaxSnapshot';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl),U64=(1n<<64n)-1n;
const TOKEN_ID=TOKEN_PROGRAM_ID.toBase58(),SYSTEM=SystemProgram.programId.toBase58(),ATA_PROGRAM=ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
type Code='INPUT'|'IDENTITY'|'TRANSACTION'|'EVENT'|'ACCOUNTS'|'PAYMENT'|'COST_CAP';
export class MiningTaxReceiptError extends Error{constructor(readonly code:Code){super(`Mining tax receipt refused: ${code}`);this.name='MiningTaxReceiptError';}}
function need(v:unknown,code:Code):asserts v{if(!v)throw new MiningTaxReceiptError(code);}
const uint=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function amount(v:unknown,code:Code='EVENT'):bigint{need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),code);const n=BigInt(v);need(n<=U64,code);return n;}
function exact(v:unknown,fields:string){need(v&&typeof v==='object'&&!Array.isArray(v),'INPUT');const keys=Reflect.ownKeys(v),names=fields.split(' ');need(keys.length===names.length&&keys.every(k=>typeof k==='string'&&names.includes(k)),'INPUT');}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export interface MiningTaxReceiptBank{readonly commitment:'finalized';readonly genesisHash:string;readonly slot:number;readonly accounts:readonly MiningRawAccount[]}
export interface MiningTaxReceiptEvidence{readonly commitment:'finalized';readonly genesisHash:string;readonly signedTransaction:Uint8Array;readonly transaction:VersionedTransactionResponse;readonly bank:MiningTaxReceiptBank}
export interface MiningTaxReceiptRequest{readonly snapshot:MiningTaxSnapshot;readonly plan:MiningTaxMessageInput;readonly blockhashContextSlot:number;readonly caps:MiningTaxCostCaps;/** Exact ordered prefix: setup alone never proves a payment. */readonly evidence:readonly MiningTaxReceiptEvidence[]}
const definitions=[['open_mining_tax_pool','MiningTaxPoolOpened',138],['accrue_mining_tax','MiningTaxAccrued',96],['open_mining_tax_spot','MiningTaxSpotOpened',105],['claim_mining_tax','MiningTaxClaimed',169]] as const;
function instructionName(bytes:Uint8Array){return definitions.find(([name])=>Buffer.from(idl.instructions.find(i=>i.name===name)!.discriminator).equals(Buffer.from(bytes)))?.[0];}
function originalAuction(raw:MiningRawAccount,program:PublicKey,original:VerifiedSeekerAuction){
 const t=original.terms,round=Buffer.alloc(8);round.writeBigUInt64LE(t.round);
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('auction'),new PublicKey(t.config).toBuffer(),Buffer.of(t.spotId),round],program);
 need(raw.address.equals(address)&&raw.owner.equals(program)&&!raw.executable&&raw.data.length===SEEKER_TERM_ACCOUNT_BYTES.Auction,'IDENTITY');
 const bytes=Buffer.from(raw.data);need(bytes.subarray(0,8).equals(Buffer.from(idl.accounts.find(a=>a.name==='Auction')!.discriminator)),'IDENTITY');
 const actual=coder.accounts.decode('Auction',bytes),num=(value:bigint)=>new BN(value.toString());
 // Every serialized field remains bound to the original finalized winner and
 // terms. Only outstanding_escrow is mutable after settlement (loser refunds).
 const expected={version:1,config:new PublicKey(t.config),term:new PublicKey(t.term),registry:new PublicKey(t.registry),spot:{id:t.spotId,class:t.class,realm_mask:t.realmMask},round:num(t.round),auction_start:num(t.auctionStart),auction_end:num(t.auctionEnd),operating_start:num(t.operatingStart),operating_end:num(t.operatingEnd),terms_hash:Buffer.from(original.termsHash,'hex'),vault:new PublicKey(t.vault),high_bid:num(original.highBid),high_bidder:new PublicKey(original.winner!),outstanding_escrow:actual.outstanding_escrow,settled:true,result_owner:new PublicKey(original.winner!),settled_at:num(original.settledAt),settled_slot:num(original.settledSlot),bump};
 need(coder.types.encode('Auction',expected).equals(bytes.subarray(8)),'IDENTITY');
}
type Event={name:string;data:Record<string,unknown>};
function events(logs:unknown,message:Message,program:string):Map<number,Event>{
 need(Array.isArray(logs)&&logs.length<=512&&logs.every(x=>typeof x==='string'&&x.length<=2048)&&logs.reduce((n,s)=>n+s.length,0)<=65536,'EVENT');
 const stack:string[]=[],out=new Map<number,Event>();let top=-1;
 for(const log of logs as string[]){
  const invoke=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[([1-4])\]$/.exec(log);
  if(invoke){need(Number(invoke[2])===stack.length+1,'EVENT');if(stack.length===0){top++;need(top<message.instructions.length&&message.accountKeys[message.instructions[top]!.programIdIndex]!.toBase58()===invoke[1],'EVENT');}stack.push(invoke[1]!);continue;}
  const success=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) success$/.exec(log);
  if(success){need(stack.pop()===success[1],'EVENT');continue;}
  need(!/^Program \S+ (?:failed:|invoke |success)/.test(log)&&log!=='Log truncated','EVENT');
  if(log.startsWith('Program data: ')){
   // Events are authority only inside this exact top-level reviewed instruction.
   need(stack.length===1&&stack[0]===program&&!out.has(top),'EVENT');
   const encoded=log.slice(14);need(encoded.length<=256&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded),'EVENT');const raw=Buffer.from(encoded,'base64');need(raw.toString('base64')===encoded,'EVENT');
   const found=definitions.find(([,name,size])=>raw.length===size&&raw.subarray(0,8).equals(Buffer.from(idl.events.find(e=>e.name===name)!.discriminator)));need(found,'EVENT');
   const event=coder.events.decode(encoded);need(event&&event.name===found[1]&&coder.types.encode(event.name,event.data).equals(raw.subarray(8)),'EVENT');out.set(top,{name:event.name,data:event.data});
  }
 }
 need(stack.length===0&&top===message.instructions.length-1,'EVENT');return out;
}
/** Validate an ordered evidence prefix, retaining durable original-term rights.
 * All arguments are ordinary checked facts, not fabricated branded capabilities. */
export async function verifyMiningTaxReceipt(inputTrust:MiningBackingTrust,request:MiningTaxReceiptRequest){
 try{
  exact(request,'snapshot plan blockhashContextSlot caps evidence');exact(request.caps,'maxFeeLamports maxRentLamports maxTotalLamports');
  const trust={...inputTrust,programId:new PublicKey(inputTrust.programId.toBytes()),keepMint:new PublicKey(inputTrust.keepMint.toBytes()),reserveOwner:new PublicKey(inputTrust.reserveOwner.toBytes())};
  const snapshot=structuredClone(request.snapshot),input={...request.plan,wallet:new PublicKey(request.plan.wallet.toBytes())},plan=buildMiningTaxMessages(trust,snapshot,input),caps={...request.caps};
  // The quote rechecks account facts after measuring its blockhash and fees.
  // Both observations constrain the transaction; neither rewrites the other.
  need(uint(request.blockhashContextSlot)&&request.blockhashContextSlot>=trust.reviewedDeploymentSlot,'INPUT');const floor=Math.max(snapshot.slot,request.blockhashContextSlot);
  for(const v of Object.values(caps))need(typeof v==='bigint'&&v>=0n&&v<=U64,'INPUT');
  need(Array.isArray(request.evidence)&&request.evidence.length>0&&request.evidence.length<=plan.transactions.length,'INPUT');
  const program=trust.programId.toBase58(),mint=trust.keepMint.toBase58(),config=miningConfigPda(trust.programId),poolKey=miningTermTaxPoolPda(trust.programId,new PublicKey(plan.term)),cursorKey=miningTaxSpotCursorPda(trust.programId,poolKey,plan.spot),auctionConfig=seekerAuctionConfigPda(trust.programId),registry=seekerRegistryPda(trust.programId),auction=seekerAuctionPda(trust.programId,auctionConfig,plan.spot,plan.round),ata=getAssociatedTokenAddressSync(trust.keepMint,input.wallet),vault=getAssociatedTokenAddressSync(trust.keepMint,config,true);
  const term:MiningTaxTermIdentity={programId:trust.programId,config,keepMint:trust.keepMint,auctionConfig,term:new PublicKey(plan.term),registry,registryHash:Buffer.from(snapshot.term.registryHash,'hex'),round:plan.round,auctionStart:snapshot.term.auctionStart,auctionEnd:snapshot.term.auctionEnd,operatingStart:snapshot.term.operatingStart,operatingEnd:snapshot.term.operatingEnd,winnerCount:snapshot.term.winnerCount};
  const common=[config,vault,getAssociatedTokenAddressSync(trust.keepMint,trust.reserveOwner,true),trust.keepMint,trust.programId,PublicKey.findProgramAddressSync([trust.programId.toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0],PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')],trust.programId)[0],SYSVAR_CLOCK_PUBKEY];
  const immutable=[auctionConfig,registry,term.term,auction],expected=[...common,...immutable,poolKey,cursorKey,ata,...snapshot.epochs.flatMap(e=>{const epoch=miningEpochPda(trust.programId,e.day);return [epoch,miningTaxEpochReceiptPda(trust.programId,epoch)];})],allowed=new Set(expected.map(a=>a.toBase58()));
  // Normalize all caller-owned bytes and metadata before the first await.
  const evidence=request.evidence.map((e,n)=>{
   exact(e,'commitment genesisHash signedTransaction transaction bank');exact(e.bank,'commitment genesisHash slot accounts');need(e.commitment==='finalized'&&e.bank.commitment==='finalized'&&e.genesisHash===trust.expectedGenesisHash&&e.bank.genesisHash===trust.expectedGenesisHash,'IDENTITY');
   const selected=plan.transactions[n]!,signed=verifyMiningClaimSignedWire({intentBytes:selected.messageBytes,signedTransaction:e.signedTransaction,wallet:input.wallet}),tx=e.transaction,meta=tx?.meta,rpc=tx?.transaction?.message;
   need(meta&&meta.err===null&&uint(tx.slot)&&tx.slot>=floor&&tx.slot>trust.reviewedDeploymentSlot&&uint(tx.blockTime)&&BigInt(tx.blockTime)>=snapshot.chainClock.unixTimestamp,'TRANSACTION');
   need(rpc?.version==='legacy'&&(tx.version===undefined||tx.version==='legacy')&&Array.isArray(rpc.accountKeys)&&rpc.accountKeys.length<=40&&Array.isArray(rpc.instructions)&&rpc.instructions.length===Message.from(selected.messageBytes).instructions.length&&typeof rpc.recentBlockhash==='string'&&rpc.recentBlockhash.length<=44,'TRANSACTION');
   for(const ix of rpc.instructions)need(ix&&typeof ix.data==='string'&&ix.data.length<=1683&&Array.isArray(ix.accounts)&&ix.accounts.length<=40&&ix.accounts.every((i:number)=>uint(i)&&i<rpc.accountKeys.length)&&uint(ix.programIdIndex)&&ix.programIdIndex<rpc.accountKeys.length,'TRANSACTION');
   need(Buffer.from(rpc.serialize()).equals(Buffer.from(selected.messageBytes))&&Array.isArray(tx.transaction.signatures)&&tx.transaction.signatures.length===1&&tx.transaction.signatures[0]===signed.signature,'TRANSACTION');
   const message=Message.from(selected.messageBytes),keys=message.accountKeys.map(a=>a.toBase58()),at=(i:number)=>{need(uint(i)&&i<keys.length,'TRANSACTION');return keys[i]!;};
   need(!meta.loadedAddresses||(meta.loadedAddresses.writable.length===0&&meta.loadedAddresses.readonly.length===0),'TRANSACTION');
   need(uint(meta.fee)&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===keys.length&&meta.postBalances.length===keys.length&&meta.preBalances.every(uint)&&meta.postBalances.every(uint),'TRANSACTION');
   const balances=(which:'preTokenBalances'|'postTokenBalances')=>{const rows=meta[which];need(Array.isArray(rows)&&rows.length<=2,'PAYMENT');const out=new Map<string,{owner:string;amount:bigint}>();for(const b of rows){const a=at(b.accountIndex);need(!out.has(a)&&b.mint===mint&&b.programId===TOKEN_ID&&b.uiTokenAmount?.decimals===TOKEN.decimals&&typeof b.owner==='string','PAYMENT');out.set(a,{owner:b.owner,amount:amount(b.uiTokenAmount.amount,'PAYMENT')});}return out;};
   need(Array.isArray(meta.innerInstructions)&&meta.innerInstructions.length<=message.instructions.length,'TRANSACTION');const groups=new Set<number>();let count=0;
   const inner=(meta.innerInstructions as {index:number;instructions:CompiledInstruction[]}[]).map(g=>{need(uint(g.index)&&g.index<message.instructions.length&&!groups.has(g.index)&&Array.isArray(g.instructions)&&count+g.instructions.length<=80,'TRANSACTION');groups.add(g.index);count+=g.instructions.length;return {index:g.index,instructions:g.instructions.map(ix=>{need(typeof ix.data==='string'&&ix.data.length<=700&&Array.isArray(ix.accounts)&&ix.accounts.length<=40&&(ix as typeof ix&{stackHeight?:unknown}).stackHeight===2,'TRANSACTION');const data=bs58.decode(ix.data);need(data.length<=512&&bs58.encode(data)===ix.data,'TRANSACTION');return {program:at(ix.programIdIndex),accounts:ix.accounts.map(at),data:Buffer.from(data)};})};});
   need(uint(e.bank.slot)&&e.bank.slot>=tx.slot&&Array.isArray(e.bank.accounts)&&e.bank.accounts.length<=expected.length,'ACCOUNTS');const rows=new Map<string,MiningRawAccount>();
   for(const r of e.bank.accounts){exact(r,'address owner executable data');const a=r.address.toBase58();need(allowed.has(a)&&!rows.has(a)&&typeof r.executable==='boolean'&&r.data instanceof Uint8Array&&r.data.length<=(a===common[5]!.toBase58()?8*1024*1024:4096),'ACCOUNTS');rows.set(a,{address:new PublicKey(r.address.toBytes()),owner:new PublicKey(r.owner.toBytes()),executable:r.executable,data:Buffer.from(r.data)});}
   return {selected,signed,message,keys,slot:tx.slot,blockTime:tx.blockTime,fee:BigInt(meta.fee),preLamports:(meta.preBalances as number[]).map(n=>BigInt(n)),postLamports:(meta.postBalances as number[]).map(n=>BigInt(n)),pre:balances('preTokenBalances'),post:balances('postTokenBalances'),inner,events:events(meta.logMessages,message,program),bankSlot:e.bank.slot,rows};
  });
  let fees=0n,rents=0n,paid=0n,previousSlot=0,previousBank=0,previousClock=snapshot.chainClock.unixTimestamp;
  let priorAccrued=snapshot.pool?.accrued??0n,priorPoolPaid=snapshot.pool?.paid??0n,priorTaxPaid=snapshot.backing.config.taxPaid,priorClaimed=snapshot.cursor?.claimedTotal??0n;
  let observedAccrued=priorAccrued,observedPoolPaid=priorPoolPaid,observedTaxPaid=priorTaxPaid,observedClaimed=priorClaimed;
  const observations=[];
  for(const e of evidence){
   need(e.slot>=previousSlot&&e.bankSlot>=previousBank,'TRANSACTION');previousSlot=e.slot;previousBank=e.bankSlot;
   const at=(i:number)=>e.keys[i]!,get=(a:PublicKey)=>{const r=e.rows.get(a.toBase58());need(r,'ACCOUNTS');return r;};
   const backing=await createMiningBackingSnapshotReader({getGenesisHash:async()=>trust.expectedGenesisHash,getSlot:async()=>e.bankSlot,getMultipleAccountsInfoAndContext:async keys=>({context:{slot:e.bankSlot},value:keys.map(get)})},trust)();
   need(backing.unixTimestamp>=previousClock&&backing.unixTimestamp>=BigInt(e.blockTime)&&backing.config.taxHighwater>=snapshot.backing.config.taxHighwater&&backing.config.taxPaid>=observedTaxPaid&&backing.config.totalPublishedHighwater>=snapshot.backing.config.totalPublishedHighwater&&backing.config.totalClaimed>=snapshot.backing.config.totalClaimed,'ACCOUNTS');previousClock=backing.unixTimestamp;
   for(const a of immutable){const raw=get(a);if(a.equals(auction)){originalAuction(raw,trust.programId,snapshot.term.auctions[plan.spot]!);continue;}const before=snapshot.source.accounts.find(r=>r.address===a.toBase58());need(before&&before.exists&&raw.owner.toBase58()===before.owner&&raw.executable===before.executable&&hash(raw.data)===before.dataSha256,'IDENTITY');}
   const tm=coder.accounts.decode('SeekerTerm',Buffer.from(get(term.term).data));
   for(const [name,value] of [['round',term.round],['auction_start',term.auctionStart],['auction_end',term.auctionEnd],['operating_start',term.operatingStart],['operating_end',term.operatingEnd],['completed_at',snapshot.term.completedAt],['completed_slot',snapshot.term.completedSlot]] as const)need(tm[name]!==null&&BigInt(tm[name].toString())===value,'IDENTITY');
   need(tm.winner_count===term.winnerCount&&Buffer.from(tm.registry_hash).equals(Buffer.from(term.registryHash)),'IDENTITY');
   const context={identity:{programId:trust.programId,keepMint:trust.keepMint,reserveOwner:trust.reserveOwner},term,config:get(config)},pool=decodeMiningTaxPool(get(poolKey),context),cursor=decodeMiningTaxSpot(get(cursorKey),{...context,pool:get(poolKey),spot:plan.spot,winner:input.wallet});
   need(pool.accrued>=observedAccrued&&pool.paid>=observedPoolPaid&&cursor.claimedTotal>=observedClaimed&&pool.paid<=pool.accrued/BigInt(pool.winnerCount)*BigInt(pool.winnerCount),'ACCOUNTS');
   let recorded=0n;const accruals=new Map<bigint,ReturnType<typeof decodeMiningTaxAccrual>>();
   for(const row of snapshot.epochs){const epoch=miningEpochPda(trust.programId,row.day),receipt=miningTaxEpochReceiptPda(trust.programId,epoch),raw=e.rows.get(epoch.toBase58()),r=e.rows.get(receipt.toBase58());
    if(row.epoch){const before=snapshot.source.accounts.find(a=>a.address===epoch.toBase58());need(raw&&before?.exists&&hash(raw.data)===before.dataSha256,'ACCOUNTS');}
    if(r){need(raw,'ACCOUNTS');const a=decodeMiningTaxAccrual(r,{...context,pool:get(poolKey),epoch:raw,day:row.day});need(a.accruedAt<=backing.unixTimestamp,'ACCOUNTS');recorded+=a.amount;accruals.set(row.day,a);}
    if(row.accrual||plan.accrualDays.includes(row.day))need(r,'ACCOUNTS');
   }
   need(recorded===pool.accrued,'ACCOUNTS');
   const rentByAddress=new Map<string,bigint>(),newAccounts=new Map(e.selected.expectedNewAccounts.map(a=>[a.address,a]));let rent=0n;
   e.keys.forEach((a,i)=>{if(i===0)return;const delta=e.postLamports[i]!-e.preLamports[i]!;if(newAccounts.has(a)){need(delta>=0n,'PAYMENT');rentByAddress.set(a,delta);rent+=delta;}else need(delta===0n,'PAYMENT');});
   need(e.preLamports[0]!-e.postLamports[0]! ===e.fee+rent,'PAYMENT');fees+=e.fee;rents+=rent;need(fees<=caps.maxFeeLamports&&rents<=caps.maxRentLamports&&fees+rents<=caps.maxTotalLamports&&fees+rents<=U64,'COST_CAP');
   const isSetup=e.selected.kind==='setup',expectedTokens=isSetup?(newAccounts.has(ata.toBase58())?[ata.toBase58()]:[]):[vault.toBase58(),ata.toBase58()];
   need(e.post.size===expectedTokens.length&&[...e.post.keys(),...e.pre.keys()].every(a=>expectedTokens.includes(a)),'PAYMENT');
   for(const [a,b] of [...e.pre,...e.post])need(b.owner===(a===vault.toBase58()?config.toBase58():plan.wallet),'PAYMENT');
   let payment=0n;
   if(!isSetup){need(e.pre.has(vault.toBase58())&&e.post.has(vault.toBase58())&&e.post.has(ata.toBase58()),'PAYMENT');payment=e.pre.get(vault.toBase58())!.amount-e.post.get(vault.toBase58())!.amount;need(payment>0n&&e.post.get(ata.toBase58())!.amount-(e.pre.get(ata.toBase58())?.amount??0n)===payment,'PAYMENT');}
   else if(expectedTokens.length)need(e.post.get(ata.toBase58())!.amount===(e.pre.get(ata.toBase58())?.amount??0n),'PAYMENT');
   // No pre-token row means uninitialized, not necessarily zero lamports: anyone
   // may dust this PDA. Exact create or transfer/allocate/assign/initialize CPI
   // evidence below still proves initialization and the claimant's actual rent.
   if(expectedTokens.includes(ata.toBase58())&&!e.pre.has(ata.toBase58()))need(newAccounts.has(ata.toBase58()),'PAYMENT');
   let transferCount=0,seenEvents=0,claimedEvent:Record<string,unknown>|undefined,accruedEvent:bigint|undefined;
   for(const [ixIndex,ix] of e.message.instructions.entries()){
    const top=at(ix.programIdIndex),name=top===program?instructionName(bs58.decode(ix.data)):undefined,event=e.events.get(ixIndex),inners=e.inner.find(g=>g.index===ixIndex)?.instructions??[];
    let target:string|undefined,owner=program,space=0;
    if(top===ATA_PROGRAM){target=ata.toBase58();owner=TOKEN_ID;space=ACCOUNT_SIZE;need(!event,'EVENT');}
    else{
     need(name&&event&&event.name===definitions.find(d=>d[0]===name)![1],'EVENT');seenEvents++;const d=event.data,pk=(name:string,value:string)=>need(d[name] instanceof PublicKey&&(d[name] as PublicKey).toBase58()===value,'EVENT');pk('pool',poolKey.toBase58());
     if(name==='open_mining_tax_pool'){pk('config',config.toBase58());pk('term',plan.term);need(Buffer.from(d.term_identity as number[]).toString('hex')===pool.termIdentity&&d.winner_count===pool.winnerCount&&d.distribution_version===1,'EVENT');target=poolKey.toBase58();}
     if(name==='open_mining_tax_spot'){pk('auction',auction.toBase58());pk('wallet',plan.wallet);need(d.spot===plan.spot,'EVENT');target=cursorKey.toBase58();}
     if(name==='accrue_mining_tax'){const day=amount(String(d.day)),a=accruals.get(day),total=amount(String(d.accrued));need(plan.accrualDays.includes(day)&&a&&a.amount===amount(String(d.amount))&&total<=pool.accrued&&(accruedEvent===undefined?(snapshot.pool===null?total===a.amount:total>=priorAccrued+a.amount):total===accruedEvent+a.amount),'EVENT');pk('epoch',a.epoch);need(ix.accounts.some(i=>at(i)===a.epoch),'EVENT');accruedEvent=total;target=a.address;}
     if(name==='claim_mining_tax'){
      pk('term',plan.term);pk('auction',auction.toBase58());pk('wallet',plan.wallet);need(d.spot===plan.spot&&amount(String(d.amount))===payment,'EVENT');
      const cumulative=amount(String(d.cumulative)),poolPaid=amount(String(d.pool_paid)),taxPaid=amount(String(d.total_tax_paid));
      need(cumulative>=plan.cumulativeBaseUnits&&cumulative<=pool.accrued/BigInt(pool.winnerCount)&&payment<=cumulative-priorClaimed&&poolPaid>=priorPoolPaid+payment&&poolPaid<=pool.paid&&taxPaid>=priorTaxPaid+payment&&taxPaid<=backing.config.taxPaid&&cursor.claimedTotal>=cumulative,'EVENT');
      if(!snapshot.cursor&&e.selected.kind==='combined')need(cumulative===payment,'EVENT');
      if(accruedEvent!==undefined)need(cumulative===accruedEvent/BigInt(pool.winnerCount),'EVENT');
      if(e.bankSlot===e.slot)need(cursor.claimedTotal===cumulative&&pool.paid===poolPaid&&backing.config.taxPaid===taxPaid,'ACCOUNTS');claimedEvent=d;
     }
     if(target){const account=newAccounts.get(target);need(account,'ACCOUNTS');space=account.space;}
    }
    let moved=0n,created=false,allocated=false,assigned=false,initialized=false;
    for(const inner of inners){
     if(name==='claim_mining_tax'){need(inner.program===TOKEN_ID&&++transferCount===1&&inner.accounts.join(',')===[vault.toBase58(),mint,ata.toBase58(),config.toBase58()].join(',')&&inner.data.length===10&&inner.data[0]===12&&inner.data.readBigUInt64LE(1)===payment&&inner.data[9]===TOKEN.decimals,'PAYMENT');continue;}
     if(inner.program===SYSTEM){need(target&&inner.data.length>=4,'PAYMENT');const tag=inner.data.readUInt32LE(0);
      if(tag===0){need(!created&&!allocated&&!assigned&&!initialized&&inner.accounts.join(',')===[plan.wallet,target].join(',')&&inner.data.length===52&&inner.data.readBigUInt64LE(12)===BigInt(space)&&new PublicKey(inner.data.subarray(20)).toBase58()===owner&&e.preLamports[e.keys.indexOf(target)]===0n,'PAYMENT');created=true;moved+=inner.data.readBigUInt64LE(4);}
      else if(tag===2){need(!created&&!allocated&&!assigned&&!initialized&&inner.accounts.join(',')===[plan.wallet,target].join(',')&&inner.data.length===12,'PAYMENT');moved+=inner.data.readBigUInt64LE(4);}
      else if(tag===8){need(!created&&!allocated&&!assigned&&!initialized&&inner.accounts.join(',')===target&&inner.data.length===12&&inner.data.readBigUInt64LE(4)===BigInt(space),'PAYMENT');allocated=true;}
      else if(tag===1){need(!created&&allocated&&!assigned&&!initialized&&inner.accounts.join(',')===target&&inner.data.length===36&&new PublicKey(inner.data.subarray(4)).toBase58()===owner,'PAYMENT');assigned=true;}
      else need(false,'PAYMENT');
     }else{need(top===ATA_PROGRAM&&inner.program===TOKEN_ID,'PAYMENT');const tag=inner.data[0];
      if(tag===21)need(inner.accounts.join(',')===mint&&(inner.data.length===1||inner.data.length===3&&inner.data.readUInt16LE(1)===7),'PAYMENT');
      else if(tag===22)need(inner.accounts.join(',')===ata.toBase58()&&inner.data.length===1,'PAYMENT');
      else {need(tag===18&&!initialized&&(created||allocated&&assigned)&&inner.accounts.join(',')===[ata.toBase58(),mint].join(',')&&inner.data.length===33&&inner.data.subarray(1).equals(input.wallet.toBuffer()),'PAYMENT');initialized=true;}
     }
    }
    if(target){need(moved===(rentByAddress.get(target)??0n),'PAYMENT');if(top===program||!e.pre.has(ata.toBase58()))need(created||allocated&&assigned,'PAYMENT');if(top===ATA_PROGRAM&&(created||allocated))need(initialized,'PAYMENT');}
   }
   need(seenEvents===e.events.size&&transferCount===(isSetup?0:1)&&Boolean(claimedEvent)===!isSetup,'PAYMENT');
   // Same-slot token rows must reconcile exactly. Later balances/ATA closure do
   // not erase a payment proven by historical CPI + permanent high-water cursors.
   if(e.bankSlot===e.slot){need(backing.vaultAmount===(isSetup?backing.vaultAmount:e.post.get(vault.toBase58())!.amount),'PAYMENT');const raw=get(ata);need(raw.owner.equals(TOKEN_PROGRAM_ID)&&!raw.executable&&raw.data.length===ACCOUNT_SIZE,'PAYMENT');const t=AccountLayout.decode(Buffer.from(raw.data));need(t.owner.equals(input.wallet)&&t.mint.equals(trust.keepMint)&&t.state===1&&t.delegateOption===0&&t.delegatedAmount===0n&&t.closeAuthorityOption===0&&t.isNativeOption===0,'PAYMENT');if(e.post.has(ata.toBase58()))need(t.amount===e.post.get(ata.toBase58())!.amount,'PAYMENT');if(!ata.equals(common[2]!))need(backing.vaultAmount+backing.reserveAmount+t.amount<=backing.mintSupply,'PAYMENT');if(isSetup&&!snapshot.cursor)need(cursor.claimedTotal===0n,'ACCOUNTS');}
   paid+=payment;observedAccrued=pool.accrued;observedPoolPaid=pool.paid;observedTaxPaid=backing.config.taxPaid;observedClaimed=cursor.claimedTotal;
   // Observed later totals are not this transaction's pre-state. Only scoped
   // events advance the execution floors used to verify the following split item.
   priorAccrued=accruedEvent??priorAccrued;if(claimedEvent){priorPoolPaid=amount(String(claimedEvent.pool_paid));priorTaxPaid=amount(String(claimedEvent.total_tax_paid));priorClaimed=amount(String(claimedEvent.cumulative));}
   observations.push(Object.freeze({kind:e.selected.kind,signature:e.signed.signature,slot:e.slot,blockTime:e.blockTime,observedAccountSlot:e.bankSlot,messageSha256:e.signed.messageSha256,signedTransactionSha256:e.signed.wireSha256,paidKeepBaseUnits:payment.toString(),feeLamports:e.fee.toString(),rentLamports:rent.toString(),currentPoolAccrued:pool.accrued.toString(),currentPoolPaid:pool.paid.toString(),currentClaimedTotal:cursor.claimedTotal.toString(),currentGlobalTaxPaid:backing.config.taxPaid.toString(),claimedCumulativeBaseUnits:claimedEvent?String(claimedEvent.cumulative):null,poolPaidAfterClaimBaseUnits:claimedEvent?String(claimedEvent.pool_paid):null,globalTaxPaidAfterClaimBaseUnits:claimedEvent?String(claimedEvent.total_tax_paid):null}));
  }
  return Object.freeze({version:1 as const,phase:evidence.length===plan.transactions.length?'settled' as const:'setup' as const,wallet:plan.wallet,round:plan.round.toString(),spot:plan.spot,term:plan.term,pool:poolKey.toBase58(),cursor:cursorKey.toBase58(),paidKeepBaseUnits:paid.toString(),feeLamports:fees.toString(),rentLamports:rents.toString(),transactions:Object.freeze(observations),source:Object.freeze({trust:'supplied-finalized-evidence' as const,genesisHash:trust.expectedGenesisHash,programId:program,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256}),finalityAuthenticated:false as const,currentClaimsAuthorized:false as const,journalClearingAuthorized:false as const});
 }catch(error){if(error instanceof MiningTaxReceiptError)throw error;throw new MiningTaxReceiptError('INPUT');}
}
export type MiningTaxReceipt=Awaited<ReturnType<typeof verifyMiningTaxReceipt>>;
