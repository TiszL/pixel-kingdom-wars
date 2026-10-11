/** Actual private event entry, played/replayed battle, terminal and lock clear.
 * The finalized RPC bank and event calendar are explicit existing fixtures;
 * retirement itself always uses the real PostgreSQL clock. */
import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {RAID_RULES} from '@shardkeep/shared';
import {baseArmy} from '../src/db/schema';
import {createClanCharterRetirementsStore} from '../src/db/charterRetirements';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {acceptLiveRaidCommand} from '../src/game/liveRaids';
import {recoverDueStartedLiveRaids} from '../src/game/raids';
import {startCharterTournamentRaid,replayCharterTournamentEvent} from '../src/game/charterTournamentRaids';
import {closeCharterTournamentEvent,claimCharterTournamentPrize,readCharterTournamentEvent} from '../src/game/charterTournamentEvents';
import {charterTournamentWorkflowFixture} from './fixtures/charterTournamentWorkflow';
import {pastTournamentWeek} from './fixtures/pastTournamentWeek';

it.each([
 // 2026-10-10: 0286 refuses a raid capture after the real Postgres clock, so held=true can no longer play a 2035 week.
 // It plays the latest week whose play closed a minute ago: retirement reads the real clock and the 7-day occupation
 // still holds. Only a run straddling Monday 00:00 UTC (the deadline) can see it lapse mid-test.
 {held:true,calendar:pastTournamentWeek(2*86_400_000+60_000)},
 {held:false,calendar:{fundedAt:'2020-01-03T00:00:00.000Z',weekStart:'2020-01-04T00:00:00.000Z',enteredAt:'2020-01-04T01:00:00.000Z'}},
])('a released winner is held=$held by its original occupation deadline and keeps residual wallet prizes',async({held,calendar})=>{
 const c=await charterTournamentWorkflowFixture({},calendar);
 try{
  const entry=(await c.entry()).state,setId=entry.set.original.operation.id;
  async function complete(id:string){const prepared=await c.prepare(id);await c.service().retainSigned(c.source.wallet,id,c.signed(prepared));await c.service().deliver(c.source.wallet,id);await c.finalizeLock(id);await c.service().recover(c.source.wallet,id);}
  await complete(setId);expect((await c.service().readEntry(c.source.wallet,entry.id)).status).toBe('entered');
  c.setTime(new Date(c.event.playStartsAt));await c.db.insert(baseArmy).values({baseId:c.source.baseId,troop:'highlander',count:5}).onConflictDoUpdate({target:[baseArmy.baseId,baseArmy.troop],set:{count:5}});
  const authority=async(wallet:string,baseId:string,tx?:Parameters<typeof assertFreshLockedBaseAuthority>[0])=>{const actor=[c.source,c.buyer].find(a=>a.wallet===wallet&&a.baseId===baseId);if(!tx&&actor)await actor.refresh();await assertFreshLockedBaseAuthority(tx??c.db,wallet,baseId);};
  const admitted=await startCharterTournamentRaid(c.db,c.source.wallet,{eventId:c.event.id,baseId:c.source.baseId,idempotencyKey:randomUUID()},{clock:c.clock,authorizeAttackerBase:authority,authorizeDefenderBase:authority});
  await acceptLiveRaidCommand(c.db,c.source.wallet,admitted.raid!.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:6,ty:10}},c.clock());
  c.setTime(new Date(c.clock().getTime()+RAID_RULES.battleDurationSec*1000+1));expect(await recoverDueStartedLiveRaids(c.db,c.clock(),undefined,admitted.raid!.id)).toEqual({resolved:1,raced:0});
  expect(await replayCharterTournamentEvent(c.db,c.event.id)).toEqual([expect.objectContaining({completed:true})]);
  c.setTime(new Date(c.event.playEndsAt));const closed=await closeCharterTournamentEvent(c.db,c.event.id,{clock:c.clock});
  expect(closed.terminal).toMatchObject({occupations:[{site:1,clanId:c.birth.consent.clanId}],entitlements:[{wallet:c.source.wallet,amounts:c.event.budget}]});
  const clear=await c.service().createClear(c.source.wallet,entry.id,{idempotencyKey:randomUUID()});await complete(clear.original.operation.id);
  expect((await c.service().readEntry(c.source.wallet,entry.id)).status).toBe('released');
  expect(await c.sql`select shardkeep_charter_tournament_fenced(${c.birth.consent.clanId}::uuid) held`).toEqual([{held:false}]);
  await c.source.refresh();const fence=await createClanCharterMemberFences(c.db).begin(c.source.wallet,{clanId:c.birth.consent.clanId,idempotencyKey:randomUUID()});
  await c.memberSettlement().settle(c.source.wallet,fence.fenceId);const store=createClanCharterRetirementsStore(c.db),input={fenceId:fence.fenceId,idempotencyKey:randomUUID()};
  const create=store.create(c.source.wallet,input);
  if(held){await expect(create).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_HELD'});expect(await c.sql`select * from charter_retirements`).toHaveLength(0);}
  else{
   const state=await create;expect(state.original.retirement.expectedRevision).toBe(2);expect((state.source as {tournament:{events:unknown[]}}).tournament.events).toHaveLength(1);
   // Retirement clearance neither consumes nor redirects the original fixed
   // wallet entitlement; claiming it must not invalidate the saved clearance.
   await c.source.refresh();const claim=await claimCharterTournamentPrize(c.db,c.source.wallet,{eventId:c.event.id,baseId:c.source.baseId},{baseId:c.source.baseId,assertAuthority:async(tx,wallet,baseId)=>{await assertFreshLockedBaseAuthority(tx,wallet,baseId);}},{clock:c.clock});
   expect(claim.amounts).toEqual(c.event.budget);expect(await store.read(c.source.wallet,state.original.retirement.id)).toEqual(state);
  }
  expect((await readCharterTournamentEvent(c.db,c.event.id)).terminal).toEqual(closed.terminal);
 }finally{await c.dispose();vi.restoreAllMocks();vi.unstubAllEnvs();}
},120000);
