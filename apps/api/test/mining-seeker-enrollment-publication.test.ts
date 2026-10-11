/** D153.209: original older SGT -> next full day -> two funded publications and
 * cumulative claims. DB custody is real; RPC banks and future clocks are explicit
 * local fixtures, not live issuance or a new future-time SBF execution. */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {PHASE_E_POLICY as P} from '@shardkeep/shared';
import {seekerMintBirthFixture} from '../../../packages/chain/src/testFixtures/miningSeekerHolding';
import {withFundedMiningReplayFixture as fixture} from './fixtures/fundedMiningReplay';
import {createSeekerEnrollmentArchives} from './fixtures/seekerEnrollmentQualification';
import {executeFundedMiningClaim} from './fixtures/fundedMiningClaims';
import {captureMiningSeekerEnrollment,readMiningSeekerEnrollmentChallenge} from '../src/mining/seekerMiningEnrollment';
import {auditStoredResourcePublication,loadAuditedMiningPrior} from '../src/mining/publicationHistory';
import {getPreparedMiningPublication} from '../src/mining/publicationPreparation';
import {resourceMiningPolicy,seekerResourceMiningPolicy,seekerResourceMiningPolicyV3} from '../src/mining/resourceMiningAudit';
import {miningCanonical} from '../src/mining/fundedMiningAudit';
import {deriveFundedMiningWallet} from '../src/mining/fundedMiningQualification';
import {createMiningClaimEntitlementReader} from '../src/mining/claimEntitlement';
import {createResourceMiningPublicationPreparer} from '../src/mining/fundedMiningAllocation';
import {installResourceMiningV3Cutover} from '../src/mining/resourceMiningPolicy';
const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
afterEach(()=>vi.unstubAllEnvs());
describe('enrolled Seeker manifests9/10',()=>{
 it('funds current20 then prospective22-resource day, claims both and replays originals offline without backdating',async()=>{
  const first=day(1),next=day(2),earlier=day(0),closed=day(3),resourceClock=()=>new Date(closed+'T12:00:00Z');
  await fixture(async f=>{
   await installResourceMiningV3Cutover(f.conn.db,next);
   const identity=seekerMintBirthFixture().input;
   await f.clock(earlier+'T18:00:00Z');
   await f.conn.sql`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.buyer},${identity.linkedWallet},${identity.mint})`;
   await f.clock(earlier+'T19:00:00Z');await captureMiningSeekerEnrollment(f.conn.db,f.buyer);
   const challenge=await readMiningSeekerEnrollmentChallenge(f.conn.db,{wallet:f.buyer});
   const archives=createSeekerEnrollmentArchives(challenge.enrollment,{observedAt:closed+'T01:00:00Z'});
   const seekerEnrollment={enrollmentFor:(wallet:string)=>wallet===f.buyer?{enrollmentId:archives.wiring.enrollmentId,enrollmentSignature:archives.wiring.enrollmentSignature}:null,providers:archives.wiring.providers};
   const saved:Awaited<ReturnType<Awaited<ReturnType<typeof f.stageResources>>['publish']>>[]=[];
   let previousClaim:Awaited<ReturnType<typeof executeFundedMiningClaim>>|null=null;
   for(const [index,date] of [first,next].entries()){
    const stage=await f.stageResources(date,index===0?{free:[{resourceId:'forge_ingot',quantity:'1'}],paid:[{resourceId:'forge_ingot',quantity:'1'},{resourceId:'heartwood_logs',quantity:'10'}]}:{free:[{resourceId:'climate_kit',quantity:'1'}],paid:[{resourceId:'expedition_kit',quantity:'3'}]},undefined,{policyVersion:index===0?2:3,seekerEnrollment});
    if(index===0){
     const duplicate={...seekerEnrollment,providers:[seekerEnrollment.providers[0],{id:'different-label',connect:seekerEnrollment.providers[0].connect}] as const};
     const refuse=createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...stage.optionsForPrepare.sources,seekerEnrollment:duplicate}});
     await expect(refuse(stage.request)).rejects.toThrow(/PROVIDER_CONFIGURATION/);
    }
    const prepared=await stage.prepare(stage.request);if(prepared.status!=='prepared')throw Error('Useful original required');
    const manifest=JSON.parse(prepared.manifestJson);
    expect(manifest).toMatchObject({version:index===0?9:10,scope:index===0?'ordinary-resource-mining-enrolled-seeker-v2':'ordinary-resource-mining-enrolled-seeker-v3',input:{policyVersion:index===0?2:3}});
    const boosted=manifest.participants.find((p:{wallet:string})=>p.wallet===f.buyer);
    expect(boosted.bonusBps).toBe(P.mining.seekerBonusBps);
    expect(boosted.weight).toBe(String(BigInt(boosted.eligibleValue)*BigInt(boosted.baseScoreBps)*BigInt(P.basisPoints+P.mining.seekerBonusBps)/BigInt(P.basisPoints)));
    expect(manifest.participants.find((p:{wallet:string})=>p.wallet===f.wallet).bonusBps).toBe(0);
    const paid=manifest.captures.find((c:{wallet:string})=>c.wallet===f.buyer);
    expect(paid.seekerQualification).toMatchObject({version:2,interval:{enrollmentId:challenge.enrollment.id}});
    expect(paid.seekerQualification.providers).toHaveLength(2);
    expect(()=>deriveFundedMiningWallet({...paid,bases:paid.bases.map((b:Record<string,unknown>)=>({...b,reservedUnits:1}))},f.identity.genesisHash,2)).toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
    for(const mutate of [
     (m:typeof manifest)=>{m.version=index===0?6:8;m.scope=index===0?'ordinary-resource-mining-seeker-v2':'ordinary-resource-mining-seeker-v3';m.policy=index===0?seekerResourceMiningPolicy:seekerResourceMiningPolicyV3;},
     (m:typeof manifest)=>{m.version=5;m.scope='ordinary-resource-mining-v2';m.policy=resourceMiningPolicy;},
     (m:typeof manifest)=>{m.participants.find((p:{wallet:string})=>p.wallet===f.buyer).bonusBps*=2;},
     (m:typeof manifest)=>{delete m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seekerQualification;},
     (m:typeof manifest)=>{m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seekerQualification.enrollmentSignature='invalid';},
    ]){const changed=structuredClone(manifest);mutate(changed);await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(changed),publication:prepared.publication})).rejects.toThrow();}
    const published=await stage.publish();saved.push(published);
    expect(published.settlement.contributions.every(c=>c.outcome==='consumed')).toBe(true);
    expect(BigInt(manifest.playerNet)+BigInt(manifest.recycle)+BigInt(manifest.tax)).toBe(BigInt(manifest.freeGross)+BigInt(manifest.deedGross));
    previousClaim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},published,previousClaim);f.acceptClaim(previousClaim);
    expect(previousClaim.postSnapshot.renownRecord).toMatchObject({renownTotal:BigInt(index+1),daysAttested:BigInt(index+1)});
   }
   const last=saved[1]!;
   await f.clock(closed+'T02:00:00Z');await f.conn.sql`update seeker_links set revoked_at=${closed+'T02:00:00Z'} where wallet=${f.buyer}`;
   for(const source of archives.archives)source.reader.getGenesisHash.mockRejectedValue(Error('Original archive offline'));
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
   const [seals]=await f.conn.sql`select (select record from divine_fragment_resource_kits_contract where singleton) is not null kits_retained,
    (select record from divine_fragment_enrolled_seeker_contract where singleton) is not null enrolled_retained,
    (select record from divine_fragment_vehicle_material_contract where singleton) is not null material_retained,
    (select record from divine_fragment_vehicle_client_contract where singleton) is not null client_retained,
    (select record from divine_fragment_existing_wallet_contract where singleton) is not null existing_retained,
    (select record from divine_fragment_seeker_absence_contract where singleton) is not null absence_retained,
    (select record from divine_fragment_gems_zero_contract where singleton) is not null gems_zero_retained,
    (select record-'functions' from divine_fragment_bound_cosmetics_contract where singleton)=shardkeep_divine_fragment_contract()-'functions' current_valid`;
   expect(seals).toEqual({kits_retained:true,enrolled_retained:true,material_retained:true,client_retained:true,existing_retained:true,absence_retained:true,gems_zero_retained:true,current_valid:true});
  },{replayFirstDay:first,resourceClock,enrollmentClock:true});
 },180_000);
});
