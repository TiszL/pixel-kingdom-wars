import {createHash,randomUUID} from 'node:crypto';
import {AddressLookupTableAccount,Keypair,Message,MessageV0,PublicKey,SystemProgram,Transaction,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import bs58 from 'bs58';
import {expect,it,vi} from 'vitest';
import {buildKeepEquipmentPaymentInstructions,buildKeepEquipmentPaymentMessage,type KeepEquipmentPaymentOriginal} from './keepEquipmentPayment';
import {KeepEquipmentPaymentWireError,verifyKeepEquipmentPaymentSignedWire as verify} from './keepEquipmentPaymentWire';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const limits={maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000};
function fixture(version:'legacy'|0='legacy',lut=false,createAta=false){
 const buyer=Keypair.generate(),seller=Keypair.generate().publicKey,mint=Keypair.generate().publicKey;
 const original:KeepEquipmentPaymentOriginal={reservationId:randomUUID(),buyer:buyer.publicKey.toBase58(),seller:seller.toBase58(),keepMint:mint.toBase58(),totalBaseUnits:1_000_001n,sellerAtaExists:!createAta,...(createAta?{sellerAtaRentCapLamports:2_039_280n}:{})};
 const blockhash=Keypair.generate().publicKey.toBase58(),prepared=buildKeepEquipmentPaymentMessage(original,limits,blockhash,version);
 const table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,addresses:[getAssociatedTokenAddressSync(mint,buyer.publicKey),getAssociatedTokenAddressSync(mint,seller),mint]}});
 const message=lut?new TransactionMessage({payerKey:buyer.publicKey,recentBlockhash:blockhash,instructions:buildKeepEquipmentPaymentInstructions(original,limits)}).compileToV0Message([table]):version==='legacy'?Message.from(prepared.messageBytes):MessageV0.deserialize(prepared.messageBytes);
 const tx=new VersionedTransaction(message);tx.sign([buyer]);
 const input={preparedMessageBytes:Uint8Array.from(message.serialize()),signedTransaction:tx.serialize(),buyer:buyer.publicKey};
 function changed(mutate:(builder:TransactionMessage)=>void){
  const b=TransactionMessage.decompile(message,lut?{addressLookupTableAccounts:[table]}:undefined);mutate(b);
  const other=new VersionedTransaction(version==='legacy'?b.compileToLegacyMessage():b.compileToV0Message(lut?[table]:[]));other.sign([buyer]);
  return {...input,signedTransaction:other.serialize()};
 }
 return {buyer,seller,mint,original,prepared,table,tx,input,changed};
}
function refused(input:Parameters<typeof verify>[0],code?:string){
 expect(()=>verify(input)).toThrowError(KeepEquipmentPaymentWireError);
 try{verify(input);}catch(error){expect(error).toMatchObject({...(code?{code}:{}),fenceReleaseAuthorized:false,unpaidProven:false});}
}

it.each((['legacy',0] as const).flatMap(version=>[false,true].flatMap(createAta=>(version===0?[false,true]:[false]).map(lut=>({version,createAta,lut})))))('accepts genuine exact KEEP $version LUT=$lut ATA=$createAta consent',({version,createAta,lut})=>{
 const f=fixture(version,lut,createAta),proof=verify(f.input);
 expect(proof.version).toBe(version);expect(proof.signature).toBe(bs58.encode(f.tx.signatures[0]!));expect(proof.wireSha256).toBe(hash(f.input.signedTransaction));expect(proof.messageSha256).toBe(hash(f.input.preparedMessageBytes));
 expect(proof.signedTransaction).toEqual(f.input.signedTransaction);expect(proof).toMatchObject({finalityVerified:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false});
});
it.each((['legacy',0] as const).flatMap(version=>(['blockhash','amount','memo','seller','extra spend'] as const).map(change=>({version,change}))))('refuses genuinely re-signed $version $change changes without replacing saved intent',({version,change})=>{
 const f=fixture(version);const original=Uint8Array.from(f.input.preparedMessageBytes),signed=Uint8Array.from(f.input.signedTransaction);
 const changed=f.changed(b=>{
  if(change==='blockhash')b.recentBlockhash=Keypair.generate().publicKey.toBase58();
  if(change==='amount')b.instructions[0]!.data.writeBigUInt64LE(900_001n,1);
  if(change==='memo')b.instructions[2]!.data=Buffer.from('pkw:keep-market:'+randomUUID());
  if(change==='seller')b.instructions[0]!.keys[2]!.pubkey=Keypair.generate().publicKey;
  if(change==='extra spend')b.instructions.push(SystemProgram.transfer({fromPubkey:f.buyer.publicKey,toPubkey:f.seller,lamports:1}));
 });
 refused(changed,'MESSAGE');expect(f.input.preparedMessageBytes).toEqual(original);expect(verify(f.input).signedTransaction).toEqual(signed);
});
it.each(['table address','lookup index'] as const)('refuses a re-signed v0 %s change',kind=>{
 const f=fixture(0,true),m=MessageV0.deserialize(f.input.preparedMessageBytes);
 if(kind==='table address')m.addressTableLookups[0]!.accountKey=Keypair.generate().publicKey;
 else m.addressTableLookups[0]!.writableIndexes[0]=(m.addressTableLookups[0]!.writableIndexes[0]!+1)%3;
 const tx=new VersionedTransaction(m);tx.sign([f.buyer]);refused({...f.input,signedTransaction:tx.serialize()},'MESSAGE');
});
it.each(['legacy',0] as const)('requires the original sole writable buyer and genuine %s signature',version=>{
 const f=fixture(version),bad=Uint8Array.from(f.input.signedTransaction);bad[1]=bad[1]!^1;
 refused({...f.input,buyer:Keypair.generate().publicKey},'SIGNER');refused({...f.input,signedTransaction:new VersionedTransaction(f.tx.message).serialize()},'SIGNATURE');refused({...f.input,signedTransaction:bad},'SIGNATURE');
 const readonly=version==='legacy'?Message.from(f.input.preparedMessageBytes):MessageV0.deserialize(f.input.preparedMessageBytes);readonly.header.numReadonlySignedAccounts=1;
 const tx=new VersionedTransaction(readonly);tx.sign([f.buyer]);refused({...f.input,preparedMessageBytes:readonly.serialize(),signedTransaction:tx.serialize()},'WIRE');
 const second=Keypair.generate(),b=TransactionMessage.decompile(f.tx.message);b.instructions.push(new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:second.publicKey,isSigner:true,isWritable:false}],data:Buffer.alloc(0)}));
 const multi=new VersionedTransaction(version==='legacy'?b.compileToLegacyMessage():b.compileToV0Message());multi.sign([f.buyer,second]);refused({...f.input,preparedMessageBytes:multi.message.serialize(),signedTransaction:multi.serialize()},'WIRE');
});
it.each(['legacy',0] as const)('refuses malformed %s vectors, trailing bytes and truncated packets',version=>{
 const f=fixture(version),wire=Buffer.from(f.input.signedTransaction),message=Buffer.from(f.input.preparedMessageBytes),at=version==='legacy'?3:4;
 refused({...f.input,signedTransaction:Buffer.concat([Buffer.of(0x81,0),wire.subarray(1)])},'WIRE');
 const noncanonical=Buffer.concat([message.subarray(0,at),Buffer.of(message[at]!|0x80,0),message.subarray(at+1)]);
 refused({...f.input,preparedMessageBytes:noncanonical,signedTransaction:Buffer.concat([wire.subarray(0,65),noncanonical])},'MESSAGE');
 refused({...f.input,preparedMessageBytes:Buffer.concat([message,Buffer.of(0)]),signedTransaction:Buffer.concat([wire,Buffer.of(0)])},'MESSAGE');
 refused({...f.input,signedTransaction:Buffer.concat([wire,Buffer.of(0)])},'MESSAGE');
 for(const length of [0,1,64,65,66,100,wire.length-1])refused({...f.input,signedTransaction:wire.subarray(0,length)});
 const short=version==='legacy'?Buffer.of(1,0,0):Buffer.of(0x80,1,0,0);refused({...f.input,preparedMessageBytes:short,signedTransaction:Buffer.concat([wire.subarray(0,65),short])},'MESSAGE');
});
it('refuses future versions and a version substitution under an existing preparation',()=>{
 const f=fixture(0),message=Buffer.from(f.input.preparedMessageBytes);message[0]=0x81;
 refused({...f.input,preparedMessageBytes:message,signedTransaction:Buffer.concat([Buffer.from(f.input.signedTransaction).subarray(0,65),message])},'WIRE');
 refused({...f.input,signedTransaction:fixture('legacy').input.signedTransaction});
});
it('bounds both buffers before reaching either existing Solana decoder',()=>{
 const f=fixture(),legacy=vi.spyOn(Message,'from'),v0=vi.spyOn(MessageV0,'deserialize'),wire=vi.spyOn(VersionedTransaction,'deserialize'),transaction=vi.spyOn(Transaction,'from');
 try{
  refused({...f.input,preparedMessageBytes:new Uint8Array(1168)},'INPUT');refused({...f.input,signedTransaction:new Uint8Array(1233)},'INPUT');
  expect(legacy).not.toHaveBeenCalled();expect(v0).not.toHaveBeenCalled();expect(wire).not.toHaveBeenCalled();expect(transaction).not.toHaveBeenCalled();
 }finally{legacy.mockRestore();v0.mockRestore();wire.mockRestore();transaction.mockRestore();}
});
it.each(['legacy',0] as const)('retains immutable %s proof when original and returned buffers are mutated',version=>{
 const f=fixture(version),expected=Uint8Array.from(f.input.signedTransaction),proof=verify(f.input),sha=proof.wireSha256;
 f.input.preparedMessageBytes.fill(0);f.input.signedTransaction.fill(0);proof.signedTransaction.fill(0);
 expect(proof.signedTransaction).toEqual(expected);expect(proof.wireSha256).toBe(sha);expect(Object.isFrozen(proof)).toBe(true);
});
it('does not claim a signed rent-cap guarantee that SPL does not encode',()=>{
 const f=fixture('legacy',false,true),a=verify(f.input),differentCap=buildKeepEquipmentPaymentMessage({...f.original,sellerAtaRentCapLamports:1n},limits,f.tx.message.recentBlockhash);
 expect(differentCap.messageBytes).toEqual(f.input.preparedMessageBytes);expect(a).not.toHaveProperty('sellerAtaRentCapLamports');expect(a.deliveryAuthorized).toBe(false);
});
it('rejects malformed caller types and invalid buyer expectations',()=>{
 const f=fixture();for(const input of [null,[],{}, {...f.input,preparedMessageBytes:[]},{...f.input,signedTransaction:'00'},{...f.input,buyer:f.buyer.publicKey.toBase58()}])refused(input as Parameters<typeof verify>[0],'INPUT');
 refused({...f.input,buyer:PublicKey.default},'SIGNER');
});
