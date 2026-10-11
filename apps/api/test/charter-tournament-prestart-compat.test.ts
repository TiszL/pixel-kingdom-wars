/** Existing B6a-only observers remain usable with every Phase E flag off. They
 * never become a D176 receipt or a tournament witness by this compatibility fix. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LIVE_RAID} from '@shardkeep/shared';
import {army} from '../src/db/schema';
import {ensureStartingBase} from '../src/game/base';
import {createCampaignRaid} from '../src/game/raids';
import {retreatLiveRaid} from '../src/game/liveRaids';
import {createTestPlayer} from './helpers';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
let f:ReturnType<typeof resourceClaimsDatabase>;
beforeEach(async()=>{vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');f=resourceClaimsDatabase();await f.setup();},120000);
afterEach(async()=>{try{await f?.close();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
it('preserves normal V2 prestart retreat for an actual B6a-only admission without creating new authority',async()=>{
 const actor=await createTestPlayer(f.db);await ensureStartingBase(f.db,actor.wallet);
 await f.db.insert(army).values({playerWallet:actor.wallet,troop:'highlander',count:1}).onConflictDoUpdate({target:[army.playerWallet,army.troop],set:{count:1}});
 await f.sql`select * from shardkeep_clan_charter_event_source_initialize()`;
 const raid=await createCampaignRaid(f.db,actor.wallet,1,randomUUID(),new Date(),{raidProtocolVersion:LIVE_RAID.protocolVersion,allowRaidProtocolV2:true});
 expect(await f.sql`select raid_id,tithe_rule_id from clan_charter_raid_events where raid_id=${raid.id}`).toEqual([{raid_id:raid.id,tithe_rule_id:null}]);
 expect(await f.sql`select * from charter_sale_raid_admissions`).toHaveLength(0);
 expect(await retreatLiveRaid(f.db,actor.wallet,raid.id,randomUUID(),new Date(raid.createdAt))).toMatchObject({terminal:true,result:{stars:0,lootShards:0,retreated:true}});
 expect(await f.sql`select status from raids where id=${raid.id}`).toEqual([{status:'resolved'}]);
 expect(await f.sql`select * from charter_tournament_prestart_retreats`).toHaveLength(0);
 expect(await f.sql`select * from clan_charter_raid_terminals`).toHaveLength(0);
 expect(await f.sql`select public.shardkeep_clan_charter_raid_chest_proof(${raid.id},true)->>'status' status`).toEqual([{status:'held'}]);
},120000);
