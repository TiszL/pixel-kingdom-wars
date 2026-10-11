import {describe,it,expect} from 'vitest';
import {Keypair,PublicKey,Message,Transaction,VersionedTransaction} from '@solana/web3.js';
import {PHASE_E_MINING_PUBLICATION,PHASE_E_POLICY} from '@shardkeep/shared';
import idl from './idl/shardkeep_economy.json' with {type:'json'};
import {createRealmSalePurchaseArgs,buildBuyRealmAccessInstruction,buildOpenRealmAccessInstruction,buildOpenSpotSalesQuotaInstruction,REALM_SALE_ACCOUNT_BYTES} from './seekerRealmSaleProtocol';
import {buildRealmSaleMessage} from './seekerRealmSaleMessage';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
const programId=new PublicKey(idl.address),pk=(n:number)=>new PublicKey(Buffer.alloc(32,n));
function fixture(){const buyer=Keypair.generate(),day=10n,at=day*BigInt(PHASE_E_MINING_PUBLICATION.daySec),args=createRealmSalePurchaseArgs({saleId:Buffer.alloc(16,7),spot:0,realm:0,round:1n,day,seller:pk(2),developer:pk(3),priorExpiry:0n,validAfter:at,validUntil:at+60n});
 return {buyer,input:{wallet:buyer.publicKey,args,blockhash:pk(4).toBase58(),needsAccess:true,needsQuota:true}};}
describe('single atomic realm sale message',()=>{
 it.each([[false,false],[true,false],[false,true],[true,true]])('keeps setup %s/%s and payment in one packet with one buyer signer', (access,quota)=>{
  const f=fixture(),input={...f.input,needsAccess:access,needsQuota:quota},r=buildRealmSaleMessage(programId,input),m=Message.from(r.messageBytes);
  const instructions=[...(access?[buildOpenRealmAccessInstruction(programId,{payer:input.wallet,wallet:input.wallet,realm:input.args.realm})]:[]),
   ...(quota?[buildOpenSpotSalesQuotaInstruction(programId,{payer:input.wallet,spot:input.args.spot,day:input.args.day})]:[]),buildBuyRealmAccessInstruction(programId,{buyer:input.wallet,args:input.args})];
  const decoded=Transaction.populate(m).instructions;
  expect(decoded.map(i=>i.data)).toEqual(instructions.map(i=>i.data));expect(decoded.map(i=>i.programId)).toEqual(instructions.map(i=>i.programId));
  expect(m.header.numRequiredSignatures).toBe(1);expect(m.accountKeys[0]).toEqual(input.wallet);expect(r.packetBytes).toBe(new VersionedTransaction(m).serialize().length);expect(r.packetBytes).toBeLessThanOrEqual(1232);
  expect(r.expectedNewAccounts.map(a=>a.space)).toEqual([...(access?[REALM_SALE_ACCOUNT_BYTES.RealmAccess]:[]),...(quota?[REALM_SALE_ACCOUNT_BYTES.SpotSalesQuota]:[]),REALM_SALE_ACCOUNT_BYTES.RealmSaleReceipt]);
  expect(r).toMatchObject({mode:'atomic',signingAuthorized:false,broadcastAuthorized:false});
 });
 it('reuses exact one-payer signed-wire verification and refuses changed signed consent',()=>{
  const f=fixture(),r=buildRealmSaleMessage(programId,f.input),tx=new VersionedTransaction(Message.from(r.messageBytes));tx.sign([f.buyer]);
  expect(verifyMiningClaimSignedWire({wallet:f.buyer.publicKey,intentBytes:r.messageBytes,signedTransaction:tx.serialize()}).messageSha256).toBe(r.messageSha256);
  const changed=buildRealmSaleMessage(programId,{...f.input,args:{...f.input.args,saleId:Buffer.alloc(16,8)}});
  expect(()=>verifyMiningClaimSignedWire({wallet:f.buyer.publicKey,intentBytes:changed.messageBytes,signedTransaction:tx.serialize()})).toThrow();
 });
 it.each(['seller','developer','both','same-recipient'] as const)('retains gross policy and exact buyer net funding with %s aliases',kind=>{
  const f=fixture(),seller=kind==='seller'||kind==='both'?f.buyer.publicKey:pk(2),developer=kind==='developer'||kind==='both'?f.buyer.publicKey:kind==='same-recipient'?seller:pk(3);
  const r=buildRealmSaleMessage(programId,{...f.input,args:{...f.input.args,seller,developer}}),p=PHASE_E_POLICY.seekerIsland;
  const expected=BigInt(p.permitPriceLamports)-(seller.equals(f.buyer.publicKey)?BigInt(p.permitPriceLamports)*BigInt(p.contractSellerBps)/BigInt(PHASE_E_POLICY.basisPoints):0n)
   -(developer.equals(f.buyer.publicKey)?BigInt(p.permitPriceLamports)*BigInt(p.contractDevBps)/BigInt(PHASE_E_POLICY.basisPoints):0n);
  expect(r.buyerNetPaymentLamports).toBe(expected);expect(r.grossPriceLamports).toBe(BigInt(p.permitPriceLamports));
 });
 it('owns immutable message and account plans after caller bytes change',()=>{
  const f=fixture(),id=Buffer.alloc(16,7),r=buildRealmSaleMessage(programId,{...f.input,args:{...f.input.args,saleId:id}}),before=Buffer.from(r.messageBytes);id.fill(9);r.messageBytes.fill(0);
  expect(Buffer.from(r.messageBytes)).toEqual(before);expect(Object.isFrozen(r.expectedNewAccounts)).toBe(true);expect(Object.isFrozen(r.expectedNewAccounts[0])).toBe(true);
 });
 it('rejects malformed identity scope blockhash setup flags and injected instruction authority',()=>{
  const f=fixture();for(const patch of [{blockhash:'bad'},{blockhash:42},{needsQuota:1},{needsAccess:null},{payer:pk(6)},{instructions:[]},{wallet:PublicKey.findProgramAddressSync([Buffer.of(8)],programId)[0]}])
   expect(()=>buildRealmSaleMessage(programId,{...f.input,...patch} as never)).toThrow();
  expect(()=>buildRealmSaleMessage(pk(1),f.input)).toThrow();expect(()=>buildRealmSaleMessage(programId,{...f.input,args:{...f.input.args,priceLamports:1n}})).toThrow();
 });
});
