import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {describe,it,expect} from 'vitest';
import {CharterClientSchema,CharterSigningSchema} from '@shardkeep/shared/charterApi';
import {charterClientFixture,fixtureTermsJson} from './testFixture';
import {clientFixture} from './clientFixture';
import {prepareCharterSigning,verifyCharterWire,verifyCharterContribution} from './signing';
const path=fileURLToPath(new URL('../../../../../packages/shared/src/testFixtures/charterClient.json',import.meta.url));
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
// Explicit regeneration produces public ephemeral vectors only, never secrets.
if(process.env.CHARTER_WRITE_PUBLIC_VECTORS==='true'){
 const f=charterClientFixture(),pairs=[f.pair(201,true),f.pair(202,true,false)],rows=pairs.map(p=>{
  const creator=p.creator.publicKey.toBase58(),buyer=p.buyer.publicKey.toBase58();const wire=(s:typeof p.creation|typeof p.sale)=>{const tx=VersionedTransaction.deserialize(Buffer.from(s.packet.unsignedTransactionHex,'hex'));tx.sign(s.kind==='creation'?[p.creator]:[p.buyer,p.creator]);const raw=Buffer.from(tx.serialize());return {wire:{signedTransaction:raw.toString('base64'),signature:bs58.encode(tx.signatures[0]!),messageSha256:s.packet.messageSha256,wireSha256:hash(raw)},signatures:tx.signatures.map(v=>Buffer.from(v).toString('base64'))};};
  const mint=wire(p.creation),sale=wire(p.sale),termsText=fixtureTermsJson(p.sale.original.terms);
  return {creator,buyer,creation:p.creation,sale:p.sale,creationWire:mint.wire,saleWire:sale.wire,buyerContribution:{wallet:buyer,attemptId:p.sale.attemptId,messageSha256:p.sale.packet.messageSha256,signature:sale.signatures[0]},sellerContribution:{wallet:creator,attemptId:p.sale.attemptId,messageSha256:p.sale.packet.messageSha256,signature:sale.signatures[1]},termsText,termsUtf8Hex:Buffer.from(termsText).toString('hex'),termsHash:p.sale.original.termsHash};
 });
 const e=clientFixture(203);mkdirSync(fileURLToPath(new URL('.',new URL(`file://${path}`))),{recursive:true});writeFileSync(path,JSON.stringify({version:1,fixtureOnly:true,trust:f.trust,rows,envelopes:{creation:e.creation,saleSeller:e.sale(),saleBuyer:e.sale(e.buyerWallet)},envelopeTrust:e.trust},null,2)+'\n');
}
const vectors=()=>JSON.parse(readFileSync(path,'utf8'));
describe('shared public Charter client vectors',()=>{
 it('reconstructs both future clans using one independent static table and verifies every genuine party signature',async()=>{const v=vectors();expect(v.version).toBe(1);expect(v.fixtureOnly).toBe(true);expect(v.rows).toHaveLength(2);for(const r of v.rows){for(const s of [r.creation,r.sale])CharterSigningSchema.parse(s);expect(r.creation.packet.packetBytes).toBe(1228);await prepareCharterSigning(r.creation,v.trust,r.creator);await prepareCharterSigning(r.sale,v.trust,r.buyer);await prepareCharterSigning(r.sale,v.trust,r.creator);await verifyCharterWire(r.creation,r.creationWire);await verifyCharterWire(r.sale,r.saleWire);await verifyCharterContribution(r.sale,r.buyer,r.buyerContribution);await verifyCharterContribution(r.sale,r.creator,r.sellerContribution);expect(Buffer.from(r.termsUtf8Hex,'hex').toString()).toBe(r.termsText);}for(const e of Object.values(v.envelopes))expect(CharterClientSchema.safeParse(e).success).toBe(true);});
 it('rejects a stale projection with both retained contributions but no full wire',()=>{const v=vectors(),e=v.envelopes.saleSeller,s=e.signing;const contributions=[e.state.original.buyer,e.state.original.seller].map(wallet=>({wallet,attemptId:s.attemptId,messageSha256:s.packet.messageSha256,signature:'A'.repeat(86)+'=='}));expect(CharterClientSchema.safeParse({...e,contributions}).success).toBe(false);});
});
