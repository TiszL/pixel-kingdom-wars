/** D153.209 enrolled-link lane, two composed publication days through the existing
 * manifests9/10 paths for a coverage-order player (captured birth BEFORE the later
 * Seeker-link marker). D216 integrates this spec into default API/CI discovery.
 * DB custody is real; the
 * enrollment table clock, synthetic two-provider archives (2019 mint birth, witness
 * slot20, holding bank slot30) and finalized RPC/publication banks are local
 * fixtures, not a live source or a new future-time SBF execution. Days are
 * wall-clock relative because the v3 cutover must be strictly in the future. */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {PHASE_E_POLICY as P} from '@shardkeep/shared';
import {withEnrolledLinkWorld,enrollBuyer,coverageOrder} from './fixtures/miningEnrolledLink';
import {executeFundedMiningClaim} from './fixtures/fundedMiningClaims';
import {readMiningSeekerLinkHistory} from '../src/mining/seekerLinkHistory';
import {auditStoredResourcePublication,loadAuditedMiningPrior} from '../src/mining/publicationHistory';
import {getPreparedMiningPublication} from '../src/mining/publicationPreparation';
import {resourceMiningPolicy,seekerResourceMiningPolicy,seekerResourceMiningPolicyV3} from '../src/mining/resourceMiningAudit';
import {miningCanonical} from '../src/mining/fundedMiningAudit';
import {deriveFundedMiningWallet} from '../src/mining/fundedMiningQualification';
import {createMiningClaimEntitlementReader} from '../src/mining/claimEntitlement';
import {createResourceMiningPublicationPreparer} from '../src/mining/fundedMiningAllocation';
import {installResourceMiningV3Cutover} from '../src/mining/resourceMiningPolicy';
afterEach(()=>vi.unstubAllEnvs());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json=Record<string,any>;

describe('enrolled Seeker manifests9/10 for a coverage-order player',()=>{
 it('funds two days with the existing bonus once, refuses downgrades/mixed sources, conserves rewards, claims both and replays originals offline',()=>withEnrolledLinkWorld(async(f,cal)=>{
  await installResourceMiningV3Cutover(f.conn.db,cal.next);
  expect(await coverageOrder(f,f.buyer)).toMatchObject({afterFloor:false,markerBeforeObserved:false,markerBeforeCreated:false,identityCoverageBeforeBirth:true,gemsCoverageBeforeBirth:true,activityCoverageBeforeBirth:true});
  expect(await coverageOrder(f,f.wallet)).toMatchObject({afterFloor:true,markerBeforeObserved:true,markerBeforeCreated:true});
  const e=await enrollBuyer(f,cal);
  const saved:Awaited<ReturnType<Awaited<ReturnType<typeof f.stageResources>>['publish']>>[]=[];
  let previousClaim:Awaited<ReturnType<typeof executeFundedMiningClaim>>|null=null;
  for(const [index,date] of [cal.first,cal.next].entries()){
   const stage=await f.stageResources(date,index===0?{free:[{resourceId:'forge_ingot',quantity:'1'}],paid:[{resourceId:'forge_ingot',quantity:'1'},{resourceId:'heartwood_logs',quantity:'10'}]}:{free:[{resourceId:'climate_kit',quantity:'1'}],paid:[{resourceId:'expedition_kit',quantity:'3'}]},undefined,{policyVersion:index===0?2:3,seekerEnrollment:e.seekerEnrollment});
   // The legacy gate still refuses this player on every closed day; the free wallet reads a genuine no_link.
   await expect(readMiningSeekerLinkHistory(f.conn.db,{wallet:f.buyer,day:date,policyVersion:1})).rejects.toMatchObject({code:'IDENTITY_COVERAGE_UNAVAILABLE'});
   expect((await readMiningSeekerLinkHistory(f.conn.db,{wallet:f.wallet,day:date,policyVersion:1})).status).toBe('no_link');
   if(index===0){
    const duplicate={...e.seekerEnrollment,providers:[e.seekerEnrollment.providers[0],{id:'different-label',connect:e.seekerEnrollment.providers[0].connect}] as const};
    const refuse=createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...stage.optionsForPrepare.sources,seekerEnrollment:duplicate}});
    await expect(refuse(stage.request)).rejects.toThrow(/PROVIDER_CONFIGURATION/);
    // Without the explicit wiring the whole plan refuses: the coverage-order player is never ordinary.
    const {seekerEnrollment:_wired,...unwiredSources}=stage.optionsForPrepare.sources;
    const unwired=createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:unwiredSources});
    await expect(unwired({...stage.request,policyVersion:2})).rejects.toThrow(/IDENTITY_COVERAGE_UNAVAILABLE/);
   }
   const prepared=await stage.prepare(stage.request);if(prepared.status!=='prepared')throw Error('Useful original required');
   const manifest=JSON.parse(prepared.manifestJson);
   expect(manifest).toMatchObject({version:index===0?9:10,scope:index===0?'ordinary-resource-mining-enrolled-seeker-v2':'ordinary-resource-mining-enrolled-seeker-v3',input:{policyVersion:index===0?2:3}});
   const boosted=manifest.participants.find((p:{wallet:string})=>p.wallet===f.buyer);
   expect(boosted.bonusBps).toBe(P.mining.seekerBonusBps);
   expect(boosted.weight).toBe(String(BigInt(boosted.eligibleValue)*BigInt(boosted.baseScoreBps)*BigInt(P.basisPoints+P.mining.seekerBonusBps)/BigInt(P.basisPoints)));
   expect(BigInt(boosted.weight)>0n).toBe(true);
   expect(manifest.participants.find((p:{wallet:string})=>p.wallet===f.wallet).bonusBps).toBe(0);
   const paid=manifest.captures.find((c:{wallet:string})=>c.wallet===f.buyer),free=manifest.captures.find((c:{wallet:string})=>c.wallet===f.wallet);
   expect(paid.seeker).toEqual({linkSource:'committed-enrollment-interval',wallet:f.buyer,day:date,enrollmentId:e.challenge.enrollment.id,link:{wallet:f.buyer,seekerWallet:e.identity.linkedWallet,sgtMint:e.identity.mint,revokedAt:null}});
   expect(paid.seekerQualification).toMatchObject({version:2,interval:{enrollmentId:e.challenge.enrollment.id}});
   expect(paid.seekerQualification.providers).toHaveLength(2);
   expect(free.seeker).toMatchObject({status:'no_link',openingLink:null,closingLink:null,changes:[],sourceUniverse:'recorded-seeker-link-events'});
   expect(free).not.toHaveProperty('seekerQualification');
   expect(()=>deriveFundedMiningWallet({...paid,bases:paid.bases.map((b:Record<string,unknown>)=>({...b,reservedUnits:1}))},f.identity.genesisHash,2)).toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
   const mutations:[string,(m:Json)=>void][]=[
    ['downgrade to the v1 Seeker profile6/8',m=>{m.version=index===0?6:8;m.scope=index===0?'ordinary-resource-mining-seeker-v2':'ordinary-resource-mining-seeker-v3';m.policy=index===0?seekerResourceMiningPolicy:seekerResourceMiningPolicyV3;}],
    ['downgrade to ordinary5',m=>{m.version=5;m.scope='ordinary-resource-mining-v2';m.policy=resourceMiningPolicy;}],
    ['doubled bonus',m=>{m.participants.find((p:{wallet:string})=>p.wallet===f.buyer).bonusBps*=2;}],
    ['deleted proof',m=>{delete m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seekerQualification;}],
    ['invalid witness signature',m=>{m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seekerQualification.enrollmentSignature='invalid';}],
    ['discriminator stripped from the enrolled capture',m=>{delete m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seeker.linkSource;}],
    ['projection claimed by the unenrolled free wallet',m=>{m.captures.find((c:{wallet:string})=>c.wallet===f.wallet).seeker.linkSource='committed-enrollment-interval';}],
    ['enrolled projection copied onto the free wallet',m=>{const c=m.captures.find((c:{wallet:string})=>c.wallet===f.wallet);c.seeker=structuredClone(paid.seeker);c.seekerQualification=structuredClone(paid.seekerQualification);}],
    ['legacy no_link substituted and proof dropped (downgrade to ordinary)',m=>{const c=m.captures.find((c:{wallet:string})=>c.wallet===f.buyer);c.seeker={...structuredClone(free.seeker),wallet:f.buyer};delete c.seekerQualification;}],
    ['rewritten mint inside the projection',m=>{m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seeker.link.sgtMint=f.identity.keepMint;}],
   ];
   for(const [reason,mutate] of mutations){const changed=structuredClone(manifest);mutate(changed);await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(changed),publication:prepared.publication}),reason).rejects.toThrow();}
   const published=await stage.publish();saved.push(published);
   expect(published.settlement.contributions.every(c=>c.outcome==='consumed')).toBe(true);
   expect(BigInt(manifest.playerNet)+BigInt(manifest.recycle)+BigInt(manifest.tax)).toBe(BigInt(manifest.freeGross)+BigInt(manifest.deedGross));
   previousClaim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},published,previousClaim);f.acceptClaim(previousClaim);
   expect(previousClaim.postSnapshot.renownRecord).toMatchObject({renownTotal:BigInt(index+1),daysAttested:BigInt(index+1)});
  }
  // Providerless paused replay after a later revocation: originals, settlement and cumulative rights are unchanged.
  const last=saved[1]!;
  await f.clock(cal.closed+'T02:00:00Z');await f.conn.sql`update seeker_links set revoked_at=${cal.closed+'T02:00:00Z'} where wallet=${f.buyer}`;
  for(const source of e.archives.archives)source.reader.getGenesisHash.mockRejectedValue(Error('Original archive offline'));
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  for(const p of saved){expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);expect(await p.settle()).toEqual(p.settlement);}
  const m=JSON.parse(last.prepared.manifestJson),s=m.funding.source,c=m.funding.config;
  const replay=await loadAuditedMiningPrior(f.conn.db,{genesisHash:s.genesisHash,programId:s.programId,configAddress:c.address,keepMint:c.keepMint,reserveOwner:c.emissionReserveOwner,
   reviewedDeploymentSlot:s.reviewedDeploymentSlot,reviewedProgramDataSha256:s.reviewedProgramDataSha256,sequence:'2'});
  expect(replay.declaration.total).toBe(BigInt(last.prepared.publication.total));
  expect(replay.declaration.leaves.find(l=>l.wallet===f.buyer)).toMatchObject({cumulativeRenown:2n,cumulativeDays:2n});
  expect((await createMiningClaimEntitlementReader(f.conn.db,f.identity)(f.buyer)).kind).toBe('entitlement');
 }),240_000);
});
