/** Real D166 packets and ephemeral payer signatures, not a generic v0 transfer. */
import {createHash} from 'node:crypto';
import {ComputeBudgetProgram,Keypair,MessageV0,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,expect,it,vi} from 'vitest';
import {buildCharterCreationPacket} from './charterCreationPreparation';
import {candidateFor,lookupFixture,preparationFixture,sign} from './testFixtures/charterPreparation';
import {CharterCreationWireError,verifyCharterCreationSignedWire as verify} from './charterCreationWire';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const f=preparationFixture(),payer=Keypair.generate(),original={...f.original,payer:payer.publicKey.toBase58()},candidate=candidateFor(original),lookup=lookupFixture(original,candidate);
 const prepared=buildCharterCreationPacket({...f.input,original,candidate,lookupTable:lookup.row,expectedLookupTable:lookup.pin,policySignature:sign(f.policy,candidate)});
 const tx=VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransactionHex,'hex'));tx.sign([payer]);
 const input={intentBytes:Buffer.from(prepared.messageHex,'hex'),signedTransaction:tx.serialize(),wallet:payer.publicKey};
 function changed(mutate:(builder:TransactionMessage)=>void){
  const builder=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:[lookup.table()]});mutate(builder);
  const other=new VersionedTransaction(builder.compileToV0Message([lookup.table()]));other.sign([payer]);return {...input,signedTransaction:other.serialize()};
 }
 return {payer,original,lookup,prepared,tx,input,changed};
}
function refused(input:Parameters<typeof verify>[0],code?:string){
 expect(()=>verify(input)).toThrowError(CharterCreationWireError);
 if(code)expect(()=>verify(input)).toThrowError(expect.objectContaining({code}));
}

describe('exact original Charter v0 wallet consent',()=>{
 it('accepts the sole original payer signature on the actual prepared Charter packet',()=>{
  const f=fixture(),receipt=verify(f.input);
  expect(f.tx.version).toBe(0);expect(f.tx.message.addressTableLookups).toHaveLength(1);
  expect(receipt.signature).toBe(bs58.encode(f.tx.signatures[0]!));expect(receipt.wireSha256).toBe(hash(f.input.signedTransaction));
  expect(receipt.messageSha256).toBe(f.prepared.messageSha256);expect(receipt.signedTransaction).toEqual(f.input.signedTransaction);
 });
 it('requires the specified original payer rather than any valid signature',()=>{
  const f=fixture();refused({...f.input,wallet:Keypair.generate().publicKey},'SIGNER');
 });
 it('rejects a different genuinely signed Charter packet without replacing the original intent',()=>{
  const f=fixture(),other=fixture();refused({...f.input,signedTransaction:other.input.signedTransaction},'MESSAGE');
 });
 it('rejects re-signed blockhash, policy signature, instruction and spending changes',()=>{
  const f=fixture();
  for(const mutate of [
   (b:TransactionMessage)=>{b.recentBlockhash=Keypair.generate().publicKey.toBase58();},
   (b:TransactionMessage)=>{b.instructions[1]!.data[48]=b.instructions[1]!.data[48]!^1;},
   (b:TransactionMessage)=>{b.instructions[2]!.data[8]=b.instructions[2]!.data[8]!^1;},
   (b:TransactionMessage)=>{b.instructions.reverse();},
   (b:TransactionMessage)=>{b.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1}));},
   (b:TransactionMessage)=>{b.instructions.push(SystemProgram.transfer({fromPubkey:f.payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}));},
  ])refused(f.changed(mutate),'MESSAGE');
 });
 it('rejects a re-signed lookup table or loaded-address index substitution',()=>{
  for(const field of ['accountKey','writableIndexes','readonlyIndexes'] as const){
   const f=fixture(),message=MessageV0.deserialize(f.input.intentBytes),lookup=message.addressTableLookups[0]!;
   if(field==='accountKey')lookup.accountKey=Keypair.generate().publicKey;
   else lookup[field][0]=(lookup[field][0]!+1)%f.lookup.keys.length;
   const tx=new VersionedTransaction(message);tx.sign([f.payer]);refused({...f.input,signedTransaction:tx.serialize()},'MESSAGE');
  }
 });
 it('requires genuine Ed25519 instead of a zero or altered wallet signature',()=>{
  const f=fixture(),zero=new VersionedTransaction(f.tx.message).serialize(),altered=Uint8Array.from(f.input.signedTransaction);altered[1]=altered[1]!^1;
  refused({...f.input,signedTransaction:zero},'SIGNATURE');refused({...f.input,signedTransaction:altered},'SIGNATURE');
 });
 it('does not accept a valid legacy transaction or unknown message version as v0 consent',()=>{
  const f=fixture(),legacy=new TransactionMessage({payerKey:f.payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1})]}).compileToLegacyMessage();
  const tx=new VersionedTransaction(legacy);tx.sign([f.payer]);refused({...f.input,intentBytes:legacy.serialize(),signedTransaction:tx.serialize()},'WIRE');
  const intent=Buffer.from(f.input.intentBytes);intent[0]=0x81;
  refused({...f.input,intentBytes:intent,signedTransaction:Buffer.concat([Buffer.from(f.input.signedTransaction).subarray(0,65),intent])},'WIRE');
 });
 it('rejects multisignature and readonly payer messages even when offered as the expected intent',()=>{
  const f=fixture(),second=Keypair.generate(),builder=TransactionMessage.decompile(f.tx.message,{addressLookupTableAccounts:[f.lookup.table()]});
  builder.instructions.push(new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:second.publicKey,isSigner:true,isWritable:false}],data:Buffer.alloc(0)}));
  const multi=new VersionedTransaction(builder.compileToV0Message([f.lookup.table()]));multi.sign([f.payer,second]);
  refused({...f.input,intentBytes:multi.message.serialize(),signedTransaction:multi.serialize()},'WIRE');
  const readonly=MessageV0.deserialize(f.input.intentBytes);readonly.header.numReadonlySignedAccounts=1;
  const tx=new VersionedTransaction(readonly);tx.sign([f.payer]);refused({...f.input,intentBytes:readonly.serialize(),signedTransaction:tx.serialize()},'WIRE');
 });
 it('rejects noncanonical signature and static-account vectors and trailing bytes',()=>{
  const f=fixture(),wire=Buffer.from(f.input.signedTransaction),intent=Buffer.from(f.input.intentBytes);
  refused({...f.input,signedTransaction:Buffer.concat([Buffer.of(0x81,0),wire.subarray(1)])},'WIRE');
  const noncanonical=Buffer.concat([intent.subarray(0,4),Buffer.of(intent[4]!|0x80,0),intent.subarray(5)]);
  refused({...f.input,intentBytes:noncanonical,signedTransaction:Buffer.concat([wire.subarray(0,65),noncanonical])},'MESSAGE');
  refused({...f.input,intentBytes:Buffer.concat([intent,Buffer.of(0)]),signedTransaction:Buffer.concat([wire,Buffer.of(0)])},'MESSAGE');
  refused({...f.input,signedTransaction:Buffer.concat([wire,Buffer.of(0)])},'MESSAGE');
 });
 it('rejects truncated signatures and v0 messages instead of exposing partial consent',()=>{
  const f=fixture();for(const length of [0,1,64,65,66,100,f.input.signedTransaction.length-1])refused({...f.input,signedTransaction:f.input.signedTransaction.slice(0,length)});
  const short=Buffer.of(0x80,1,0,0);refused({...f.input,intentBytes:short,signedTransaction:Buffer.concat([Buffer.from(f.input.signedTransaction).subarray(0,65),short])},'MESSAGE');
 });
 it('bounds both inputs before decoding attacker-controlled Solana vectors',()=>{
  const f=fixture(),message=vi.spyOn(MessageV0,'deserialize'),transaction=vi.spyOn(VersionedTransaction,'deserialize');
  try{refused({...f.input,intentBytes:new Uint8Array(1168)},'INPUT');refused({...f.input,signedTransaction:new Uint8Array(1233)},'INPUT');
   expect(message).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
  }finally{message.mockRestore();transaction.mockRestore();}
 });
 it('owns caller inputs and returns detached wire copies without mutable receipt fields',()=>{
  const f=fixture(),expected=Uint8Array.from(f.input.signedTransaction),receipt=verify(f.input),sha=receipt.wireSha256;
  f.input.intentBytes.fill(0);f.input.signedTransaction.fill(0);receipt.signedTransaction.fill(0);
  expect(receipt.signedTransaction).toEqual(expected);expect(receipt.wireSha256).toBe(sha);expect(Object.isFrozen(receipt)).toBe(true);
 });
 it('rejects malformed input types and a non-PublicKey wallet expectation',()=>{
  const f=fixture();
  for(const input of [null,{}, {...f.input,intentBytes:[]},{...f.input,signedTransaction:'00'},{...f.input,wallet:f.payer.publicKey.toBase58()}])
   refused(input as Parameters<typeof verify>[0],'INPUT');
  refused({...f.input,wallet:PublicKey.default},'SIGNER');
 });
});
