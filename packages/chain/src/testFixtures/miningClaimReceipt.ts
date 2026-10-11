/** Generated signatures and real serialized account/transaction evidence only. */
import {Keypair,Message,PublicKey,SystemProgram,VersionedTransaction,type CompiledInstruction,type TransactionInstruction,type VersionedTransactionResponse} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {TOKEN,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import bs58 from 'bs58';
import {buildMiningClaimMessages,type MiningClaimMessageInput} from '../miningClaimMessage';
import {hashMiningAllocationLeaf,hashMiningAllocationNode,type MiningProofNode} from '../miningAllocationProof';
import {createMiningClaimFixture} from './miningClaim';
import type {MiningClaimReceiptReader,MiningClaimReceiptRequest} from '../miningClaimReceipt';

export async function createMiningClaimReceiptFixture(kind:'combined'|'claim'|'setup'='combined'){
 const signer=Keypair.generate(),state=await createMiningClaimFixture({wallet:signer.publicKey}),proof:MiningProofNode[]=[];
 let root=state.tree.root,total=state.tree.total;
 if(kind==='setup')for(let i=0;i<16;i++){
  const n={hash:hashMiningAllocationLeaf({...state.leaf,wallet:Keypair.generate().publicKey.toBase58()}),sum:0n,isLeft:false};
  root=hashMiningAllocationNode(root,total,n.hash,n.sum);proof.push(n);
 }
 state.root.root=root;state.root.leaf_count=kind==='setup'?65536:1;
 const plan:MiningClaimMessageInput={wallet:signer.publicKey,root,sequence:1n,day:state.request.day,totalCumulative:total,leaf:{...state.leaf},proof,blockhash:Keypair.generate().publicKey.toBase58(),needsAta:kind!=='claim',needsMinerRecords:kind!=='claim'};
 const planned=buildMiningClaimMessages({programId:state.trust.programId,keepMint:state.trust.keepMint,reserveOwner:state.trust.reserveOwner},plan),selected=planned.transactions.find(t=>t.kind===kind)!;
 const message=Message.from(selected.messageBytes),signed=new VersionedTransaction(message);signed.sign([signer]);
 const strings=message.accountKeys.map(k=>k.toBase58()),index=(s:string)=>{const i=strings.indexOf(s);if(i<0)throw new Error(`Missing fixture key ${s}`);return i;};
 const vault=state.rows[1]!.address.toBase58(),ata=state.rows[12]!.address.toBase58(),config=state.rows[0]!.address.toBase58(),mint=state.trust.keepMint.toBase58();
 const tokenBalance=(address:string,owner:string,amount:bigint)=>({accountIndex:index(address),mint,owner,programId:TOKEN_PROGRAM_ID.toBase58(),uiTokenAmount:{amount:amount.toString(),decimals:TOKEN.decimals,uiAmount:null,uiAmountString:amount.toString()}});
 const payment=kind==='setup'?0n:kind==='combined'?80n:50n,inner:{index:number;instructions:(CompiledInstruction&{stackHeight:number})[]}[]=[];
 const compile=(ix:TransactionInstruction)=>({programIdIndex:index(ix.programId.toBase58()),accounts:ix.keys.map(k=>index(k.pubkey.toBase58())),data:bs58.encode(ix.data),stackHeight:2});
 const rent=1_000_000,create=(address:string,space:number,owner:PublicKey)=>compile(SystemProgram.createAccount({fromPubkey:signer.publicKey,newAccountPubkey:new PublicKey(address),lamports:rent,space,programId:owner}));
 for(const [i,ix] of message.compiledInstructions.entries()){
  const program=strings[ix.programIdIndex];
  if(program===ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())inner.push({index:i,instructions:[
   {programIdIndex:index(TOKEN_PROGRAM_ID.toBase58()),accounts:[index(mint)],data:bs58.encode(Buffer.of(21,7,0)),stackHeight:2},
   create(ata,AccountLayout.span,TOKEN_PROGRAM_ID),
   {programIdIndex:index(TOKEN_PROGRAM_ID.toBase58()),accounts:[index(ata)],data:bs58.encode(Buffer.of(22)),stackHeight:2},
   {programIdIndex:index(TOKEN_PROGRAM_ID.toBase58()),accounts:[index(ata),index(mint)],data:bs58.encode(Buffer.concat([Buffer.of(18),signer.publicKey.toBuffer()])),stackHeight:2}]});
  else if(program===state.trust.programId.toBase58()&&ix.data.length===40)inner.push({index:i,instructions:selected.expectedNewAccounts.filter(a=>a.address!==ata).map(a=>create(a.address,a.space,state.trust.programId))});
  else if(program===state.trust.programId.toBase58()){
   const data=Buffer.alloc(10);data[0]=12;data.writeBigUInt64LE(payment,1);data[9]=TOKEN.decimals;
   inner.push({index:i,instructions:[{programIdIndex:index(TOKEN_PROGRAM_ID.toBase58()),accounts:[index(vault),index(mint),index(ata),index(config)],data:bs58.encode(data),stackHeight:2}]});
  }
 }
 const now=state.root.published_at+BigInt(PHASE_E_MINING_PUBLICATION.claimDelaySec);
 if(kind!=='setup'){
  state.root.claims_count=1n;state.miner.claimed_total=state.leaf.cumulativeKeep;state.miner.last_sequence=1n;state.miner.last_claim_at=now;
  state.renown.last_sequence=1n;state.renown.synced_at=now;state.backing.model.total_claimed=80n;
  const vaultToken=AccountLayout.decode(Buffer.from(state.rows[1]!.data));AccountLayout.encode({...vaultToken,amount:100n-payment},Buffer.from(state.rows[1]!.data.buffer,state.rows[1]!.data.byteOffset,state.rows[1]!.data.byteLength));
  const destination=AccountLayout.decode(Buffer.from(state.rows[12]!.data));AccountLayout.encode({...destination,amount:payment},Buffer.from(state.rows[12]!.data.buffer,state.rows[12]!.data.byteOffset,state.rows[12]!.data.byteLength));
 }
 await state.backing.config();await state.encodeRoot();await state.records();
 const preBalances=strings.map(()=>1_000_000),postBalances=[...preBalances];preBalances[0]=postBalances[0]=10_000_000;
 for(const account of selected.expectedNewAccounts){preBalances[index(account.address)]=0;postBalances[index(account.address)]=rent;postBalances[0]!-=rent;}
 postBalances[0]!-=5000;
 const tx:VersionedTransactionResponse={slot:140,blockTime:Number(now),version:'legacy',transaction:{message,signatures:[bs58.encode(signed.signatures[0]!)]},meta:{err:null,fee:5000,preBalances,postBalances,
  preTokenBalances:kind==='setup'?[]:[tokenBalance(vault,config,100n),...(kind==='claim'?[tokenBalance(ata,signer.publicKey.toBase58(),0n)]:[])],
  postTokenBalances:kind==='setup'?[tokenBalance(ata,signer.publicKey.toBase58(),0n)]:[tokenBalance(vault,config,100n-payment),tokenBalance(ata,signer.publicKey.toBase58(),payment)],innerInstructions:inner,logMessages:[],loadedAddresses:{writable:[],readonly:[]}}};
 const reader:MiningClaimReceiptReader={...state.reader,getTransaction:async()=>tx};
 const request={signature:tx.transaction.signatures[0]!,signedTransaction:signed.serialize(),plan,kind,blockhashContextSlot:130,sourceHash:Buffer.from(state.epoch.source_hash).toString('hex')} satisfies MiningClaimReceiptRequest;
 return {state,signer,planned,message,signed,tx,reader,request,index,payment};
}

/** Public fixture evidence for dust arriving after the immutable message was signed. */
export function prefundMiningClaimReceiptAta(f:Awaited<ReturnType<typeof createMiningClaimReceiptFixture>>,lamports:number){
 const meta=f.tx.meta!,ata=f.state.rows[12]!.address,wallet=f.signer.publicKey,at=f.index(ata.toBase58()),system=f.index(SystemProgram.programId.toBase58());
 if(!Number.isSafeInteger(lamports)||lamports<=0||meta.preBalances[at]!==0||meta.preTokenBalances!.some(b=>b.accountIndex===at))throw new Error('Invalid prefunded claimant ATA fixture');
 const rent=meta.postBalances[at]!,shortfall=Math.max(0,rent-lamports);meta.preBalances[at]=lamports;meta.postBalances[at]=Math.max(rent,lamports);meta.postBalances[0]!+=rent-shortfall;
 const group=meta.innerInstructions!.find(g=>f.message.accountKeys[f.message.instructions[g.index]!.programIdIndex]!.equals(ASSOCIATED_TOKEN_PROGRAM_ID))!;
 const original=group.instructions.findIndex(ix=>ix.programIdIndex===system);
 const instructions=[...(shortfall?[SystemProgram.transfer({fromPubkey:wallet,toPubkey:ata,lamports:shortfall})]:[]),SystemProgram.allocate({accountPubkey:ata,space:AccountLayout.span}),SystemProgram.assign({accountPubkey:ata,programId:TOKEN_PROGRAM_ID})];
 group.instructions.splice(original,1,...instructions.map(ix=>({programIdIndex:system,accounts:ix.keys.map(k=>f.index(k.pubkey.toBase58())),data:bs58.encode(ix.data),stackHeight:2})));
}
