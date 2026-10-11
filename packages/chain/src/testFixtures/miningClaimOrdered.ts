import {createHash} from 'node:crypto';
import {AddressLookupTableProgram,Keypair,Message,MessageV0,PublicKey,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {buildMiningClaimMessages} from '../miningClaimMessage';
import {miningClaimLookupAddresses,miningClaimV0Accounts,type MiningClaimFormat} from '../miningClaimFormat';
import {MINING_PROGRAM_ADDRESS,type MiningProgramIdentity} from '../miningProgramProtocol';
import {hashMiningAllocationLeaf,hashMiningAllocationNode,type MiningProofNode} from '../miningAllocationProof';
import {createMiningClaimReceiptFixture,prefundMiningClaimReceiptAta} from './miningClaimReceipt';
import {createMiningClaimFailureFixture} from './miningClaimFailure';
import type {MiningClaimReceiptReader} from '../miningClaimReceipt';
export function miningClaimFormatFixture(identity:MiningProgramIdentity):MiningClaimFormat{
 const data=Buffer.alloc(152);data.writeUInt32LE(1);data.writeBigUInt64LE((1n<<64n)-1n,4);data.writeBigUInt64LE(100n,12);
 miningClaimLookupAddresses(identity).forEach((k,i)=>k.toBuffer().copy(data,56+32*i));const address=Keypair.generate().publicKey.toBase58();
 return {version:1,preset:'ordered-v0',lookupTable:{address,owner:AddressLookupTableProgram.programId.toBase58(),executable:false,dataHex:data.toString('hex'),slot:120},expectedLookupTable:{address,dataSha256:createHash('sha256').update(data).digest('hex')},blockhashContextSlot:130};
}
/** Re-index actual generated legacy fixture history into the separately compiled
 * ordered message. No provider-supplied key determines the new index mapping. */
export async function miningClaimOrderedReceiptFixture(kind:'setup'|'claim',failed=false,prefundedLamports?:number){
 const old=await (failed?createMiningClaimFailureFixture(kind):createMiningClaimReceiptFixture(kind));
 if(prefundedLamports)prefundMiningClaimReceiptAta(old,prefundedLamports);
 const identity={programId:old.state.trust.programId,keepMint:old.state.trust.keepMint,reserveOwner:old.state.trust.reserveOwner},format=miningClaimFormatFixture(identity),planned=buildMiningClaimMessages(identity,old.request.plan,format),selected=planned.transactions.find(t=>t.kind===kind)!;
 const message=MessageV0.deserialize(selected.messageBytes),resolved=miningClaimV0Accounts(message,format),strings=resolved.keys.map(k=>k.toBase58());
 const index=(s:string)=>{const i=strings.indexOf(s);if(i<0)throw new Error('Missing ordered key');return i;};
 const signed=new VersionedTransaction(message);signed.sign([old.signer]);const signature=bs58.encode(signed.signatures[0]!);
 const tx=reindexMiningClaimOrderedHistory(old.tx,message,format,signature);
 if(failed)tx.meta!.err={InstructionError:[message.compiledInstructions.length-1,{Custom:6000}]};
 const lookupRow={address:new PublicKey(format.lookupTable.address),owner:AddressLookupTableProgram.programId,executable:false,data:Buffer.from(format.lookupTable.dataHex,'hex')};
 const reader:MiningClaimReceiptReader={...old.reader,getTransaction:async()=>tx,getMultipleAccountsInfoAndContext:async(keys,options)=>keys.length===1?{context:{slot:150},value:[lookupRow]}:old.reader.getMultipleAccountsInfoAndContext(keys,options)};
 const request={...old.request,format,signedTransaction:signed.serialize(),signature};return {...old,format,planned,message,signed,tx,reader,request,index,lookupRow};
}

/** Test-only format conversion of exact legacy history, preserving every account
 * delta, token row and CPI; callers retain source-derived authority separately. */
export function reindexMiningClaimOrderedHistory(old:VersionedTransactionResponse,message:MessageV0,format:MiningClaimFormat,signature:string):VersionedTransactionResponse{
 if(old.transaction.message.version!=='legacy')throw new Error('Expected legacy fixture history');
 const resolved=miningClaimV0Accounts(message,format),strings=resolved.keys.map(k=>k.toBase58()),oldMessage=old.transaction.message as Message,oldStrings=oldMessage.accountKeys.map(k=>k.toBase58());
 const index=(s:string)=>{const i=strings.indexOf(s);if(i<0)throw new Error('Missing ordered key');return i;},map=(i:number)=>index(oldStrings[i]!);
 if(message.compiledInstructions.length!==oldMessage.compiledInstructions.length+1)throw new Error('Ordered history must add only compute budget');
 for(const [i,oldIx] of oldMessage.compiledInstructions.entries()){const ix=message.compiledInstructions[i+1]!;
  if(strings[ix.programIdIndex]!==oldStrings[oldIx.programIdIndex]||!Buffer.from(ix.data).equals(Buffer.from(oldIx.data))||ix.accountKeyIndexes.map(n=>strings[n]).join(',')!==oldIx.accountKeyIndexes.map(n=>oldStrings[n]).join(','))throw new Error('Different fixture instructions');
 }
 const meta=old.meta!,balances=(values:number[])=>strings.map(s=>{const i=oldStrings.indexOf(s);return i<0?0:values[i]!;});
 const tx:VersionedTransactionResponse={...old,version:0,transaction:{message,signatures:[signature]},meta:{...meta,preBalances:balances(meta.preBalances),postBalances:balances(meta.postBalances),
  preTokenBalances:(meta.preTokenBalances??[]).map(b=>({...b,accountIndex:map(b.accountIndex)})),postTokenBalances:(meta.postTokenBalances??[]).map(b=>({...b,accountIndex:map(b.accountIndex)})),
  innerInstructions:(meta.innerInstructions??[]).map(g=>({index:g.index+1,instructions:g.instructions.map(ix=>({...ix,programIdIndex:map(ix.programIdIndex),accounts:ix.accounts.map(map)}))})),loadedAddresses:resolved.loaded}};
 return tx;
}

export function miningClaimOrderedMessageFixture(depth=14,needsAta=true,needsMinerRecords=true){
 const signer=Keypair.generate(),identity={programId:new PublicKey(MINING_PROGRAM_ADDRESS),keepMint:Keypair.generate().publicKey,reserveOwner:Keypair.generate().publicKey},format=miningClaimFormatFixture(identity);
 const leaf={wallet:signer.publicKey.toBase58(),sequence:1n,cumulativeKeep:8n,cumulativeRenown:0n,cumulativeDays:0n},proof:MiningProofNode[]=[];let root=hashMiningAllocationLeaf(leaf),totalCumulative=8n;
 for(let i=0;i<depth;i++){const n={hash:hashMiningAllocationLeaf({...leaf,wallet:Keypair.generate().publicKey.toBase58()}),sum:8n,isLeft:false};root=hashMiningAllocationNode(root,totalCumulative,n.hash,n.sum);totalCumulative+=n.sum;proof.push(n);}
 const input={wallet:signer.publicKey,root,sequence:1n,day:100n,totalCumulative,leaf,proof,blockhash:Keypair.generate().publicKey.toBase58(),needsAta,needsMinerRecords};return {signer,identity,format,input};
}
