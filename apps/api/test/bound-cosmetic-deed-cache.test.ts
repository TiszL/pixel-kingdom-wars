/** Actual custody/preference source, explicit local deed fixtures, fake image
 * renderer/putter. This verifies cache identity and capture, never scene pixels. */
import {createHash,randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {and,eq,isNull} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {BUILD_COSTS,BuildingType} from '@shardkeep/shared';
import type {BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import type {BaseVisualContext} from '@shardkeep/shared/baseVisual';
import type {Db} from '../src/db/client';
import {bases,baseSlots,buildings,builderJobs,deedOwnershipObservations,obstacles} from '../src/db/schema';
import {sweepDeedMetadata,type ObjectPutter} from '../src/game/deedR2';
import {readBoundCosmeticBase,setBoundCosmeticAwning} from '../src/game/boundCosmeticPresentation';
import {resolveBaseVisual} from '../src/game/baseVisual';
import {observationHash} from '../src/game/baseOwnership';
import {cosmeticVisualDatabase} from './fixtures/boundCosmeticVisualDatabase';
import {completedCosmeticPresentation,type CosmeticPresentationFixture} from './fixtures/boundCosmeticPresentation';
import {createTestPlayer} from './helpers';
const renderer=vi.hoisted(()=>vi.fn<(db:Db,wallet:string,baseId?:string,context?:BaseVisualContext,appearance?:BoundCosmeticBaseRead,captured?:null)=>Promise<Buffer|null>>());
vi.mock('../src/game/baseRender',()=>({baseRenderAvailable:()=>true,baseRenderFleetArtFingerprint:()=>null,renderBasePng:renderer}));
const conn=cosmeticVisualDatabase(),db=conn.db,PUB='https://deed-cache.invalid';
beforeAll(()=>conn.setup(),180000);afterAll(()=>conn.close());
beforeEach(()=>{
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED','PHASE_E_CATALOG_ENABLED'])vi.stubEnv(flag,'true');
 vi.stubEnv('FANTASY_WORLD_ENABLED','false');vi.stubEnv('DEV_LOGIN_REALM','');vi.stubEnv('DEED_IMAGE_URL',undefined);
 renderer.mockReset();renderer.mockImplementation(async(_db,wallet,baseId,context,appearance)=>Buffer.from(JSON.stringify({wallet,baseId,context,appearance})));
 vi.spyOn(console,'error').mockImplementation(()=>{});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function deed(f:{wallet:string;baseId:string}){
 const asset=Keypair.generate().publicKey.toBase58(),checkedAt=new Date();
 await db.update(bases).set({deedAssetId:asset,deedMintAssetId:asset,landPaidAt:checkedAt}).where(eq(bases.id,f.baseId));
 await db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:asset,owner:f.wallet,slot:1n,status:'owned',source:'fixture',checkedAt,auditHash:observationHash(asset,f.wallet,'owned',1n,checkedAt)});
 return {...f,asset};
}
async function prepared(){return {...await deed(await completedCosmeticPresentation(db))} as CosmeticPresentationFixture&{asset:string};}
const toggle=(f:CosmeticPresentationFixture,enabled:boolean,expectedRevision:string)=>setBoundCosmeticAwning(db,f.wallet,{baseId:f.baseId,enabled,expectedRevision},f.authority);
function cache(){
 const puts=new Map<string,string|Buffer>(),lastPushed=new Map<string,string>(),lastImageHash=new Map<string,string>(),pngKnown=new Map<string,boolean>();
 const put:ObjectPutter=async(key,body)=>{puts.set(key,Buffer.isBuffer(body)?Buffer.from(body):body);};
 return {puts,lastPushed,lastImageHash,pngKnown,put};
}
async function sweep(c:ReturnType<typeof cache>,extra:Partial<NonNullable<Parameters<typeof sweepDeedMetadata>[3]>>={}){
 return sweepDeedMetadata(db,c.put,c.lastPushed,{publicBaseUrl:PUB,lastImageHash:c.lastImageHash,pngKnown:c.pngKnown,renderAvailable:true,...extra});
}
const image=(c:ReturnType<typeof cache>,asset:string)=>(JSON.parse(c.puts.get(`deed/asset/${asset}.json`)!.toString()) as {image:string}).image;
const calls=(baseId:string)=>renderer.mock.calls.filter(call=>call[2]===baseId);

it('uses actual free on/off choices in the cache identity and passes that exact source/context to rendering',async()=>{
 const f=await prepared(),c=cache();await sweep(c);const off=c.lastImageHash.get(f.baseId)!;
 expect(off).toMatch(/^[0-9a-f]{8}$/);expect(calls(f.baseId).at(-1)?.[4]).toEqual(await readBoundCosmeticBase(db,f.baseId,f.wallet));
 await toggle(f,true,'0');const expected=await readBoundCosmeticBase(db,f.baseId,f.wallet);await sweep(c);const on=c.lastImageHash.get(f.baseId)!;
 expect(on).not.toBe(off);expect(image(c,f.asset)).toBe(`${PUB}/deed/asset/${f.asset}.png?v=${on}`);
 expect(calls(f.baseId).at(-1)?.slice(3,5)).toEqual([await resolveBaseVisual(db,f.baseId),expected]);
 expect(calls(f.baseId).at(-1)?.[5]).toBeNull();
 const png=JSON.parse(c.puts.get(`deed/asset/${f.asset}.png`)!.toString());expect(png.appearance).toEqual(expected);
 await toggle(f,false,'1');await sweep(c);expect(c.lastImageHash.get(f.baseId)).toBe(off);
});

it('does not repaint a captured Awning hash with a newer preference during the rendering await',async()=>{
 const f=await prepared(),c=cache();await toggle(f,true,'0');await sweep(c);const originalHash=c.lastImageHash.get(f.baseId)!,captured=await readBoundCosmeticBase(db,f.baseId,f.wallet);
 c.lastImageHash.delete(f.baseId);let changed=false;
 renderer.mockImplementation(async(_db,wallet,baseId,context,appearance)=>{
  if(baseId===f.baseId&&!changed){changed=true;await toggle(f,false,'1');}
  return Buffer.from(JSON.stringify({wallet,baseId,context,appearance}));
 });
 await sweep(c);expect(changed).toBe(true);expect(c.lastImageHash.get(f.baseId)).toBe(originalHash);
 expect(calls(f.baseId).at(-1)?.[4]).toEqual(captured);
 expect(JSON.parse(c.puts.get(`deed/asset/${f.asset}.png`)!.toString()).appearance).toEqual(captured);
 expect(await readBoundCosmeticBase(db,f.baseId,f.wallet)).toEqual({state:'available',visual:{version:1,marketAwnings:[]}});
 await sweep(c);expect(c.lastImageHash.get(f.baseId)).not.toBe(originalHash);
});

it('holds unavailable current source without rendering or publishing a newly certified plain image',async()=>{
 const f=await prepared(),c=cache();await toggle(f,true,'0');await sweep(c);const known=c.lastImageHash.get(f.baseId)!,before=calls(f.baseId).length;c.puts.clear();
 await conn.sql`alter function public.shardkeep_bound_cosmetic_market_awnings(uuid,text) immutable`;
 try{
  expect((await readBoundCosmeticBase(db,f.baseId,f.wallet)).state).toBe('unavailable');
  c.lastPushed.clear();await sweep(c);expect(calls(f.baseId)).toHaveLength(before);expect(c.lastImageHash.get(f.baseId)).toBe(known);
  expect(c.puts.has(`deed/asset/${f.asset}.png`)).toBe(false);expect(image(c,f.asset)).toContain(`?v=${known}`);
  const fresh=cache();await sweep(fresh,{head:async()=>true});expect(fresh.lastImageHash.has(f.baseId)).toBe(false);
  expect(fresh.puts.has(`deed/asset/${f.asset}.png`)).toBe(false);expect(image(fresh,f.asset)).not.toContain('?v=');
 }finally{await conn.sql`alter function public.shardkeep_bound_cosmetic_market_awnings(uuid,text) stable`;}
});

it('preserves the published hash on failed/absent rendering and cannot certify a Market image from HEAD alone',async()=>{
 const f=await prepared(),c=cache();await sweep(c);const known=c.lastImageHash.get(f.baseId)!;await toggle(f,true,'0');
 renderer.mockRejectedValue(new Error('Fixture renderer failure'));c.lastPushed.clear();c.puts.clear();await sweep(c);
 expect(c.lastImageHash.get(f.baseId)).toBe(known);expect(image(c,f.asset)).toContain(`?v=${known}`);expect(c.puts.has(`deed/asset/${f.asset}.png`)).toBe(false);
 c.lastPushed.clear();await sweep(c,{renderAvailable:false});expect(image(c,f.asset)).toContain(`?v=${known}`);
 const fresh=cache(),head=vi.fn(async()=>true);await sweep(fresh,{renderAvailable:false,head});
 expect(head).toHaveBeenCalledWith(`deed/asset/${f.asset}.png`);expect(fresh.pngKnown.get(f.baseId)).toBe(true);
 expect(fresh.lastImageHash.has(f.baseId)).toBe(false);expect(image(fresh,f.asset)).not.toContain('?v=');
});

it('invalidates Market initial-build completion even when positions, displayed levels and empty preference are unchanged',async()=>{
 const f=await prepared(),c=cache(),at=new Date(),finish=new Date(+at+BUILD_COSTS[BuildingType.Market].buildSec*1000);
 const [market]=await db.insert(buildings).values({playerWallet:f.wallet,baseId:f.baseId,type:BuildingType.Market,level:1,tx:12,ty:2}).returning();
 const [job]=await db.insert(builderJobs).values({playerWallet:f.wallet,baseId:f.baseId,buildingId:market!.id,kind:'build',startedAt:at,finishesAt:finish}).returning();
 expect((await conn.sql`select completed_at is null pending from builder_jobs where id=${job!.id}`)[0]!.pending).toBe(true);
 await sweep(c);const pending=c.lastImageHash.get(f.baseId)!;
 await db.update(builderJobs).set({completedAt:finish}).where(eq(builderJobs.id,job!.id));
 expect((await conn.sql`select completed_at is null pending from builder_jobs where id=${job!.id}`)[0]!.pending).toBe(false);
 await sweep(c);
 expect(c.lastImageHash.get(f.baseId)).not.toBe(pending);expect(calls(f.baseId).at(-1)?.[4]).toEqual({state:'available',visual:{version:1,marketAwnings:[]}});
});

it('keeps the pre-change image hash for bases without a Market instead of invalidating every deed',async()=>{
 const player=await createTestPlayer(db),baseId=randomUUID();
 await db.insert(bases).values({id:baseId,ownerWallet:player.wallet});await db.insert(baseSlots).values({wallet:player.wallet,baseId,slot:1});
 await db.insert(buildings).values({playerWallet:player.wallet,baseId,type:BuildingType.Keep,level:1,tx:2,ty:2});
 const f=await deed({wallet:player.wallet,baseId}),c=cache(),visualContext=await resolveBaseVisual(db,baseId);
 // Frozen predecessor layout identity: the new Market identity must be absent.
 const b=await db.select({type:buildings.type,level:buildings.level,tx:buildings.tx,ty:buildings.ty}).from(buildings).where(eq(buildings.baseId,baseId)).orderBy(buildings.tx,buildings.ty,buildings.type);
 const o=await db.select({k:obstacles.spriteKey,tx:obstacles.tx,ty:obstacles.ty}).from(obstacles).where(and(eq(obstacles.baseId,baseId),isNull(obstacles.clearedAt))).orderBy(obstacles.tx,obstacles.ty);
 const oldHash=createHash('sha256').update(JSON.stringify({b,o,e:0,a:5,visualContext})).digest('hex').slice(0,8);
 c.lastImageHash.set(baseId,oldHash);await sweep(c);expect(calls(baseId)).toHaveLength(0);expect(c.lastImageHash.get(baseId)).toBe(oldHash);
 expect(image(c,f.asset)).toContain(`?v=${oldHash}`);
 const restarted=cache();await sweep(restarted,{renderAvailable:false,head:async()=>true});expect(image(restarted,f.asset)).toContain(`?v=${oldHash}`);
});
