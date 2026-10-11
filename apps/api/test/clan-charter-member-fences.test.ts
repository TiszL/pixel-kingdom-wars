/** Preparation freezes member facts and conflicting gameplay. It does not
 * authorize a payout, a permit, or release of the durable transition fence. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {STRUCTURES} from '@shardkeep/shared';
import {bases,baseSlots,clanMembers,clans,players} from '../src/db/schema';
import {createClan,joinClan,kickMember,leaveClan,settleClanChests,clanChestInvariantHolds} from '../src/game/clans';
import {completeDueJobs,ensureStartingBase,placeBuilding} from '../src/game/base';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {completeDueTraining} from '../src/game/army';
import {createRaid,submitOrders} from '../src/game/raids';
import {rewardShards} from '../src/game/spend';
import {getOrCreatePlayerAccount} from '../src/ledger';
import {createClanCharterRaidChest} from '../src/game/clanCharterRaidChest';
import {createTestPlayer,fundTestKeep} from './helpers';
import {trainTroop} from './training-consent';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';

let conn:ReturnType<typeof resourceClaimsDatabase>;
const key=()=>randomUUID(),future=(minutes:number)=>new Date(Date.now()+minutes*60_000);
beforeEach(async()=>{vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');conn=resourceClaimsDatabase();await conn.setup();},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await conn?.close();},120_000);
async function factory(db=conn.db){const {createClanCharterMemberFences}=await import('../src/game/clanCharterMemberFences');return createClanCharterMemberFences(db);}
async function enabled<T>(run:()=>Promise<T>){const multi=process.env.MULTI_BASE_ENABLED,charter=process.env.PHASE_E_CHARTER_ENABLED;vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');try{return await run();}finally{vi.stubEnv('MULTI_BASE_ENABLED',multi);vi.stubEnv('PHASE_E_CHARTER_ENABLED',charter);}}
const initialize=()=>enabled(()=>createClanCharterRaidChest(conn.db).initializeRule());
const begin=(wallet:string,clanId:string,idempotencyKey=key())=>enabled(async()=>(await factory()).begin(wallet,{clanId,idempotencyKey}));
async function funded(){const p=await createTestPlayer(conn.db);await rewardShards(conn.db,p.wallet,1_000_000n,'test.charter-fence.shards',key());return p;}
async function clan(wallet:string){return createClan(conn.db,wallet,{name:'Clan '+key().slice(0,8),tag:key().slice(0,5).toUpperCase()},key());}
async function attacker(){
 const p=await funded();await fundTestKeep(conn.db,p.wallet,1_000_000n,'test.charter-fence.keep',key());await ensureStartingBase(conn.db,p.wallet);
 await placeBuilding(conn.db,p.wallet,'barracks' as never,17,17,key());await completeDueJobs(conn.db,p.wallet,future(120));await placeBuilding(conn.db,p.wallet,'camp' as never,19,19,key());await completeDueJobs(conn.db,p.wallet,future(240));
 for(let i=0;i<6;i++){await trainTroop(conn.db,p.wallet,'highlander',key(),future(300+i*10));await completeDueTraining(conn.db,p.wallet,future(310+i*10));}return p;
}
async function defender(){const p=await createTestPlayer(conn.db);await ensureStartingBase(conn.db,p.wallet);await rewardShards(conn.db,p.wallet,BigInt(STRUCTURES.vault.capacity[0]!)+50_000n,'test.charter-fence.defender',key());await completeDueJobs(conn.db,p.wallet,future(120));return p;}
function resolve(wallet:string,raidId:string){return submitOrders(conn.db,wallet,raidId,{idempotencyKey:key(),deploys:[{troop:'highlander',tx:6,ty:14,tMs:0},{troop:'highlander',tx:6,ty:15,tMs:0},{troop:'highlander',tx:23,ty:14,tMs:0},{troop:'highlander',tx:23,ty:15,tMs:0},{troop:'highlander',tx:14,ty:6,tMs:0},{troop:'highlander',tx:14,ty:23,tMs:0}]});}
async function members(clanId:string){return conn.db.select().from(clanMembers).where(eq(clanMembers.clanId,clanId));}
async function chest(clanId:string){return (await conn.db.select().from(clans).where(eq(clans.id,clanId)))[0]!.chestShards;}
const shards=(wallet:string)=>getOrCreatePlayerAccount(conn.db,wallet,'player_shards').then(a=>a.balance);
async function paidBase(wallet:string,slot:number,options:{paid?:boolean;active?:boolean}={}){
 // Same stable ownership/slot fixture used by clans-base.test.ts. Eligibility
 // is a server database predicate; this is not a caller-supplied payment proof.
 const [base]=await conn.db.insert(bases).values({ownerWallet:wallet,status:'active',landPaidAt:options.paid===false?null:new Date()}).returning();
 await conn.db.insert(baseSlots).values({wallet,slot,baseId:base!.id,active:options.active??true});return base!;
}
async function fenced(action:Promise<unknown>){
 const error:unknown=await action.then(()=>null,(e:unknown)=>e),messages:string[]=[];let current=error;
 for(let depth=0;depth<8&&current&&typeof current==='object';depth++){if('message'in current)messages.push(String(current.message));current='cause'in current?current.cause:undefined;}
 expect(messages).toContain('CLAN_CHARTER_MEMBER_FENCED');
}
async function fundedChest(){const a=await attacker(),c=await clan(a.wallet),d=await defender();await initialize();const raid=await createRaid(conn.db,a.wallet,{defenderWallet:d.wallet,idempotencyKey:key()});await resolve(a.wallet,raid.id);expect(await chest(c.id)).toBeGreaterThan(0n);expect(await clanChestInvariantHolds(conn.db)).toBe(true);return {a,c,raid};}
async function waitForClanWait(){
 for(let i=0;i<200;i++){const rows=await conn.sql`select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%from "clans"%'`;if(rows.length)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Expected the actual clan operation to wait on the independent row lock');
}

describe('member settlement preparation fences through actual clan gameplay',()=>{
 it('freezes a real roster and prevents join, leave and kick even after feature pause',async()=>{
  const leader=await funded(),member=await funded(),outsider=await funded(),c=await clan(leader.wallet);await joinClan(conn.db,member.wallet,c.id);await initialize();const before=await members(c.id),fence=await begin(leader.wallet,c.id);
  expect(fence).toMatchObject({fenceId:expect.any(String),clanId:c.id,actorWallet:leader.wallet,raidOrdinal:'0',chestShards:'0',status:'preparing'});expect(fence.members).toEqual(expect.arrayContaining([expect.objectContaining({wallet:leader.wallet,eligibilityAtFence:false,baseId:null,slot:null}),expect.objectContaining({wallet:member.wallet,eligibilityAtFence:false,baseId:null,slot:null})]));expect(fence.members).toHaveLength(2);
  await fenced(joinClan(conn.db,outsider.wallet,c.id));await fenced(leaveClan(conn.db,member.wallet));await fenced(kickMember(conn.db,leader.wallet,member.wallet));expect(await members(c.id)).toEqual(before);expect(await chest(c.id)).toBe(0n);expect(await (await factory()).read(fence.fenceId)).toEqual(fence);
 });
 it('captures one eligibility row per wallet using only the lowest active paid owned slot',async()=>{
  const leader=await funded(),multi=await funded(),inactive=await funded(),unpaid=await funded(),deedless=await funded(),c=await clan(leader.wallet);for(const member of [multi,inactive,unpaid,deedless])await joinClan(conn.db,member.wallet,c.id);
  const leaderBase=await paidBase(leader.wallet,1),higher=await paidBase(multi.wallet,2),lower=await paidBase(multi.wallet,1);await paidBase(inactive.wallet,1,{active:false});await paidBase(unpaid.wallet,1,{paid:false});await initialize();const fence=await begin(leader.wallet,c.id);
  expect(fence.members).toHaveLength(5);expect(fence.members).toEqual(expect.arrayContaining([{wallet:leader.wallet,eligibilityAtFence:true,baseId:leaderBase.id,slot:1},{wallet:multi.wallet,eligibilityAtFence:true,baseId:lower.id,slot:1},...([inactive,unpaid,deedless].map(p=>({wallet:p.wallet,eligibilityAtFence:false,baseId:null,slot:null})))]));expect(fence.members.filter(m=>m.wallet===multi.wallet)).toHaveLength(1);expect(fence.members.some(m=>m.baseId===higher.id)).toBe(false);
 });
 it('retains the original member identity after an actual deed transfer without paying that member chest to the buyer',async()=>{
  // createTestPlayer uses arbitrary address bytes; the actual deed receiver
  // must instead be a signable wallet, as ownershipEligible requires.
  const leader=await funded(),buyer={wallet:Keypair.generate().publicKey.toBase58()},c=await clan(leader.wallet),base=await paidBase(leader.wallet,1),mint=Keypair.generate().publicKey.toBase58();await conn.db.insert(players).values(buyer);expect((await registerOwnedDeed(conn.db,leader.wallet,mint)).id).toBe(base.id);await initialize();const fence=await begin(leader.wallet,c.id),before=await shards(buyer.wallet),transferAt=new Date();
  await transferStableBase(conn.db,base.id,leader.wallet,buyer.wallet,mint,{owner:buyer.wallet,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:transferAt.getTime()},()=>new Date(transferAt));expect((await conn.db.select().from(bases).where(eq(bases.id,base.id)))[0]!.ownerWallet).toBe(buyer.wallet);
  const saved=await (await factory()).read(fence.fenceId);expect(saved).toEqual(fence);expect(saved.members).toEqual([{wallet:leader.wallet,eligibilityAtFence:true,baseId:base.id,slot:1}]);expect(await members(c.id)).toEqual([expect.objectContaining({playerWallet:leader.wallet})]);expect(await shards(buyer.wallet)).toBe(before);expect(await conn.sql`select id from ledger_transactions where type in ('clan.chest_split','clan.chest_dissolve')`).toHaveLength(0);
 });
 it('keeps positive backing with no eligible members and rolls a sole-leader dissolution payout back',async()=>{
  const {a,c}=await fundedChest(),amount=await chest(c.id),before=await shards(a.wallet),fence=await begin(a.wallet,c.id);expect(fence).toMatchObject({status:'preparing',chestShards:amount.toString()});expect(fence.members).toEqual([{wallet:a.wallet,eligibilityAtFence:false,baseId:null,slot:null}]);
  await fenced(leaveClan(conn.db,a.wallet));await fenced(conn.db.update(clans).set({inviteMode:'invite',inviteCode:'changed'}).where(eq(clans.id,c.id)));expect(await chest(c.id)).toBe(amount);expect(await shards(a.wallet)).toBe(before);expect(await conn.sql`select id from ledger_transactions where type='clan.chest_dissolve'`).toHaveLength(0);expect(await clanChestInvariantHolds(conn.db)).toBe(true);expect(await (await factory()).read(fence.fenceId)).toEqual(fence);
 });
 it('stops new clan raids atomically while an earlier admitted raid may add observed positive accrual',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender(),other=await defender();await initialize();const raid=await createRaid(conn.db,a.wallet,{defenderWallet:d.wallet,idempotencyKey:key()}),fence=await begin(a.wallet,c.id),request=key(),before=await shards(a.wallet);expect(fence).toMatchObject({raidOrdinal:'1',chestShards:'0'});
  await fenced(createRaid(conn.db,a.wallet,{defenderWallet:other.wallet,idempotencyKey:request}));expect(await conn.sql`select id from raids where idempotency_key=${request}`).toHaveLength(0);expect(await conn.sql`select ordinal::text from clan_charter_event_heads where clan_id=${c.id}`).toEqual([{ordinal:'1'}]);expect(await shards(a.wallet)).toBe(before);
  await resolve(a.wallet,raid.id);expect(await chest(c.id)).toBeGreaterThan(0n);expect(await clanChestInvariantHolds(conn.db)).toBe(true);expect(await (await factory()).read(fence.fenceId)).toEqual(fence);expect(await conn.sql`select * from clan_charter_raid_terminals where raid_id=${raid.id}`).toHaveLength(1);
 });
 it('prevents an actual weekly split after the fence without leaving a ledger debit or reducing clan backing',async()=>{
  const {a,c}=await fundedChest();await paidBase(a.wallet,1);const before=await chest(c.id),fence=await begin(a.wallet,c.id),week=key(),accounts=await conn.sql`select id,balance::text from accounts order by id`;const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
  expect(await enabled(()=>settleClanChests(conn.db,week))).toEqual({settled:0});expect(errors).toHaveBeenCalled();expect(await conn.sql`select id from ledger_transactions where idempotency_key=${'clan-chest:'+week+':'+c.id}`).toHaveLength(0);expect(await conn.sql`select id,balance::text from accounts order by id`).toEqual(accounts);expect(await chest(c.id)).toBe(before);expect(await clanChestInvariantHolds(conn.db)).toBe(true);expect(await (await factory()).read(fence.fenceId)).toEqual(fence);
 });
 it('serializes an actual earlier weekly split before capture and snapshots only its remaining attributed chest',async()=>{
  const {a,c}=await fundedChest(),member=await funded();await joinClan(conn.db,member.wallet,c.id);await paidBase(a.wallet,1);await paidBase(member.wallet,1);const before=await chest(c.id),week=key(),lock=conn.reopen();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const holding=lock.db.transaction(async tx=>{await tx.select().from(clans).where(eq(clans.id,c.id)).for('update');entered();await gate;});await ready;vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');const settling=settleClanChests(conn.db,week);
  try{await waitForClanWait();await expect((await factory()).begin(a.wallet,{clanId:c.id,idempotencyKey:key()})).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_BUSY'});}finally{release();await holding;await Promise.allSettled([settling]);await lock.sql.end();}
  expect(await settling).toEqual({settled:1});const after=await chest(c.id);expect(after).toBe(before%2n);const fence=await begin(a.wallet,c.id);expect(fence.chestShards).toBe(after.toString());const entries=await conn.sql`select e.delta::text from ledger_entries e join ledger_transactions t on t.id=e.txn_id where t.idempotency_key=${'clan-chest:'+week+':'+c.id}`;expect(entries).toHaveLength(3);expect(entries.reduce((sum,e)=>sum+BigInt(e.delta),0n)).toBe(0n);expect(await clanChestInvariantHolds(conn.db)).toBe(true);
 });
 it('captures an actual join that wins the clan mutex and holds a concurrent preparation for retry',async()=>{
  const leader=await funded(),member=await funded(),c=await clan(leader.wallet);await initialize();const lock=conn.reopen();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});const holding=lock.db.transaction(async tx=>{await tx.select().from(clans).where(eq(clans.id,c.id)).for('update');entered();await gate;});await ready;const joining=joinClan(conn.db,member.wallet,c.id);
  try{await waitForClanWait();await expect(begin(leader.wallet,c.id)).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_BUSY'});}finally{release();await holding;await Promise.allSettled([joining]);await lock.sql.end();}await joining;const fence=await begin(leader.wallet,c.id);expect(fence.members.map(m=>m.wallet).sort()).toEqual([leader.wallet,member.wallet].sort());expect(await members(c.id)).toHaveLength(2);
 });
 it('requires exact new-admission flags and the leader while preserving paused original replay and request binding',async()=>{
  const leader=await funded(),member=await funded(),other=await funded(),c=await clan(leader.wallet),otherClan=await clan(other.wallet);await joinClan(conn.db,member.wallet,c.id);await initialize();const cap=await factory(),request={clanId:c.id,idempotencyKey:key()};
  for(const [multi,charter] of [['false','true'],['true','false'],['true','TRUE']]){vi.stubEnv('MULTI_BASE_ENABLED',multi);vi.stubEnv('PHASE_E_CHARTER_ENABLED',charter);await expect(cap.begin(leader.wallet,request)).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_DISABLED'});}
  vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');await expect(cap.begin(member.wallet,request)).rejects.toMatchObject({statusCode:404});const first=await cap.begin(leader.wallet,request);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');vi.stubEnv('MULTI_BASE_ENABLED','false');expect(await cap.begin(leader.wallet,request)).toEqual(first);await expect(cap.begin(leader.wallet,{...request,clanId:otherClan.id})).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_CONFLICT'});await expect(cap.read(key())).rejects.toMatchObject({code:'CLAN_CHARTER_FENCE_NOT_FOUND'});expect(Object.keys(first).sort()).toEqual(['fenceId','clanId','actorWallet','idempotencyKey','sourceId','raidOrdinal','chestShards','createdAt','status','members'].sort());
 });
 it('makes concurrent identical preparation retries converge on one immutable fence without any payout',async()=>{
  const leader=await funded(),c=await clan(leader.wallet);await initialize();const cap=await factory(),request={clanId:c.id,idempotencyKey:key()};vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');const outcomes=await Promise.allSettled([cap.begin(leader.wallet,request),cap.begin(leader.wallet,request)]);expect(outcomes.some(r=>r.status==='fulfilled')).toBe(true);for(const r of outcomes)if(r.status==='rejected')expect(r.reason).toMatchObject({code:'CLAN_CHARTER_FENCE_BUSY'});const first=await cap.begin(leader.wallet,request);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');for(let i=0;i<2;i++)expect(await cap.begin(leader.wallet,request)).toEqual(first);expect(await conn.sql`select * from clan_charter_member_fences where clan_id=${c.id}`).toHaveLength(1);expect(await conn.sql`select id from ledger_transactions where type in ('clan.chest_split','clan.chest_dissolve')`).toHaveLength(0);
 });
});
