/** Current writer and explicit pre-K232 historical observations. Reconciliation
 * does not redirect loot, authorize a Charter sale, or settle other refunds. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {CAMPAIGN,STRUCTURES} from '@shardkeep/shared';
import {clans} from '../src/db/schema';
import {createClan,joinClan,leaveClan,clanChestInvariantHolds} from '../src/game/clans';
import {completeDueJobs,ensureStartingBase,placeBuilding} from '../src/game/base';
import {completeDueTraining} from '../src/game/army';
import {batchOrdersSubmitDeadlineAt,createCampaignRaid,createRaid,getRaidEnergy,submitOrders} from '../src/game/raids';
import {rewardShards,spendShards} from '../src/game/spend';
import {getOrCreatePlayerAccount} from '../src/ledger';
import {createTestPlayer,fundTestKeep} from './helpers';
import {trainTroop} from './training-consent';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {withHistoricalUnpricedClanWriter} from './fixtures/historicalClanRaidWriter';
import {createClanCharterRaidChest} from '../src/game/clanCharterRaidChest';

let conn:ReturnType<typeof resourceClaimsDatabase>;
const key=()=>randomUUID(),future=(minutes:number)=>new Date(Date.now()+minutes*60_000);
beforeEach(async()=>{vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');conn=resourceClaimsDatabase();await conn.setup();},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await conn?.close();},120_000);
async function reconciliation(db=conn.db){const {createClanCharterReconciliation}=await import('../src/game/clanCharterReconciliation');return createClanCharterReconciliation(db);}
async function initialize(historical=false){const {createClanCharterEvents}=await import('../src/game/clanCharterEvents');vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');try{return historical ? await createClanCharterEvents(conn.db).initialize() : await createClanCharterRaidChest(conn.db).initializeRule();}finally{vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');}}
async function funded(){const p=await createTestPlayer(conn.db);await rewardShards(conn.db,p.wallet,1_000_000n,'test.charter-terminal.shards',key());return p;}
async function clan(wallet:string){return createClan(conn.db,wallet,{name:'Clan '+key().slice(0,8),tag:key().slice(0,5).toUpperCase()},key());}
async function attacker(troop:'highlander'|'turrider'='highlander'){
 const p=await funded();await fundTestKeep(conn.db,p.wallet,1_000_000n,'test.charter-terminal.keep',key());await ensureStartingBase(conn.db,p.wallet);
 await placeBuilding(conn.db,p.wallet,'barracks' as never,17,17,key());await completeDueJobs(conn.db,p.wallet,future(120));await placeBuilding(conn.db,p.wallet,'camp' as never,19,19,key());await completeDueJobs(conn.db,p.wallet,future(240));
 for(let i=0;i<(troop==='turrider'?4:6);i++){await trainTroop(conn.db,p.wallet,troop,key(),future(300+i*10));await completeDueTraining(conn.db,p.wallet,future(310+i*10));}return p;
}
async function defender(hasLoot=true){const p=await createTestPlayer(conn.db);await ensureStartingBase(conn.db,p.wallet);if(hasLoot)await rewardShards(conn.db,p.wallet,BigInt(STRUCTURES.vault.capacity[0]!)+50_000n,'test.charter-terminal.defender',key());await completeDueJobs(conn.db,p.wallet,future(120));return p;}
async function admission(wallet:string,target:string){return createRaid(conn.db,wallet,{defenderWallet:target,idempotencyKey:key()});}
function resolve(wallet:string,raidId:string){return submitOrders(conn.db,wallet,raidId,{idempotencyKey:key(),deploys:[{troop:'highlander',tx:6,ty:14,tMs:0},{troop:'highlander',tx:6,ty:15,tMs:0},{troop:'highlander',tx:23,ty:14,tMs:0},{troop:'highlander',tx:23,ty:15,tMs:0},{troop:'highlander',tx:14,ty:6,tMs:0},{troop:'highlander',tx:14,ty:23,tMs:0}]});}
async function entries(raidId:string){return conn.sql`select e.id::text,e.delta::text,a.kind,a.owner_wallet from ledger_entries e join ledger_transactions t on t.id=e.txn_id join accounts a on a.id=e.account_id where t.idempotency_key=${'raid:'+raidId+':loot'} order by e.id`;}
async function chest(clanId:string){const [row]=await conn.db.select().from(clans).where(eq(clans.id,clanId));return row!.chestShards;}
const shards=(wallet:string)=>getOrCreatePlayerAccount(conn.db,wallet,'player_shards').then(a=>a.balance);
async function held(raidId:string){const result=await (await reconciliation()).read(raidId);expect(result).toMatchObject({status:'held',reason:expect.any(String)});if(result.status==='held')expect(result.reason.length).toBeGreaterThan(0);return result;}
async function positiveWitness(raidId:string,actualClanId:string,amount:bigint){
 const posts=await conn.sql`select * from clan_charter_loot_posts where raid_id=${raidId}`;expect(posts).toHaveLength(1);const post=posts[0]!;
 const savedEntries=await conn.sql`select * from clan_charter_loot_entries where ledger_id=${post.ledger_id}`,updates=await conn.sql`select * from clan_charter_chest_updates where ledger_id=${post.ledger_id}`,terminals=await conn.sql`select * from clan_charter_raid_terminals where raid_id=${raidId}`;
 expect(savedEntries).toHaveLength(3);expect(updates).toHaveLength(1);expect(terminals).toHaveLength(1);expect(updates[0]).toMatchObject({actual_clan_id:actualClanId,pairing:'matched',delta:amount.toString()});expect(terminals[0]).toMatchObject({terminal_status:'resolved'});
 // This is the original full transaction identity across the ledger's nested
 // savepoint, the actual clan attribution UPDATE, and final raid transition.
 expect(post.tx_key).toMatch(/^[1-9][0-9]*$/);for(const row of [...savedEntries,...updates,...terminals])expect(row.tx_key).toBe(post.tx_key);
 expect(BigInt(updates[0]!.after_clan.chest_shards)-BigInt(updates[0]!.before_clan.chest_shards)).toBe(amount);
}

describe('actual raid terminal reconciliation for clan Charter evidence',()=>{
 it('reconciles the original clan actual positive payment and replays while paused after reopening without posting again',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender();await initialize();const raid=await admission(a.wallet,d.wallet),attackerBefore=await shards(a.wallet),defenderBefore=await shards(d.wallet);
  const {result}=await resolve(a.wallet,raid.id);expect(result.stars).toBeGreaterThanOrEqual(1);const paid=await chest(c.id);expect(paid).toBeGreaterThan(0n);const postings=await entries(raid.id);expect(postings).toHaveLength(3);expect(postings.reduce((sum,e)=>sum+BigInt(e.delta),0n)).toBe(0n);expect(postings.find(e=>e.kind==='clan_chest')?.delta).toBe(paid.toString());expect(defenderBefore-await shards(d.wallet)).toBe(await shards(a.wallet)-attackerBefore+paid);
  const expected={status:'reconciled',raidId:raid.id,originalClanId:c.id,terminalStatus:'resolved',chestShards:paid.toString()};expect(await (await reconciliation()).read(raid.id)).toEqual(expected);await positiveWitness(raid.id,c.id,paid);
  // Both flags have stayed off since admission-source initialization. History
  // still survives a fresh capability/connection without another money write.
  const reopened=conn.reopen();try{expect(await (await reconciliation(reopened.db)).read(raid.id)).toEqual(expected);}finally{await reopened.sql.end();}
  expect(await entries(raid.id)).toEqual(postings);expect(await chest(c.id)).toBe(paid);expect(await clanChestInvariantHolds(conn.db)).toBe(true);
 });
 it('retains actual credit to a different current clan and holds the original-clan mismatch',async()=>{
  const a=await attacker(),oldLeader=await funded(),newLeader=await funded(),oldClan=await clan(oldLeader.wallet),newClan=await clan(newLeader.wallet),d=await defender();await joinClan(conn.db,a.wallet,oldClan.id);await initialize(true);const raid=await admission(a.wallet,d.wallet);
  await leaveClan(conn.db,a.wallet);await joinClan(conn.db,a.wallet,newClan.id);await withHistoricalUnpricedClanWriter(()=>resolve(a.wallet,raid.id));expect(await chest(oldClan.id)).toBe(0n);const actual=await chest(newClan.id);expect(actual).toBeGreaterThan(0n);expect((await entries(raid.id)).find(e=>e.kind==='clan_chest')?.delta).toBe(actual.toString());await positiveWitness(raid.id,newClan.id,actual);await held(raid.id);expect(await clanChestInvariantHolds(conn.db)).toBe(true);
 });
 it('holds positive untithed loot after leaving the original clan rather than guessing a historical floor-zero rate',async()=>{
  const a=await attacker(),leader=await funded(),c=await clan(leader.wallet),d=await defender();await joinClan(conn.db,a.wallet,c.id);await initialize(true);const raid=await admission(a.wallet,d.wallet);await leaveClan(conn.db,a.wallet);const {result}=await withHistoricalUnpricedClanWriter(()=>resolve(a.wallet,raid.id));
  expect(result.lootShards).toBeGreaterThan(0);const posting=await entries(raid.id);expect(posting).toHaveLength(2);expect(posting.every(e=>e.kind==='player_shards')).toBe(true);expect(posting.reduce((sum,e)=>sum+BigInt(e.delta),0n)).toBe(0n);expect(await chest(c.id)).toBe(0n);await held(raid.id);
 });
 it('holds a positive current-clan payment after a captured clanless actor joins instead of assigning an original clan retroactively',async()=>{
  const a=await attacker(),leader=await funded(),c=await clan(leader.wallet),d=await defender();await initialize(true);const raid=await admission(a.wallet,d.wallet);await joinClan(conn.db,a.wallet,c.id);await withHistoricalUnpricedClanWriter(()=>resolve(a.wallet,raid.id));const actual=await chest(c.id);expect(actual).toBeGreaterThan(0n);expect(await entries(raid.id)).toHaveLength(3);await positiveWitness(raid.id,c.id,actual);await held(raid.id);expect(await clanChestInvariantHolds(conn.db)).toBe(true);
 });
 it('reconciles captured-none positive two-entry loot as zero original-clan chest obligation',async()=>{
  const a=await attacker(),d=await defender();await initialize();const raid=await admission(a.wallet,d.wallet),{result}=await resolve(a.wallet,raid.id);expect(result.lootShards).toBeGreaterThan(0);const posting=await entries(raid.id);expect(posting).toHaveLength(2);expect(posting.reduce((sum,e)=>sum+BigInt(e.delta),0n)).toBe(0n);expect(posting.every(e=>e.kind==='player_shards')).toBe(true);
  expect(await (await reconciliation()).read(raid.id)).toEqual({status:'reconciled',raidId:raid.id,originalClanId:null,terminalStatus:'resolved',chestShards:'0'});expect(await clanChestInvariantHolds(conn.db)).toBe(true);
 });
 it('reconciles an actual zero-loot resolution without inventing a loot posting or a tithe',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender(false);
  // A new defender still owns starting SHARDS. Drain them through the actual
  // balanced spend path before admission, so both snapshot and source are zero.
  const starting=await shards(d.wallet);expect(starting).toBeGreaterThan(0n);await spendShards(conn.db,d.wallet,starting,'test.charter-terminal.empty-defender',key());expect(await shards(d.wallet)).toBe(0n);
  await initialize();const raid=await admission(a.wallet,d.wallet),{result}=await resolve(a.wallet,raid.id);expect(result.lootShards).toBe(0);expect(await entries(raid.id)).toHaveLength(0);expect(await chest(c.id)).toBe(0n);expect(await shards(d.wallet)).toBe(0n);
  expect(await (await reconciliation()).read(raid.id)).toEqual({status:'reconciled',raidId:raid.id,originalClanId:c.id,terminalStatus:'resolved',chestShards:'0'});expect(await clanChestInvariantHolds(conn.db)).toBe(true);
 });
 it('keeps the actual campaign reward at full value and reconciles only its zero clan-chest obligation',async()=>{
  // Reuse the real four-rider stage-one witness from world.test.ts; no fake
  // result, campaign reward receipt or declared tax exemption is injected.
  const a=await attacker('turrider'),c=await clan(a.wallet);await initialize();const raid=await createCampaignRaid(conn.db,a.wallet,1,key()),before=await shards(a.wallet);
  const {result}=await submitOrders(conn.db,a.wallet,raid.id,{idempotencyKey:key(),deploys:[{troop:'turrider',tx:6,ty:14,tMs:0},{troop:'turrider',tx:23,ty:14,tMs:0},{troop:'turrider',tx:14,ty:6,tMs:0},{troop:'turrider',tx:14,ty:23,tMs:0}]});expect(result.stars).toBe(3);
  const reward=BigInt(CAMPAIGN.firstThreeStarShardsByKeep[CAMPAIGN.encounters[0]!.keepLevel-1]!);expect(await shards(a.wallet)-before).toBe(reward);const rewardEntries=await conn.sql`select e.delta::text,a.kind from ledger_entries e join ledger_transactions t on t.id=e.txn_id join accounts a on a.id=e.account_id where t.idempotency_key=${'campaign-3star:'+a.wallet+':1'}`;
  expect(rewardEntries).toHaveLength(2);expect(rewardEntries.find(e=>e.kind==='player_shards')?.delta).toBe(reward.toString());expect(rewardEntries.reduce((sum,e)=>sum+BigInt(e.delta),0n)).toBe(0n);expect(await entries(raid.id)).toHaveLength(0);expect(await chest(c.id)).toBe(0n);expect(await conn.sql`select * from clan_charter_chest_updates`).toHaveLength(0);
  expect(await (await reconciliation()).read(raid.id)).toEqual({status:'reconciled',raidId:raid.id,originalClanId:c.id,terminalStatus:'resolved',chestShards:'0'});
 });
 it('uses real stale-raid expiry as zero chest evidence without declaring unrelated refunds settled',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender();await initialize();const raid=await admission(a.wallet,d.wallet);await held(raid.id);await getRaidEnergy(conn.db,a.wallet,new Date(batchOrdersSubmitDeadlineAt(raid.ordersDeadlineAt).getTime()+1));expect(await conn.sql`select status from raids where id=${raid.id}`).toEqual([{status:'expired'}]);expect(await entries(raid.id)).toHaveLength(0);expect(await chest(c.id)).toBe(0n);
  expect(await (await reconciliation()).read(raid.id)).toEqual({status:'reconciled',raidId:raid.id,originalClanId:c.id,terminalStatus:'expired',chestShards:'0'});
 });
 it('rolls back actual terminal settlement, ledger and credit evidence together and retries the same raid exactly once',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender();await initialize();const raid=await admission(a.wallet,d.wallet),attackerBefore=await shards(a.wallet),defenderBefore=await shards(d.wallet);
  // Reject only the final witness INSERT, after real loot/chest writes. The
  // real top-level submitOrders failure path must roll its settlement back.
  await conn.sql`alter table clan_charter_raid_terminals add constraint b6b_fixture_rollback check (terminal_status <> 'resolved') not valid`;
  try{await expect(resolve(a.wallet,raid.id)).rejects.toThrow();}finally{await conn.sql`alter table clan_charter_raid_terminals drop constraint b6b_fixture_rollback`;}
  expect(await conn.sql`select status from raids where id=${raid.id}`).toEqual([{status:'pending_orders'}]);expect(await entries(raid.id)).toHaveLength(0);expect(await chest(c.id)).toBe(0n);expect(await shards(a.wallet)).toBe(attackerBefore);expect(await shards(d.wallet)).toBe(defenderBefore);await held(raid.id);
  expect(await conn.sql`select * from clan_charter_loot_posts`).toHaveLength(0);expect(await conn.sql`select * from clan_charter_loot_entries`).toHaveLength(0);expect(await conn.sql`select * from clan_charter_chest_updates`).toHaveLength(0);expect(await conn.sql`select * from clan_charter_raid_terminals`).toHaveLength(0);
  await resolve(a.wallet,raid.id);const paid=await chest(c.id);expect(paid).toBeGreaterThan(0n);const expected={status:'reconciled',raidId:raid.id,originalClanId:c.id,terminalStatus:'resolved',chestShards:paid.toString()};expect(await (await reconciliation()).read(raid.id)).toEqual(expected);expect(await (await reconciliation()).read(raid.id)).toEqual(expected);await positiveWitness(raid.id,c.id,paid);expect(await entries(raid.id)).toHaveLength(3);expect(await clanChestInvariantHolds(conn.db)).toBe(true);
 });
 it('keeps a real terminal raid predating admission enrollment untracked instead of reconstructing its original clan',async()=>{
  const a=await attacker(),c=await clan(a.wallet),d=await defender(),raid=await admission(a.wallet,d.wallet);await resolve(a.wallet,raid.id);const before=await entries(raid.id),paid=await chest(c.id);expect(paid).toBeGreaterThan(0n);await initialize();expect(await (await reconciliation()).read(raid.id)).toEqual({status:'untracked'});expect(await entries(raid.id)).toEqual(before);expect(await chest(c.id)).toBe(paid);
 });
});
