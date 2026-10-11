/** Actual encoded finalized access banks plus synthetic operating-tax terms.
 * No public RPC, validator, live authority, purchase or signature is used. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_STARTER_ROUTES as C} from '@shardkeep/shared';
import type {ExpeditionRealmAccessObservation as Observation} from '@shardkeep/shared/paidStarterExpeditions';
import {StarterRouteIdSchema,starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {createSeekerRealmAccessFixture} from '../../../packages/chain/src/testFixtures/seekerRealmAccess';
import {bases,baseSlots,builderJobs,expeditionFreeHomes,expeditionTermSnapshots,resourceStocks,starterExpeditions,starterExpeditionInflight} from '../src/db/schema';
import {prefetchExpeditionRealmAccessReader,type ExpeditionRealmAccessReader} from '../src/game/expeditionRealmAccess';
import {pinOperatingExpeditionTerm} from '../src/game/expeditionTermStore';
import {dispatchStarterExpedition,readStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {readStarterExpeditionReturn,settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {readStarterExpeditionView} from '../src/game/starterExpeditionView';
import {readStarterFleetView} from '../src/game/starterFleetView';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {connectTestDb,createTestPlayer} from './helpers';
const conn=connectTestDb(),db=conn.db;afterAll(()=>conn.sql.end());afterEach(()=>vi.unstubAllEnvs());
type Fixture=Awaited<ReturnType<typeof createStarterExpeditionFixture>>;
type Coverage=ExpeditionRealmAccessReader['readCoverage'];
async function fixture(){
 const f=await createStarterExpeditionFixture(db),bank=await createSeekerRealmAccessFixture();
 f.snapshot={...f.snapshot,source:{...f.snapshot.source,genesisHash:bank.genesis.toBase58(),programId:bank.programId.toBase58()}};
 f.reader={readOperatingTerm:async at=>({snapshot:f.snapshot,finality:{commitment:'finalized',contextSlot:'200',observedAt:at}})};
 // Paid routes add their own catalogue v3 while preserving the existing reward
 // table and the accepted HOME coastal survey output/duration.
 f.command={...f.command,routeId:'paid_frostveil',routeVersion:3,rewardVersion:C.rewardTableVersion};
 return f;
}
async function coverage(f:Fixture,options:{wallet?:string;realm?:number;expiresAt?:bigint;absent?:boolean;observedAt?:Date}={}){
 const bank=await createSeekerRealmAccessFixture(),wallet=new PublicKey(options.wallet??f.wallet),realm=options.realm??0;
 const now=BigInt(Math.floor(f.now.getTime()/1000)),expiry=options.expiresAt??now+60n;
 const BN=bank.accessModel.expires_at.constructor as new(value:string)=>typeof bank.accessModel.expires_at;
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('realm_access'),wallet.toBuffer(),Buffer.of(realm)],bank.programId);
 bank.accessModel.wallet=wallet;bank.accessModel.realm=realm;bank.accessModel.bump=bump;bank.accessModel.expires_at=new BN(expiry.toString());bank.rows[3]!.address=address;
 await bank.encode('access');bank.rows[4]!.data.writeBigInt64LE(now,32);if(options.absent)bank.rows[3]=null;
 // Paid coverage does not consume a receipt or the seller/auction term that
 // sold it. These missing rows cannot invalidate existing wallet coverage.
 bank.rows[5]=null;const connect=vi.fn(()=>bank.rpc),observedAt=options.observedAt??new Date(f.now.getTime());
 const reader=await prefetchExpeditionRealmAccessReader(connect,bank.trust,{wallet:wallet.toBase58(),realm},{clock:()=>observedAt});
 return {bank,connect,expiry,readCoverage:vi.fn(reader.readCoverage)};
}
function dispatch(f:Fixture,readCoverage?:Coverage){
 const deps={reader:f.reader,clock:()=>f.now,...(readCoverage?{readCoverage}:{})};
 return dispatchStarterExpedition(db,f.wallet,f.command,f.authority,deps);
}
async function noAdmission(f:Fixture){
 expect(await readStarterExpedition(db,f.command.id)).toBeNull();
 expect(await db.select().from(starterExpeditions).where(eq(starterExpeditions.baseId,f.baseId))).toEqual([]);
 expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId,f.installationId))).toEqual([]);
 expect(await db.select().from(expeditionFreeHomes).where(eq(expeditionFreeHomes.baseId,f.baseId))).toEqual([]);
 expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId,f.snapshot.termId))).toEqual([]);
 expect(await db.select().from(resourceStocks).where(eq(resourceStocks.baseId,f.baseId))).toEqual([]);
}
const outcome=<T>(promise:Promise<T>)=>promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error: error as unknown}));
describe.sequential('paid realm coverage at starter departure only',()=>{
 it('accepts a foreign destination with measured coverage, unchanged HOME economics and one vehicle',async()=>{
  const f=await fixture(),access=await coverage(f),trip=await dispatch(f,access.readCoverage),expected=starterRoutePreview('frostveil','coastal_survey');
  expect(trip.homeEvidence).toMatchObject({realmId:'crownlands',custodyWallet:f.wallet});
  expect(trip.routeSnapshot).toMatchObject({routeId:'paid_frostveil',routeCatalogueVersion:3,rewardTableVersion:C.rewardTableVersion,realmId:'frostveil',resourceId:expected.resourceId,
   durationSec:expected.durationSec,grossQuantity:expected.grossQuantity,netQuantity:expected.netQuantity,islandPoolQuantity:expected.islandPoolQuantity,
   access:{kind:'paid_realm',policyVersion:1,observation:{wallet:f.wallet,realm:0,expiresAt:String(access.expiry),finality:{observedAt:f.now.toISOString()}}}});
  expect(trip.gross).toBe(trip.net+trip.tax);expect(trip.returnsAt.getTime()).toBeGreaterThan(Number(access.expiry)*1000);expect(access.readCoverage).toHaveBeenCalledOnce();expect(access.connect).toHaveBeenCalledOnce();
  expect(await readStarterExpedition(db,trip.id)).toEqual(trip);expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId,f.installationId))).toEqual([{installationId:f.installationId,expeditionId:trip.id}]);
  const view=await db.transaction(async tx=>{const [base]=await tx.select().from(bases).where(eq(bases.id,f.baseId));return readStarterExpeditionView(tx,base!,f.now,await readStarterFleetView(tx,f.baseId));});
  expect(StarterRouteIdSchema.options).toHaveLength(11);expect(view.routes.map(r=>r.routeId)).toEqual(StarterRouteIdSchema.options);expect(view.routes.some(r=>r.routeId.startsWith('paid_'))).toBe(false);expect(view.flight?.expeditionId).toBe(trip.id);
 });
 it.each(['missing','absent','expired','wrong-wallet','wrong-realm','stale'] as const)('rejects %s coverage before committing home, tax term, trip or reservation',async kind=>{
  const f=await fixture(),now=BigInt(Math.floor(f.now.getTime()/1000));
  const access=kind==='missing'?null:await coverage(f,{...(kind==='absent'?{absent:true}:{}),...(kind==='expired'?{expiresAt:now}:{}),
   ...(kind==='wrong-wallet'?{wallet:(await createTestPlayer(db)).wallet}:{}),...(kind==='wrong-realm'?{realm:1}:{}),
   ...(kind==='stale'?{observedAt:new Date(f.now.getTime()-PHASE_E_SEEKER_AUCTION.observationMaxAgeMs-1)}:{})});
  await expect(dispatch(f,access?.readCoverage)).rejects.toMatchObject({code:kind==='missing'?'UNAVAILABLE':kind==='absent'?'NO_COVERAGE':kind==='expired'?'EXPIRED':kind==='stale'?'STALE':'SOURCE'});
  await noAdmission(f);if(access)expect(access.connect).toHaveBeenCalledOnce();
 });
 it('rejects a current tax-term network/program different from the authentic paid coverage',async()=>{
  for(const field of ['genesisHash','programId'] as const){const f=await fixture(),access=await coverage(f);f.snapshot={...f.snapshot,source:{...f.snapshot.source,[field]:new PublicKey(Buffer.alloc(32,9)).toBase58()}};
   await expect(dispatch(f,access.readCoverage)).rejects.toMatchObject({code:'SOURCE'});await noAdmission(f);
  }
 });
 it('requires current operating-tax authority even with valid paid coverage',async()=>{
  const f=await fixture(),access=await coverage(f);f.reader={readOperatingTerm:async()=>null};await expect(dispatch(f,access.readCoverage)).rejects.toThrow('Authoritative operating expedition term unavailable');await noAdmission(f);
 });
 it('rechecks exclusive expiry after the actual tax-term advisory lock wait without refreshing coverage',async()=>{
  const f=await fixture(),before=new Date(f.now.getTime()),access=await coverage(f,{expiresAt:BigInt(Math.floor(before.getTime()/1000))+1n});
  let release!:()=>void,pid:number|undefined;const gate=new Promise<void>(resolve=>{release=resolve;}),scope=JSON.stringify([f.snapshot.source.genesisHash,f.snapshot.source.programId,f.snapshot.source.auctionConfig]);
  const holder=outcome(db.transaction(async tx=>{await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`expedition-term:${scope}`},0))`);const [row]=await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{pid:number}>;pid=row!.pid;await gate;}));
  let pending:ReturnType<typeof outcome<Awaited<ReturnType<typeof dispatch>>>>|undefined;
  try{
   await expect.poll(()=>pid).toBeDefined();pending=outcome(dispatch(f,access.readCoverage));
   await expect.poll(async()=>(await conn.sql<{waiting:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid!}=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock%') AS waiting`)[0]!.waiting).toBe(true);
   expect(access.readCoverage).toHaveBeenCalledOnce();f.now=new Date(before.getTime()+1000);release();expect(await pending).toMatchObject({ok:false,error:{code:'EXPIRED'}});await noAdmission(f);expect(access.connect).toHaveBeenCalledOnce();
  }finally{release();await holder;if(pending)await pending;}
 });
 it.each(['base','lodge','starter'] as const)('paid coverage cannot bypass the existing %s prerequisite',async kind=>{
  const f=await fixture(),access=await coverage(f);
  if(kind==='base')await db.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));
  if(kind==='lodge')await db.update(builderJobs).set({completedAt:null}).where(eq(builderJobs.id,f.lodgeJobId));
  if(kind==='starter')f.command.installationId=randomUUID();
  await expect(dispatch(f,access.readCoverage)).rejects.toMatchObject({code:kind==='base'?'BASE_NOT_OWNED':kind==='lodge'?'EXPEDITION_LODGE_UNAVAILABLE':'STARTER_FLEET_UNAVAILABLE'});await noAdmission(f);
 });
 it('shares the original starter reservation with HOME and common trips',async()=>{
  const f=await fixture(),access=await coverage(f),paid=await dispatch(f,access.readCoverage);
  for(const routeId of ['introduction','common_elderwood'] as const){const p=starterRoutePreview('crownlands',routeId),command={...f.command,id:randomUUID(),routeId,routeVersion:p.routeCatalogueVersion,rewardVersion:p.rewardTableVersion};
   await expect(dispatchStarterExpedition(db,f.wallet,command,f.authority,{reader:f.reader,clock:()=>f.now})).rejects.toMatchObject({code:'STARTER_EXPEDITION_INFLIGHT'});
  }
  expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId,f.installationId))).toEqual([{installationId:f.installationId,expeditionId:paid.id}]);
 });
 it('keeps existing coverage valid across sales pause and seller turnover while pinning the current tax owner',async()=>{
  const f=await fixture(),access=await coverage(f),newSeller=(await createTestPlayer(db)).wallet;
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');f.snapshot={...f.snapshot,spots:f.snapshot.spots.map(s=>s.spotId===0?{...s,ownerWallet:newSeller}:s)};
  const trip=await dispatch(f,access.readCoverage);expect(trip.termId).toBe(f.snapshot.termId);expect(trip.routeSnapshot).toMatchObject({access:{observation:{wallet:f.wallet,expiresAt:String(access.expiry)}}});expect(access.connect).toHaveBeenCalledOnce();
 });
 it('replays the exact paid acceptance before provider, expiry, flags or current ownership checks',async()=>{
  const f=await fixture(),access=await coverage(f),trip=await dispatch(f,access.readCoverage);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');f.now=new Date(f.snapshot.endsAt);
  const denied=vi.fn(()=>{throw Error('Mutable admission is unavailable');}),provider=vi.fn(async()=>{throw Error('Coverage provider unavailable');});
  const deps={reader:{readOperatingTerm:provider},readCoverage:provider,clock:denied,assertAdmission:denied};
  expect(await dispatchStarterExpedition(db,f.wallet,f.command,{...f.authority,assertAuthority:async()=>denied()},deps)).toEqual(trip);expect(provider).not.toHaveBeenCalled();expect(denied).not.toHaveBeenCalled();
 });
 it('returns exact original output once after coverage expiry, actual tax-term rollover and base custody transfer',async()=>{
  const f=await fixture(),access=await coverage(f),trip=await dispatch(f,access.readCoverage),buyer=await createTestPlayer(db);
  const next={...f.snapshot,termId:randomUUID(),startsAt:f.snapshot.endsAt,endsAt:new Date(Date.parse(f.snapshot.endsAt)+PHASE_E_POLICY.seekerIsland.operatingTermSec*1000).toISOString(),
   source:{...f.snapshot.source,round:String(BigInt(f.snapshot.source.round)+1n)},spots:f.snapshot.spots.map(s=>({...s,ownerWallet:buyer.wallet}))};
  const cutoff=new Date(next.startsAt);await pinOperatingExpeditionTerm(db,cutoff,{readOperatingTerm:async at=>({snapshot:next,finality:{commitment:'finalized',contextSlot:'200',observedAt:at}})});
  await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.baseId));});
  f.reader.readOperatingTerm=async()=>{throw Error('Return cannot consult current terms');};access.bank.rpc.getGenesisHash=async()=>{throw Error('Return cannot renew coverage');};vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');
  const [proof]=await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,cutoff));expect(proof!.expedition).toEqual(trip);expect(proof!.receipt.custodyWallet).toBe(buyer.wallet);
  expect(proof!.entries.map(e=>[e.bucket,e.delta])).toEqual([['base_stock',trip.net],['island_pool',trip.tax],['issued',-trip.gross]]);expect(proof!.entries.reduce((sum,e)=>sum+e.delta,0n)).toBe(0n);
  expect(await readStarterExpeditionReturn(db,trip.id)).toEqual(proof);expect(await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,cutoff))).toEqual([]);
  expect((await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId,f.baseId),eq(resourceStocks.resourceId,trip.resourceId))))[0]).toMatchObject({available:trip.net,reserved:0n});
  expect(await db.select().from(starterExpeditionInflight).where(eq(starterExpeditionInflight.installationId,f.installationId))).toEqual([]);
 });
 it('SQL rejects stripped or substituted paid admission evidence and preserves accepted history',async()=>{
  const f=await fixture(),access=await coverage(f),trip=await dispatch(f,access.readCoverage);await db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,trip.returnsAt));
  const route=trip.routeSnapshot as unknown as Record<string,unknown>,marker=route.access as Record<string,unknown>,observation=marker.observation as Record<string,unknown>;
  const {access:_,...stripped}=route;
  const damaged:Record<string,unknown>[]=[];
  const change=(edit:(o:Observation)=>void)=>{const copy=structuredClone(observation) as unknown as Observation;edit(copy);damaged.push({...route,access:{...marker,observation:copy}});};
  // SQL is a separate guard against substituted historical evidence, not an RPC
  // finality verifier. Each mutation must fail before a reservation can exist.
  change(o=>{Reflect.deleteProperty(o,'source');});change(o=>{Object.assign(o,{extra:'unexpected'});});change(o=>{o.expiresAt='1.5';});
  change(o=>{Object.assign(o.finality,{commitment:'confirmed'});});change(o=>{o.finality.observedAt=new Date(trip.departedAt.getTime()+1).toISOString();});
  change(o=>{o.finality.observedAt=new Date(trip.departedAt.getTime()-PHASE_E_SEEKER_AUCTION.observationMaxAgeMs-1).toISOString();});
  change(o=>{o.finality.chainUnixTimestamp=String(Math.floor(trip.departedAt.getTime()/1000)+1);});change(o=>{o.finality.contextSlot='0';});
  change(o=>{Object.assign(o.source.accounts[0]!,{dataSha256:1e63});});
  change(o=>{Object.assign(o.source,{reviewedProgramDataSha256:1e63});Object.assign(o.source.accounts[1]!,{dataSha256:1e63});});
  change(o=>{o.source.genesisHash=new PublicKey(Buffer.alloc(32,9)).toBase58();});change(o=>{o.source.reviewedProgramDataSha256='a'.repeat(64);});
  change(o=>{o.source.accounts[3]!.owner=o.wallet;});change(o=>{Object.assign(o.source.accounts[3]!,{exists:false});});
  change(o=>{o.source.accounts[3]!.address=o.source.accounts[2]!.address;});change(o=>{o.source.accounts[4]!.executable=true;});
  for(const routeSnapshot of [stripped,{...route,access:{...marker,observation:{...observation,wallet:(await createTestPlayer(db)).wallet}}},
   {...route,access:{...marker,observation:{...observation,realm:1}}},{...route,access:{...marker,observation:{...observation,expiresAt:String(Math.floor(trip.departedAt.getTime()/1000))}}},...damaged]){
   await expect(db.transaction(async tx=>{const id=randomUUID();await tx.insert(starterExpeditions).values({...trip,id,routeSnapshot});await tx.insert(starterExpeditionInflight).values({installationId:f.installationId,expeditionId:id});})).rejects.toThrow();
  }
  await expect(db.update(starterExpeditions).set({routeSnapshot:stripped}).where(eq(starterExpeditions.id,trip.id))).rejects.toThrow();
  await expect(db.delete(starterExpeditions).where(eq(starterExpeditions.id,trip.id))).rejects.toThrow();expect(await readStarterExpedition(db,trip.id)).toEqual(trip);
 });
});
