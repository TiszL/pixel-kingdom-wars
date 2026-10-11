import {createHash} from 'node:crypto';
import {Keypair,Message,PublicKey,Transaction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {ACCOUNT_SIZE,ASSOCIATED_TOKEN_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {describe,expect,it,vi} from 'vitest';
import {buildClaimMiningInstruction,buildOpenMinerRecordsInstruction,MINING_ACCOUNT_BYTES,MINING_PROGRAM_ADDRESS,minerClaimPda,renownRecordPda} from './miningProgramProtocol';
import {hashMiningAllocationLeaf,hashMiningAllocationNode,type MiningAllocationLeaf,type MiningProofNode} from './miningAllocationProof';
import {buildMiningClaimMessages,MiningClaimMessageError,type MiningClaimMessageInput} from './miningClaimMessage';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(depth=0,needsAta=true,needsMinerRecords=true){
 const signer=Keypair.generate(),identity={programId:new PublicKey(MINING_PROGRAM_ADDRESS),keepMint:Keypair.generate().publicKey,reserveOwner:Keypair.generate().publicKey};
 const leaf:MiningAllocationLeaf={wallet:signer.publicKey.toBase58(),sequence:1n,cumulativeKeep:8n,cumulativeRenown:0n,cumulativeDays:0n};
 const proof:MiningProofNode[]=[];let root=hashMiningAllocationLeaf(leaf),totalCumulative=leaf.cumulativeKeep;
 // A valid path through opaque sibling subtrees tests the full wire depth without
 // allocating 65,536 unrelated player records. Every sum remains authenticated.
 for(let i=0;i<depth;i++){
  const sibling={hash:hashMiningAllocationLeaf({...leaf,wallet:Keypair.generate().publicKey.toBase58()}),sum:8n,isLeft:i%2===0};
  root=sibling.isLeft?hashMiningAllocationNode(sibling.hash,sibling.sum,root,totalCumulative):hashMiningAllocationNode(root,totalCumulative,sibling.hash,sibling.sum);
  totalCumulative+=sibling.sum;proof.push(sibling);
 }
 const input:MiningClaimMessageInput={wallet:signer.publicKey,root,sequence:1n,day:100n,totalCumulative,leaf,proof,blockhash:Keypair.generate().publicKey.toBase58(),needsAta,needsMinerRecords};
 return {signer,identity,input};
}
function refuse(f:ReturnType<typeof fixture>,input:MiningClaimMessageInput,code?:string){expect(()=>buildMiningClaimMessages(f.identity,input)).toThrowError(MiningClaimMessageError);if(code)expect(()=>buildMiningClaimMessages(f.identity,input)).toThrowError(expect.objectContaining({code}));}
function instructions(f:ReturnType<typeof fixture>){
 const result=[];
 if(f.input.needsAta)result.push(createAssociatedTokenAccountIdempotentInstruction(f.input.wallet,getAssociatedTokenAddressSync(f.identity.keepMint,f.input.wallet),f.input.wallet,f.identity.keepMint));
 if(f.input.needsMinerRecords)result.push(buildOpenMinerRecordsInstruction(f.identity,{payer:f.input.wallet,wallet:f.input.wallet}));
 result.push(buildClaimMiningInstruction(f.identity,{leaf:f.input.leaf,proof:f.input.proof}));return result;
}
describe('canonical claimant mining messages',()=>{
 it.each([[true,true],[true,false],[false,true],[false,false]])('uses only required setup (ATA %s, records %s), with exact ABI instructions and rent sizes', (needsAta,needsMinerRecords)=>{
  const f=fixture(0,needsAta,needsMinerRecords),result=buildMiningClaimMessages(f.identity,f.input),tx=result.transactions[0]!;
  const expected=new TransactionMessage({payerKey:f.input.wallet,recentBlockhash:f.input.blockhash,instructions:instructions(f)}).compileToLegacyMessage();
  expect(result.mode).toBe('combined');expect(tx.kind).toBe(needsAta||needsMinerRecords?'combined':'claim');expect(result.transactions).toHaveLength(1);
  expect(tx.messageBytes).toEqual(Uint8Array.from(expected.serialize()));expect(tx.messageSha256).toBe(hash(expected.serialize()));
  expect(tx.expectedNewAccounts).toEqual([
   ...(needsAta?[{address:getAssociatedTokenAddressSync(f.identity.keepMint,f.input.wallet).toBase58(),space:ACCOUNT_SIZE}]:[]),
   ...(needsMinerRecords?[{address:minerClaimPda(f.identity.programId,f.input.wallet).toBase58(),space:MINING_ACCOUNT_BYTES.MinerClaim},{address:renownRecordPda(f.identity.programId,f.input.wallet).toBase58(),space:MINING_ACCOUNT_BYTES.RenownRecord}]:[]),
  ]);
  expect(result.signingAuthorized).toBe(false);expect(result.broadcastAuthorized).toBe(false);
 });
 it('only the claimant signs and pays every required setup account; packet size is the real signed envelope',()=>{
  const f=fixture(),result=buildMiningClaimMessages(f.identity,f.input),tx=result.transactions[0]!,message=Message.from(tx.messageBytes),signed=new VersionedTransaction(message);
  expect(message.header.numRequiredSignatures).toBe(1);expect(message.accountKeys[0]!.equals(f.input.wallet)).toBe(true);signed.sign([f.signer]);
  expect(signed.serialize().length).toBe(tx.packetBytes);expect(tx.packetBytes).toBeLessThanOrEqual(1232);expect(Transaction.from(signed.serialize()).verifySignatures()).toBe(true);
  const setup=TransactionMessage.decompile(message).instructions[0]!;expect(setup.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);expect(setup.data).toEqual(Buffer.of(1));expect(setup.keys[0]!.pubkey.equals(f.input.wallet)).toBe(true);
 });
 it('splits a depth-16 proof only after measuring the combined packet, while claim alone remains valid',()=>{
  const f=fixture(16),combined=new TransactionMessage({payerKey:f.input.wallet,recentBlockhash:f.input.blockhash,instructions:instructions(f)}).compileToLegacyMessage();
  expect(new VersionedTransaction(combined).serialize().length).toBeGreaterThan(1232);
  const result=buildMiningClaimMessages(f.identity,f.input);expect(result.mode).toBe('split');expect(result.transactions.map(t=>t.kind)).toEqual(['setup','claim']);
  expect(result.transactions[0]!.expectedNewAccounts).toHaveLength(3);expect(result.transactions[1]!.expectedNewAccounts).toEqual([]);
  for(const tx of result.transactions){const signed=new VersionedTransaction(Message.from(tx.messageBytes));signed.sign([f.signer]);expect(signed.serialize().length).toBe(tx.packetBytes);expect(tx.packetBytes).toBeLessThanOrEqual(1232);}
  const claimOnly=buildMiningClaimMessages(f.identity,{...f.input,needsAta:false,needsMinerRecords:false});expect(claimOnly.mode).toBe('combined');expect(claimOnly.transactions[0]!.kind).toBe('claim');expect(claimOnly.transactions[0]!.messageBytes).toEqual(result.transactions[1]!.messageBytes);
 });
 it('selects combined or split from actual serialization across every allowed proof depth',()=>{
  for(let depth=0;depth<=16;depth++){
   const f=fixture(depth),all=new TransactionMessage({payerKey:f.input.wallet,recentBlockhash:f.input.blockhash,instructions:instructions(f)}).compileToLegacyMessage(),bytes=new VersionedTransaction(all).serialize().length;
   const result=buildMiningClaimMessages(f.identity,f.input);expect(result.mode).toBe(bytes<=1232?'combined':'split');expect(result.transactions.every(t=>t.packetBytes<=1232)).toBe(true);
  }
 });
 it('refuses wallet, sequence, root and total substitution even when other fields are genuine',()=>{
  const f=fixture(2);refuse(f,{...f.input,wallet:Keypair.generate().publicKey},'IDENTITY');refuse(f,{...f.input,sequence:2n},'IDENTITY');refuse(f,{...f.input,root:new Uint8Array(32)},'PROOF');refuse(f,{...f.input,totalCumulative:f.input.totalCumulative+1n},'PROOF');
  refuse(f,{...f.input,proof:[{...f.input.proof[0]!,isLeft:!f.input.proof[0]!.isLeft},...f.input.proof.slice(1)]},'PROOF');
 });
 it('refuses zero entitlement, malformed or oversized proof before transaction compilation',()=>{
  const f=fixture(1),compile=vi.spyOn(TransactionMessage.prototype,'compileToLegacyMessage');
  try{refuse(f,{...f.input,leaf:{...f.input.leaf,cumulativeKeep:0n}},'INPUT');refuse(f,{...f.input,proof:Array.from({length:17},()=>f.input.proof[0]!)},'INPUT');refuse(f,{...f.input,proof:[{...f.input.proof[0]!,isLeft:1 as unknown as boolean}]},'PROOF');expect(compile).not.toHaveBeenCalled();}finally{compile.mockRestore();}
 });
 it('rejects noncanonical blockhashes, scalar ranges, extra instructions and forced split inputs',()=>{
  const f=fixture();for(const blockhash of ['', '0'.repeat(32),'1'.repeat(33)])refuse(f,{...f.input,blockhash},'INPUT');
  refuse(f,{...f.input,day:0n},'INPUT');refuse(f,{...f.input,sequence:1n<<64n},'INPUT');refuse(f,{...f.input,needsAta:1 as unknown as boolean},'INPUT');
  refuse(f,{...f.input,split:true} as MiningClaimMessageInput,'INPUT');refuse(f,{...f.input,instructions:[]} as MiningClaimMessageInput,'INPUT');
  expect(()=>buildMiningClaimMessages({...f.identity,programId:Keypair.generate().publicKey},f.input)).toThrowError(MiningClaimMessageError);
 });
 it('retains stable canonical bytes independently of all caller buffers and every returned copy',()=>{
  const f=fixture(2),first=buildMiningClaimMessages(f.identity,f.input),again=buildMiningClaimMessages(f.identity,f.input),expected=first.transactions[0]!.messageBytes,sha=first.transactions[0]!.messageSha256;
  expect(again.transactions[0]!.messageBytes).toEqual(expected);f.input.root.fill(0);f.input.proof[0]!.hash.fill(0);f.input.leaf.cumulativeKeep=999n;
  first.transactions[0]!.messageBytes.fill(0);expect(first.transactions[0]!.messageBytes).toEqual(expected);expect(first.transactions[0]!.messageSha256).toBe(sha);
  expect(Object.isFrozen(first)).toBe(true);expect(Object.isFrozen(first.transactions)).toBe(true);expect(Object.isFrozen(first.transactions[0])).toBe(true);expect(Object.isFrozen(first.transactions[0]!.expectedNewAccounts[0])).toBe(true);
 });
});
