/** Actual three-source economy and original winning rights. Locally signed
 * finalized fixtures are not live-chain or mint-provenance attestations. */
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {Keypair,PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {PHASE_E_HARVESTER} from '@shardkeep/shared';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {installStarterFleet} from '../src/game/starterFleet';
import {assertFreshLockedBaseAuthority,registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {readStoredExpeditionTerm} from '../src/game/expeditionTermStore';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {selectHarvesterSource} from '../src/game/harvesterSources';
import {settleDueHarvesterSources,readHarvesterSettlement} from '../src/game/harvesterSettlement';
import {dispatchAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';
import {settleDueAdvancedExpeditions,readAdvancedExpeditionReturn} from '../src/game/advancedExpeditionReturns';
import {createSeekerResourceClaimProvider} from '../src/game/seekerResourceClaimProvider';
import {readCompleteSeekerResourcePool} from '../src/game/seekerResourceClaims';
import {deedOwnershipObservations} from '../src/db/schema';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
it('conserves mixed real sources and all original spot shares through producer transfer, expiry and a later advanced return',async()=>{
 // 2026-10-10: 0256/0279 refuse a settlement cutoff later than Postgres clock_timestamp(), which no test can fake. The
 // run reaches term expiry (+7 days), so the calendar opens 8 days in the real past and every facility completes before it.
 let now=new Date(Math.floor((Date.now()-8*86400000)/1000)*1000);
 const f=await vehicleBurnDatabase('survey_balloon',1,{},{completedAt:new Date(+now-3600000)});
 try{
  f.finalizeBurn();await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
  const berth=randomUUID(),lodge=randomUUID(),harvesterId=randomUUID();
  for(const [id,type,x] of [[berth,'berth',8],[lodge,'lodge',12],[harvesterId,'harvester',16]] as const){
   await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${id},${f.actor},${f.baseId},${type},${x},2)`;
   await f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${f.actor},${f.baseId},${id},'build',${new Date(+now-7200000).toISOString()},${new Date(+now-3600000).toISOString()},${new Date(+now-3600000).toISOString()})`;
  }
  const authority={baseId:f.baseId,assertAuthority:async(...a:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...a);}};
  const starter=await installStarterFleet(f.conn.db,f.actor,berth,authority);
  // Facility fixtures do not prove the fenced ordinary five-berth build path.
  const owners=[Keypair.generate().publicKey.toBase58(),Keypair.generate().publicKey.toBase58()],buyer=Keypair.generate().publicKey.toBase58();
  const destinations=new Map<string,string>();
  for(const wallet of [...owners,buyer]){const base=randomUUID();await f.conn.sql`insert into players(wallet) values(${wallet})`;await f.conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet})`;await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base})`;destinations.set(wallet,base);}
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED','PHASE_E_SEEKER_ENABLED','STARTER_FLEET_ENABLED','STARTER_EXPEDITIONS_ENABLED'])vi.stubEnv(flag,'true');
  const winners=[owners[0]!,owners[0]!,owners[1]!,owners[1]!],bank=await createMiningTermFixture({day:now.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey,winners:winners.map((wallet,spotId)=>({spotId,wallet:new PublicKey(wallet)}))});
  async function reader(){bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+now/1000),32);return prefetchExpeditionTermReader(bank.connect,bank.policy);}
  // One explicitly seeded provision balance; returned output and all tax come
  // from actual producers. Provision provenance has separate earned-supply proof.
  await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},'rough_prism',2,0)`;
  const depart=async()=>dispatchAdvancedExpedition(f.conn.db,f.actor,{id:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:'coastal_survey',policyVersion:1},authority,{reader:await reader(),clock:()=>now});
  const advanced=await depart(),preview=starterRoutePreview('crownlands','coastal_survey');
  const free=await dispatchStarterExpedition(f.conn.db,f.actor,{id:randomUUID(),baseId:f.baseId,installationId:starter.installationId,routeId:preview.routeId,routeVersion:preview.routeCatalogueVersion,rewardVersion:preview.rewardTableVersion},authority,{reader:await reader(),clock:()=>now});
  const harvester=await selectHarvesterSource(f.conn.db,f.actor,{id:randomUUID(),baseId:f.baseId,harvesterId,policyVersion:PHASE_E_HARVESTER.currentPolicyVersion},authority,{reader:await reader(),clock:()=>now});
  expect([free.termId,harvester.termId]).toEqual([advanced.termId,advanced.termId]);expect([free.resourceId,harvester.resourceId]).toEqual([advanced.resourceId,advanced.resourceId]);
  // Exercise carried fractional Harvester tax and leave positive whole-pool dust.
  const cadences=2*PHASE_E_HARVESTER.v1.taxBasisPoints/PHASE_E_HARVESTER.v1.islandPoolBps;
  now=new Date(Math.max(+advanced.returnsAt,+free.returnsAt,+harvester.admittedAt+cadences*PHASE_E_HARVESTER.v1.cadenceSec*1000));vi.setSystemTime(now);
  await f.conn.db.transaction(async tx=>{await settleDueStarterExpeditions(tx,f.baseId,now);await settleDueHarvesterSources(tx,f.baseId,now);await settleDueAdvancedExpeditions(tx,f.baseId,now);});
  const harvesterProof=(await readHarvesterSettlement(f.conn.db,harvester.id))!;
  const produced=()=>f.conn.sql`select bucket,sum(delta)::text total from (
   select bucket,delta from starter_expedition_entries union all select bucket,delta from harvester_entries union all select bucket,delta from advanced_expedition_entries
  ) sources group by bucket order by bucket`;
  const sums=await produced(),byBucket=new Map(sums.map(row=>[row.bucket,BigInt(row.total)])),pool=byBucket.get('island_pool')!,gross=-byBucket.get('issued')!,net=byBucket.get('base_stock')!;
  expect(harvesterProof.events.length).toBeGreaterThan(0);expect(pool).toBeGreaterThan(advanced.tax+free.tax);expect(gross).toBe(net+pool);
  expect(await readCompleteSeekerResourcePool(f.conn.db,advanced.termId,advanced.termHash,advanced.resourceId)).toBe(pool);
  const provider=createSeekerResourceClaimProvider(f.conn.db),command=(spotId:number,wallet=winners[spotId]!)=>({idempotencyKey:randomUUID(),baseId:destinations.get(wallet)!,termId:advanced.termId,resourceId:advanced.resourceId,spotId});
  const first=[];for(let spotId=0;spotId<winners.length;spotId++)first.push(await provider.claim(winners[spotId]!,command(spotId)));
  const firstPaid=first.reduce((n,r)=>n+BigInt(r.quantity),0n);expect(pool%BigInt(winners.length)).toBeGreaterThan(0n);expect(firstPaid+pool%BigInt(winners.length)).toBe(pool);
  expect(first.every(r=>BigInt(r.quantity)===pool/BigInt(winners.length))).toBe(true);
  const later=await depart();expect(later.completedBefore).toBe(1n);
  const mint=Keypair.generate().publicKey.toBase58();expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);
  await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:now,status:'owned',source:'rpc-finalized',auditHash:randomUUID()});
  await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:+now});
  const term=(await readStoredExpeditionTerm(f.conn.db,advanced.termId,advanced.termHash))!;
  now=new Date(Date.parse(term.snapshot.endsAt)+1000);vi.setSystemTime(now);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
  const reopened=f.conn.reopen();try{
   await reopened.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,now));
   expect((await readAdvancedExpeditionReturn(reopened.db,later.id))!.receipt).toMatchObject({custodyWallet:buyer,completedTotal:2n});
   const current=createSeekerResourceClaimProvider(reopened.db),total=await readCompleteSeekerResourcePool(reopened.db,advanced.termId,advanced.termHash,advanced.resourceId);
   expect(total).toBe(pool+later.tax);
   const more=[];for(let spotId=0;spotId<winners.length;spotId++)more.push(await current.claim(winners[spotId]!,command(spotId)));
   expect(more.every(r=>r.termId===advanced.termId&&r.termHash===advanced.termHash&&BigInt(r.cumulativeTotal)===total/BigInt(winners.length))).toBe(true);
   await expect(current.claim(buyer,command(0,buyer))).rejects.toMatchObject({code:'SEEKER_RESOURCE_NOT_OWNER'});
   const paid=firstPaid+more.reduce((n,r)=>n+BigInt(r.quantity),0n),dust=total%BigInt(winners.length);
   expect(paid+dust).toBe(total);
   const [stock]=await reopened.sql`select sum(available+reserved)::text total from resource_stocks where resource_id=${advanced.resourceId}`;
   expect(BigInt(stock!.total)+dust).toBe(gross+later.gross);
   const sourcesBefore=await produced();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');expect(await current.claim(winners[0]!,{idempotencyKey:first[0]!.idempotencyKey,baseId:first[0]!.baseId,termId:first[0]!.termId,resourceId:first[0]!.resourceId,spotId:first[0]!.spotId})).toEqual(first[0]);expect(await produced()).toEqual(sourcesBefore);
  }finally{await reopened.sql.end();}
 }finally{await f.dispose();}
},120_000);
