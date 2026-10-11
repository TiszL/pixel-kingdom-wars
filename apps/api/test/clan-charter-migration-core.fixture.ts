/** Actual legacy creation charge and captured raid prefix precede real SBF
 * migration, sale and retirement. Upstream deeds and combat gross are declared
 * fixtures; no funded Charter reservation or completed Core state is seeded. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {VersionedTransaction} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {createCharterPolicyIssuer} from '../src/charterPolicyIssuer';
import {initializeCharterIssuerJournal} from '../src/charterPolicyIssuerJournal';
import {createClanCharterMigrationWorkflow} from '../src/game/clanCharterMigrationWorkflow';
import {createClanCharterSales} from '../src/game/clanCharterSales';
import {createClanCharterClient} from '../src/game/clanCharterClient';
import {createClanCharterSalesStore} from '../src/db/charterSales';
import {createClanCharterRetirementWorkflow} from '../src/game/clanCharterRetirementWorkflow';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {createClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {createClanCharterRetirementsStore} from '../src/db/charterRetirements';
import {createClan} from '../src/game/clans';
import {createRaid} from '../src/game/raids';
import {actualCharterSalesCoreJourney} from './fixtures/charterSalesCore';
import {setupCharterSaleRaidActor} from './fixtures/charterSalesRaid';
import {settleCharterSaleFixtureGross} from './fixtures/charterSalesRaidPayout';
it('real existing clan migrates without another SHARDS charge, pays prior captured liabilities, transfers and permanently retires',async()=>{
 await actualCharterSalesCoreJourney({migration:async c=>{
  const f=c.fixture,actor=c.leader.publicKey.toBase58(),buyer=c.buyer.publicKey.toBase58(),connect=(_signal:AbortSignal)=>c.delivery;
  await setupCharterSaleRaidActor(f,actor);vi.stubEnv('MULTI_BASE_ENABLED','false');
  const clan=await createClan(f.db,actor,{name:'Actual Legacy Clan',tag:'LEGAC',inviteMode:'invite'},randomUUID());
  const defender=await f.actor();vi.stubEnv('MULTI_BASE_ENABLED','false');const raid=await createRaid(f.db,actor,{defenderWallet:defender.wallet,idempotencyKey:randomUUID()}),gross=await settleCharterSaleFixtureGross(f.db,raid.id,BigInt(PHASE_E_POLICY.basisPoints));expect(gross.chestCut).toBeGreaterThan(0n);
  vi.stubEnv('MULTI_BASE_ENABLED','true');const [head]=await f.sql`select * from clan_charter_raid_chest_heads where clan_id=${clan.id}`;expect(head!.first_raid_id).toBe(raid.id);
  const before=await f.salesSnapshot(),originalCreationPosts=await f.sql`select id from ledger_transactions where type='clan.create' order by id`;expect(originalCreationPosts).toHaveLength(1);
  const journalFile=join(c.working,'migration-policy.jsonl');await initializeCharterIssuerJournal(journalFile,{genesisHash:c.domain.genesisHash,economyProgram:c.domain.economyProgram});
  const issuer=await createCharterPolicyIssuer({journalFile,trust:c.chain.trust,connect,signer:{publicKey:c.policy.publicKey.toBase58(),sign:message=>sign(c.policy,message)}});
  try{
   const delivery={connect,trust:c.chain.trust,expectedCurrentSigner:c.chain.expectedCurrentSigner,lookupTable:c.chain.lookupTable},recovery={connect,trust:c.chain.trust};
   const migration=createClanCharterMigrationWorkflow(f.db,{newMigration:{domain:{genesisHash:c.domain.genesisHash,economyProgram:c.domain.economyProgram,craftProgram:c.domain.craftProgram},metadataUriPrefix:'https://invalid.example/legacy/'},chain:c.chain,issuer,recovery,delivery});
   const created=await migration.create(actor,{clanId:clan.id,idempotencyKey:randomUUID()});expect(created.snapshot.chestShards).toBe(gross.chestCut.toString());expect(created.original).not.toHaveProperty('funding');
   const prepared=await migration.prepare(actor,created.id),tx=VersionedTransaction.deserialize(Buffer.from(prepared.preparation!.packet.unsignedTransactionHex,'hex'));tx.sign([c.leader]);const bytes=Buffer.from(tx.serialize());const signed=await migration.retainSigned(actor,created.id,bytes);
   const minted=await c.submitExact('migration',bytes,signed.attempt!.quote.packetInput.lastValidBlockHeight,async()=>{expect(await migration.deliver(actor,created.id)).toMatchObject({status:'submitted',signature:signed.signed!.signature});});
   const controlled=await migration.recover(actor,created.id);expect(controlled.status).toBe('controlled');expect(await f.salesSnapshot()).toBe(before);expect(await f.sql`select * from charter_creation_reservations`).toHaveLength(0);expect(await f.sql`select * from charter_creation_funding_posts`).toHaveLength(0);
   expect(await f.sql`select * from clan_charter_raid_chest_heads where clan_id=${clan.id}`).toEqual([head]);
   const salesOptions={newSaleDomain:c.domain,chain:c.transferChain,issuer,recovery,finalizedDeedReader:c.deeds,deedCollection:f.buyer.collection},sales=createClanCharterSales(f.db,salesOptions);
   const draft=await sales.create(actor,{clanId:clan.id,buyer,priceLamports:'101000003',sellerLeaves:true,idempotencyKey:randomUUID()});const accepted=await sales.accept(buyer,draft.id,{termsHash:draft.original.termsHash,buyerBaseId:f.buyer.baseId});
   const saleStore=createClanCharterSalesStore(f.db),acceptedSaved=await saleStore.read(actor,draft.id),oldMembers=createClanCharterMemberSettlement(f.db,{deedCollection:f.source.collection,finalizedDeedReader:c.deeds});
   const paid=await oldMembers.settle(actor,acceptedSaved.fenceId!);expect(paid.totalShards).toBe(gross.chestCut.toString());
   const salePrepared=await sales.prepare(actor,accepted.id),saleTx=VersionedTransaction.deserialize(Buffer.from(salePrepared.preparation!.packet.unsignedTransactionHex,'hex'));saleTx.sign([c.buyer,c.leader]);const saleBytes=Buffer.from(saleTx.serialize());await sales.retainSigned(buyer,draft.id,saleBytes);
   const saleSaved=await saleStore.read(actor,draft.id),saleQuote=saleSaved.attempt!.quote as {packetInput:{lastValidBlockHeight:number}},client=createClanCharterClient(f.db,{sales:salesOptions,delivery});
   const sold=await c.submitExact('migration-sale',saleBytes,saleQuote.packetInput.lastValidBlockHeight,async()=>{expect(await client.deliver(buyer,'sale',draft.id)).toMatchObject({status:'submitted',signature:saleSaved.signed!.signature});});
   const completedSale=await sales.recover(actor,draft.id);expect(completedSale.status).toBe('completed');expect(await f.sql`select player_wallet from clan_members where clan_id=${clan.id}`).toEqual([{player_wallet:buyer}]);
   const fence=await createClanCharterMemberFences(f.db).begin(buyer,{clanId:clan.id,idempotencyKey:randomUUID()}),members=createClanCharterMemberSettlement(f.db,{deedCollection:f.buyer.collection,finalizedDeedReader:c.deeds}),finalPayment=await members.settle(buyer,fence.fenceId);expect(finalPayment.totalShards).toBe('0');
   const retire=createClanCharterRetirementWorkflow(f.db,{chain:c.transferChain,issuer,recovery,delivery}),original=await retire.create(buyer,{fenceId:fence.fenceId,idempotencyKey:randomUUID()}),retirement=await retire.prepare(buyer,original.id),retireTx=VersionedTransaction.deserialize(Buffer.from(retirement.preparation!.packet.unsignedTransactionHex,'hex'));retireTx.sign([c.buyer]);const retireBytes=Buffer.from(retireTx.serialize());await retire.retainSigned(buyer,original.id,retireBytes);
   const retirementSaved=await createClanCharterRetirementsStore(f.db).read(buyer,original.id),retirementQuote=retirementSaved.attempt!.quote as {packetInput:{lastValidBlockHeight:number}},ledger=await f.sql`select * from ledger_entries order by id`;
   const retired=await c.submitExact('migration-retirement',retireBytes,retirementQuote.packetInput.lastValidBlockHeight,async()=>{expect(await retire.deliver(buyer,original.id)).toMatchObject({status:'submitted',signature:retirementSaved.signed!.signature});});
   const completed=await retire.recover(buyer,original.id);expect(completed.status).toBe('completed');expect(await f.sql`select id from clans where id=${clan.id}`).toHaveLength(0);expect(await f.sql`select player_wallet from clan_members where clan_id=${clan.id}`).toHaveLength(0);expect(await f.sql`select * from ledger_entries order by id`).toEqual(ledger);
   expect(await f.sql`select id from ledger_transactions where type='clan.create' order by id`).toEqual(originalCreationPosts);expect(await f.sql`select * from charter_creation_reservations`).toHaveLength(0);
   vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');expect(await createClanCharterMigrationWorkflow(f.db).recover(actor,created.id)).toEqual(controlled);expect(await createClanCharterSales(f.db).read(actor,draft.id)).toEqual(completedSale);expect(await createClanCharterRetirementWorkflow(f.db).recover(buyer,original.id)).toEqual(completed);expect(await createClanCharterMemberSettlement(f.db).read(actor,acceptedSaved.fenceId!)).toEqual(paid);
   await writeFile(join(c.working,'api-migration-result.json'),JSON.stringify({version:1,clanId:clan.id,migrationId:created.id,sourceRaidId:raid.id,capturedChestShards:gross.chestCut.toString(),sourceHead:head,migration:controlled,sale:completedSale,retirement:completed,originalMemberPayment:paid,finalMemberPayment:finalPayment,migrationWireSha256:signed.signed!.wireSha256,signatures:[minted.transaction.signatures[0],sold.transaction.signatures[0],retired.transaction.signatures[0]],sameClanCutoverPreservedAllBalancesAndRoster:true,noSecondCreationShardsCharge:true,noFabricatedFundedReservation:true,providerlessOriginalHistoryAfterRetirement:true},(_k,v:unknown)=>typeof v==='bigint'?v.toString():v,2),{mode:0o600});
  }finally{await issuer.close();vi.unstubAllEnvs();}
 }});
},480000);
