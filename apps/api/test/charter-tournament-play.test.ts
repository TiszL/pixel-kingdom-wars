/** Genuine service entry, automatic original raids, normal lifecycle and actual
 * bounded replay. Upstream chain bank is the declared R1 fixture, not live RPC. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {BuildingType,RAID_RULES,RAID_ENERGY,LIVE_RAID,PHASE_E_CHARTER_TOURNAMENT as POLICY} from '@shardkeep/shared';
import {baseArmy,baseProfiles,bases,baseSlots,buildings,craftingStocks} from '../src/db/schema';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {rewardBaseShards} from '../src/game/baseEconomy';
import {createRaid,recoverDueStartedLiveRaids,recoverNeverStartedLiveRaids} from '../src/game/raids';
import {acceptLiveRaidCommand,retreatLiveRaid} from '../src/game/liveRaids';
import {startCharterTournamentRaid,readCharterTournamentRaid,replayCharterTournamentEvent,cancelCharterTournamentRaidRequest} from '../src/game/charterTournamentRaids';
import {closeCharterTournamentEvent,claimCharterTournamentPrize} from '../src/game/charterTournamentEvents';
import {charterTournamentWorkflowFixture,type CharterTournamentWorkflowFixture} from './fixtures/charterTournamentWorkflow';
let f:CharterTournamentWorkflowFixture|undefined;
beforeEach(async()=>{f=await charterTournamentWorkflowFixture();},120000);
afterEach(async()=>{const previous=f;f=undefined;try{await previous?.dispose();}finally{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
async function entered(){const c=f!,entry=await c.entry(),id=entry.state.set.original.operation.id,prepared=await c.prepare(id);await c.service().retainSigned(c.source.wallet,id,c.signed(prepared));await c.service().deliver(c.source.wallet,id);await c.finalizeLock(id);await c.service().recover(c.source.wallet,id);expect((await c.service().readEntry(c.source.wallet,entry.state.id)).status).toBe('entered');c.setTime(new Date(Date.parse(c.event.playStartsAt)+3_600_000));await c.db.insert(baseArmy).values({baseId:c.source.baseId,troop:'highlander',count:5}).onConflictDoUpdate({target:[baseArmy.baseId,baseArmy.troop],set:{count:5}});return c;}
function options(c:CharterTournamentWorkflowFixture){const authority:NonNullable<Parameters<typeof createRaid>[2]['authorizeAttackerBase']>=async(wallet,baseId,tx)=>{const actor=[c.source,c.buyer].find(a=>a.wallet===wallet&&a.baseId===baseId);if(!tx&&actor)await actor.refresh();await assertFreshLockedBaseAuthority(tx??c.db,wallet,baseId);};return {authorizeAttackerBase:authority,authorizeDefenderBase:authority,clock:c.clock};}
async function expire(c:CharterTournamentWorkflowFixture){c.setTime(new Date(c.clock().getTime()+RAID_RULES.deployWindowSec*1000+1));// The legacy expiry worker samples Date internally; drive that private fixture
 // clock too, without replacing timers or any protected raid writer.
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(c.clock());
 try{expect((await recoverNeverStartedLiveRaids(c.db,c.clock())).released).toBe(1);}finally{vi.useRealTimers();}}
it('ordinary visit cannot be adopted; actual private played raid alone ranks and fixes original funded rights',async()=>{
 const c=await entered(),opts=options(c),key=randomUUID();
 const ordinary=await createRaid(c.db,c.source.wallet,{attackerBaseId:c.source.baseId,idempotencyKey:key,authorizeAttackerBase:opts.authorizeAttackerBase,authorizeDefenderBase:opts.authorizeDefenderBase,raidProtocolVersion:LIVE_RAID.protocolVersion,allowRaidProtocolV2:true},c.clock);
 await retreatLiveRaid(c.db,c.source.wallet,ordinary.id,randomUUID(),c.clock());
 const cmd={eventId:c.event.id,baseId:c.source.baseId,idempotencyKey:key},admitted=await startCharterTournamentRaid(c.db,c.source.wallet,cmd,opts);
 expect(admitted.ordinal).toBe(1);expect(admitted.raid!.id).not.toBe(ordinary.id);expect(admitted.raid).not.toHaveProperty('idempotencyKey');expect(admitted.raid).not.toHaveProperty('simulationLeaseToken');expect(typeof admitted.raid!.seed).toBe('number');expect(()=>JSON.stringify(admitted)).not.toThrow();
 expect(await readCharterTournamentRaid(c.db,c.source.wallet,c.event.id,key)).toEqual(admitted);
 expect(await c.sql`select jsonb_array_length(count_witness)::int n from charter_tournament_raid_admissions`).toEqual([{n:1}]);
 await expect(closeCharterTournamentEvent(c.db,c.event.id,{clock:()=>new Date(c.event.playEndsAt)})).rejects.toThrow();
 await acceptLiveRaidCommand(c.db,c.source.wallet,admitted.raid!.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:6,ty:10}},c.clock());
 c.setTime(new Date(c.clock().getTime()+RAID_RULES.battleDurationSec*1000+1));expect(await recoverDueStartedLiveRaids(c.db,c.clock(),undefined,admitted.raid!.id)).toEqual({resolved:1,raced:0});
 expect(await replayCharterTournamentEvent(c.db,c.event.id)).toEqual([expect.objectContaining({raidId:admitted.raid!.id,completed:true})]);
 const closed=await closeCharterTournamentEvent(c.db,c.event.id,{clock:()=>new Date(c.event.playEndsAt)});expect(closed.terminal).toMatchObject({rankings:[{clanId:c.birth.consent.clanId,completedRaids:1,rosterSize:1}],occupations:[{site:1,clanId:c.birth.consent.clanId}],entitlements:[{wallet:c.source.wallet,amounts:c.event.budget}]});
 await c.source.refresh();const claim=await claimCharterTournamentPrize(c.db,c.source.wallet,{eventId:c.event.id,baseId:c.source.baseId},{baseId:c.source.baseId,assertAuthority:async(tx,wallet,baseId)=>{await assertFreshLockedBaseAuthority(tx,wallet,baseId);}},{clock:()=>new Date(Date.parse(c.event.playEndsAt)+1000)});expect(claim.amounts).toEqual(c.event.budget);
 expect((await c.db.select().from(craftingStocks).where(eq(craftingStocks.baseId,c.source.baseId))).every(s=>s.available===17n)).toBe(true);
},120000);
it('admission ordinal follows frozen wallet across bases and never returns after normal expiry',async()=>{
 const c=await entered(),opts=options(c);const [second]=await c.db.insert(bases).values({ownerWallet:c.source.wallet,status:'active',landPaidAt:new Date(),keepLevel:1}).returning();await c.db.insert(baseSlots).values({wallet:c.source.wallet,baseId:second!.id,slot:2});await c.db.insert(buildings).values({baseId:second!.id,playerWallet:c.source.wallet,type:BuildingType.Keep,level:1,tx:13,ty:13});await rewardBaseShards(c.db,second!.id,10000n,'test.tournament.existing-base-stock',randomUUID());
 for(const [index,baseId] of [c.source.baseId,second!.id,c.source.baseId].entries()){const admitted=await startCharterTournamentRaid(c.db,c.source.wallet,{eventId:c.event.id,baseId,idempotencyKey:randomUUID()},opts);expect(admitted.ordinal).toBe(index+1);await expire(c);}
 await expect(startCharterTournamentRaid(c.db,c.source.wallet,{eventId:c.event.id,baseId:second!.id,idempotencyKey:randomUUID()},opts)).rejects.toThrow();expect(await c.sql`select count(*)::int n from charter_tournament_raid_admissions`).toEqual([{n:3}]);expect((await replayCharterTournamentEvent(c.db,c.event.id)).every(r=>!r.completed)).toBe(true);
 const closed=await closeCharterTournamentEvent(c.db,c.event.id,{clock:()=>new Date(c.event.playEndsAt)});expect(closed.terminal).toMatchObject({rankings:[],occupations:[],entitlements:[{wallet:c.source.wallet,amounts:c.event.budget}]});
},120000);
it('lost pre-admission request has one retained private key and no unlimited replacement requests',async()=>{
 const c=await entered(),opts=options(c),cmd={eventId:c.event.id,baseId:c.source.baseId,idempotencyKey:randomUUID()};await expect(startCharterTournamentRaid(c.db,c.source.wallet,cmd,{...opts,authorizeDefenderBase:async()=>{throw new Error('fixture provider unavailable');}})).rejects.toThrow();expect(await readCharterTournamentRaid(c.db,c.source.wallet,c.event.id,cmd.idempotencyKey)).toMatchObject({ordinal:null,raid:null});await expect(startCharterTournamentRaid(c.db,c.source.wallet,{...cmd,idempotencyKey:randomUUID()},opts)).rejects.toThrow();expect(await c.sql`select count(*)::int n from charter_tournament_raid_requests`).toEqual([{n:1}]);const admitted=await startCharterTournamentRaid(c.db,c.source.wallet,cmd,opts);expect(admitted.ordinal).toBe(1);await retreatLiveRaid(c.db,c.source.wallet,admitted.raid!.id,randomUUID(),c.clock());expect(await replayCharterTournamentEvent(c.db,c.event.id)).toEqual([expect.objectContaining({completed:false,stars:0,destruction:0})]);const closed=await closeCharterTournamentEvent(c.db,c.event.id,{clock:()=>new Date(c.event.playEndsAt)});expect(closed.terminal).toMatchObject({rankings:[],occupations:[]});
},120000);
it('existing purchased energy cannot convert an exhausted free daily cap into a qualifying admission',async()=>{
 const c=await entered(),opts=options(c);for(let i=0;i<RAID_ENERGY.freePerDay;i++){const r=await createRaid(c.db,c.source.wallet,{attackerBaseId:c.source.baseId,idempotencyKey:randomUUID(),authorizeAttackerBase:opts.authorizeAttackerBase,authorizeDefenderBase:opts.authorizeDefenderBase,raidProtocolVersion:LIVE_RAID.protocolVersion,allowRaidProtocolV2:true},c.clock);await retreatLiveRaid(c.db,c.source.wallet,r.id,randomUUID(),c.clock());}
 await c.db.update(baseProfiles).set({purchasedEnergy:1}).where(eq(baseProfiles.baseId,c.source.baseId));await expect(startCharterTournamentRaid(c.db,c.source.wallet,{eventId:c.event.id,baseId:c.source.baseId,idempotencyKey:randomUUID()},opts)).rejects.toThrow();expect(await c.sql`select count(*)::int n from charter_tournament_raid_admissions`).toEqual([{n:0}]);expect((await c.db.select().from(baseProfiles).where(eq(baseProfiles.baseId,c.source.baseId)))[0]!.purchasedEnergy).toBe(1);
},120000);

it('cancellation fences a genuine create already in flight before its admission and never cancels an actual raid',async()=>{
 const c=await entered(),opts=options(c),cmd={eventId:c.event.id,baseId:c.source.baseId,idempotencyKey:randomUUID()};
 let enteredGate!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>enteredGate=r),gate=new Promise<void>(r=>release=r);
 const pending=startCharterTournamentRaid(c.db,c.source.wallet,cmd,{...opts,authorizeDefenderBase:async(...args)=>{enteredGate();await gate;await opts.authorizeDefenderBase(...args);}}).then(value=>({value}),error=>({error}));
 try{await reached;const cancelled=await cancelCharterTournamentRaidRequest(c.db,c.source.wallet,{eventId:c.event.id,idempotencyKey:cmd.idempotencyKey},{clock:c.clock});expect(cancelled).toMatchObject({status:'cancelled',raid:null,ordinal:null});}finally{release();}
 expect(await pending).toHaveProperty('error');expect(await c.sql`select count(*)::int n from charter_tournament_raid_admissions`).toEqual([{n:0}]);
 expect(await startCharterTournamentRaid(c.db,c.source.wallet,cmd,opts)).toMatchObject({status:'cancelled',raid:null});
 const next={...cmd,idempotencyKey:randomUUID()},admitted=await startCharterTournamentRaid(c.db,c.source.wallet,next,opts);expect(admitted).toMatchObject({status:'admitted',ordinal:1});await expect(cancelCharterTournamentRaidRequest(c.db,c.source.wallet,{eventId:c.event.id,idempotencyKey:next.idempotencyKey},{clock:c.clock})).rejects.toThrow();await expire(c);
},120000);
it('explicit abandoned identities remain recoverable but cannot grow beyond the fixed operational bound',async()=>{
 const c=await entered(),opts=options(c);let first='';
 for(let i=0;i<POLICY.maxRequestIdentitiesPerWallet;i++){const idempotencyKey=randomUUID();if(!first)first=idempotencyKey;await expect(startCharterTournamentRaid(c.db,c.source.wallet,{eventId:c.event.id,baseId:c.source.baseId,idempotencyKey},{...opts,authorizeDefenderBase:async()=>{throw new Error('provider unavailable');}})).rejects.toThrow();expect((await cancelCharterTournamentRaidRequest(c.db,c.source.wallet,{eventId:c.event.id,idempotencyKey},{clock:c.clock})).status).toBe('cancelled');}
 await expect(startCharterTournamentRaid(c.db,c.source.wallet,{eventId:c.event.id,baseId:c.source.baseId,idempotencyKey:randomUUID()},opts)).rejects.toThrow();expect((await readCharterTournamentRaid(c.db,c.source.wallet,c.event.id,first))?.status).toBe('cancelled');expect(await c.sql`select count(*)::int n from charter_tournament_raid_requests`).toEqual([{n:POLICY.maxRequestIdentitiesPerWallet}]);expect(await c.sql`select count(*)::int n from charter_tournament_raid_admissions`).toEqual([{n:0}]);
},120000);
