import {createHash} from 'node:crypto';
import {Keypair,Message,PublicKey,SystemProgram,Transaction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {describe,it,expect,vi} from 'vitest';
import type {GameWallet} from '../../auth/useGameWallet';
import {createRealmSalePurchaseArgs} from '../../../../../packages/chain/src/seekerRealmSaleProtocol';
import {buildRealmSaleMessage} from '../../../../../packages/chain/src/seekerRealmSaleMessage';
import idl from '../../../../../packages/chain/src/idl/shardkeep_economy.json' with {type:'json'};
import {RealmSalePreparationSchema,type RealmSalePreparationView} from '@shardkeep/shared/realmSalesApi';
import {prepareRealmSaleSigning,signRealmSale,verifySignedRealmSale,type RealmSaleSigningTrust} from './signing';
const key=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n));
function fixture(access=false,quota=false,alias='none'){
 const signer=key(1),other=key(2),dev=key(3),seller=alias==='buyer-seller'||alias==='all'?signer.publicKey:other.publicKey;
 const developer=alias==='buyer-dev'||alias==='all'?signer.publicKey:alias==='seller-dev'?seller:dev.publicKey;
 const args=createRealmSalePurchaseArgs({saleId:Buffer.alloc(16,5),spot:0,realm:0,round:0n,day:100n,seller,developer,priorExpiry:0n,validAfter:8_640_000n,validUntil:8_640_600n});
 const blockhash=key(4).publicKey.toBase58(),plan=buildRealmSaleMessage(new PublicKey(idl.address),{wallet:signer.publicKey,args,blockhash,needsAccess:access,needsQuota:quota});
 const rent=BigInt(plan.expectedNewAccounts.length)*1000n,fee=5000n,required=rent+fee+plan.buyerNetPaymentLamports;
 const p=RealmSalePreparationSchema.parse({version:1,wallet:signer.publicKey.toBase58(),idempotencyKey:'00000000-0000-4000-8000-000000000001',saleId:Buffer.from(args.saleId).toString('hex'),spot:0,realm:0,
  terms:{round:'0',day:'100',seller:seller.toBase58(),developer:developer.toBase58(),priorExpiry:'0',validAfter:args.validAfter.toString(),validUntil:args.validUntil.toString()},
  source:{revision:'test-r1',genesisHash:key(6).publicKey.toBase58(),programId:idl.address,programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:1,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:2,initialSlot:2,blockhashSlot:2,feeSlot:2,costSlot:2,admissionSlot:2},
  quote:{blockhash,lastValidBlockHeight:100,unixTimestamp:args.validAfter.toString(),needsAccess:access,needsQuota:quota,quotaRemaining:10,messageHex:Buffer.from(plan.messageBytes).toString('hex'),messageSha256:plan.messageSha256,packetBytes:plan.packetBytes,
   rents:plan.expectedNewAccounts.map(a=>({address:a.address,space:a.space,minimumBalanceLamports:'1000',existingLamports:'0',maxIncreaseLamports:'1000'})),feeLamports:fee.toString(),rentLamports:rent.toString(),paymentDebitLamports:plan.buyerNetPaymentLamports.toString(),requiredLamports:required.toString(),payerLamports:required.toString()},
  state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false});
 const trust:RealmSaleSigningTrust={genesisHash:p.source.genesisHash,programId:p.source.programId,developer:p.terms.developer,reviewedProgramDataSha256:p.source.programDataSha256,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,revision:p.source.revision};
 return {p,trust,signer};
}
function wallet(f:ReturnType<typeof fixture>,sign?:(tx:Transaction)=>Promise<Transaction>):GameWallet{return {publicKey:f.signer.publicKey,signMessage:null,isEmbedded:false,sendTransaction:vi.fn(),signTransaction:vi.fn(sign??(async tx=>{tx.partialSign(f.signer);return tx;}))};}
function replaceMessage(p:RealmSalePreparationView,bytes:Uint8Array){p.quote.messageHex=Buffer.from(bytes).toString('hex');p.quote.messageSha256=createHash('sha256').update(bytes).digest('hex');p.quote.packetBytes=bytes.length+65;}
describe('realm sale exact original sign-only wire',()=>{
 it.each([false,true].flatMap(access=>[false,true].flatMap(quota=>['none','buyer-seller','buyer-dev','seller-dev','all'].map(alias=>({access,quota,alias})))))('matches real SDK ABI and role aliases %j',async({access,quota,alias})=>{
  const f=fixture(access,quota,alias),w=wallet(f),prepared=await prepareRealmSaleSigning(f.p,f.trust),signed=await signRealmSale(prepared,w);expect(await verifySignedRealmSale(f.p,signed.wire)).toEqual(signed);expect(w.sendTransaction).not.toHaveBeenCalled();expect(w.signTransaction).toHaveBeenCalledTimes(1);expect(Transaction.from(Buffer.from(signed.wire,'base64')).verifySignatures()).toBe(true);
 });
 it.each(['genesisHash','programId','developer','reviewedProgramDataSha256','reviewedDeploymentSlot','revision'] as const)('requires independent trust pin %s',async name=>{
  const f=fixture(),value=name==='reviewedDeploymentSlot'?9:name==='reviewedProgramDataSha256'?'00'.repeat(32):name==='revision'?'other':key(9).publicKey.toBase58();await expect(prepareRealmSaleSigning(f.p,{...f.trust,[name]:value})).rejects.toThrow(/TRUST/);
 });
 it('refuses substituted instructions, accounts, amount, payer, privileges and setup order even with recomputed hash',async()=>{
  for(const change of [(tx:Transaction)=>tx.add(SystemProgram.transfer({fromPubkey:tx.feePayer!,toPubkey:key(8).publicKey,lamports:1})),(tx:Transaction)=>{tx.instructions.at(-1)!.keys[10]!.pubkey=key(8).publicKey;},(tx:Transaction)=>{tx.instructions.at(-1)!.data[93]=tx.instructions.at(-1)!.data[93]!^1;},(tx:Transaction)=>{tx.instructions.at(-1)!.keys[1]!.isWritable=true;},(tx:Transaction)=>{tx.feePayer=key(8).publicKey;},(tx:Transaction)=>{[tx.instructions[0],tx.instructions[1]]=[tx.instructions[1]!,tx.instructions[0]!];}]){
   const f=fixture(true,true),tx=Transaction.populate(Message.from(Buffer.from(f.p.quote.messageHex,'hex')));change(tx);replaceMessage(f.p,tx.serializeMessage());await expect(prepareRealmSaleSigning(f.p,f.trust)).rejects.toThrow();
  }
 });
 it('binds displayed terms, byte hash, packet size and canonical rent allocation addresses/order',async()=>{
  for(const change of [(p:RealmSalePreparationView)=>{p.terms.seller=key(8).publicKey.toBase58();},(p:RealmSalePreparationView)=>{p.terms.priorExpiry='1';},(p:RealmSalePreparationView)=>{p.quote.messageSha256='00'.repeat(32);},(p:RealmSalePreparationView)=>{p.quote.packetBytes++;},(p:RealmSalePreparationView)=>{p.quote.rents[0]!.address=key(8).publicKey.toBase58();},(p:RealmSalePreparationView)=>{p.quote.rents.reverse();}]){const f=fixture(true,true);change(f.p);await expect(prepareRealmSaleSigning(f.p,f.trust)).rejects.toThrow();}
 });
 it('rejects versioned, oversized, malformed and unsigned inputs before arbitrary decoding',async()=>{
  const f=fixture(),message=Message.from(Buffer.from(f.p.quote.messageHex,'hex')),tx=Transaction.populate(message);replaceMessage(f.p,new TransactionMessage({payerKey:f.signer.publicKey,recentBlockhash:message.recentBlockhash,instructions:tx.instructions}).compileToV0Message().serialize());await expect(prepareRealmSaleSigning(f.p,f.trust)).rejects.toThrow();
  for(const raw of ['A'.repeat(1648),'!!!!','AQ==',null,{wire:'AA=='}])await expect(verifySignedRealmSale(fixture().p,raw)).rejects.toThrow();
  const g=fixture();g.p.quote.rents=Array(10000).fill(g.p.quote.rents[0]);await expect(prepareRealmSaleSigning(g.p,g.trust)).rejects.toThrow(/INPUT/);
  const unsigned=Buffer.from(new VersionedTransaction(Message.from(Buffer.from(fixture().p.quote.messageHex,'hex'))).serialize()).toString('base64');await expect(verifySignedRealmSale(fixture().p,unsigned)).rejects.toThrow(/SIGNATURE/);
 });
 it('rejects corrupted signature, different original wire and unsupported wallet/opaque handles',async()=>{
  const f=fixture(),prepared=await prepareRealmSaleSigning(f.p,f.trust),signed=await signRealmSale(prepared,wallet(f)),bytes=Buffer.from(signed.wire,'base64');bytes[1]=bytes[1]!^1;await expect(verifySignedRealmSale(f.p,bytes.toString('base64'))).rejects.toThrow(/SIGNATURE/);
  const g=fixture(true);await expect(verifySignedRealmSale(g.p,signed.wire)).rejects.toThrow(/MESSAGE/);await expect(signRealmSale({...prepared},wallet(f))).rejects.toThrow(/INPUT/);
  const wrong=wallet(f);wrong.publicKey=key(8).publicKey;await expect(signRealmSale(prepared,wrong)).rejects.toThrow(/WALLET/);expect(wrong.signTransaction).not.toHaveBeenCalled();await expect(signRealmSale(prepared,{...wallet(f),signTransaction:null})).rejects.toThrow(/WALLET/);
 });
 it('rejects oversized wallet signature bytes before serialization',async()=>{const f=fixture(),serialize=vi.fn(),w=wallet(f,async tx=>{tx.signatures[0]!.signature=Buffer.alloc(100000);tx.serialize=serialize;return tx;});await expect(signRealmSale(await prepareRealmSaleSigning(f.p,f.trust),w)).rejects.toThrow(/MESSAGE/);expect(serialize).not.toHaveBeenCalled();});
 it('bounds wallet mutations before serializing and retains a valid late signature despite caller/account changes',async()=>{
  const f=fixture(),serialize=vi.fn(),w=wallet(f,async tx=>{tx.recentBlockhash='1'.repeat(100000);tx.serializeMessage=serialize;return tx;});await expect(signRealmSale(await prepareRealmSaleSigning(f.p,f.trust),w)).rejects.toThrow(/MESSAGE/);expect(serialize).not.toHaveBeenCalled();
  const original=structuredClone(f.p),promise=prepareRealmSaleSigning(f.p,f.trust);f.p.terms.seller=key(8).publicKey.toBase58();(f.trust as {developer:string}).developer=key(8).publicKey.toBase58();const prepared=await promise;
  const late=wallet(f,async tx=>{late.publicKey=null;tx.partialSign(f.signer);return tx;});expect(await verifySignedRealmSale(original,(await signRealmSale(prepared,late)).wire)).toHaveProperty('signature');expect(late.sendTransaction).not.toHaveBeenCalled();
 });
});
