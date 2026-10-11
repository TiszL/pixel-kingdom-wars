import {describe,expect,it} from 'vitest';
import {Message,PublicKey,SystemProgram,Transaction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {realmSaleReceiptFixture} from './testFixtures/seekerRealmSaleReceipt';
import {verifyRealmSaleTransactionEvidence} from './seekerRealmSaleReceipt';
describe('exact original realm sale transaction evidence',()=>{
 it.each([[false,false],[true,false],[false,true],[true,true]])('proves original payment with setup %s/%s without inferring finality',async(needsAccess,needsQuota)=>{
  const f=await realmSaleReceiptFixture({needsAccess,needsQuota}),r=verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,f.expected);
  expect(r).toMatchObject({signature:f.signature,transactionEvidenceVerified:true,finalityVerified:false,paymentAuthorized:false,feeLamports:'5000'});
  expect(r.actualRentLamports).toBe((BigInt(f.plan.expectedNewAccounts.length)*1000000n).toString());expect(r.receipt.acceptedAt).toBe(f.expected.args.validAfter);
 });
 it.each(['seller','developer','both','recipients','new-access'] as const)('conserves aggregate %s aliases including rent-funded PDA recipients',async alias=>{
  const f=await realmSaleReceiptFixture({alias}),r=verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,f.expected);
  expect(r.buyerNetPaymentLamports).toBe(f.plan.buyerNetPaymentLamports.toString());expect(r.actualRentLamports).toBe('3000000');
 });
 it('uses historical rent increases on prefunded PDAs, never later receipt lamports or blockTime equality',async()=>{
  const f=await realmSaleReceiptFixture({prefunded:true});f.transaction.blockTime=null;
  expect(verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,f.expected).actualRentLamports).toBe('3000000');
 });
 it('distinguishes unavailable transaction/metadata from an exact failed transaction',async()=>{
  const f=await realmSaleReceiptFixture();expect(()=>verifyRealmSaleTransactionEvidence(null,f.receipt,f.expected)).toThrow(expect.objectContaining({code:'UNAVAILABLE'}));
  expect(()=>verifyRealmSaleTransactionEvidence({...f.transaction,meta:null},f.receipt,f.expected)).toThrow(expect.objectContaining({code:'UNAVAILABLE'}));
  f.transaction.meta!.err={InstructionError:[0,'AccountAlreadyInitialized']};expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,f.expected)).toThrow(expect.objectContaining({code:'FAILED'}));
 });
 it('rejects changed retained message, fake signature, signer and canonical packet violations',async()=>{
  const f=await realmSaleReceiptFixture(),bad=Uint8Array.from(f.expected.signedTransaction);bad[1]=bad[1]!^1;
  for(const patch of [{signedTransaction:bad},{signedTransaction:new Uint8Array(1233)},{preparedMessageBytes:new Uint8Array(1000000)},
   {wallet:SystemProgram.programId},{args:{...f.expected.args,saleId:Buffer.alloc(16,9)}},{unexpected:true}])expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,{...f.expected,...patch} as never)).toThrow();
 });
 it('rejects substituted body bytes/signature, ALT, missing signer header and oversized encoded instruction before decoding',async()=>{
  for(const mutation of ['signature','header','instruction','oversized','alt'] as const){const f=await realmSaleReceiptFixture();
   const m=f.transaction.transaction.message as Message;
   if(mutation==='signature')f.transaction.transaction.signatures[0]='1'.repeat(64);
   if(mutation==='header')m.header.numRequiredSignatures=0;
   if(mutation==='instruction')m.instructions[0]!.accounts.reverse();
   if(mutation==='oversized')m.instructions[0]!.data='2'.repeat(1000000);
   if(mutation==='alt')f.transaction.meta!.loadedAddresses={writable:[new PublicKey(Buffer.alloc(32,8))],readonly:[]};
   expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,f.expected)).toThrow();
  }
 });
 it('rejects an extra signed transfer even when retained bytes and RPC body agree',async()=>{
  const f=await realmSaleReceiptFixture(),original=Message.from(f.plan.messageBytes),tx=new VersionedTransaction(new TransactionMessage({payerKey:f.buyer.publicKey,recentBlockhash:original.recentBlockhash,
   instructions:[...Transaction.populate(original).instructions,SystemProgram.transfer({fromPubkey:f.buyer.publicKey,toPubkey:f.expected.args.seller,lamports:1})]}).compileToLegacyMessage());
  tx.sign([f.buyer]);expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,{...f.expected,preparedMessageBytes:tx.message.serialize(),signedTransaction:tx.serialize()})).toThrow();
 });
 it('requires safe transaction/deployment/context order and on-chain receipt Clock no later than the proof Clock',async()=>{
  const f=await realmSaleReceiptFixture();
  for(const patch of [{reviewedDeploymentSlot:101},{minContextSlot:102},{observedAccountSlot:100},{proofClockUnixTimestamp:f.expected.args.validAfter-1n}])expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,{...f.expected,...patch})).toThrow();
  for(const slot of [-1,Number.MAX_SAFE_INTEGER+1,NaN])expect(()=>verifyRealmSaleTransactionEvidence({...f.transaction,slot},f.receipt,f.expected)).toThrow();
 });
 it('refuses wrong account owner/address, trailing bytes and receipt consent substitution',async()=>{
  const f=await realmSaleReceiptFixture();for(const patch of [{owner:SystemProgram.programId},{address:SystemProgram.programId},{data:Buffer.concat([f.receipt.data,Buffer.of(0)])}])expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,{...f.receipt,...patch},f.expected)).toThrow();
  const changed=await f.reencode({seller:new PublicKey(Buffer.alloc(32,9))});expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,changed,f.expected)).toThrow();
 });
 it('rejects unapproved rent, missing/duplicate rent accounts, hidden debit, unsafe balance and invalid CPI',async()=>{
  for(const mutation of ['cap','missing','duplicate','debit','unsafe','cpi'] as const){const f=await realmSaleReceiptFixture();
   if(mutation==='cap')f.expected.newAccountRentCaps[0]!.maxIncreaseLamports=999999n;
   if(mutation==='missing')f.expected.newAccountRentCaps.pop();
   if(mutation==='duplicate')f.expected.newAccountRentCaps[1]=f.expected.newAccountRentCaps[0]!;
   if(mutation==='debit')f.transaction.meta!.postBalances[0]!-=1;
   if(mutation==='unsafe')f.transaction.meta!.preBalances[1]=Number.MAX_SAFE_INTEGER+1;
   if(mutation==='cpi')f.transaction.meta!.innerInstructions![0]!.instructions[0]!.data='1';
   expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,f.expected)).toThrow();
  }
 });
 it('recovers an expired original quote without current owner/pause fields and keeps returned evidence immutable',async()=>{
  const f=await realmSaleReceiptFixture(),r=verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,{...f.expected,proofClockUnixTimestamp:f.expected.args.validAfter+1000000n});
  expect(r.receipt.expiresAt>r.receipt.acceptedAt).toBe(true);expect(Object.isFrozen(r)).toBe(true);expect(Object.isFrozen(r.receipt)).toBe(true);
 });
 it('does not misclassify missing success metadata or missing CPI history as a failed purchase',async()=>{
  const f=await realmSaleReceiptFixture();
  for(const patch of [{err:undefined},{innerInstructions:null}])expect(()=>verifyRealmSaleTransactionEvidence({...f.transaction,meta:{...f.transaction.meta!,...patch}} as never,f.receipt,f.expected)).toThrow(expect.objectContaining({code:'UNAVAILABLE'}));
 });
 it('rejects conserved but wrong-recipient extra payment and an extra hidden System transfer',async()=>{
  const f=await realmSaleReceiptFixture(),index=(f.transaction.transaction.message as Message).accountKeys.findIndex(k=>k.equals(f.expected.args.seller));
  f.transaction.meta!.postBalances[0]!-=1;f.transaction.meta!.postBalances[index]!+=1;
  expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,f.expected)).toThrow(expect.objectContaining({code:'PAYMENT'}));
  const g=await realmSaleReceiptFixture(),last=g.transaction.meta!.innerInstructions!.at(-1)!;
  last.instructions.push(last.instructions.at(-1)!);expect(()=>verifyRealmSaleTransactionEvidence(g.transaction,g.receipt,g.expected)).toThrow();
 });
 it('rejects noncanonical raw instruction encodings and absent signer headers instead of trusting RPC serialize',async()=>{
  for(const mutation of ['noncanonical','missing-header','fake-serialize'] as const){const f=await realmSaleReceiptFixture(),m=f.transaction.transaction.message as Message;
   if(mutation==='noncanonical')m.instructions[0]!.data='0';
   if(mutation==='missing-header')(m as unknown as {header:unknown}).header=undefined;
   if(mutation==='fake-serialize'){m.instructions[0]!.accounts.reverse();m.serialize=()=>Buffer.from(f.plan.messageBytes);}
   expect(()=>verifyRealmSaleTransactionEvidence(f.transaction,f.receipt,f.expected)).toThrow();
  }
 });
});
