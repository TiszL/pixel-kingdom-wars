/** Actual generated IDL/SPL accounts and signed settlement/tax bodies behind a
 * bounded injected RPC. No deployment, live signing, network or DB authority. */
import {createHash,randomBytes} from 'node:crypto';
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import {Keypair,PublicKey,Ed25519Program,TransactionMessage,VersionedTransaction,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,SYSVAR_CLOCK_PUBKEY,type VersionedTransactionResponse} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import bs58 from 'bs58';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import {createMiningTaxReceiptFixture} from './miningTaxReceipt';
import type {MiningTaxReceiptReaderRpc,MiningTaxReceiptReaderRequest} from '../miningTaxReceiptReader';
import {encodeSeekerActionPermit,hashSettleSeekerAuctionPayload,hashSeekerAuctionTerms,seekerAuthorityPda,seekerBidPda,seekerPermitReceiptPda,type SeekerAuctionTerms} from '../seekerAuctionProtocol';
import {hashMiningTermTaxIdentity,hashMiningTaxCommitment} from '../miningTaxProtocol';
import {readFinalizedHistoricalSeekerTerm,type SeekerTermRpc} from '../seekerTerms';
import {SEEKER_TERM_ACCOUNT_BYTES} from '../seekerTermAccounts';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl),hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
export async function createMiningTaxReceiptReaderFixture(kind:'claim'|'combined'|'split'='claim',options:{advancingQuote?:boolean;genesisHash?:PublicKey}={}){
 const fixture=await createMiningTaxReceiptFixture(kind,options),{state}=fixture;
 let snapshot=fixture.snapshot;const hints=new Map<number,string>();
 if(kind==='split'){
  // A full seven-day eligible term requires native-permit settlement at the
  // operating boundary. Replace the pure fixture's calendar stress facts with
  // canonical accounts plus100 actual signed native-verifier permit messages.
  const cfg=state.store.get(state.term.auctionConfig.toBase58())!,config=coder.accounts.decode('AuctionConfig',cfg.data),policy=Keypair.generate(),settler=Keypair.generate(),start=state.term.operatingStart;
  state.term.auctionStart=start-BigInt(config.auction_sec.toString());config.first_operating_start=new BN(start.toString());cfg.data=await coder.accounts.encode('AuctionConfig',config);
  const termRow=state.store.get(state.term.term.toBase58())!,term=coder.accounts.decode('SeekerTerm',termRow.data);term.auction_start=new BN(state.term.auctionStart.toString());termRow.data=Buffer.alloc(SEEKER_TERM_ACCOUNT_BYTES.SeekerTerm);(await coder.accounts.encode('SeekerTerm',term)).copy(termRow.data);
  const authRow=state.store.get(seekerAuthorityPda(state.term.programId).toBase58())!,auth=coder.accounts.decode('SeekerAuthority',authRow.data);auth.current_policy_key=policy.publicKey;const authBytes=await coder.accounts.encode('SeekerAuthority',auth);authBytes.copy(authRow.data);
  state.seeker.bodies.clear();const layout=idl.instructions.find(i=>i.name==='settle_auction_with_permit')!;
  for(const original of snapshot.term.auctions){
   const strings={...original.terms,auctionStart:state.term.auctionStart,auctionEnd:start,operatingStart:start,operatingEnd:state.term.operatingEnd};
   const terms={...strings,registryHash:Buffer.from(strings.registryHash,'hex')} as unknown as {-readonly [K in keyof SeekerAuctionTerms]:SeekerAuctionTerms[K]};
   for(const field of ['config','term','auction','registry','mint','tokenProgram','vault','prizeOwner','prizeAta'] as const)terms[field]=new PublicKey(strings[field]);
   const termsHash=hashSeekerAuctionTerms(terms),row=state.store.get(strings.auction)!,auction=coder.accounts.decode('Auction',row.data);
   Object.assign(auction,{auction_start:new BN(terms.auctionStart.toString()),auction_end:new BN(start.toString()),operating_start:new BN(start.toString()),operating_end:new BN(terms.operatingEnd.toString()),terms_hash:[...termsHash],settled_at:new BN(start.toString())});row.data=Buffer.alloc(SEEKER_TERM_ACCOUNT_BYTES.Auction);(await coder.accounts.encode('Auction',auction)).copy(row.data);
   const winner=original.winner?new PublicKey(original.winner):null,id=randomBytes(16),expiry=start+BigInt(PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec),permit=encodeSeekerActionPermit({genesisHash:state.seeker.policy.genesisHash,programId:state.term.programId,kind:8,permitId:id,wallet:settler.publicKey,expiry,payloadHash:hashSettleSeekerAuctionPayload({auction:terms.auction,config:terms.config,term:terms.term,termsHash,highBid:original.highBid,highBidder:winner})});
   const data=Buffer.alloc(34);Buffer.from(layout.discriminator).copy(data);id.copy(data,8);data.writeBigInt64LE(expiry,24);data.writeUInt16LE(0,32);
   const accounts=[settler.publicKey,terms.config,terms.term,terms.auction,terms.mint,terms.vault,terms.prizeAta,winner?seekerBidPda(state.term.programId,terms.auction,winner):state.term.programId,TOKEN_PROGRAM_ID,seekerAuthorityPda(state.term.programId),seekerPermitReceiptPda(state.term.programId,id),SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId];
   const message=new TransactionMessage({payerKey:settler.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[Ed25519Program.createInstructionWithPrivateKey({privateKey:policy.secretKey,message:permit}),{programId:state.term.programId,data,keys:accounts.map((pubkey,i)=>({pubkey,isSigner:'signer' in layout.accounts[i]!&&layout.accounts[i]!.signer,isWritable:(i!==7||winner!==null)&&'writable' in layout.accounts[i]!&&layout.accounts[i]!.writable}))}]}).compileToLegacyMessage(),signed=new VersionedTransaction(message);signed.sign([settler]);
   const signature=bs58.encode(signed.signatures[0]!);hints.set(strings.spotId,signature);state.seeker.bodies.set(signature,{slot:Number(original.settledSlot),blockTime:Number(start),version:'legacy',transaction:{message,signatures:[signature]},meta:{err:null,fee:5,preBalances:[],postBalances:[]}});
  }
  const pool=state.store.get(state.addresses.pool.toBase58())!,poolData=coder.accounts.decode('MiningTaxPool',pool.data);poolData.term_identity=[...hashMiningTermTaxIdentity(state.term)];pool.data=await coder.accounts.encode('MiningTaxPool',poolData);
  const epochs=snapshot.epochs.map(e=>{const row=state.store.get(e.epoch!.address)!,data=coder.accounts.decode('MiningEpochReceipt',row.data),commitment=hashMiningTaxCommitment(state.term,{day:e.day,epoch:new PublicKey(e.epoch!.address)});data.tax_commitment=[...commitment];return {row,data,value:{...e,epoch:{...e.epoch!,taxCommitment:Buffer.from(commitment).toString('hex')}}};});
  for(const e of epochs)e.row.data=await coder.accounts.encode('MiningEpochReceipt',e.data);
  for(const tx of fixture.txs){const logs=tx.meta!.logMessages!;for(const [i,line] of logs.entries())if(line.startsWith('Program data: ')){const event=coder.events.decode(line.slice(14));if(event?.name==='MiningTaxPoolOpened'){event.data.term_identity=poolData.term_identity;logs[i]=`Program data: ${Buffer.concat([Buffer.from(idl.events.find(e=>e.name===event.name)!.discriminator),coder.types.encode(event.name,event.data)]).toString('base64')}`;}}}
  const changed=new Set([state.term.auctionConfig.toBase58(),state.term.term.toBase58(),...snapshot.term.auctions.map(a=>a.terms.auction),...epochs.map(e=>e.value.epoch.address)]);
  snapshot={...snapshot,epochs:epochs.map(e=>e.value),source:{...snapshot.source,accounts:snapshot.source.accounts.map(a=>a.exists&&changed.has(a.address)?{...a,dataSha256:hash(state.store.get(a.address)!.data)}:a)}};
 }
 let slot=Math.max(2003,fixture.txs.at(-1)!.slot+1);const clock=state.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data;clock.writeBigUInt64LE(BigInt(slot),0);clock.writeBigInt64LE(BigInt(fixture.txs.at(-1)!.blockTime!)+1n,32);
 const transactions=new Map<string,VersionedTransactionResponse|null>([...state.seeker.bodies,...fixture.txs.map(tx=>[tx.transaction.signatures[0]!,tx] as const)]),calls={history:0,blocks:0,transactions:[] as string[],banks:[] as {addresses:PublicKey[];floor:number}[],slots:0,genesis:0},signals:AbortSignal[]=[];
 const rpc:MiningTaxReceiptReaderRpc={
  getGenesisHash:async()=>{calls.genesis++;return state.trust.mining.expectedGenesisHash;},
  getSlot:async()=>{calls.slots++;return slot;},
  getMultipleAccountsInfoAndContext:async(addresses,options)=>{const floor=typeof options==='object'?options.minContextSlot??0:0;calls.banks.push({addresses:[...addresses],floor});return {context:{slot},value:addresses.map(a=>{const r=state.store.get(a.toBase58());return r?{...r,data:Buffer.from(r.data)}:null;})};},
  getTransaction:(async(signature:string)=>{calls.transactions.push(signature);return transactions.get(signature)??null;}) as MiningTaxReceiptReaderRpc['getTransaction'],
  getSignaturesForAddress:async()=>{calls.history++;throw new Error('Unexpected fixture discovery');},getBlock:(async()=>{calls.blocks++;throw new Error('Unexpected fixture block retry');}) as MiningTaxReceiptReaderRpc['getBlock'],
 };
 if(kind==='split'){
  const preparationRpc:SeekerTermRpc={...rpc,getMultipleAccountsInfoAndContext:async(addresses)=>({context:{slot:snapshot.slot},value:addresses.map(a=>{const row=state.store.get(a.toBase58());if(!row)return null;const data=Buffer.from(row.data);if(a.equals(SYSVAR_CLOCK_PUBKEY)){data.writeBigUInt64LE(BigInt(snapshot.slot),0);data.writeBigInt64LE(snapshot.chainClock.unixTimestamp,32);}return {...row,data};})})};
  snapshot={...snapshot,term:await readFinalizedHistoricalSeekerTerm(()=>preparationRpc,{...state.trust.seeker,round:fixture.request.plan.round},{settlementSignatures:hints})};calls.transactions=[];calls.genesis=0;
 }
 const request:MiningTaxReceiptReaderRequest={snapshot,plan:fixture.request.plan,blockhashContextSlot:fixture.request.blockhashContextSlot,caps:fixture.request.caps,signedTransactions:fixture.evidence.map(e=>e.signedTransaction)};
 return {...fixture,trust:state.trust,request,rpc,connect:(signal:AbortSignal)=>{signals.push(signal);return rpc;},calls,transactions,signals,setSlot(next:number){slot=next;clock.writeBigUInt64LE(BigInt(next),0);},clock};
}
