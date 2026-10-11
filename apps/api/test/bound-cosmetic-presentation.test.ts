/** Original-source appearance projection and transport pairing. This is private
 * service/SQL integration: no public cosmetic spend, combat or renderer claim. */
import {randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {beforeAll,afterAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {SIM_VERSION} from '@shardkeep/sim';
import {matchBoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import {createDb} from '../src/db/client';
import {bases,baseSlots,buildings,raids} from '../src/db/schema';
import {readBoundCosmeticBase,readBoundCosmeticRaid,boundCosmeticRaidFields,setBoundCosmeticAwning} from '../src/game/boundCosmeticPresentation';
import {getBaseState} from '../src/game/base';
import {getPendingRaidResume,getReplay} from '../src/game/raids';
import {persistReplayTimeline,decodeReplayTimeline,encodeReplayTimeline} from '../src/game/raidReplayArchive';
import {recordBaseBattle,getBaseBattleReplay} from '../src/game/baseBattleHistory';
import {cosmeticVisualDatabase} from './fixtures/boundCosmeticVisualDatabase';
import {completedCosmeticPresentation,prepareCosmeticVisualSchema,type CosmeticPresentationFixture} from './fixtures/boundCosmeticPresentation';
import {cosmeticStock} from './fixtures/boundCosmetics';
import {createTestPlayer} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';

const conn=cosmeticVisualDatabase(),db=conn.db;
beforeAll(()=>prepareCosmeticVisualSchema(conn),180000);afterAll(()=>conn.close());
beforeEach(()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED','PHASE_E_CATALOG_ENABLED'])vi.stubEnv(flag,'true');});
afterEach(()=>vi.unstubAllEnvs());
const toggle=(f:CosmeticPresentationFixture,enabled:boolean,expectedRevision:string)=>setBoundCosmeticAwning(db,f.wallet,{baseId:f.baseId,enabled,expectedRevision},f.authority);
async function current(f:CosmeticPresentationFixture){return getBaseState(db,f.wallet,f.now,f.baseId,f.authority.assertAuthority,()=>f.now,2);}
async function manualRaid(f:CosmeticPresentationFixture){
 const rows=await db.select({id:buildings.id,type:buildings.type,level:buildings.level,tx:buildings.tx,ty:buildings.ty}).from(buildings).where(eq(buildings.baseId,f.baseId));
 const snapshot={buildings:rows,traps:[],surplusShards:0},attacker=await createTestPlayer(db);
 const [raid]=await db.insert(raids).values({attackerWallet:attacker.wallet,defenderWallet:f.wallet,defenderBaseId:f.baseId,seed:1n,snapshot,armySnapshot:{counts:{},levels:{}},ordersDeadlineAt:new Date(+f.now+60_000),simVersion:SIM_VERSION}).returning();
 return {raid:raid!,snapshot,attacker};
}

it('pairs the actual completed source, current base DTO and captured pending snapshot for renderer acceptance',async()=>{
 const f=await completedCosmeticPresentation(db);const preference=await toggle(f,true,'0'),base=await current(f);
 expect(base.boundCosmetics).toEqual(preference.visual);expect(matchBoundCosmeticBaseRead(base.boundCosmetics,base.buildings)).toEqual(base.boundCosmetics);
 expect(base.boundCosmetics).toMatchObject({state:'available',visual:{marketAwnings:[{buildingId:f.market.id,appearance:f.appearance}]}});
 const {raid,snapshot,attacker}=await manualRaid(f),pending=await getPendingRaidResume(db,attacker.wallet,raid.id,f.now);
 expect(pending?.boundCosmeticVisual).toEqual(base.boundCosmetics);expect(pending?.snapshot).toEqual(snapshot);
 expect(await getPendingRaidResume(db,f.wallet,raid.id,f.now)).toBeNull();
 if(process.env.BOUND_COSMETIC_WRITE_FIXTURE==='1'){
  const directory=new URL('../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/',import.meta.url);mkdirSync(directory,{recursive:true});
  writeFileSync(new URL('actual-presentation.fixture.json',directory),JSON.stringify({version:1,
   scope:'Local original-source private service and SQL pairing; explicit facility/raw/refined stocks and manual raid insertion. No public cosmetic admission, combat or rendering proof.',
   source:{blueprint:f.blueprint,cosmetic:f.started,completedAt:f.now.toISOString()},preference,currentBase:base,pendingRaid:pending,
   raid:{id:raid.id,snapshot,boundCosmeticVisual:await readBoundCosmeticRaid(db,raid.id)}},(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n');
 }
});

it('makes a free concurrent identical preference retry once and rejects a delayed older choice',async()=>{
 const f=await completedCosmeticPresentation(db),stock=await cosmeticStock(f),ledger=await db.execute(sql`select count(*)::text n from ledger_transactions`);
 const [a,b]=await Promise.all([toggle(f,true,'0'),toggle(f,true,'0')]);expect(a).toEqual(b);expect(a.revision).toBe('1');
 await expect(toggle(f,false,'0')).rejects.toMatchObject({code:'BOUND_COSMETIC_PREFERENCE_CHANGED'});
 expect((await toggle(f,false,'1')).revision).toBe('2');
 await expect(toggle(f,true,'0')).rejects.toMatchObject({code:'BOUND_COSMETIC_PREFERENCE_CHANGED'});
 expect(await cosmeticStock(f)).toEqual(stock);expect(await db.execute(sql`select count(*)::text n from ledger_transactions`)).toEqual(ledger);
 expect(await readBoundCosmeticBase(db,f.baseId,f.wallet)).toEqual({state:'available',visual:{version:1,marketAwnings:[]}});
});

it('rolls back a choice when final locked authority changes and rejects another current account',async()=>{
 const f=await completedCosmeticPresentation(db);let calls=0;
 await expect(setBoundCosmeticAwning(db,f.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'0'},
  {baseId:f.baseId,assertAuthority:async()=>{if(++calls===2)throw Error('final ownership changed');}})).rejects.toThrow('final ownership changed');
 expect(calls).toBe(2);expect(await db.execute(sql`select * from bound_cosmetic_preferences where base_id=${f.baseId}`)).toEqual([]);
 const outsider=await createTestPlayer(db);await expect(setBoundCosmeticAwning(db,outsider.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'0'},f.authority)).rejects.toThrow();
 await toggle(f,true,'0');expect((await readBoundCosmeticBase(db,f.baseId,f.wallet)).state).toBe('available');
});

it('carries frozen appearance through actual replay/archive and inherited battle-history readers after explicit owner transfer',async()=>{
 const f=await completedCosmeticPresentation(db);await toggle(f,true,'0');const {raid,snapshot,attacker}=await manualRaid(f),fields=await boundCosmeticRaidFields(db,raid.id);
 const result={stars:1,destructionPct:50,lootShards:0},events:[]=[];
 // Resolution and battle facts are explicit fixtures; combat is not claimed.
 await db.update(raids).set({status:'resolved',orders:[],events,result}).where(eq(raids.id,raid.id));
 expect((await getReplay(db,attacker.wallet,raid.id)).boundCosmeticVisual).toEqual(fields.boundCosmeticVisual);
 const envelope={snapshot,armySnapshot:raid.armySnapshot,orders:[],seed:Number(raid.seed),simVersion:raid.simVersion,events,result,...fields};
 const archive=await persistReplayTimeline(db,raid.id,envelope,0);expect(decodeReplayTimeline(archive)).toEqual(envelope);
 const [attackerBase]=await db.insert(bases).values({ownerWallet:attacker.wallet,status:'active'}).returning();
 await recordBaseBattle(db,{raidId:raid.id,attackerBaseId:attackerBase!.id,defenderBaseId:f.baseId,attackerOwnerWallet:attacker.wallet,defenderOwnerWallet:f.wallet,stars:1,destructionPct:50,lootShards:0n,createdAt:f.now});
 await toggle(f,false,'1');const buyer=await createTestPlayer(db);
 await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet}).where(eq(bases.id,f.baseId));await tx.insert(baseSlots).values({wallet:buyer.wallet,baseId:f.baseId,slot:1});});
 expect(await readBoundCosmeticBase(db,f.baseId,f.wallet)).toEqual({state:'unavailable',visual:null});
 expect(await readBoundCosmeticBase(db,f.baseId,buyer.wallet)).toEqual({state:'available',visual:{version:1,marketAwnings:[]}});
 await expect(toggle(f,true,'2')).rejects.toThrow();
 expect((await getReplay(db,f.wallet,raid.id)).boundCosmeticVisual).toEqual(fields.boundCosmeticVisual);
 const inherited=await getBaseBattleReplay(db,buyer.wallet,f.baseId,raid.id);
 expect(inherited.boundCosmeticVisual).toEqual(fields.boundCosmeticVisual);expect(inherited.timeline.integrityVerified).toBe(true);
 const reopened=conn.reopen();try{expect(await readBoundCosmeticRaid(reopened.db,raid.id)).toEqual(fields.boundCosmeticVisual);}finally{await reopened.sql.end();}
});

it('preserves optional historical archive absence and explicit unavailable without consulting current appearance',async()=>{
 const f=await completedCosmeticPresentation(db);await toggle(f,true,'0');const {raid,snapshot,attacker}=await manualRaid(f);
 expect(await boundCosmeticRaidFields(db,randomUUID())).toEqual({});
 const envelope={snapshot,armySnapshot:raid.armySnapshot,orders:[],seed:1,simVersion:SIM_VERSION,events:[],result:{stars:0}};
 // An old-format archive fixture deliberately has no presentation sibling.
 expect(decodeReplayTimeline(encodeReplayTimeline(envelope,0))).not.toHaveProperty('boundCosmeticVisual');
 await persistReplayTimeline(db,raid.id,envelope,0);await db.update(raids).set({status:'resolved',orders:[],events:[],result:{stars:0}}).where(eq(raids.id,raid.id));
 expect(await getReplay(db,attacker.wallet,raid.id)).not.toHaveProperty('boundCosmeticVisual');
 const unavailable={state:'unavailable',visual:null} as const;
 expect(decodeReplayTimeline(encodeReplayTimeline({...envelope,boundCosmeticVisual:unavailable},0)).boundCosmeticVisual).toEqual(unavailable);
 await toggle(f,false,'1');expect(await getReplay(db,attacker.wallet,raid.id)).not.toHaveProperty('boundCosmeticVisual');
});

it('two actual local provisioning passes expose only projection capabilities and refuse the private preference writer',async()=>{
 const f=await completedCosmeticPresentation(db);await toggle(f,true,'0');const {raid}=await manualRaid(f),expected=await readBoundCosmeticBase(db,f.baseId,f.wallet);
 const [current]=await db.execute<{name:string}>(sql`select current_database() name`),ownerUrl=new URL(ADMIN_DATABASE_URL);ownerUrl.pathname='/'+current!.name;
 const suffix=randomUUID().replaceAll('-',''),api='visual_api_'+suffix,worker='visual_worker_'+suffix,password=randomBytes(32).toString('hex'),workerPassword=randomBytes(32).toString('hex');
 const env={PATH:process.env.PATH,PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:current!.name,PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),
  POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',
  API_DB_USER:api,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:workerPassword};
 const tables=['bound_cosmetic_preferences','bound_cosmetic_raid_visuals','bound_cosmetic_charter_contract','bound_cosmetic_jobs','bound_cosmetic_completions'];
 try{
  for(let run=0;run<2;run++){
   execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{env,timeout:30000,maxBuffer:2*1024*1024});
   await db.execute(sql`select public.shardkeep_charter_retirement_source(),public.shardkeep_divine_fragment_source()`);
   expect((await db.execute<{valid:boolean}>(sql`select public.shardkeep_bound_cosmetic_visual_sources_valid() valid`))[0]!.valid).toBe(true);
   for(const role of [api,worker]){
    const url=new URL(ownerUrl);url.username=role;url.password=role===api?password:workerPassword;const reader=createDb(url.toString(),{max:1});
    try{
     expect(await readBoundCosmeticBase(reader.db,f.baseId,f.wallet)).toEqual(expected);expect(await readBoundCosmeticRaid(reader.db,raid.id)).toEqual(expected);
     await expect(setBoundCosmeticAwning(reader.db,f.wallet,{baseId:f.baseId,enabled:false,expectedRevision:'1'},f.authority)).rejects.toMatchObject({code:'BOUND_COSMETIC_OWNER'});
     for(const name of tables){
      const [acl]=await reader.db.execute<{table_acl:boolean;column_acl:boolean}>(sql`select has_table_privilege(current_user,${'public.'+name},'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') table_acl,has_any_column_privilege(current_user,${'public.'+name},'SELECT,INSERT,UPDATE,REFERENCES') column_acl`);
      expect(acl).toEqual({table_acl:false,column_acl:false});await expect(reader.db.execute(sql.raw('select * from public.'+name))).rejects.toThrow();
     }
    }finally{await reader.sql.end();}
   }
  }
 }finally{for(const role of [api,worker]){const [exists]=await db.execute(sql`select 1 from pg_roles where rolname=${role}`);if(exists){await db.execute(sql.raw('drop owned by '+role));await db.execute(sql.raw('drop role '+role));}}}
},90000);
