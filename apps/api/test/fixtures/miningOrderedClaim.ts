/** Source-funded entitlement with real canonical ordered messages, signatures,
 * raw bank encodings and finalized metadata. No receipt or root fabrication. */
import {randomUUID} from 'node:crypto';
import {ComputeBudgetProgram,MessageV0,PublicKey,SystemProgram,VersionedMessage,VersionedTransaction,type CompiledInstruction,type TransactionInstruction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {TOKEN,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import {decodeMiningAllocationLeaf,decodeMiningAllocationProof} from '@shardkeep/chain/mining-allocation';
import {buildMiningClaimMessages} from '@shardkeep/chain/mining-claim-message';
import {miningClaimV0Accounts} from '@shardkeep/chain/mining-claim-format';
import {miningConfigPda} from '@shardkeep/chain/mining-program';
import type {MiningClaimReceiptReader} from '@shardkeep/chain/mining-claim-receipt';
import {createMiningClaimFixture} from '../../../../packages/chain/src/testFixtures/miningClaim';
import {miningClaimFormatFixture} from '../../../../packages/chain/src/testFixtures/miningClaimOrdered';
import {createFundedMiningClientAdmission} from './fundedMiningClaims';
import {withFundedMiningReplayFixture,type FundedReplayFixture,type FundedReplayPublication} from './fundedMiningReplay';
import {createMiningClaimPreparer,type MiningClaimQuoteReader} from '../../src/mining/claimPreparation';
import {getMiningClaimSigned,acceptMiningClaimSigned,type MiningClaimSignedWire} from '../../src/mining/claimSignedStore';
import {createMiningClaimSettlement,type MiningClaimSettlement} from '../../src/mining/claimSettlement';
import {createMiningClaimFailure,type MiningClaimFailure} from '../../src/mining/claimFailure';
import type {MiningClaimsProvider} from '../../src/mining/claimRoutes';
import type {MiningClaimPreparation} from '../../src/mining/claimPreparationStore';
export async function withMiningOrderedClaimFixture(run:(f:MiningOrderedClaimFixture)=>Promise<void>){return withFundedMiningReplayFixture(async f=>run(await extend(f)));}
async function extend(f:FundedReplayFixture):Promise<MiningOrderedClaimFixture>{
 const publication=await(await f.stage('2020-01-01')).publish(),source=await createFundedMiningClientAdmission(f,publication,null),trust=source.bank.trust,rows=source.bank.rows;
 let slot=source.bank.before.slot+10,height=200,blockhash=new PublicKey(Buffer.alloc(32,91)).toBase58(),now=new Date(source.preparedAt);
 const synthetic=miningClaimFormatFixture(trust),format={...synthetic,lookupTable:{...synthetic.lookupTable,slot},blockhashContextSlot:slot};
 const table={address:new PublicKey(format.lookupTable.address),owner:new PublicKey(format.lookupTable.owner),executable:false,data:Buffer.from(format.lookupTable.dataHex,'hex')};
 const observe=()=>{(rows[7]!.data as Buffer).writeBigUInt64LE(BigInt(slot));(rows[7]!.data as Buffer).writeBigInt64LE(BigInt(Math.floor(+now/1000)),32);};observe();
 const reader:MiningClaimReceiptReader={getGenesisHash:async()=>trust.expectedGenesisHash,getSlot:async()=>slot,
  getMultipleAccountsInfoAndContext:async addresses=>({context:{slot},value:addresses.map(address=>address.equals(table.address)?{...table,data:Buffer.from(table.data)}:rows.find(row=>row?.address.equals(address))??null)}),
  getTransaction:async signature=>histories.get(signature)??null};
 const quote:MiningClaimQuoteReader={getGenesisHash:reader.getGenesisHash,getSlot:reader.getSlot,getBlockHeight:async()=>height,getLatestBlockhashAndContext:async()=>({context:{slot},value:{blockhash,lastValidBlockHeight:height+50}}),getFeeForMessage:async()=>({context:{slot},value:5000}),getMinimumBalanceForRentExemption:async size=>size*10,getAccountInfoAndContext:async()=>({context:{slot},value:table})};
 const sends:Uint8Array[]=[],histories=new Map<string,VersionedTransactionResponse>();
 const provider:MiningClaimsProvider={reader,trust,ordered:{...format.expectedLookupTable},quoteSource:()=>quote,now:()=>new Date(+now),transport:()=>({getGenesisHash:reader.getGenesisHash,getSignatureStatuses:async()=>({context:{slot},value:[null]}),getBlockHeight:async()=>height,sendRawTransaction:async bytes=>{sends.push(Uint8Array.from(bytes));throw Error('Lost acknowledgement');}})};
 const prepare=createMiningClaimPreparer(f.conn.db,provider),prepared=await prepare.prepare(f.wallet,{idempotencyKey:randomUUID(),profile:'ordered-v0'});
 const sign=(p:MiningClaimPreparation,ordinal:number)=>{const tx=new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(p.transactions[ordinal]!.messageHex,'hex')));tx.sign([f.walletSigner]);return tx.serialize();};
 const raw=await createMiningClaimFixture({wallet:f.walletSigner.publicKey,day:new Date(Number(BigInt(prepared.header.day)*BigInt(PHASE_E_MINING_PUBLICATION.daySec)*1000n)).toISOString().slice(0,10)});
 Object.assign(raw.backing.model,publication.chain.models[0]);Object.assign(raw.root,publication.chain.models[2]);Object.assign(raw.epoch,publication.chain.models[1]);
 const ata=raw.rows[12]!.address,TOKEN_PROGRAM_ID=raw.rows[12]!.owner,config=miningConfigPda(trust.programId),vault=rows[1]!.address;
 async function execute(p:MiningClaimPreparation,ordinal:number,failed=false){
  const wire=sign(p,ordinal),signed=await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:p.claimId,signedTransaction:wire});
  const message=MessageV0.deserialize(Buffer.from(p.transactions[ordinal]!.messageHex,'hex')),resolved=miningClaimV0Accounts(message,p.format!),keys=resolved.keys,strings=keys.map(k=>k.toBase58()),index=(address:PublicKey|string)=>{const i=strings.indexOf(typeof address==='string'?address:address.toBase58());if(i<0)throw Error(`Missing ordered fixture key ${address}`);return i;};
  const kind=p.transactions[ordinal]!.kind,leaf=decodeMiningAllocationLeaf(Buffer.from(p.leafHex,'hex')),payment=kind==='setup'||failed?0n:leaf.cumulativeKeep-raw.miner.claimed_total;
  const plan=buildMiningClaimMessages({programId:trust.programId,keepMint:trust.keepMint,reserveOwner:trust.reserveOwner},{wallet:f.walletSigner.publicKey,root:Buffer.from(p.header.root,'hex'),sequence:BigInt(p.header.sequence),day:BigInt(p.header.day),totalCumulative:BigInt(p.header.totalCumulative),leaf,proof:decodeMiningAllocationProof(Buffer.from(p.proofHex,'hex')),blockhash:p.blockhash,needsAta:p.needsAta,needsMinerRecords:p.needsMinerRecords},p.format),selected=plan.transactions[ordinal]!;
  const inner:{index:number;instructions:(CompiledInstruction&{stackHeight:number})[]}[]=[],preBalances=strings.map(()=>1_000_000),postBalances=[...preBalances];preBalances[0]=Number(rows[13]!.lamports);postBalances[0]=preBalances[0]!-5000;
  const beforeVault=Buffer.from(rows[1]!.data).readBigUInt64LE(64),beforeAta=rows[12]?Buffer.from(rows[12]!.data).readBigUInt64LE(64):null;
  const balance=(address:PublicKey,owner:PublicKey,amount:bigint)=>({accountIndex:index(address),mint:trust.keepMint.toBase58(),owner:owner.toBase58(),programId:TOKEN_PROGRAM_ID.toBase58(),uiTokenAmount:{amount:amount.toString(),decimals:TOKEN.decimals,uiAmount:null,uiAmountString:amount.toString()}});
  const compile=(ix:TransactionInstruction)=>({programIdIndex:index(ix.programId),accounts:ix.keys.map(k=>index(k.pubkey)),data:bs58.encode(ix.data),stackHeight:2});
  const create=(address:string,space:number,owner:PublicKey)=>compile(SystemProgram.createAccount({fromPubkey:f.walletSigner.publicKey,newAccountPubkey:new PublicKey(address),lamports:space*10,space,programId:owner}));
  if(!failed)for(const[i,ix]of message.compiledInstructions.entries()){
   const program=keys[ix.programIdIndex]!;
   if(!program.equals(trust.programId)&&!program.equals(ComputeBudgetProgram.programId))inner.push({index:i,instructions:[{programIdIndex:index(TOKEN_PROGRAM_ID),accounts:[index(trust.keepMint)],data:bs58.encode(Buffer.of(21,7,0)),stackHeight:2},create(ata.toBase58(),165,TOKEN_PROGRAM_ID),{programIdIndex:index(TOKEN_PROGRAM_ID),accounts:[index(ata)],data:bs58.encode(Buffer.of(22)),stackHeight:2},{programIdIndex:index(TOKEN_PROGRAM_ID),accounts:[index(ata),index(trust.keepMint)],data:bs58.encode(Buffer.concat([Buffer.of(18),f.walletSigner.publicKey.toBuffer()])),stackHeight:2}]});
   else if(program.equals(trust.programId)&&ix.data.length===40)inner.push({index:i,instructions:selected.expectedNewAccounts.filter(a=>a.address!==ata.toBase58()).map(a=>create(a.address,a.space,trust.programId))});
   else if(program.equals(trust.programId)){const data=Buffer.alloc(10);data[0]=12;data.writeBigUInt64LE(payment,1);data[9]=TOKEN.decimals;inner.push({index:i,instructions:[{programIdIndex:index(TOKEN_PROGRAM_ID),accounts:[index(vault),index(trust.keepMint),index(ata),index(config)],data:bs58.encode(data),stackHeight:2}]});}
  }
  if(!failed){for(const account of selected.expectedNewAccounts){preBalances[index(account.address)]=0;postBalances[index(account.address)]=account.space*10;postBalances[0]!-=account.space*10;}
   if(kind==='setup'){await raw.records();rows[10]=raw.rows[10]!;rows[11]=raw.rows[11]!;rows[12]={...raw.rows[12]!,data:Buffer.from(raw.rows[12]!.data)};}
   else{raw.miner.claimed_total+=payment;raw.miner.last_sequence=leaf.sequence;raw.miner.last_claim_at=BigInt(Math.floor(+now/1000));raw.renown.renown_total=leaf.cumulativeRenown;raw.renown.days_attested=leaf.cumulativeDays;raw.renown.last_sequence=leaf.sequence;raw.renown.synced_at=raw.miner.last_claim_at;raw.backing.model.total_claimed+=payment;raw.root.claims_count+=1n;
    await raw.records();await raw.backing.config();await raw.encodeRoot();rows[10]=raw.rows[10]!;rows[11]=raw.rows[11]!;rows[0]=raw.backing.rows[0]!;rows[8]={...raw.rows[8]!,address:rows[8]!.address};(rows[1]!.data as Buffer).writeBigUInt64LE(beforeVault-payment,64);(rows[12]!.data as Buffer).writeBigUInt64LE((beforeAta??0n)+payment,64);}
  }
  rows[13]={...rows[13]!,lamports:postBalances[0]!};slot+=2;observe();
  const preTokenBalances=kind==='setup'?(beforeAta===null?[]:[balance(ata,f.walletSigner.publicKey,beforeAta)]):[balance(vault,config,beforeVault),...(beforeAta===null?[]:[balance(ata,f.walletSigner.publicKey,beforeAta)])];
  const postTokenBalances=failed?structuredClone(preTokenBalances):kind==='setup'?[balance(ata,f.walletSigner.publicKey,0n)]:[balance(vault,config,beforeVault-payment),balance(ata,f.walletSigner.publicKey,(beforeAta??0n)+payment)];
  const tx:VersionedTransactionResponse={slot:failed?p.blockhashContextSlot+1:slot-1,blockTime:Math.floor(+now/1000),version:0,transaction:{message,signatures:[signed.signature]},meta:{err:failed?{InstructionError:[1,{Custom:6000}]}:null,fee:5000,preBalances,postBalances,preTokenBalances,postTokenBalances,innerInstructions:inner,logMessages:[],loadedAddresses:resolved.loaded}};histories.set(signed.signature,tx);
  const request={wallet:f.wallet,claimId:p.claimId,ordinal},outcome=failed?await createMiningClaimFailure(f.conn.db,{reader,trust})(request):await createMiningClaimSettlement(f.conn.db,{reader,trust})(request);
  return {wire,signed,tx,outcome,payment};
 }
 return {...f,publication,provider,prepare,prepared,sign,execute,rows,table,histories,sends,quote,trust,reader,
  advance(){height+=100;slot+=100;blockhash=new PublicKey(Buffer.alloc(32,height%200+1)).toBase58();now=new Date(+now+1000);observe();},setHeight(n:number){height=n;},setSlot(n:number){slot=n;observe();},setNow(at:Date){now=at;},getSlot:()=>slot,
  read:(claimId=prepared.claimId)=>getMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId})};
}
export interface MiningOrderedClaimFixture extends Pick<FundedReplayFixture,'conn'|'url'|'wallet'|'walletSigner'|'buyer'> {
 publication:FundedReplayPublication;provider:MiningClaimsProvider;prepare:ReturnType<typeof createMiningClaimPreparer>;prepared:MiningClaimPreparation;
 sign(p:MiningClaimPreparation,ordinal:number):Uint8Array;
 execute(p:MiningClaimPreparation,ordinal:number,failed?:boolean):Promise<{wire:Uint8Array;signed:MiningClaimSignedWire;tx:VersionedTransactionResponse;outcome:MiningClaimSettlement|MiningClaimFailure;payment:bigint}>;
 rows:Awaited<ReturnType<typeof createMiningClaimFixture>>['rows'];table:{address:PublicKey;owner:PublicKey;executable:boolean;data:Buffer};histories:Map<string,VersionedTransactionResponse>;sends:Uint8Array[];
 quote:MiningClaimQuoteReader;trust:MiningClaimsProvider['trust'];reader:MiningClaimReceiptReader;
 advance():void;setHeight(n:number):void;setSlot(n:number):void;setNow(at:Date):void;getSlot():number;read(claimId?:string):ReturnType<typeof getMiningClaimSigned>;
}
