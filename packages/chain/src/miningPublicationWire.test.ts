import { createHash } from 'node:crypto';
import { ComputeBudgetProgram,Keypair,Message,PublicKey,Transaction,TransactionInstruction,TransactionMessage,VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe,expect,it,vi } from 'vitest';
import { buildPublishMiningInstruction,MINING_PROGRAM_ADDRESS } from './miningProgramProtocol';
import { MiningPublicationWireError,verifyMiningPublicationSignedWire as verify } from './miningPublicationWire';
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function fixture(version:'legacy'|0='legacy',extraSigner=false){
 const signer=Keypair.generate(),second=Keypair.generate(),identity={programId:new PublicKey(MINING_PROGRAM_ADDRESS),keepMint:Keypair.generate().publicKey,reserveOwner:Keypair.generate().publicKey};
 const publication=buildPublishMiningInstruction(identity,{signer:signer.publicKey,args:{sequence:1n,day:100n,kind:0,root:Buffer.alloc(32,3),totalCumulative:4n,leafCount:1,budgetGross:100n,freeGross:5n,deedGross:0n,sourceHash:Buffer.alloc(32,4),taxCommitment:Buffer.alloc(32,5),taxVersion:1}});
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),publication];
 if(extraSigner)instructions.push(new TransactionInstruction({programId:identity.programId,keys:[{pubkey:second.publicKey,isSigner:true,isWritable:false}],data:Buffer.alloc(0)}));
 const builder=new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions});
 const message=version==='legacy'?builder.compileToLegacyMessage():builder.compileToV0Message(),signed=new VersionedTransaction(message);
 signed.sign(extraSigner?[signer,second]:[signer]);
 return {input:{intentBytes:message.serialize(),signedTransaction:signed.serialize(),signer:signer.publicKey},signed,message};
}
function refused(input:Parameters<typeof verify>[0],code?:string){expect(()=>verify(input)).toThrowError(MiningPublicationWireError);if(code)expect(()=>verify(input)).toThrowError(expect.objectContaining({code}));}
describe('mining publication exact signed wire',()=>{
 it('verifies the generated publisher signature over the exact retained legacy publication message',()=>{
  const f=fixture(),result=verify(f.input);
  expect(result.signature).toBe(bs58.encode(f.signed.signatures[0]!));expect(result.wireSha256).toBe(hash(f.input.signedTransaction));expect(result.messageSha256).toBe(hash(f.input.intentBytes));
  expect(result.signedTransaction).toEqual(f.input.signedTransaction);expect(Object.isFrozen(result)).toBe(true);
 });
 it('rejects another expected publisher even when the packet has a valid signature',()=>{const f=fixture();refused({...f.input,signer:Keypair.generate().publicKey},'SIGNER');});
 it('rejects another valid signed publication instead of accepting a new message',()=>{const a=fixture(),b=fixture();refused({...a.input,signedTransaction:b.input.signedTransaction},'MESSAGE');});
 it('refuses an omitted or altered signature without consulting external chain state',()=>{
  const f=fixture(),empty=new VersionedTransaction(f.message).serialize(),tampered=Uint8Array.from(f.input.signedTransaction);tampered[1]=tampered[1]!^1;
  refused({...f.input,signedTransaction:empty},'SIGNATURE');refused({...f.input,signedTransaction:tampered},'SIGNATURE');
 });
 it('refuses a valid two-signer transaction; the admitted publisher is the sole fee payer/signature',()=>{const f=fixture('legacy',true);refused(f.input,'WIRE');});
 it('refuses versioned messages even when no address lookup is needed',()=>{refused(fixture(0).input,'WIRE');});
 it('refuses noncanonical signature-count and message-vector encodings',()=>{
  const f=fixture(),wire=Buffer.from(f.input.signedTransaction),intent=Buffer.from(f.input.intentBytes);
  refused({...f.input,signedTransaction:Buffer.concat([Buffer.of(0x81,0),wire.subarray(1)])},'WIRE');
  const noncanonical=Buffer.concat([intent.subarray(0,3),Buffer.of(intent[3]!|0x80,0),intent.subarray(4)]);
  refused({...f.input,intentBytes:noncanonical,signedTransaction:Buffer.concat([wire.subarray(0,65),noncanonical])},'MESSAGE');
 });
 it.each([0,1,64,65,100])('refuses truncated packet length %i',length=>{const f=fixture();refused({...f.input,signedTransaction:f.input.signedTransaction.slice(0,length)});});
 it('refuses trailing bytes even when supplied in both the intent and packet',()=>{
  const f=fixture();refused({...f.input,intentBytes:Buffer.concat([f.input.intentBytes,Buffer.of(0)]),signedTransaction:Buffer.concat([f.input.signedTransaction,Buffer.of(0)])},'MESSAGE');
 });
 it('bounds oversized input before either message or transaction constructor',()=>{
  const f=fixture(),message=vi.spyOn(Message,'from'),transaction=vi.spyOn(Transaction,'from');
  try{
   refused({...f.input,intentBytes:new Uint8Array(1233)},'INPUT');refused({...f.input,signedTransaction:new Uint8Array(1233)},'INPUT');
   expect(message).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
  }finally{message.mockRestore();transaction.mockRestore();}
 });
 it('owns retained bytes independently of input buffers and every returned buffer',()=>{
  const f=fixture(),expected=Uint8Array.from(f.input.signedTransaction),result=verify(f.input),signature=result.signature;
  f.input.intentBytes.fill(0);f.input.signedTransaction.fill(0);expect(result.signedTransaction).toEqual(expected);
  const copy=result.signedTransaction;copy.fill(0);expect(result.signedTransaction).toEqual(expected);expect(result.signature).toBe(signature);expect(result.wireSha256).toBe(hash(expected));
 });
});
