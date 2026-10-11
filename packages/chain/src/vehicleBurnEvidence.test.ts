import {describe,it,expect} from 'vitest';
import {Keypair,Message,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {buildVehicleBurnMessage} from './vehicleBurnMessage';
import {verifyVehicleBurnEvidence} from './vehicleBurnEvidence';
const pk=()=>Keypair.generate().publicKey.toBase58();
function fixture(){
 const wallet=Keypair.generate(),plan={wallet:wallet.publicKey.toBase58(),reservationId:'ac2ee077-1c46-4fb0-8c35-cb331613e054',
  identity:{assetId:pk(),collection:pk(),family:'survey_balloon' as const,tier:1 as const},blockhash:pk()};
 const prepared=buildVehicleBurnMessage(plan),signed=new VersionedTransaction(Message.from(prepared.messageBytes));signed.sign([wallet]);
 const message=Message.from(prepared.messageBytes),asset=message.accountKeys.findIndex(k=>k.toBase58()===plan.identity.assetId);
 const pre=message.accountKeys.map(()=>10_000_000),post=[...pre],fee=5_000,refund=2_000_000;
 post[0]!+=refund-fee;post[asset]!-=refund;
 const tx:VersionedTransactionResponse={slot:101,blockTime:1_700_000_000,version:'legacy',transaction:{message,signatures:[bs58.encode(signed.signatures[0]!)]},
  meta:{err:null,fee,preBalances:pre,postBalances:post,innerInstructions:[],loadedAddresses:{readonly:[],writable:[]},preTokenBalances:[],postTokenBalances:[]}};
 return {plan,prepared,signedTransaction:signed.serialize(),tx,asset,fee,refund};
}
const verify=(f:ReturnType<typeof fixture>)=>verifyVehicleBurnEvidence(f.tx,{plan:f.plan,preparedMessageBytes:f.prepared.messageBytes,signedTransaction:f.signedTransaction});
describe('exact reserved Core burn transaction evidence',()=>{
 it('verifies actual signed consent, successful direct burn and exact network-fee/refund accounting, without granting authority',()=>{
  const f=fixture(),proof=verify(f);
  expect(proof).toMatchObject({version:1,reservationId:f.plan.reservationId,identity:f.plan.identity,wallet:f.plan.wallet,slot:f.tx.slot,
   originalMessageSha256:f.prepared.messageSha256,feeLamports:String(f.fee),assetRefundLamports:String(f.refund),
   transactionEvidenceVerified:true,finalityVerified:false,preBurnOwnershipVerified:false,registryMembershipVerified:false,installationAuthorized:false});
  expect(Object.isFrozen(proof)).toBe(true);expect(Object.isFrozen(proof.identity)).toBe(true);
 });
 it('does not require the burned asset balance to vanish: Core retains a tombstone and donated overage',()=>{
  const f=fixture();expect(f.tx.meta!.postBalances[f.asset]).toBeGreaterThan(0);expect(verify(f).assetRefundLamports).toBe(String(f.refund));
 });
 it('rejects a changed signature, unsigned packet, altered saved message or replay into another reservation',()=>{
  const f=fixture();f.signedTransaction[4]=f.signedTransaction[4]!^1;expect(()=>verify(f)).toThrow();
  const g=fixture();g.signedTransaction.fill(0,1,65);expect(()=>verify(g)).toThrow();
  const h=fixture();h.plan.reservationId='ac2ee077-1c46-4fb0-8c35-cb331613e055';expect(()=>verify(h)).toThrow();
  const j=fixture();expect(()=>verifyVehicleBurnEvidence(j.tx,{plan:j.plan,preparedMessageBytes:new Uint8Array(1233),signedTransaction:j.signedTransaction})).toThrow();
 });
 it('compares RPC raw message fields instead of trusting an injected serialize method',()=>{
  const f=fixture(),m=f.tx.transaction.message as Message;m.instructions[0]!.data=bs58.encode(Buffer.of(14,0));
  m.serialize=()=>Buffer.from(f.prepared.messageBytes);expect(()=>verify(f)).toThrow();
 });
 it.each(['missing','failed','trace','signature','version','lookup','instructions','slot','trailing'] as const)('holds %s execution evidence',kind=>{
  const f=fixture();
  if(kind==='missing')f.tx.meta=null;
  if(kind==='failed')f.tx.meta!.err={InstructionError:[0,'InvalidArgument']};
  if(kind==='trace')f.tx.meta!.innerInstructions=null;
  if(kind==='signature')f.tx.transaction.signatures=[bs58.encode(Buffer.alloc(64,3))];
  if(kind==='version')f.tx.version=0;
  if(kind==='lookup')f.tx.meta!.loadedAddresses={readonly:[Keypair.generate().publicKey],writable:[]};
  if(kind==='instructions')(f.tx.transaction.message as Message).instructions.push((f.tx.transaction.message as Message).instructions[0]!);
  if(kind==='slot')f.tx.slot=NaN;
  if(kind==='trailing')(f.tx.transaction.message as Message).instructions[0]!.data=bs58.encode(Buffer.of(12,0,0));
  expect(()=>verify(f)).toThrow();
 });
 it('refuses any CPI path, including a successful outer transaction that caught a failed inner burn',()=>{
  const f=fixture(),ix=(f.tx.transaction.message as Message).instructions[0]!;
  f.tx.meta!.innerInstructions=[{index:0,instructions:[{...ix,accounts:[...ix.accounts]}]}];expect(()=>verify(f)).toThrow();
 });
 it.each(['wallet','collection','asset','fee','unsafe','negative','token'] as const)('rejects %s balance inconsistencies rather than inferring a burn',kind=>{
  const f=fixture(),meta=f.tx.meta!;
  if(kind==='wallet')meta.postBalances[0]!++;
  if(kind==='collection')meta.postBalances[(f.tx.transaction.message as Message).accountKeys.findIndex(k=>k.toBase58()===f.plan.identity.collection)]!--;
  if(kind==='asset')meta.postBalances[f.asset]=meta.preBalances[f.asset]!+1;
  if(kind==='fee')meta.fee++;
  if(kind==='unsafe')meta.preBalances[0]=Number.MAX_SAFE_INTEGER+1;
  if(kind==='negative')meta.postBalances[f.asset]=-1;
  if(kind==='token')meta.postTokenBalances=[{} as never];
  expect(()=>verify(f)).toThrow();
 });
 it('rejects sparse balances and forged authority fields even when nominally false',()=>{
  const f=fixture();delete f.tx.meta!.preBalances[1];expect(()=>verify(f)).toThrow();
  const g=fixture();expect(()=>verifyVehicleBurnEvidence(g.tx,{plan:g.plan,preparedMessageBytes:g.prepared.messageBytes,signedTransaction:g.signedTransaction,finalityVerified:false} as never)).toThrow();
 });
});
