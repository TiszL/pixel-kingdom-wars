import {randomUUID,createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {encodeMiningAllocationLeaf,encodeMiningAllocationProof} from '@shardkeep/chain/mining-allocation';
import {createMiningClaimReceiptVerifier} from '@shardkeep/chain/mining-claim-receipt';
import {createMiningClaimReceiptFixture} from '../../../packages/chain/src/testFixtures/miningClaimReceipt';
import type {MiningClaimPreparation} from '../src/mining/claimPreparationStore';
import type {MiningClaimSigned} from '../src/mining/claimSignedStore';
import type {MiningClaimSettlement} from '../src/mining/claimSettlement';
import {toMiningClaimStatusView,toMiningClaimPreparationView,toMiningClaimPreparationEnvelope,toMiningClaimView} from '../src/mining/claimHttpView';
const now='2035-01-01T00:00:00.000Z',micro='2035-01-01T00:00:00.000123Z',hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
async function fixture(){
 const f=await createMiningClaimReceiptFixture(),p=f.request.plan,h=f.state,claimId=randomUUID();
 const preparation:MiningClaimPreparation={claimId,wallet:p.leaf.wallet,idempotencyKey:randomUUID(),header:{genesisHash:h.trust.expectedGenesisHash,programId:h.trust.programId.toBase58(),keepMint:h.trust.keepMint.toBase58(),reserveOwner:h.trust.reserveOwner.toBase58(),configAddress:h.root.config.toBase58(),sequence:'1',day:p.day.toString(),root:Buffer.from(p.root).toString('hex'),totalCumulative:p.totalCumulative.toString(),leafCount:1,sourceHash:f.request.sourceHash,publicationSignature:f.request.signature,publicationSlot:120},leafHex:Buffer.from(encodeMiningAllocationLeaf(p.leaf)).toString('hex'),proofHex:Buffer.from(encodeMiningAllocationProof(p.proof)).toString('hex'),needsAta:true,needsMinerRecords:true,quoteVersion:1,preparedAt:now,expiresAt:'2035-01-01T00:02:00.000Z',snapshotSlot:125,blockhashContextSlot:130,blockhash:p.blockhash,lastValidBlockHeight:200,payerBalanceLamports:'10000',feeLamports:'5',rentLamports:'10',totalLamports:'15',transactions:f.planned.transactions.map(t=>({kind:t.kind,messageHex:Buffer.from(t.messageBytes).toString('hex'),messageSha256:t.messageSha256,packetBytes:t.packetBytes,feeLamports:'5',rentLamports:'10'})),state:'prepared',currentSigningAuthorized:false,claimSubmissionAuthorized:false};
 const signed:MiningClaimSigned={preparation,wires:[{wallet:preparation.wallet,claimId,ordinal:0,kind:'combined',signature:f.request.signature,signedTransactionHex:Buffer.from(f.request.signedTransaction).toString('hex'),wireSha256:hash(f.request.signedTransaction),messageSha256:preparation.transactions[0]!.messageSha256,acceptedAt:micro,claimSubmissionAuthorized:false}]};
 const receipt=await createMiningClaimReceiptVerifier(f.reader,f.state.trust)(f.request),settlement:MiningClaimSettlement={wallet:preparation.wallet,claimId,ordinal:0,signature:receipt.signature,receipt,settledAt:micro,claimFinalized:true};
 return {f,preparation,signed,settlement,key:{wallet:preparation.wallet,claimId,serverNow:now}};
}
describe('public mining claim views',()=>{
 it('does not manufacture zero balances from an unavailable source',()=>{
  const view=toMiningClaimStatusView({wallet:'11111111111111111111111111111111',state:'unavailable',reason:'DISABLED',decimals:9,preparationAllowed:false,claimSubmissionAuthorized:false},now);
  expect(view.claimableBaseUnits).toBeNull();expect(view.claimedBaseUnits).toBeNull();expect(view.features.claims).toEqual({version:1,receipts:1});
 });
 it('publishes exact canonical unsigned messages and own proof while stripping internal attestations',async()=>{
  const f=await fixture(),v=toMiningClaimPreparationView(f.preparation,now);
  expect(v.transactions[0]!.message).toBe(Buffer.from(f.preparation.transactions[0]!.messageHex,'hex').toString('base64'));expect(v.leaf.wallet).toBe(f.key.wallet);expect(v.quoteId).toBe(f.key.claimId);expect(v.preparedAt).toBe(now);expect(v.identity.keepMint).toBe(f.preparation.header.keepMint);
  const json=JSON.stringify(v);for(const field of ['sourceHash','publicationSignature','messageHex','signedTransactionHex','reviewedProgramDataSha256'])expect(json).not.toContain(field);
  expect(toMiningClaimPreparationEnvelope({wallet:f.key.wallet,idempotencyKey:f.preparation.idempotencyKey,preparation:f.preparation,serverNow:now}).status).toBe('prepared');
 });
 it('distinguishes unknown, prepared, retained and settled without calling retention a submission',async()=>{
  const f=await fixture();expect(toMiningClaimView({...f.key,signed:null,settlements:[]})).toMatchObject({state:'unknown',signature:null,settledBaseUnits:null});
  expect(toMiningClaimView({...f.key,signed:{preparation:f.preparation,wires:[]},settlements:[]})).toMatchObject({state:'prepared',landing:'pending'});
  expect(toMiningClaimView({...f.key,signed:f.signed,settlements:[]})).toMatchObject({state:'retained',landing:'pending',signature:f.signed.wires[0]!.signature,settledBaseUnits:null});
  expect(toMiningClaimView({...f.key,signed:f.signed,settlements:[f.settlement]})).toMatchObject({state:'settled',landing:'finalized',settledBaseUnits:'80'});
 });
 it('refuses foreign actors, claims, conflicting wire hashes and terminal receipts',async()=>{
  const f=await fixture();expect(()=>toMiningClaimView({...f.key,claimId:randomUUID(),signed:f.signed,settlements:[]})).toThrow();
  expect(()=>toMiningClaimView({...f.key,signed:f.signed,settlements:[{...f.settlement,signature:'1'.repeat(63)+'2'}]})).toThrow();
  expect(()=>toMiningClaimView({...f.key,signed:{...f.signed,wires:[{...f.signed.wires[0]!,messageSha256:'0'.repeat(64)}]},settlements:[]})).toThrow();
  expect(()=>toMiningClaimView({...f.key,signed:f.signed,settlements:[f.settlement,f.settlement]})).toThrow();
  expect(()=>toMiningClaimPreparationView({...f.preparation,wallet:'11111111111111111111111111111111'},now)).toThrow();
 });
});
