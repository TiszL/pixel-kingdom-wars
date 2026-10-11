/** Genuine local SBF creation, sale and permanent retirement; paid-land snapshots
 * and the accepted gross-combat adapter remain explicitly declared fixtures. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {VersionedTransaction} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {createCharterPolicyIssuer} from '../src/charterPolicyIssuer';
import {initializeCharterIssuerJournal} from '../src/charterPolicyIssuerJournal';
import {createClanCharterRetirementWorkflow} from '../src/game/clanCharterRetirementWorkflow';
import {createClanCharterRetirementsStore} from '../src/db/charterRetirements';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {createClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {createCharterCreationWorkflow} from '../src/game/clanCharterCreationWorkflow';
import {createClanCharterSales} from '../src/game/clanCharterSales';
import {createRaid} from '../src/game/raids';
import {actualCharterSalesCoreJourney} from './fixtures/charterSalesCore';
import {setupCharterSaleRaidActor} from './fixtures/charterSalesRaid';
import {settleCharterSaleFixtureGross} from './fixtures/charterSalesRaidPayout';

it('actual mint and sale lead to positive member payout, exact purpose-9 delivery, permanent receipt and atomic SQL dissolution',async()=>{
 await actualCharterSalesCoreJourney({retirement:async c=>{
  const f=c.fixture,actor=c.leader.publicKey.toBase58(),connect=(_signal:AbortSignal)=>c.delivery;
  await setupCharterSaleRaidActor(f,actor);const defender=await f.actor();vi.stubEnv('MULTI_BASE_ENABLED','false');
  const raid=await createRaid(f.db,actor,{defenderWallet:defender.wallet,idempotencyKey:randomUUID()}),gross=await settleCharterSaleFixtureGross(f.db,raid.id,BigInt(PHASE_E_POLICY.basisPoints));expect(gross.chestCut).toBeGreaterThan(0n);
  vi.stubEnv('MULTI_BASE_ENABLED','true');const deed=await c.deeds(f.buyer.deed);expect(deed).not.toBeNull();await f.buyer.refresh(f.buyer.wallet,deed!.slot);
  const fences=createClanCharterMemberFences(f.db),fence=await fences.begin(actor,{clanId:c.clanId,idempotencyKey:randomUUID()}),members=createClanCharterMemberSettlement(f.db,{deedCollection:f.buyer.collection,finalizedDeedReader:c.deeds}),payment=await members.settle(actor,fence.fenceId);
  expect(payment.totalShards).toBe(gross.chestCut.toString());const ledger=await f.sql`select * from ledger_entries order by id`;
  const journalFile=join(c.working,'retirement-policy-journal.jsonl');await initializeCharterIssuerJournal(journalFile,{genesisHash:c.domain.genesisHash,economyProgram:c.domain.economyProgram});
  const issuer=await createCharterPolicyIssuer({journalFile,trust:c.chain.trust,connect,signer:{publicKey:c.policy.publicKey.toBase58(),sign:message=>sign(c.policy,message)}});
  try{
   const workflow=createClanCharterRetirementWorkflow(f.db,{chain:c.chain,issuer,recovery:{connect,trust:c.chain.trust},delivery:{connect,trust:c.chain.trust,expectedCurrentSigner:c.chain.expectedCurrentSigner,lookupTable:c.chain.lookupTable}}),store=createClanCharterRetirementsStore(f.db);
   const original=await workflow.create(actor,{fenceId:fence.fenceId,idempotencyKey:randomUUID()});expect(original.original.expectedRevision).toBe(1);
   const prepared=await workflow.prepare(actor,original.id);expect(prepared.preparation).not.toBeNull();
   const tx=VersionedTransaction.deserialize(Buffer.from(prepared.preparation!.packet.unsignedTransactionHex,'hex'));tx.sign([c.leader]);const bytes=Buffer.from(tx.serialize());
   await workflow.retainSigned(actor,original.id,bytes);const saved=await store.read(actor,original.id),quote=saved.attempt!.quote as {packetInput:{lastValidBlockHeight:number}};
   const actual=await c.submitExact('retirement',bytes,quote.packetInput.lastValidBlockHeight,async()=>{const delivery=await workflow.deliver(actor,original.id);expect(delivery,JSON.stringify(delivery)).toMatchObject({status:'submitted',signature:saved.signed!.signature});});
   const completed=await workflow.recover(actor,original.id);expect(completed.status).toBe('completed');
   const terminal=await store.read(actor,original.id);expect(terminal.terminal?.record).toMatchObject({finalizedTransitionObserved:true,currentStateMatchesResult:true,signature:actual.transaction.signatures[0],priorRevision:1,revision:2,retirementAuthorized:false});
   expect(await f.sql`select id from clans where id=${c.clanId}`).toHaveLength(0);expect(await f.sql`select player_wallet from clan_members where clan_id=${c.clanId}`).toHaveLength(0);expect(await f.sql`select * from ledger_entries order by id`).toEqual(ledger);
   vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');const offline=createClanCharterRetirementWorkflow(f.db);
   expect(await offline.recover(actor,original.id)).toEqual(completed);expect(await offline.deliver(actor,original.id)).toMatchObject({status:'terminal'});
   expect(await createCharterCreationWorkflow(f.db).read(f.source.wallet,c.creationIntentId)).toEqual(c.creation);
   expect(await createClanCharterSales(f.db).read(f.source.wallet,c.saleId)).toEqual(c.sale);
   expect(await createClanCharterMemberFences(f.db).read(fence.fenceId)).toEqual(fence);expect(await createClanCharterMemberSettlement(f.db).read(actor,fence.fenceId)).toEqual(payment);
   expect(await createClanCharterMemberSettlement(f.db).read(f.source.wallet,c.saleFenceId)).toMatchObject(c.sale.memberPayment!);
   await writeFile(join(c.working,'api-retirement-result.json'),JSON.stringify({version:1,domain:c.domain,trust:c.chain.trust,clanId:c.clanId,creationIntentId:c.creationIntentId,saleId:c.saleId,raidId:raid.id,retirementId:original.id,memberPayment:payment,terminal:terminal.terminal,exactWireSha256:saved.signed!.wireSha256,atomicRosterRemoval:true,noSecondMemberDebit:true,providerlessHistoricalReplay:true},null,2),{mode:0o600});
  }finally{await issuer.close();vi.unstubAllEnvs();}
 }});
},360000);
