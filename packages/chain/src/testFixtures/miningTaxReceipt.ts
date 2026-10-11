/** Throwaway signatures, real IDL accounts/events, legacy messages and SPL CPI
 * metadata. The seven-day case supplies explicit planning facts, not RPC authority. */
import {createHash} from 'node:crypto';
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import {Keypair,PublicKey,Message,SystemProgram,VersionedTransaction,SYSVAR_CLOCK_PUBKEY,type VersionedTransactionResponse,type CompiledInstruction} from '@solana/web3.js';
import {AccountLayout,ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {PHASE_E_MINING_PUBLICATION as P,TOKEN} from '@shardkeep/shared';
import bs58 from 'bs58';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import {createMiningTaxSnapshotFixture} from './miningTaxSnapshot';
import {createMiningTaxSnapshotReader,type MiningTaxSnapshot} from '../miningTaxSnapshot';
import {buildMiningTaxMessages} from '../miningTaxMessage';
import {createMiningTaxQuoteReader,type MiningTaxQuote,type MiningTaxQuoteRpc} from '../miningTaxQuote';
import {miningEpochPda} from '../miningProgramProtocol';
import {hashMiningTermTaxIdentity,hashMiningTaxCommitment,miningTaxEpochReceiptPda} from '../miningTaxProtocol';
import type {MiningTaxReceiptRequest,MiningTaxReceiptEvidence} from '../miningTaxReceipt';
const {BN,BorshCoder}=anchorPkg,coder=new BorshCoder(idl as Idl),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function bn(v:unknown):unknown{if(BN.isBN(v))return v;if(typeof v==='bigint')return new BN(v.toString());if(v instanceof PublicKey)return v;if(v instanceof Uint8Array)return [...v];if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,bn(x)]));return v;}
export async function createMiningTaxReceiptFixture(mode:'claim'|'combined'|'split'='claim',options:{advancingQuote?:boolean;genesisHash?:PublicKey}={}){
 const signer=Keypair.generate(),state=await createMiningTaxSnapshotFixture({wallet:signer.publicKey,...(options.genesisHash?{genesisHash:options.genesisHash}:{})}),trust=state.trust.mining;
 // A settled auction may retain refundable loser escrow after the winning bid
 // has been burned/paid. Receipt recovery must survive those later withdrawals.
 const originalAuction=state.store.get(state.models.cursor.auction.toBase58())!,auctionModel=coder.accounts.decode('Auction',originalAuction.data);
 auctionModel.outstanding_escrow=new BN(500);originalAuction.data=await coder.accounts.encode('Auction',auctionModel);
 state.models.cursor.claimed_total=0n;await state.encode('cursor');
 const originalAta={...state.store.get(state.addresses.ata.toBase58())!,data:Buffer.from(state.store.get(state.addresses.ata.toBase58())!.data)};
 if(mode!=='claim'){state.store.delete(state.addresses.ata.toBase58());state.store.delete(state.addresses.cursor.toBase58());}
 if(mode==='split'){state.store.delete(state.addresses.pool.toBase58());state.store.delete(state.addresses.accrual.toBase58());}
 let snapshot=await createMiningTaxSnapshotReader(()=>state.rpc,state.trust)(state.request);
 const epochs=new Map<bigint,typeof state.models.epoch>([[state.models.epoch.day,{...state.models.epoch}]]);
 if(mode==='split'){
  const sec=BigInt(P.daySec),start=state.models.epoch.day*sec;Object.assign(state.term,{auctionStart:start-sec,auctionEnd:start,operatingStart:start,operatingEnd:start+7n*sec});
  const raw=state.store.get(state.term.term.toBase58())!,tm=coder.accounts.decode('SeekerTerm',raw.data);Object.assign(tm,{auction_start:new BN((start-sec).toString()),auction_end:new BN(start.toString()),operating_start:new BN(start.toString()),operating_end:new BN(state.term.operatingEnd.toString()),completed_at:new BN(start.toString())});raw.data=await coder.accounts.encode('SeekerTerm',tm);
  state.clock.writeBigInt64LE(state.term.operatingEnd+sec,32);Object.assign(state.backing.model,{tax_highwater:70n,tax_paid:0n,latest_day:state.models.epoch.day+6n});await state.config();
  epochs.clear();const rows=[];
  for(let i=0;i<7;i++){
   const day=state.models.epoch.day+BigInt(i),epoch=miningEpochPda(trust.programId,day),le=Buffer.alloc(8);le.writeBigUInt64LE(day);
   const model={...state.models.epoch,day,funded_at:(day+1n)*sec,tax_commitment:hashMiningTaxCommitment(state.term,{day,epoch}),bump:PublicKey.findProgramAddressSync([Buffer.from('mining_epoch'),le],trust.programId)[1]};epochs.set(day,model);
   state.store.set(epoch.toBase58(),{...raw,data:await coder.accounts.encode('MiningEpochReceipt',bn(model) as object)});
   const original=snapshot.epochs.find(e=>e.epoch)!.epoch!;rows.push({day,accrual:null,epoch:{...original,day,address:epoch.toBase58(),fundedAt:model.funded_at,taxCommitment:Buffer.from(model.tax_commitment).toString('hex')}});
  }
  snapshot={...snapshot,term:{...snapshot.term,auctionStart:state.term.auctionStart,auctionEnd:start,operatingStart:start,operatingEnd:state.term.operatingEnd,completedAt:start},chainClock:{slot:snapshot.slot,unixTimestamp:state.term.operatingEnd+sec},epochs:rows,backing:{...snapshot.backing,unixTimestamp:state.term.operatingEnd+sec,chainDay:(state.term.operatingEnd+sec)/sec,vaultAmount:200n,taxOutstanding:70n,totalOutstanding:snapshot.backing.playerOutstanding+70n,config:{...snapshot.backing.config,taxHighwater:70n,taxPaid:0n,latestDay:state.models.epoch.day+6n}},source:{...snapshot.source,accounts:[...snapshot.source.accounts, ...rows.flatMap(r=>{const a=new PublicKey(r.epoch.address),row=state.store.get(a.toBase58())!;return [{address:a.toBase58(),exists:true as const,owner:row.owner.toBase58(),executable:false,dataSha256:hash(row.data)}];})].map(a=>{const raw=state.store.get(a.address);return raw&&a.exists?{...a,dataSha256:hash(raw.data)}:a;})}};
  // Deduplicate the original first epoch after extending the explicit fixture.
  snapshot={...snapshot,source:{...snapshot.source,accounts:[...new Map(snapshot.source.accounts.map(a=>[a.address,a])).values()]}};
  state.models.pool.accrued=0n;state.models.pool.paid=0n;state.models.pool.term_identity=hashMiningTermTaxIdentity(state.term);
 }
 const input={...state.request,blockhash:Keypair.generate().publicKey.toBase58()},caps={maxFeeLamports:10n,maxRentLamports:1000n,maxTotalLamports:1010n};
 let quote:MiningTaxQuote|undefined;
 if(options.advancingQuote){
  if(mode==='split')throw new Error('Advancing quote requires canonical original fixture accounts');
  // Exercise the actual two-snapshot quote: finalized account bank advances
  // after the blockhash and fee measurements, without changing the consent.
  let bankSlot=2000;
  const rpc:MiningTaxQuoteRpc={...state.rpc,getSlot:async()=>bankSlot,
   getMultipleAccountsInfoAndContext:async(keys,config)=>{const response=await state.rpc.getMultipleAccountsInfoAndContext(keys,config);return {context:{slot:bankSlot},value:response.value.map((row,i)=>{if(row&&keys[i]!.equals(SYSVAR_CLOCK_PUBKEY))row.data.writeBigUInt64LE(BigInt(bankSlot),0);return row;})};},
   getLatestBlockhashAndContext:async()=>{bankSlot=2001;return {context:{slot:2001},value:{blockhash:input.blockhash,lastValidBlockHeight:300}};},
   getFeeForMessage:async()=>{bankSlot=2003;return {context:{slot:2002},value:5};},
   getMinimumBalanceForRentExemption:async()=>100,getBlockHeight:async()=>200,
  };
  quote=await createMiningTaxQuoteReader(()=>rpc,state.trust)({...state.request,caps});snapshot=quote.snapshot;
 }
 const planned=buildMiningTaxMessages(trust,snapshot,input),evidence:MiningTaxReceiptEvidence[]=[],txs:VersionedTransactionResponse[]=[];
 const program=trust.programId.toBase58(),mint=trust.keepMint.toBase58(),vault=state.backing.rows[1]!.address.toBase58(),ata=state.addresses.ata.toBase58(),config=state.term.config.toBase58(),pool=state.addresses.pool.toBase58();
 let vaultBalance=mode==='split'?200n:100n,ataBalance=0n;
 for(const [n,selected] of planned.transactions.entries()){
  const message=Message.from(selected.messageBytes),signed=new VersionedTransaction(message);signed.sign([signer]);const keys=message.accountKeys.map(k=>k.toBase58()),index=(s:string)=>{const i=keys.indexOf(s);if(i<0)throw new Error(`Missing fixture key ${s}`);return i;};
  const preBalances=keys.map(()=>1000),postBalances=[...preBalances],inner:{index:number;instructions:(CompiledInstruction&{stackHeight:number})[]}[]=[],logs:string[]=[];
  preBalances[0]=1_000_000;postBalances[0]=1_000_000-5-selected.expectedNewAccounts.length*100;
  for(const a of selected.expectedNewAccounts){preBalances[index(a.address)]=0;postBalances[index(a.address)]=100;}
  const hadAta=state.store.has(ata),preVault=vaultBalance,preAta=ataBalance;let payment=0n;
  const event=(name:string,data:object)=>Buffer.concat([Buffer.from(idl.events.find(e=>e.name===name)!.discriminator),coder.types.encode(name,bn(data) as object)]).toString('base64');
  for(const [i,ix] of message.instructions.entries()){
   const top=keys[ix.programIdIndex]!,name=idl.instructions.find(d=>Buffer.from(d.discriminator).equals(bs58.decode(ix.data)))?.name,inners:(CompiledInstruction&{stackHeight:number})[]=[];let eventData:string|undefined,target:string|undefined,owner=trust.programId;
   if(top===ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()){target=ata;owner=TOKEN_PROGRAM_ID;state.store.set(ata,{...originalAta,data:Buffer.from(originalAta.data)});}
   if(name==='open_mining_tax_pool'){target=pool;await state.encode('pool');eventData=event('MiningTaxPoolOpened',{pool:state.addresses.pool,config:state.term.config,term:state.term.term,term_identity:state.models.pool.term_identity,winner_count:3,distribution_version:1});}
   if(name==='accrue_mining_tax'){
    const model=[...epochs.values()].find(e=>ix.accounts.some(k=>keys[k]===miningEpochPda(trust.programId,e.day).toBase58()))!,epoch=miningEpochPda(trust.programId,model.day),receipt=miningTaxEpochReceiptPda(trust.programId,epoch);target=receipt.toBase58();state.models.pool.accrued+=model.tax;await state.encode('pool');
    const accruedAt=snapshot.chainClock.unixTimestamp+BigInt(n+1);state.store.set(target,{...originalAta,owner:trust.programId,data:await coder.accounts.encode('MiningTaxAccrual',bn({...state.models.accrual,epoch,amount:model.tax,accrued_at:accruedAt,bump:PublicKey.findProgramAddressSync([Buffer.from('mining_tax_epoch'),state.term.config.toBuffer(),epoch.toBuffer()],trust.programId)[1]}) as object)});
    eventData=event('MiningTaxAccrued',{pool:state.addresses.pool,epoch,day:model.day,amount:model.tax,accrued:state.models.pool.accrued});
   }
   if(name==='open_mining_tax_spot'){target=state.addresses.cursor.toBase58();await state.encode('cursor');eventData=event('MiningTaxSpotOpened',{pool:state.addresses.pool,auction:state.models.cursor.auction,spot:0,wallet:signer.publicKey});}
   if(name==='claim_mining_tax'){
    const cumulative=state.models.pool.accrued/3n;payment=cumulative-state.models.cursor.claimed_total;state.models.cursor.claimed_total=cumulative;state.models.pool.paid+=payment;state.backing.model.tax_paid+=payment;vaultBalance-=payment;ataBalance+=payment;
    await state.encode('cursor');await state.encode('pool');await state.config();
    const bytes=Buffer.alloc(10);bytes[0]=12;bytes.writeBigUInt64LE(payment,1);bytes[9]=TOKEN.decimals;inners.push({programIdIndex:index(TOKEN_PROGRAM_ID.toBase58()),accounts:[index(vault),index(mint),index(ata),index(config)],data:bs58.encode(bytes),stackHeight:2});
    eventData=event('MiningTaxClaimed',{pool:state.addresses.pool,term:state.term.term,auction:state.models.cursor.auction,spot:0,wallet:signer.publicKey,amount:payment,cumulative,pool_paid:state.models.pool.paid,total_tax_paid:state.backing.model.tax_paid});
   }
   if(target){const space=selected.expectedNewAccounts.find(a=>a.address===target)!.space,create=SystemProgram.createAccount({fromPubkey:signer.publicKey,newAccountPubkey:new PublicKey(target),lamports:100,space,programId:owner});inners.push({programIdIndex:index(SystemProgram.programId.toBase58()),accounts:[0,index(target)],data:bs58.encode(create.data),stackHeight:2});
    if(top===ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())inners.push({programIdIndex:index(TOKEN_PROGRAM_ID.toBase58()),accounts:[index(ata),index(mint)],data:bs58.encode(Buffer.concat([Buffer.of(18),signer.publicKey.toBuffer()])),stackHeight:2});
   }
   if(inners.length)inner.push({index:i,instructions:inners});logs.push(`Program ${top} invoke [1]`);for(const cpi of inners)logs.push(`Program ${keys[cpi.programIdIndex]} invoke [2]`,`Program ${keys[cpi.programIdIndex]} success`);if(eventData)logs.push(`Program data: ${eventData}`);logs.push(`Program ${top} success`);
  }
  for(const [a,balance] of [[vault,vaultBalance],[ata,ataBalance]] as const){const row=state.store.get(a)!;AccountLayout.encode({...AccountLayout.decode(row.data),amount:balance},row.data);}
  const slot=snapshot.slot+1+n,now=snapshot.chainClock.unixTimestamp+BigInt(n+1),clock=state.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data;clock.writeBigUInt64LE(BigInt(slot),0);clock.writeBigInt64LE(now,32);
  const token=(address:string,owner:string,value:bigint)=>({accountIndex:index(address),mint,owner,programId:TOKEN_PROGRAM_ID.toBase58(),uiTokenAmount:{amount:String(value),decimals:TOKEN.decimals,uiAmount:null,uiAmountString:String(value)}}),isSetup=selected.kind==='setup';
  const tx:VersionedTransactionResponse={slot,blockTime:Number(now),version:'legacy',transaction:{message,signatures:[bs58.encode(signed.signatures[0]!)]},meta:{err:null,fee:5,preBalances,postBalances,preTokenBalances:isSetup?[]:[token(vault,config,preVault),...(hadAta?[token(ata,signer.publicKey.toBase58(),preAta)]:[])],postTokenBalances:isSetup?[token(ata,signer.publicKey.toBase58(),ataBalance)]:[token(vault,config,vaultBalance),token(ata,signer.publicKey.toBase58(),ataBalance)],innerInstructions:inner,logMessages:logs,loadedAddresses:{writable:[],readonly:[]}}};txs.push(tx);
  const allowed=new Set([...snapshot.source.accounts.filter(a=>a.address!==signer.publicKey.toBase58()).map(a=>a.address),...snapshot.epochs.flatMap(r=>{const epoch=miningEpochPda(trust.programId,r.day);return [epoch.toBase58(),miningTaxEpochReceiptPda(trust.programId,epoch).toBase58()];})]);
  const accounts=[...state.store].filter(([a])=>allowed.has(a)).map(([address,row])=>({address:new PublicKey(address),owner:row.owner,executable:row.executable,data:Buffer.from(row.data)}));
  evidence.push({commitment:'finalized',genesisHash:trust.expectedGenesisHash,signedTransaction:signed.serialize(),transaction:tx,bank:{commitment:'finalized',genesisHash:trust.expectedGenesisHash,slot,accounts}});
 }
 const request:MiningTaxReceiptRequest={snapshot,plan:input,blockhashContextSlot:quote?.blockhashSlot??2000,caps,evidence};
 return {state,trust,signer,snapshot,planned,request,evidence,txs,quote,hash,event:(name:string,data:object)=>Buffer.concat([Buffer.from(idl.events.find(e=>e.name===name)!.discriminator),coder.types.encode(name,bn(data) as object)]).toString('base64')};
}

/** Dust arrives after preparation, before this transaction. The same signed ATA
 * instruction now executes the actual SPL prefunded allocation/assignment path. */
export function prefundMiningTaxReceiptAta(e:MiningTaxReceiptEvidence,ata:PublicKey,wallet:PublicKey,lamports:number){
 const tx=e.transaction,meta=tx.meta!,message=tx.transaction.message as Message,keys=message.accountKeys.map(k=>k.toBase58()),at=keys.indexOf(ata.toBase58()),system=keys.indexOf(SystemProgram.programId.toBase58());
 if(at<0||system<0||!Number.isSafeInteger(lamports)||lamports<=0||meta.preBalances[at]!==0||meta.preTokenBalances!.some(b=>b.accountIndex===at))throw new Error('Invalid dusted ATA fixture');
 const rent=meta.postBalances[at]!,shortfall=Math.max(0,rent-lamports);meta.preBalances[at]=lamports;meta.postBalances[at]=Math.max(rent,lamports);meta.postBalances[0]!+=rent-shortfall;
 const group=meta.innerInstructions!.find(g=>message.accountKeys[message.instructions[g.index]!.programIdIndex]!.equals(ASSOCIATED_TOKEN_PROGRAM_ID))!;
 const original=group.instructions.findIndex(ix=>ix.programIdIndex===system),create=Buffer.from(bs58.decode(group.instructions[original]!.data)),space=Number(create.readBigUInt64LE(12));
 const instructions=[...(shortfall?[SystemProgram.transfer({fromPubkey:wallet,toPubkey:ata,lamports:shortfall})]:[]),SystemProgram.allocate({accountPubkey:ata,space}),SystemProgram.assign({accountPubkey:ata,programId:TOKEN_PROGRAM_ID})];
 group.instructions.splice(original,1,...instructions.map(ix=>({programIdIndex:system,accounts:ix.keys.map(k=>keys.indexOf(k.pubkey.toBase58())),data:bs58.encode(ix.data),stackHeight:2})));
 const logs=meta.logMessages!,invoke=`Program ${SystemProgram.programId.toBase58()} invoke [2]`,success=`Program ${SystemProgram.programId.toBase58()} success`,start=logs.indexOf(invoke);logs.splice(start,2,...instructions.flatMap(()=>[invoke,success]));
}
