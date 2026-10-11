/** Real resource custody and original publication replay with a prospective SGT
 * challenge, committed DB link and two signed synthetic mainnet archive sources. */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {PHASE_E_POLICY as P} from '@shardkeep/shared';
import {withFundedMiningReplayFixture as fixture} from './fixtures/fundedMiningReplay';
import {createSeekerMiningArchives} from './fixtures/seekerMiningQualification';
import {executeFundedMiningClaim} from './fixtures/fundedMiningClaims';
import {initializeMiningSeekerCoverageChallenge,readMiningSeekerCoverageChallenge,captureMiningSeekerCheckpoint} from '../src/mining/seekerCheckpointHistory';
import {auditStoredResourcePublication,loadAuditedMiningPrior} from '../src/mining/publicationHistory';
import {getPreparedMiningPublication} from '../src/mining/publicationPreparation';
import {resourceMiningPolicy} from '../src/mining/resourceMiningAudit';
import {miningCanonical} from '../src/mining/fundedMiningAudit';
import {deriveFundedMiningWallet} from '../src/mining/fundedMiningQualification';
import {createMiningClaimEntitlementReader} from '../src/mining/claimEntitlement';
import {createResourceMiningPublicationPreparer} from '../src/mining/fundedMiningAllocation';
afterEach(()=>vi.unstubAllEnvs());

describe('Seeker-qualified resource manifest6 publication',()=>{
 it('funds two original days, claims exact KEEP/Renown and replays both after current links and archives become unavailable',async()=>fixture(async f=>{
  await f.clock('2019-12-31T15:00:00Z');await initializeMiningSeekerCoverageChallenge(f.conn.db);
  const challenge=await readMiningSeekerCoverageChallenge(f.conn.db);
  const sources=createSeekerMiningArchives(challenge,{mintBirthAt:'2019-12-31T16:00:00Z',accountCreatedAt:'2019-12-31T16:01:00Z',issuedAt:'2019-12-31T16:02:00Z',observedAt:'2020-01-03T01:00:00Z'});
  await f.clock('2019-12-31T18:00:00Z');
  await f.conn.sql`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.buyer},${sources.input.linkedWallet},${sources.input.mint})`;
  await f.clock('2019-12-31T19:00:00Z');await captureMiningSeekerCheckpoint(f.conn.db,f.buyer);
  const saved:Awaited<ReturnType<Awaited<ReturnType<typeof f.stageResources>>['publish']>>[]=[];
  for(const day of ['2020-01-01','2020-01-02']){
   const stage=await f.stageResources(day,{free:[{resourceId:'forge_ingot',quantity:'1'}],paid:[{resourceId:'forge_ingot',quantity:'1'},{resourceId:'heartwood_logs',quantity:'10'}]},sources.wiring);
   if(saved.length===0){
    const duplicate={...sources.wiring,providers:[sources.wiring.providers[0],{id:'different-label',connect:sources.wiring.providers[0].connect}] as const};
    const refuse=createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...stage.optionsForPrepare.sources,seeker:duplicate}});
    await expect(refuse(stage.request)).rejects.toThrow(/PROVIDER_CONFIGURATION/);
   }
   const prepared=await stage.prepare(stage.request);if(prepared.status!=='prepared')throw Error('Useful original required');
   const manifest=JSON.parse(prepared.manifestJson);
   expect(manifest).toMatchObject({version:6,scope:'ordinary-resource-mining-seeker-v2',input:{policyVersion:2}});
   const boosted=manifest.participants.find((p:{wallet:string})=>p.wallet===f.buyer);
   expect(boosted.bonusBps).toBe(P.mining.seekerBonusBps);
   expect(boosted.weight).toBe(String(BigInt(boosted.eligibleValue)*BigInt(boosted.baseScoreBps)*BigInt(P.basisPoints+P.mining.seekerBonusBps)/BigInt(P.basisPoints)));
   expect(manifest.participants.find((p:{wallet:string})=>p.wallet===f.wallet).bonusBps).toBe(0);
   const paid=manifest.captures.find((c:{wallet:string})=>c.wallet===f.buyer);
   expect(paid.seekerQualification.providers).toHaveLength(2);
   expect(()=>deriveFundedMiningWallet({...paid,bases:paid.bases.map((b:Record<string,unknown>)=>({...b,reservedUnits:1}))},f.identity.genesisHash,2)).toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
   const mutations=[
    (m:typeof manifest)=>{m.version=5;m.scope='ordinary-resource-mining-v2';m.policy=resourceMiningPolicy;},
    (m:typeof manifest)=>{m.participants.find((p:{wallet:string})=>p.wallet===f.buyer).bonusBps*=2;},
    (m:typeof manifest)=>{delete m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seekerQualification;},
    (m:typeof manifest)=>{m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seekerQualification.coverageSignature='invalid';},
   ];
   for(const mutate of mutations){const changed=structuredClone(manifest);mutate(changed);
    await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(changed),publication:prepared.publication})).rejects.toThrow();}
   const published=await stage.publish();saved.push(published);
   expect(published.settlement.contributions.every(c=>c.outcome==='consumed')).toBe(true);
   expect(BigInt(manifest.playerNet)+BigInt(manifest.recycle)+BigInt(manifest.tax)).toBe(BigInt(manifest.freeGross)+BigInt(manifest.deedGross));
  }
  const last=saved[1]!;
  const claim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},last,null);f.acceptClaim(claim);
  expect(claim.postSnapshot.renownRecord).toMatchObject({renownTotal:2n,daysAttested:2n});
  await f.clock('2020-01-03T02:00:00Z');await f.conn.sql`update seeker_links set revoked_at='2020-01-03T02:00:00Z' where wallet=${f.buyer}`;
  for(const source of sources.archives)source.reader.getGenesisHash.mockRejectedValue(Error('Original archive offline'));
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  for(const p of saved){expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);expect(await p.settle()).toEqual(p.settlement);}
  const m=JSON.parse(last.prepared.manifestJson),s=m.funding.source,c=m.funding.config;
  const replay=await loadAuditedMiningPrior(f.conn.db,{genesisHash:s.genesisHash,programId:s.programId,configAddress:c.address,keepMint:c.keepMint,reserveOwner:c.emissionReserveOwner,
   reviewedDeploymentSlot:s.reviewedDeploymentSlot,reviewedProgramDataSha256:s.reviewedProgramDataSha256,sequence:'2'});
  expect(replay.declaration.total).toBe(BigInt(last.prepared.publication.total));
  expect(replay.declaration.leaves.find(l=>l.wallet===f.buyer)).toMatchObject({cumulativeRenown:2n,cumulativeDays:2n});
  expect((await createMiningClaimEntitlementReader(f.conn.db,f.identity)(f.buyer)).kind).toBe('entitlement');
  // 2026-10-10 (CI 38050662691): 0277 is no longer the newest custody seal. 0279 (bound cosmetics) sealed the current
  // table projection, and its successors (0283-0298) re-seal the function set through their own validators, which the
  // whole-system shardkeep_divine_fragment_source() check above accepts. Pin both halves: the 0277 record stays retained
  // history, and the 0279 record still equals the current projection in everything but that successor-owned function set.
  await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
  const [seals]=await f.conn.sql`select (select record from divine_fragment_resource_publication_contract where singleton) is not null old_retained,
   (select record from divine_fragment_seeker_publication_contract where singleton) is not null seeker_retained,
   (select record from divine_fragment_ordinary_kits_contract where singleton) is not null kits_retained,
   (select record from divine_fragment_resource_kits_contract where singleton) is not null resource_kits_retained,
   (select record from divine_fragment_enrolled_seeker_contract where singleton) is not null enrolled_retained,
   (select record from divine_fragment_vehicle_material_contract where singleton) is not null material_retained,
   (select record from divine_fragment_vehicle_client_contract where singleton) is not null client_retained,
    (select record from divine_fragment_existing_wallet_contract where singleton) is not null existing_retained,
    (select record from divine_fragment_seeker_absence_contract where singleton) is not null absence_retained,
    (select record from divine_fragment_gems_zero_contract where singleton) is not null gems_zero_retained,
    (select record-'functions' from divine_fragment_bound_cosmetics_contract where singleton)=shardkeep_divine_fragment_contract()-'functions' current_valid`;
  expect(seals).toEqual({old_retained:true,seeker_retained:true,kits_retained:true,resource_kits_retained:true,enrolled_retained:true,material_retained:true,client_retained:true,existing_retained:true,absence_retained:true,gems_zero_retained:true,current_valid:true});
 }),180_000);
});
