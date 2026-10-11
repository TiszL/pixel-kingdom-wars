/** Real private service, SQL custody and completed-refining Blueprint source.
 * Raw stocks/facility construction are explicit fixture authority, not an
 * expedition/marketplace or rendered-appearance acceptance claim. */
import {randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {beforeAll,afterAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {BoundCosmeticAppearanceSchema,type BoundCosmeticRequest} from '@shardkeep/shared/boundCosmeticApi';
import {bases,baseSlots,craftingStocks} from '../src/db/schema';
import {boundCosmeticEnvelope,startBoundCosmetic,settleDueBoundCosmetics} from '../src/game/boundCosmetics';
import {settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {boundCosmeticFixture,cosmeticMaterials,cosmeticStock,pendingOrdinary} from './fixtures/boundCosmetics';
import {createTestPlayer} from './helpers';
const conn=resourceClaimsDatabase(),db=conn.db,awning='craft_artisan_market_awning_t1_v1';
beforeAll(()=>conn.setup(),120000);afterAll(()=>conn.close());
beforeEach(()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED','PHASE_E_CATALOG_ENABLED'])vi.stubEnv(flag,'true');});
afterEach(()=>vi.unstubAllEnvs());
async function fixture(wallet?:string,slot?:number){
 const f=await boundCosmeticFixture(db,{...(wallet?{wallet}:{}),...(slot===undefined?{}:{slot})});
 const source=await pendingOrdinary(f);f.now=source.job.readyAt;await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,f.now));
 const recipe=await cosmeticMaterials(f,awning);
 const [row]=await db.execute<{appearance:unknown}>(sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
 const appearance=BoundCosmeticAppearanceSchema.parse(row!.appearance);
 const request:BoundCosmeticRequest={idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:awning,recipeVersion:1,appearanceBindingSha256:appearance.bindingSha256};
 return {...f,request,source,recipe};
}
type F=Awaited<ReturnType<typeof fixture>>;
const start=(f:F,request=f.request)=>startBoundCosmetic(db,f.wallet,request,f.authority,{clock:()=>f.now});
const grants=(wallet:string)=>db.execute(sql`select source_job_id from bound_cosmetic_blueprints where wallet=${wallet}`);

it('atomically grants from completed original refining and recovers one craft after concurrent retry and reopen',async()=>{
 const f=await fixture();expect(await grants(f.wallet)).toEqual([]);
 const [a,b]=await Promise.all([start(f),start(f)]);expect(a.receipt).toEqual(b.receipt);
 if(a.status!=='accepted')throw Error('Expected accepted original');
 expect(a.receipt.blueprint.jobId).toBe(f.source.job.id);expect(await grants(f.wallet)).toEqual([{source_job_id:f.source.job.id}]);
 for(const input of f.recipe.inputs)expect((await cosmeticStock(f)).find(s=>s.itemId===input.itemId)!.available).toBe(0n);
 const reopened=conn.reopen();try{expect((await boundCosmeticEnvelope(reopened.db,f.wallet,f.request.idempotencyKey)).receipt).toEqual(a.receipt);}finally{await reopened.sql.end();}
 await db.transaction(tx=>settleDueBoundCosmetics(tx,f.baseId,new Date(a.receipt.readyAt)));
 await db.transaction(tx=>settleDueBoundCosmetics(tx,f.baseId,new Date(a.receipt.readyAt)));
 expect((await boundCosmeticEnvelope(db,f.wallet,f.request.idempotencyKey)).completion).toEqual({completedAt:a.receipt.readyAt});
});
it('a missing later material rolls back the first Blueprint grant and every earlier debit',async()=>{
 const f=await fixture(),last=f.recipe.inputs.at(-1)!;
 await db.update(craftingStocks).set({available:0n}).where(and(eq(craftingStocks.baseId,f.baseId),eq(craftingStocks.itemId,last.itemId)));
 const before=await cosmeticStock(f);await expect(start(f)).rejects.toMatchObject({code:'INSUFFICIENT_CRAFTING_STOCK'});
 expect(await cosmeticStock(f)).toEqual(before);expect(await grants(f.wallet)).toEqual([]);
 expect((await boundCosmeticEnvelope(db,f.wallet,f.request.idempotencyKey)).status).toBe('unknown');
});
it('new appearance consent and final base authority must both hold before any stock or grant survives',async()=>{
 const f=await fixture(),before=await cosmeticStock(f);
 await expect(start(f,{...f.request,appearanceBindingSha256:'0'.repeat(64)})).rejects.toMatchObject({code:'BOUND_COSMETIC_APPEARANCE_CHANGED'});
 let calls=0;await expect(startBoundCosmetic(db,f.wallet,f.request,{baseId:f.baseId,assertAuthority:async()=>{if(++calls===2)throw Error('Authority changed');}},{clock:()=>f.now})).rejects.toThrow('Authority changed');
 expect(await cosmeticStock(f)).toEqual(before);expect(await grants(f.wallet)).toEqual([]);
});
it('one account cannot buy the same appearance twice from two kingdoms',async()=>{
 const a=await fixture(),b=await fixture(a.wallet,2),before=await cosmeticStock(b);
 await start(a);await expect(start(b)).rejects.toMatchObject({code:'BOUND_COSMETIC_ALREADY_OWNED'});
 expect(await cosmeticStock(b)).toEqual(before);expect((await boundCosmeticEnvelope(db,b.wallet,b.request.idempotencyKey)).status).toBe('unknown');
});
it('pause and an explicit owner/slot transfer fixture preserve original-actor completion and exact replay without buyer inheritance',async()=>{
 const f=await fixture(),original=await start(f);if(original.status!=='accepted')throw Error('Original missing');
 const buyer=await createTestPlayer(db);await db.transaction(async tx=>{
  await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.baseId));
 });
 vi.stubEnv('PHASE_E_CATALOG_ENABLED','false');vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');
 await db.transaction(tx=>settleDueBoundCosmetics(tx,f.baseId,f.now));expect((await boundCosmeticEnvelope(db,f.wallet,f.request.idempotencyKey)).completion).toBeNull();
 await db.transaction(tx=>settleDueBoundCosmetics(tx,f.baseId,new Date(original.receipt.readyAt)));
 const replay=await start(f);expect(replay.receipt).toEqual(original.receipt);expect(replay.completion).toEqual({completedAt:original.receipt.readyAt});
 expect((await boundCosmeticEnvelope(db,buyer.wallet,f.request.idempotencyKey)).status).toBe('unknown');
 await expect(start(f,{...f.request,baseId:randomUUID()})).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
});
it('missing Blueprint and disabled catalogue never turn existing stocks into an automatic entitlement',async()=>{
 const f=await boundCosmeticFixture(db),recipe=await cosmeticMaterials(f,awning);
 const [row]=await db.execute<{appearance:unknown}>(sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
 const appearance=BoundCosmeticAppearanceSchema.parse(row!.appearance),request={idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:awning,recipeVersion:1,appearanceBindingSha256:appearance.bindingSha256};
 await expect(startBoundCosmetic(db,f.wallet,request,f.authority,{clock:()=>f.now})).rejects.toMatchObject({code:'BOUND_COSMETIC_BLUEPRINT_REQUIRED'});
 vi.stubEnv('PHASE_E_CATALOG_ENABLED','false');await expect(startBoundCosmetic(db,f.wallet,request,f.authority)).rejects.toMatchObject({code:'PHASE_E_DISABLED'});
 expect(await grants(f.wallet)).toEqual([]);for(const input of recipe.inputs)expect((await cosmeticStock(f)).find(s=>s.itemId===input.itemId)!.available).toBe(BigInt(input.quantity));
});


it('repeated actual local provisioning leaves cosmetic tables private and the canonical source admitted',async()=>{
 const [current]=await db.execute<{name:string}>(sql`select current_database() name`),ownerUrl=new URL(ADMIN_DATABASE_URL);
 ownerUrl.pathname='/'+current!.name;
 const suffix=randomUUID().replaceAll('-',''),api='cos_api_'+suffix,worker='cos_worker_'+suffix,password=randomBytes(32).toString('hex'),workerPassword=randomBytes(32).toString('hex');
 const env={PATH:process.env.PATH,PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:current!.name,PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),
  POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',
  API_DB_USER:api,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:workerPassword};
 const names=['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions','bound_cosmetic_return_contract'];
 try{
  for(let run=0;run<2;run++){
   execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{env,timeout:30000,maxBuffer:2*1024*1024});
   await db.execute(sql`select public.shardkeep_divine_fragment_source()`);
   for(const role of [api,worker]){
    const url=new URL(ownerUrl);url.username=role;url.password=role===api?password:workerPassword;
    const reader=createDb(url.toString(),{max:1});try{
     for(const name of names){
      const [acl]=await reader.db.execute<{table_acl:boolean;column_acl:boolean}>(sql`select has_table_privilege(current_user,${'public.'+name},'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') table_acl,has_any_column_privilege(current_user,${'public.'+name},'SELECT,INSERT,UPDATE,REFERENCES') column_acl`);
      expect(acl).toEqual({table_acl:false,column_acl:false});
      await expect(reader.db.execute(sql.raw('select * from public.'+name))).rejects.toThrow();
     }
    }finally{await reader.sql.end();}
   }
  }
 }finally{
  for(const role of [api,worker]){
   const [exists]=await db.execute(sql`select 1 from pg_roles where rolname=${role}`);
   if(exists){await db.execute(sql.raw('drop owned by '+role));await db.execute(sql.raw('drop role '+role));}
  }
 }
},90000);
