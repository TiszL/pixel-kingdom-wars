/** Historical calendar is an explicit fixture; the occupation expiry gate uses
 * the unchanged real PostgreSQL clock. Awards come from an actual played raid. */
import {randomUUID} from 'node:crypto';
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {RAID_RULES} from '@shardkeep/shared';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {baseArmy} from '../src/db/schema';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {acceptLiveRaidCommand} from '../src/game/liveRaids';
import {recoverDueStartedLiveRaids} from '../src/game/raids';
import {startCharterTournamentRaid,replayCharterTournamentEvent} from '../src/game/charterTournamentRaids';
import {closeCharterTournamentEvent,claimCharterTournamentPrize,readCharterTournamentEvent} from '../src/game/charterTournamentEvents';
import {createDivineFragmentTermSource} from '../src/game/divineFragmentTermReader';
import {createDivineFragments} from '../src/game/divineFragments';
import {createDivineClanFragments} from '../src/game/divineClanFragments';
import {createClan,joinClan} from '../src/game/clans';
import {charterTournamentWorkflowFixture} from './fixtures/charterTournamentWorkflow';
import {charterRetirementWorkflowFixture} from './fixtures/charterRetirementWorkflow';

it('retirement preserves original tournament receipts and wallet-owned prize and Divine awards after joining another clan',async()=>{
 const c=await charterTournamentWorkflowFixture({},{fundedAt:'2020-01-03T00:00:00.000Z',weekStart:'2020-01-04T00:00:00.000Z',enteredAt:'2020-01-04T01:00:00.000Z'});
 let retirement:Awaited<ReturnType<typeof charterRetirementWorkflowFixture>>|undefined;
 try{
  for(const key of ['PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED'])vi.stubEnv(key,'true');
  const bank=await createMiningTermFixture({day:'2020-01-06',genesisHash:new PublicKey(c.domain.genesisHash),programId:Keypair.generate().publicKey,winners:[{spotId:0,wallet:new PublicKey(c.source.wallet)}]}),termSource=createDivineFragmentTermSource(signal=>bank.connect(signal),bank.policy);
  const options={domain:{genesisHash:c.domain.genesisHash,economyProgram:c.domain.economyProgram},clock:c.clock,termSource,finalizedDeedReader:c.reader,deedCollection:c.source.collection};
  const clan=createDivineClanFragments(c.db,{...options,domain:c.domain}),fragments=createDivineFragments(c.db,options);
  c.setTime(new Date('2020-01-03T00:00:00.000Z'));await clan.enroll(c.event.id);c.setTime(new Date('2020-01-04T01:00:00.000Z'));
  const entry=(await c.entry()).state;
  async function complete(id:string){const prepared=await c.prepare(id);await c.service().retainSigned(c.source.wallet,id,c.signed(prepared));await c.finalizeLock(id);return c.service().recover(c.source.wallet,id);}
  await complete(entry.set.original.operation.id);c.setTime(new Date(c.event.playStartsAt));
  await c.db.insert(baseArmy).values({baseId:c.source.baseId,troop:'highlander',count:5}).onConflictDoUpdate({target:[baseArmy.baseId,baseArmy.troop],set:{count:5}});
  const authority=async(wallet:string,baseId:string,tx?:Parameters<typeof assertFreshLockedBaseAuthority>[0])=>{const actor=[c.source,c.buyer].find(a=>a.wallet===wallet&&a.baseId===baseId);if(!tx&&actor)await actor.refresh();await assertFreshLockedBaseAuthority(tx??c.db,wallet,baseId);};
  const admitted=await startCharterTournamentRaid(c.db,c.source.wallet,{eventId:c.event.id,baseId:c.source.baseId,idempotencyKey:randomUUID()},{clock:c.clock,authorizeAttackerBase:authority,authorizeDefenderBase:authority});
  await acceptLiveRaidCommand(c.db,c.source.wallet,admitted.raid!.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:6,ty:10}},c.clock());
  c.setTime(new Date(c.clock().getTime()+RAID_RULES.battleDurationSec*1000+1));expect(await recoverDueStartedLiveRaids(c.db,c.clock(),undefined,admitted.raid!.id)).toEqual({resolved:1,raced:0});expect(await replayCharterTournamentEvent(c.db,c.event.id)).toEqual([expect.objectContaining({completed:true})]);
  c.setTime(new Date(c.event.playEndsAt));const closed=await closeCharterTournamentEvent(c.db,c.event.id,{clock:c.clock});expect(closed.terminal).toMatchObject({occupations:[expect.objectContaining({clanId:c.birth.consent.clanId})]});
  const clear=await c.service().createClear(c.source.wallet,entry.id,{idempotencyKey:randomUUID()});await complete(clear.original.operation.id);const originalEntry=await c.service().readEntry(c.source.wallet,entry.id);
  c.setTime(new Date('2020-01-07T00:00:00.000Z'));bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(c.clock().getTime()/1000),32);
  let award:Awaited<ReturnType<typeof clan.settle>>;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(c.clock());try{award=await clan.settle(c.event.id);}finally{vi.useRealTimers();}
  expect(award.awards).toHaveLength(1);expect(award.awards[0]!.wallet).toBe(c.source.wallet);
  retirement=await charterRetirementWorkflowFixture({existing:c});await retirement.preparedSigned();await retirement.finalizeRetirement();expect(await retirement.service().recover(retirement.actor,retirement.cleared.id)).toMatchObject({status:'completed'});
  expect(await c.sql`select id from clans where id=${c.birth.consent.clanId}`).toHaveLength(0);
  expect(await c.service({chain:null,issuer:null,delivery:null}).readEntry(c.source.wallet,entry.id)).toEqual(originalEntry);expect((await readCharterTournamentEvent(c.db,c.event.id)).terminal).toEqual(closed.terminal);
  // Awards belong to the captured wallet, even after its current clan changes.
  await c.buyer.refresh();const successor=await createClan(c.db,c.buyer.wallet,{name:'Successor '+randomUUID().slice(0,8),tag:randomUUID().slice(0,5).toUpperCase()},randomUUID(),{baseId:c.buyer.baseId,assertAuthority:async(tx,wallet,baseId)=>{await assertFreshLockedBaseAuthority(tx,wallet,baseId);}});
  expect(await joinClan(c.db,c.source.wallet,successor.id)).toMatchObject({clanId:successor.id,members:2});
  await c.source.refresh();const claim=await claimCharterTournamentPrize(c.db,c.source.wallet,{eventId:c.event.id,baseId:c.source.baseId},{baseId:c.source.baseId,assertAuthority:async(tx,wallet,baseId)=>{await assertFreshLockedBaseAuthority(tx,wallet,baseId);}},{clock:c.clock});expect(claim.amounts).toEqual(c.event.budget);
  expect((await fragments.award(c.source.wallet,c.event.id)).award).toEqual(award.awards[0]);
  const input={baseId:c.source.baseId,idempotencyKey:randomUUID()},delivered=await fragments.deliver(c.source.wallet,c.event.id,input);expect(delivered.quantity).toBe(award.awards[0]!.net);expect(await fragments.deliver(c.source.wallet,c.event.id,input)).toEqual(delivered);
 }finally{if(retirement)await retirement.close();else await c.dispose();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();}
},180000);
