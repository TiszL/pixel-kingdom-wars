/** Actual B3f preparation + claimant signature, with serialized finalized RPC evidence. */
import { Message,PublicKey,SystemProgram,type CompiledInstruction,type TransactionInstruction,type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { TOKEN,PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import { decodeMiningAllocationLeaf,decodeMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import type { MiningClaimReceiptReader,MiningClaimReceiptTrust } from '@shardkeep/chain/mining-claim-receipt';
import { verifyMiningClaimSignedWire } from '@shardkeep/chain/mining-claim-wire';
import { buildMiningClaimMessages } from '@shardkeep/chain/mining-claim-message';
import { createMiningClaimFixture } from '../../../../packages/chain/src/testFixtures/miningClaim';
import { acceptMiningClaimSigned,type MiningClaimSignedWire } from '../../src/mining/claimSignedStore';
import { withMiningClaimPreparationFixture,type MiningClaimPreparationFixture } from './miningClaimPreparation';
export type MiningClaimSettlementFixture=MiningClaimPreparationFixture & {signed:MiningClaimSignedWire;tx:VersionedTransactionResponse;receiptReader:MiningClaimReceiptReader;receiptTrust:MiningClaimReceiptTrust;trust:MiningClaimReceiptTrust;receiptRows:Awaited<ReturnType<typeof createMiningClaimFixture>>['rows'];payment:bigint;index:(key:string)=>number};
export async function withMiningClaimSettlementFixture(run:(f:MiningClaimSettlementFixture)=>Promise<void>,options:{deferSignedPersistence?:boolean;genesisHash?:string}={}):Promise<void>{return withMiningClaimPreparationFixture(async f=>{
 const p=f.preparedClaim,wire=f.sign();
 const verified=verifyMiningClaimSignedWire({intentBytes:Buffer.from(p.transactions[0]!.messageHex,'hex'),signedTransaction:wire,wallet:f.claimantSigner.publicKey});
 // HTTP fixtures must perform the first persistence themselves. This descriptor
 // supplies real signature bytes to serialized chain evidence, never a receipt.
 const signed:MiningClaimSignedWire=options.deferSignedPersistence?{wallet:f.wallet,claimId:p.claimId,ordinal:0,kind:p.transactions[0]!.kind,signature:verified.signature,signedTransactionHex:Buffer.from(wire).toString('hex'),wireSha256:verified.wireSha256,messageSha256:verified.messageSha256,acceptedAt:p.preparedAt,claimSubmissionAuthorized:false}:await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:p.claimId,signedTransaction:wire});
 const message=Message.from(Buffer.from(p.transactions[0]!.messageHex,'hex')),strings=message.accountKeys.map(k=>k.toBase58()),index=(key:string)=>{const i=strings.indexOf(key);if(i<0)throw Error('Missing fixture key');return i;};
 const claim=message.compiledInstructions.at(-1)!,account=(i:number)=>message.accountKeys[claim.accountKeyIndexes[i]!]!;
 const vault=account(5).toBase58(),ata=account(6),mint=account(7),token=account(8),config=account(1).toBase58();
 const leaf=decodeMiningAllocationLeaf(Buffer.from(p.leafHex,'hex')),payment=leaf.cumulativeKeep;
 const post=await createMiningClaimFixture({wallet:f.claimantSigner.publicKey,day:'2020-01-01'});
 for(let i=0;i<14;i++){const row=f.bank.rows[i];post.rows[i]=row?{...row,data:Buffer.from(row.data)}:null;}
 Object.assign(post.backing.model,f.chain.models[0]);Object.assign(post.root,f.chain.models[2]);Object.assign(post.epoch,f.chain.models[1]);
 const before=Buffer.from(post.rows[1]!.data).readBigUInt64LE(64),after=before-payment;
 (post.rows[1]!.data as Buffer).writeBigUInt64LE(after,64);
 // Classic SPL account layout: mint0, owner32, amount64, Initialized108;
 // the remaining delegate/native/close fields stay explicitly zero.
 const ataData=Buffer.alloc(165);mint.toBuffer().copy(ataData,0);f.claimantSigner.publicKey.toBuffer().copy(ataData,32);ataData.writeBigUInt64LE(payment,64);ataData[108]=1;
 post.rows[12]={address:ata,owner:token,executable:false,data:ataData};
 const now=BigInt(p.header.day)*BigInt(POLICY.daySec)+BigInt(POLICY.daySec+POLICY.claimDelaySec);
 post.miner.claimed_total=payment;post.miner.last_sequence=1n;post.miner.last_claim_at=now;post.renown.last_sequence=1n;post.renown.synced_at=now;
 post.backing.model.total_claimed=payment;post.root.claims_count=1n;
 await post.records();await post.backing.config();post.rows[0]={...post.backing.rows[0]!,data:Buffer.from(post.backing.rows[0]!.data)};await post.encodeRoot();await post.encodeEpoch();(post.rows[7]!.data as Buffer).writeBigUInt64LE(3005n);
 const balance=(address:string,owner:string,amount:bigint)=>({accountIndex:index(address),mint:mint.toBase58(),owner,programId:token.toBase58(),uiTokenAmount:{amount:String(amount),decimals:TOKEN.decimals,uiAmount:null,uiAmountString:String(amount)}});
 // Reconstruct the exact saved plan so fixture creation evidence uses the same
 // reviewed ABI sizes and account set as the independent receipt verifier.
 const plan=buildMiningClaimMessages({programId:f.bank.trust.programId,keepMint:f.bank.trust.keepMint,reserveOwner:f.bank.trust.reserveOwner},{wallet:f.claimantSigner.publicKey,root:Buffer.from(p.header.root,'hex'),sequence:BigInt(p.header.sequence),day:BigInt(p.header.day),totalCumulative:BigInt(p.header.totalCumulative),leaf,proof:decodeMiningAllocationProof(Buffer.from(p.proofHex,'hex')),blockhash:p.blockhash,needsAta:p.needsAta,needsMinerRecords:p.needsMinerRecords});
 const selected=plan.transactions[0]!;if(Buffer.from(selected.messageBytes).toString('hex')!==p.transactions[0]!.messageHex)throw Error('Fixture differs from saved claim');
 const inner:{index:number;instructions:(CompiledInstruction&{stackHeight:number})[]}[]=[];
 const compile=(ix:TransactionInstruction)=>({programIdIndex:index(ix.programId.toBase58()),accounts:ix.keys.map(k=>index(k.pubkey.toBase58())),data:bs58.encode(ix.data),stackHeight:2});
 const create=(address:string,space:number,owner:PublicKey)=>compile(SystemProgram.createAccount({fromPubkey:f.claimantSigner.publicKey,newAccountPubkey:new PublicKey(address),lamports:space*10,space,programId:owner}));
 for(const [i,ix] of message.compiledInstructions.entries()){
  if(i===message.compiledInstructions.length-1){const data=Buffer.alloc(10);data[0]=12;data.writeBigUInt64LE(payment,1);data[9]=TOKEN.decimals;inner.push({index:i,instructions:[{programIdIndex:index(token.toBase58()),accounts:[index(vault),index(mint.toBase58()),index(ata.toBase58()),index(config)],data:bs58.encode(data),stackHeight:2}]});}
  else if(message.accountKeys[ix.programIdIndex]!.equals(f.bank.trust.programId)){inner.push({index:i,instructions:selected.expectedNewAccounts.filter(a=>a.address!==ata.toBase58()).map(a=>create(a.address,a.space,f.bank.trust.programId))});}
  else inner.push({index:i,instructions:[
   {programIdIndex:index(token.toBase58()),accounts:[index(mint.toBase58())],data:bs58.encode(Buffer.of(21,7,0)),stackHeight:2},
   create(ata.toBase58(),165,token),
   {programIdIndex:index(token.toBase58()),accounts:[index(ata.toBase58())],data:bs58.encode(Buffer.of(22)),stackHeight:2},
   {programIdIndex:index(token.toBase58()),accounts:[index(ata.toBase58()),index(mint.toBase58())],data:bs58.encode(Buffer.concat([Buffer.of(18),f.claimantSigner.publicKey.toBuffer()])),stackHeight:2}]});
 }
 const preBalances=strings.map(()=>1_000_000),postBalances=[...preBalances];
 for(const account of selected.expectedNewAccounts){preBalances[index(account.address)]=0;postBalances[index(account.address)]=account.space*10;postBalances[0]!-=account.space*10;}
 postBalances[0]!-=5000;
 const tx:VersionedTransactionResponse={slot:3004,blockTime:Number(now),version:'legacy',transaction:{message,signatures:[signed.signature]},meta:{err:null,fee:5000,preBalances,postBalances,preTokenBalances:[balance(vault,config,before)],postTokenBalances:[balance(vault,config,after),balance(ata.toBase58(),f.wallet,payment)],innerInstructions:inner,logMessages:[],loadedAddresses:{writable:[],readonly:[]}}};
 const receiptReader:MiningClaimReceiptReader={getGenesisHash:f.bank.reader.getGenesisHash,getSlot:async()=>3005,getMultipleAccountsInfoAndContext:async()=>({context:{slot:3005},value:post.rows}),getTransaction:async()=>tx};await run({...f,signed,tx,receiptReader,receiptTrust:f.bank.trust,trust:f.bank.trust,receiptRows:post.rows,payment,index});
},options);}
