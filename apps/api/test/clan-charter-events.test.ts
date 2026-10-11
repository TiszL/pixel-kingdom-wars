/** B6a captures authoritative raid admission, not final accrual attribution or
 * payout authority. Existing settlement behavior is deliberately exercised. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {STRUCTURES} from '@shardkeep/shared';
import {clans} from '../src/db/schema';
import {createClan,joinClan,kickMember,leaveClan,clanChestInvariantHolds} from '../src/game/clans';
import {completeDueJobs,ensureStartingBase,placeBuilding} from '../src/game/base';
import {completeDueTraining} from '../src/game/army';
import {createRaid,submitOrders} from '../src/game/raids';
import {rewardShards} from '../src/game/spend';
import {bootstrapSystemAccounts,getOrCreatePlayerAccount} from '../src/ledger';
import {createTestPlayer,fundTestKeep} from './helpers';
import {trainTroop} from './training-consent';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {raidChestPg} from './fixtures/clanCharterRaidChest';
import {createClanCharterRaidChest} from '../src/game/clanCharterRaidChest';

let conn:ReturnType<typeof resourceClaimsDatabase>;
const key=()=>randomUUID(),future=(minutes:number)=>new Date(Date.now()+minutes*60_000);
beforeEach(async()=>{vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');conn=resourceClaimsDatabase();await conn.setup();},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await conn?.close();},120_000);
async function factory(){const {createClanCharterEvents}=await import('../src/game/clanCharterEvents');return createClanCharterEvents(conn.db);}
async function initialize(withRule=false){vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');try{if(withRule)await createClanCharterRaidChest(conn.db).initializeRule();return await (await factory()).initialize();}finally{vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');}}
async function funded(){const p=await createTestPlayer(conn.db);await rewardShards(conn.db,p.wallet,1_000_000n,'test.charter.shards',key());return p;}
async function clan(wallet:string){return createClan(conn.db,wallet,{name:'Clan '+key().slice(0,8),tag:key().slice(0,5).toUpperCase()},key());}
async function attacker(){
 const p=await funded();await fundTestKeep(conn.db,p.wallet,1_000_000n,'test.charter.keep',key());await ensureStartingBase(conn.db,p.wallet);
 await placeBuilding(conn.db,p.wallet,'barracks' as never,17,17,key());await completeDueJobs(conn.db,p.wallet,future(120));await placeBuilding(conn.db,p.wallet,'camp' as never,19,19,key());await completeDueJobs(conn.db,p.wallet,future(240));
 for(let i=0;i<6;i++){const at=future(300+i*10);await trainTroop(conn.db,p.wallet,'highlander' as never,key(),at);await completeDueTraining(conn.db,p.wallet,future(310+i*10));}return p;
}
async function defender(){const p=await createTestPlayer(conn.db);await ensureStartingBase(conn.db,p.wallet);await rewardShards(conn.db,p.wallet,BigInt(STRUCTURES.vault.capacity[0]!)+50_000n,'test.charter.defender',key());await completeDueJobs(conn.db,p.wallet,future(120));return p;}
async function admission(wallet:string,target:string,id=key()){return createRaid(conn.db,wallet,{defenderWallet:target,idempotencyKey:id});}
async function resolve(wallet:string,raidId:string){return submitOrders(conn.db,wallet,raidId,{idempotencyKey:key(),deploys:[{troop:'highlander',tx:6,ty:14,tMs:0},{troop:'highlander',tx:6,ty:15,tMs:0},{troop:'highlander',tx:23,ty:14,tMs:0},{troop:'highlander',tx:23,ty:15,tMs:0},{troop:'highlander',tx:14,ty:6,tMs:0},{troop:'highlander',tx:14,ty:23,tMs:0}]});}
const shards=(wallet:string)=>getOrCreatePlayerAccount(conn.db,wallet,'player_shards').then(a=>a.balance);

describe('prospective clan Charter admission capture through actual raids',()=>{
 it('records the original clan before combat and returns the same captured event after admission retry',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender();await initialize();const id=key(),raid=await admission(a.wallet,d.wallet,id),events=await factory(),first=await events.read(raid.id);
  expect(first).toMatchObject({status:'captured',event:{raidId:raid.id,actorWallet:a.wallet,attackerBaseId:null,defenderWallet:d.wallet,defenderBaseId:null,pveCampId:null,campaignStage:null,kind:'legacy_pvp',originalClanId:c.id,originalLeaderWallet:a.wallet,clanOrdinal:'1'}});expect(first.event?.sourceId).toEqual(expect.any(String));expect(new Date(first.event!.admittedAt).getTime()).toBe(raid.createdAt.getTime());expect(raid.status).toBe('pending_orders');expect(await conn.sql`select id from ledger_transactions where idempotency_key=${'raid:'+raid.id+':loot'}`).toHaveLength(0);
  const retry=await admission(a.wallet,d.wallet,id);expect(retry.id).toBe(raid.id);expect(await events.read(retry.id)).toEqual(first);expect(await conn.sql`select * from clan_charter_raid_events`).toHaveLength(1);
 });
 it('distinguishes captured no-clan from untracked history after the actor joins a clan',async()=>{
  const a=await attacker(),leader=await funded(),c=await clan(leader.wallet),d=await defender();await initialize();const raid=await admission(a.wallet,d.wallet),events=await factory(),before=await events.read(raid.id);
  expect(before).toMatchObject({status:'captured',event:{originalClanId:null,originalLeaderWallet:null,clanOrdinal:null}});expect(await events.read(key())).toEqual({status:'untracked',event:null});
  await joinClan(conn.db,a.wallet,c.id);expect(await events.read(raid.id)).toEqual(before);expect(await conn.sql`select * from clan_charter_event_heads`).toHaveLength(0);
 });
 it('preserves the original clan and leader across kick and join while holding dissolution of unpriced captured history',async()=>{
  const a=await attacker(),oldLeader=await funded(),newLeader=await funded(),oldClan=await clan(oldLeader.wallet),newClan=await clan(newLeader.wallet),d=await defender();await joinClan(conn.db,a.wallet,oldClan.id);await initialize();const raid=await admission(a.wallet,d.wallet),events=await factory(),before=await events.read(raid.id);
  expect(before).toMatchObject({status:'captured',event:{originalClanId:oldClan.id,originalLeaderWallet:oldLeader.wallet,clanOrdinal:'1'}});
  await kickMember(conn.db,oldLeader.wallet,a.wallet);await joinClan(conn.db,a.wallet,newClan.id);
  const balances=await conn.sql`select id,balance from accounts order by id`,members=await conn.sql`select * from clan_members order by player_wallet`;
  // B6p cannot infer a historical rate for this B6a-only capture. Refusing the
  // later deletion must preserve attribution and the whole attempted dissolve.
  expect(raidChestPg(await leaveClan(conn.db,oldLeader.wallet).catch(error=>error))).toEqual({code:'P0001',message:'CLAN_CHARTER_RAID_CHEST_PENDING'});
  expect(await conn.db.select().from(clans).where(eq(clans.id,oldClan.id))).toEqual([oldClan]);
  expect(await conn.sql`select * from clan_members order by player_wallet`).toEqual(members);
  expect(await conn.sql`select player_wallet,clan_id from clan_members where player_wallet in(${oldLeader.wallet},${a.wallet})`).toEqual(expect.arrayContaining([
   {player_wallet:oldLeader.wallet,clan_id:oldClan.id},{player_wallet:a.wallet,clan_id:newClan.id},
  ]));
  expect(await conn.sql`select id,balance from accounts order by id`).toEqual(balances);
  expect(await conn.sql`select id from ledger_transactions where idempotency_key=${'clan-dissolve:'+oldClan.id}`).toHaveLength(0);
  expect(await conn.sql`select ordinal::text from clan_charter_event_heads where clan_id=${oldClan.id}`).toEqual([{ordinal:'1'}]);
  expect(await events.read(raid.id)).toEqual(before);
 });
 it('leaves actual legacy raid loot and chest backing unchanged while keeping admission evidence immutable',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender();await initialize(true);const raid=await admission(a.wallet,d.wallet),events=await factory(),before=await events.read(raid.id),defenderBefore=await shards(d.wallet),attackerBefore=await shards(a.wallet);
  const {result}=await resolve(a.wallet,raid.id);expect(result.stars).toBeGreaterThanOrEqual(1);const [saved]=await conn.db.select().from(clans).where(eq(clans.id,c.id));expect(saved!.chestShards).toBeGreaterThan(0n);const sys=await bootstrapSystemAccounts(conn.db),[pool]=await conn.sql`select balance from accounts where id=${sys.clan_chest}`;expect(BigInt(pool!.balance)).toBe(saved!.chestShards);
  const entries=await conn.sql`select e.delta,a.kind from ledger_entries e join ledger_transactions t on t.id=e.txn_id join accounts a on a.id=e.account_id where t.idempotency_key=${'raid:'+raid.id+':loot'}`;expect(entries).toHaveLength(3);expect(entries.reduce((sum,e)=>sum+BigInt(e.delta),0n)).toBe(0n);expect(entries.find(e=>e.kind==='clan_chest')?.delta).toBe(saved!.chestShards.toString());expect(defenderBefore-await shards(d.wallet)).toBe(await shards(a.wallet)-attackerBefore+saved!.chestShards);expect(await clanChestInvariantHolds(conn.db)).toBe(true);expect(await events.read(raid.id)).toEqual(before);
  // Capture has no terminal-reconciliation marker or authorization to sell.
  expect(await conn.sql`select status from raids where id=${raid.id}`).toEqual([{status:'resolved'}]);expect(await conn.sql`select * from clan_charter_raid_events`).toHaveLength(1);
 });
 it('rolls back a real admission and its tentative ordinal together, then retries the original key once',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender();await initialize();const before=await shards(a.wallet),request=key();
  // Fail the capture INSERT after its head allocation, inside the real raid's
  // transaction. This is an isolated fixture constraint, not a source bypass.
  await conn.sql`alter table clan_charter_raid_events add constraint b6a_fixture_rollback check (clan_ordinal is null) not valid`;
  try{await expect(admission(a.wallet,d.wallet,request)).rejects.toThrow();expect(await conn.sql`select id from raids where idempotency_key=${request}`).toHaveLength(0);expect(await conn.sql`select * from clan_charter_raid_events`).toHaveLength(0);expect(await conn.sql`select * from clan_charter_event_heads where clan_id=${c.id}`).toHaveLength(0);expect(await shards(a.wallet)).toBe(before);}finally{await conn.sql`alter table clan_charter_raid_events drop constraint b6a_fixture_rollback`;}
  const raid=await admission(a.wallet,d.wallet,request),event=await (await factory()).read(raid.id);expect(event).toMatchObject({status:'captured',event:{originalClanId:c.id,clanOrdinal:'1'}});expect((await admission(a.wallet,d.wallet,request)).id).toBe(raid.id);expect(await conn.sql`select * from clan_charter_raid_events`).toHaveLength(1);
 });
 it('holds initialization for a real older pending raid and never backfills it after actual terminal settlement',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender(),raid=await admission(a.wallet,d.wallet),events=await factory();expect(await events.read(raid.id)).toEqual({status:'untracked',event:null});
  await expect(initialize()).rejects.toMatchObject({code:'CLAN_CHARTER_EVENT_PENDING_RAIDS'});expect(await conn.sql`select * from clan_charter_event_source`).toHaveLength(0);expect(await conn.sql`select * from clan_charter_raid_events`).toHaveLength(0);
  await resolve(a.wallet,raid.id);const [chest]=await conn.db.select().from(clans).where(eq(clans.id,c.id)),first=await initialize();expect(first.sourceId).toEqual(expect.any(String));expect(await events.read(raid.id)).toEqual({status:'untracked',event:null});expect(await conn.sql`select * from clan_charter_raid_events`).toHaveLength(0);expect((await conn.db.select().from(clans).where(eq(clans.id,c.id)))[0]!.chestShards).toBe(chest!.chestShards);expect(await clanChestInvariantHolds(conn.db)).toBe(true);
  // Existing initialization is durable history and replays without new flags.
  expect(await events.initialize()).toEqual(first);expect(await conn.sql`select * from clan_charter_event_source`).toHaveLength(1);
 });
 it('orders admissions from distinct real clan attackers under one per-clan counter',async()=>{
  const a=await attacker(),b=await attacker(),c=await clan(a.wallet),d=await defender(),e=await defender();await joinClan(conn.db,b.wallet,c.id);await initialize();const first=await admission(a.wallet,d.wallet),second=await admission(b.wallet,e.wallet),events=await factory();
  expect(await events.read(first.id)).toMatchObject({status:'captured',event:{originalClanId:c.id,originalLeaderWallet:a.wallet,clanOrdinal:'1'}});expect(await events.read(second.id)).toMatchObject({status:'captured',event:{originalClanId:c.id,originalLeaderWallet:a.wallet,clanOrdinal:'2'}});expect(await conn.sql`select ordinal::text from clan_charter_event_heads where clan_id=${c.id}`).toEqual([{ordinal:'2'}]);
 });
});
