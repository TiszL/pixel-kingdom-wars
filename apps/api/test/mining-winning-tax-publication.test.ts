/** Original settled spots, not today's lease owner, receive each funded day's tax. */
import { createHash, randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { hashMiningTaxCommitment } from '@shardkeep/chain/mining-tax';
import { miningConfigPda, miningEpochPda } from '@shardkeep/chain/mining-program';
import { createMiningPublicationFixture } from '../../../packages/chain/src/testFixtures/miningPublication';
import { createInitialFreePublicationPreparer } from '../src/mining/publicationPreparation';
import { createMiningPublicationSettlement } from '../src/mining/publicationSettlement';
import { withInitialFreePublicationFixture as fixture } from './fixtures/initialFreePublication';

describe('mining publication for original winning spots', () => {
 it.each([false, true])('binds King and regular spots equally; same wallet=%s', async sameWallet => {
  const first=Keypair.generate().publicKey,second=sameWallet?first:Keypair.generate().publicKey;
  await fixture(async f=>{
   const plan=await f.plan(f.request),p=plan.publication;if(!p)throw Error('Expected a useful funded plan');
   const m=JSON.parse(plan.manifestJson),t=m.taxManifest.source,programId=f.backing.trust.programId;
   expect(p.taxVersion).toBe(2);
   expect(m.taxManifest).toMatchObject({version:2,mode:'original-term-winning-spot-pool',distributionVersion:1,
    distribution:'equal-cumulative-per-winning-spot',remainder:'original-term-encumbered',futureTermReassignmentAuthorized:false,
    beneficiaries:[{spotId:0,auction:t.auctions[0].terms.auction,wallet:first.toBase58()},
     {spotId:20,auction:t.auctions[20].terms.auction,wallet:second.toBase58()}]});
   const identity={programId,config:miningConfigPda(programId),keepMint:f.backing.trust.keepMint,
    auctionConfig:new PublicKey(t.source.config),term:new PublicKey(t.term),registry:new PublicKey(t.registry),
    registryHash:Buffer.from(t.registryHash,'hex'),round:BigInt(t.source.round),auctionStart:BigInt(t.auctionStart),
    auctionEnd:BigInt(t.auctionEnd),operatingStart:BigInt(t.operatingStart),operatingEnd:BigInt(t.operatingEnd),winnerCount:2};
   expect(p.taxCommitment).toBe(Buffer.from(hashMiningTaxCommitment(identity,{day:p.day,epoch:miningEpochPda(programId,p.day)})).toString('hex'));
   expect(p.taxCommitment).not.toBe(createHash('sha256').update(JSON.stringify(m.taxManifest)).digest('hex'));
   expect(t.auctions).toHaveLength(100);expect(t.finality).toBeUndefined();expect(t.authority).toBeUndefined();
   expect(m.publicationAuthorized).toBe(false);expect(await f.conn.sql`select epoch_id from mining_publication_attempts`).toHaveLength(0);
  },{winners:[{spotId:0,wallet:first},{spotId:20,wallet:second}]});
 });
 it('refuses an unavailable positive settlement and recovers without reserving stock twice',async()=>{
  await fixture(async f=>{
   const tx=[...f.term.bodies.values()][0]!,err=tx.meta!.err;tx.meta!.err={InstructionError:[0,'Custom']};
   await expect(f.plan(f.request)).rejects.toMatchObject({code:'TAX_SOURCE_UNAVAILABLE'});
   expect(await f.conn.sql`select epoch_id from mining_publication_attempts`).toHaveLength(0);
   tx.meta!.err=err;expect((await f.plan(f.request)).publication?.taxVersion).toBe(2);
   expect(await f.conn.sql`select id from mining_ingot_reservations`).toHaveLength(1);
  },{winners:[{spotId:0,wallet:Keypair.generate().publicKey}]});
 });
 it('pins, finalizes and replays v2 publication without reassigning the original beneficiaries',async()=>{
  const winner=Keypair.generate().publicKey;
  await fixture(async f=>{
   const signer=Keypair.generate();f.backing.model.publisher=signer.publicKey;f.backing.model.flags=0;await f.backing.config();
   const attemptKey=randomUUID(),prepare=createInitialFreePublicationPreparer(f.conn.db,{sources:f.sources,signer:signer.publicKey,
    blockhashSource:()=>({getGenesisHash:async()=>f.backing.trust.expectedGenesisHash,getLatestBlockhashAndContext:async()=>({context:{slot:2000},value:{blockhash:new PublicKey(Buffer.alloc(32,91)).toBase58(),lastValidBlockHeight:5000}})})});
   const saved=await prepare({...f.request,attemptKey});if(saved.status!=='prepared')throw Error('Expected prepared publication');
   const p=saved.publication;expect(p.taxVersion).toBe(2);
   const args={sequence:BigInt(p.sequence),day:BigInt(p.day),kind:0 as const,root:Buffer.from(p.root,'hex'),totalCumulative:BigInt(p.total),leafCount:p.leafCount,
    budgetGross:BigInt(p.budgetGross),freeGross:BigInt(p.freeGross),deedGross:BigInt(p.deedGross),sourceHash:Buffer.from(saved.sourceHash,'hex'),taxCommitment:Buffer.from(p.taxCommitment,'hex'),taxVersion:p.taxVersion};
   const chain=await createMiningPublicationFixture('legacy',{signer,identity:{programId:f.backing.trust.programId,keepMint:f.backing.trust.keepMint,reserveOwner:f.backing.trust.reserveOwner},
    args,genesisHash:f.backing.trust.expectedGenesisHash,programData:f.backing.programData,intentBytes:Buffer.from(saved.intentHex,'hex'),publicationSlot:2001});
   const settle=createMiningPublicationSettlement(f.conn.db,{reader:chain.reader,trust:chain.trusted}),request={epochId:f.request.epochId,attemptKey,signature:chain.request.signature,signedTransaction:chain.request.signedTransaction};
   const settled=await settle(request);expect(settled.dispositions).toMatchObject([{actorWallet:f.wallet,consumed:2,returned:1}]);
   expect(settled.receipt.taxVersion).toBe(2);expect(settled.receipt.taxCommitment).toBe(p.taxCommitment);
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');chain.reader.getTransaction=async()=>{throw Error('Replay must not ask for a current owner');};
   try{expect(await prepare({...f.request,attemptKey})).toEqual(saved);expect(await settle(request)).toEqual(settled);}
   finally{vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
   expect(JSON.parse(saved.manifestJson).taxManifest.beneficiaries).toMatchObject([{spotId:20,wallet:winner.toBase58()}]);
   expect(await f.conn.sql`select epoch_id from mining_publication_settlements`).toHaveLength(1);
   expect(await f.conn.sql`select reservation_id from mining_ingot_dispositions`).toHaveLength(1);
  },{quantities:[3],winners:[{spotId:20,wallet:winner}]});
 });
});
