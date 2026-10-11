import {createHash} from 'node:crypto';
import {ComputeBudgetProgram,Keypair,Message,PublicKey,SystemProgram,Transaction,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,expect,it,vi} from 'vitest';
import {buildMiningClaimMessages} from './miningClaimMessage';
import {MINING_PROGRAM_ADDRESS} from './miningProgramProtocol';
import {hashMiningAllocationLeaf,hashMiningAllocationNode,type MiningProofNode} from './miningAllocationProof';
import {MiningClaimWireError,verifyMiningClaimSignedWire as verify} from './miningClaimWire';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(kind:'combined'|'claim'|'split'='combined'){
 const signer=Keypair.generate(),identity={programId:new PublicKey(MINING_PROGRAM_ADDRESS),keepMint:Keypair.generate().publicKey,reserveOwner:Keypair.generate().publicKey};
 const leaf={wallet:signer.publicKey.toBase58(),sequence:1n,cumulativeKeep:8n,cumulativeRenown:0n,cumulativeDays:0n},proof:MiningProofNode[]=[];
 let root=hashMiningAllocationLeaf(leaf),totalCumulative=leaf.cumulativeKeep;
 for(let i=0;i<(kind==='split'?16:1);i++){
  const sibling={hash:hashMiningAllocationLeaf({...leaf,wallet:Keypair.generate().publicKey.toBase58()}),sum:8n,isLeft:i%2===0};
  root=sibling.isLeft?hashMiningAllocationNode(sibling.hash,sibling.sum,root,totalCumulative):hashMiningAllocationNode(root,totalCumulative,sibling.hash,sibling.sum);
  totalCumulative+=sibling.sum;proof.push(sibling);
 }
 const planned=buildMiningClaimMessages(identity,{wallet:signer.publicKey,root,sequence:1n,day:100n,totalCumulative,leaf,proof,blockhash:Keypair.generate().publicKey.toBase58(),needsAta:kind!=='claim',needsMinerRecords:kind!=='claim'});
 function signed(index=0){const intentBytes=planned.transactions[index]!.messageBytes,message=Message.from(intentBytes),transaction=new VersionedTransaction(message);transaction.sign([signer]);return {intentBytes,signedTransaction:transaction.serialize(),wallet:signer.publicKey};}
 return {signer,identity,planned,signed};
}
function refused(input:Parameters<typeof verify>[0],code?:string){expect(()=>verify(input)).toThrowError(MiningClaimWireError);if(code)expect(()=>verify(input)).toThrowError(expect.objectContaining({code}));}
function resign(f:ReturnType<typeof fixture>,mutate:(builder:TransactionMessage)=>void){const input=f.signed(),builder=TransactionMessage.decompile(Message.from(input.intentBytes));mutate(builder);const tx=new VersionedTransaction(builder.compileToLegacyMessage());tx.sign([f.signer]);return {...input,signedTransaction:tx.serialize()};}
describe('exact saved claimant mining wire',()=>{
 it.each(['combined','claim','split'] as const)('accepts the sole generated claimant signature over actual %s planner messages',kind=>{
  const f=fixture(kind);expect(f.planned.transactions.map(t=>t.kind)).toEqual(kind==='split'?['setup','claim']:[kind]);
  for(let index=0;index<f.planned.transactions.length;index++){
   const input=f.signed(index),accepted=verify(input);
   expect(accepted.signature).toBe(bs58.encode(VersionedTransaction.deserialize(input.signedTransaction).signatures[0]!));
   expect(accepted.messageSha256).toBe(hash(input.intentBytes));expect(accepted.wireSha256).toBe(hash(input.signedTransaction));expect(accepted.signedTransaction).toEqual(input.signedTransaction);
  }
 });
 it('refuses another wallet expectation even for a genuinely signed claim',()=>{const f=fixture();refused({...f.signed(),wallet:Keypair.generate().publicKey},'SIGNER');});
 it('refuses another valid claimant message rather than accepting fresh intent',()=>{const f=fixture(),other=fixture();refused({...f.signed(),signedTransaction:other.signed().signedTransaction},'MESSAGE');});
 it('refuses a re-signed recipient substitution',()=>{
  const f=fixture('claim');refused(resign(f,b=>{const claim=b.instructions[0]!;claim.keys[6]={...claim.keys[6]!,pubkey:Keypair.generate().publicKey};}),'MESSAGE');
 });
 it('refuses a re-signed proof substitution',()=>{
  const f=fixture('claim');refused(resign(f,b=>{const claim=b.instructions[0]!;claim.data[claim.data.length-1]=claim.data[claim.data.length-1]!^1;}),'MESSAGE');
 });
 it('refuses a re-signed fee change or appended spending instruction',()=>{
  const f=fixture('claim');refused(resign(f,b=>{b.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1}));}),'MESSAGE');
  refused(resign(f,b=>{b.instructions.push(SystemProgram.transfer({fromPubkey:f.signer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));}),'MESSAGE');
 });
 it('refuses changed blockhash and fee payer',()=>{
  const f=fixture('claim');refused(resign(f,b=>{b.recentBlockhash=Keypair.generate().publicKey.toBase58();}),'MESSAGE');
  const input=f.signed(),payer=Keypair.generate(),b=TransactionMessage.decompile(Message.from(input.intentBytes));b.payerKey=payer.publicKey;
  const tx=new VersionedTransaction(b.compileToLegacyMessage());tx.sign([payer,f.signer]);refused({...input,signedTransaction:tx.serialize()},'WIRE');
 });
 it('requires the actual signature, not a placeholder or altered signature bytes',()=>{
  const f=fixture(),input=f.signed(),missing=new VersionedTransaction(Message.from(input.intentBytes)).serialize(),tampered=Uint8Array.from(input.signedTransaction);tampered[1]=tampered[1]!^1;
  refused({...input,signedTransaction:missing},'SIGNATURE');refused({...input,signedTransaction:tampered},'SIGNATURE');
 });
 it('refuses a valid multisignature intent even when supplied as the saved message',()=>{
  const f=fixture('claim'),second=Keypair.generate(),input=f.signed(),b=TransactionMessage.decompile(Message.from(input.intentBytes));
  b.instructions.push(new TransactionInstruction({programId:f.identity.programId,keys:[{pubkey:second.publicKey,isSigner:true,isWritable:false}],data:Buffer.alloc(0)}));
  const message=b.compileToLegacyMessage(),tx=new VersionedTransaction(message);tx.sign([f.signer,second]);refused({...input,intentBytes:message.serialize(),signedTransaction:tx.serialize()},'WIRE');
 });
 it('rejects a readonly sole signer even with a valid signature; the claimant must be writable payer',()=>{
  const f=fixture('claim'),input=f.signed(),message=Message.from(input.intentBytes);message.header.numReadonlySignedAccounts=1;
  const tx=new VersionedTransaction(message);tx.sign([f.signer]);refused({...input,intentBytes:message.serialize(),signedTransaction:tx.serialize()},'WIRE');
 });
 it('refuses versioned messages even without lookup tables',()=>{
  const f=fixture('claim'),input=f.signed(),message=TransactionMessage.decompile(Message.from(input.intentBytes)).compileToV0Message(),tx=new VersionedTransaction(message);tx.sign([f.signer]);
  refused({...input,intentBytes:message.serialize(),signedTransaction:tx.serialize()},'WIRE');
 });
 it('refuses noncanonical signature and account-vector lengths and trailing bytes',()=>{
  const f=fixture('claim'),input=f.signed(),wire=Buffer.from(input.signedTransaction),intent=Buffer.from(input.intentBytes);
  refused({...input,signedTransaction:Buffer.concat([Buffer.of(0x81,0),wire.subarray(1)])},'WIRE');
  const noncanonical=Buffer.concat([intent.subarray(0,3),Buffer.of(intent[3]!|0x80,0),intent.subarray(4)]);
  refused({...input,intentBytes:noncanonical,signedTransaction:Buffer.concat([wire.subarray(0,65),noncanonical])},'MESSAGE');
  refused({...input,intentBytes:Buffer.concat([intent,Buffer.of(0)]),signedTransaction:Buffer.concat([wire,Buffer.of(0)])},'MESSAGE');
 });
 it.each([0,1,64,65,100])('refuses truncated signed packet at %i bytes',length=>{const input=fixture().signed();refused({...input,signedTransaction:input.signedTransaction.slice(0,length)});});
 it('bounds packet and message bytes before constructing a Solana decoder',()=>{
  const input=fixture().signed(),message=vi.spyOn(Message,'from'),transaction=vi.spyOn(Transaction,'from');
  try{refused({...input,intentBytes:new Uint8Array(1168)},'INPUT');refused({...input,signedTransaction:new Uint8Array(1233)},'INPUT');expect(message).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();}finally{message.mockRestore();transaction.mockRestore();}
 });
 it('retains copied wire independently from caller buffers and all returned copies',()=>{
  const input=fixture('split').signed(),expected=Uint8Array.from(input.signedTransaction),result=verify(input),sha=result.wireSha256;
  input.intentBytes.fill(0);input.signedTransaction.fill(0);result.signedTransaction.fill(0);
  expect(result.signedTransaction).toEqual(expected);expect(result.wireSha256).toBe(sha);expect(Object.isFrozen(result)).toBe(true);
 });
});
