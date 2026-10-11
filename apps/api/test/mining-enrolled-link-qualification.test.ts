/** D153.209 enrolled-link lane: a player whose identity/activity/Gems coverage and
 * captured birth precede a LATER Seeker-link marker holds a valid committed
 * enrollment, purpose-bound witness and full holding proof. Only the explicit
 * enrollment wiring may name that link, from the validated interval; the legacy
 * captured-birth reader stays byte-identical for every other wallet. DB custody is
 * real; clocks, archives and RPC banks are local synthetic fixtures (no SBF run). */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {PHASE_E_POLICY as P} from '@shardkeep/shared';
import {seekerMintBirthFixture} from '../../../packages/chain/src/testFixtures/miningSeekerHolding';
import {seekerCoverageFixture} from '../../../packages/chain/src/testFixtures/miningSeekerCoverage';
import {withEnrolledLinkWorld,enrollBuyer,coverageOrder} from './fixtures/miningEnrolledLink';
import {withSeekerMiningEnrollmentFixture} from './fixtures/seekerMiningEnrollment';
import {createSeekerEnrollmentArchives} from './fixtures/seekerEnrollmentQualification';
import {captureMiningWalletQualification,deriveMiningWalletQualification,deriveFundedMiningWallet} from '../src/mining/fundedMiningQualification';
import {deriveResourceMiningWallet} from '../src/mining/resourceMiningAllocation';
import {readMiningSeekerLinkHistory} from '../src/mining/seekerLinkHistory';
import {readMiningWalletActivity} from '../src/mining/walletActivity';
import {initializeFreeGemsEvidence,readFreeGemsEvidence} from '../src/mining/freeGemsEvidence';
import {captureMiningSeekerEnrollment,readMiningSeekerEnrollmentChallenge} from '../src/mining/seekerMiningEnrollment';
import {captureMiningSeekerEnrollmentQualification,replayMiningSeekerEnrollmentQualification} from '../src/mining/seekerEnrollmentQualification';
import type {SeekerMiningQualificationWiring} from '../src/mining/seekerMiningQualification';
import {auditStoredResourcePublication} from '../src/mining/publicationHistory';
import {miningCanonical} from '../src/mining/fundedMiningAudit';
afterEach(()=>vi.unstubAllEnvs());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json=Record<string,any>;
const clone=(value:unknown)=>JSON.parse(miningCanonical(value)) as Json;
const foreignKey=()=>Keypair.generate().publicKey.toBase58();
const day1={free:[{resourceId:'forge_ingot' as const,quantity:'1'}],paid:[{resourceId:'forge_ingot' as const,quantity:'1'},{resourceId:'heartwood_logs' as const,quantity:'10'}]};
const resourceBases=(c:Json)=>({...c,bases:(c.bases as Json[]).map(b=>({...b,reservedValue:'1000'}))});

describe('D153.209 enrolled Seeker link qualification (coverage order)',()=>{
 it('coverage-order player: the legacy captured-birth gate refuses, explicit enrollment wiring qualifies with the existing bonus once',()=>withEnrolledLinkWorld(async(f,cal)=>{
  const buyer=await coverageOrder(f,f.buyer),free=await coverageOrder(f,f.wallet);
  expect(buyer).toMatchObject({afterFloor:false,markerBeforeObserved:false,markerBeforeCreated:false,identityCoverageBeforeBirth:true,gemsCoverageBeforeBirth:true,activityCoverageBeforeBirth:true});
  expect(free).toMatchObject({afterFloor:true,markerBeforeObserved:true,markerBeforeCreated:true,identityCoverageBeforeBirth:true});
  const e=await enrollBuyer(f,cal);
  const stage=await f.stageResources(cal.first,day1,undefined,{policyVersion:2,seekerEnrollment:e.seekerEnrollment});
  const q=stage.sources.qualification,genesis=q.expectedGenesisHash;
  // The unchanged legacy reader is exactly what the base capture invoked first.
  await expect(readMiningSeekerLinkHistory(f.conn.db,{wallet:f.buyer,day:cal.first,policyVersion:1})).rejects.toMatchObject({name:'MiningSeekerLinkHistoryError',code:'IDENTITY_COVERAGE_UNAVAILABLE'});
  expect((await readMiningSeekerLinkHistory(f.conn.db,{wallet:f.wallet,day:cal.first,policyVersion:1})).status).toBe('no_link');
  // Without explicit enrollment wiring the same player still refuses: no no_link or ordinary fallback.
  await expect(captureMiningWalletQualification(f.conn.db,q,f.buyer,cal.first,[f.paidBaseId],undefined,2)).rejects.toMatchObject({name:'MiningSeekerLinkHistoryError',code:'IDENTITY_COVERAGE_UNAVAILABLE'});
  const cap=await captureMiningWalletQualification(f.conn.db,q,f.buyer,cal.first,[f.paidBaseId],undefined,2,undefined,e.wiring);
  expect(cap.seeker).toEqual({linkSource:'committed-enrollment-interval',wallet:f.buyer,day:cal.first,enrollmentId:e.challenge.enrollment.id,
   link:{wallet:f.buyer,seekerWallet:e.identity.linkedWallet,sgtMint:e.identity.mint,revokedAt:null}});
  for(const key of ['identity','status','openingLink','closingLink','changes','credentialHistory','sourceUniverse'])expect(cap.seeker).not.toHaveProperty(key);
  if(cap.seekerQualification?.version!==2)throw Error('qualification2 required');
  expect(cap.seekerQualification.interval.enrollmentId).toBe(e.challenge.enrollment.id);
  // No birth is invented: the interval carries no players event, and the activity/Gems births are the captured one.
  expect(cap.seekerQualification.interval.events.filter(event=>event.sourceTable==='players')).toEqual([]);
  if(!('birthEventId'in cap.activity.identity)||!('birthEventId'in cap.gems))throw Error('legacy captured birth sources required');
  expect(cap.activity.identity.birthEventId).toBe(buyer.birthEventId);expect(cap.gems.birthEventId).toBe(buyer.birthEventId);
  const derived=deriveResourceMiningWallet(resourceBases(cap as unknown as Json) as Parameters<typeof deriveResourceMiningWallet>[0],genesis,true,2);
  expect(derived).toHaveLength(1);
  const paid=derived[0]!;
  expect(paid).toMatchObject({wallet:f.buyer,baseId:f.paidBaseId,pool:'deed',eligible:true,bonusBps:P.mining.seekerBonusBps});
  expect(paid.weight).toBe(String(BigInt(paid.eligibleValue)*BigInt(paid.baseScoreBps)*BigInt(P.basisPoints+P.mining.seekerBonusBps)/BigInt(P.basisPoints)));
  expect(BigInt(paid.weight)>0n).toBe(true);
  // The retained canonical bytes derive identically (key order is not authority).
  expect(deriveResourceMiningWallet(resourceBases(clone(cap)) as Parameters<typeof deriveResourceMiningWallet>[0],genesis,true,2)).toEqual(derived);
  // Through the real planner: manifest9 with the bonus exactly once for the enrolled buyer, none for the free wallet.
  const prepared=await stage.prepare(stage.request);if(prepared.status!=='prepared')throw Error('Useful original required');
  const manifest=JSON.parse(prepared.manifestJson);
  expect(manifest).toMatchObject({version:9,scope:'ordinary-resource-mining-enrolled-seeker-v2',input:{policyVersion:2}});
  const boosted=manifest.participants.find((p:{wallet:string})=>p.wallet===f.buyer),plain=manifest.participants.find((p:{wallet:string})=>p.wallet===f.wallet);
  expect(boosted.bonusBps).toBe(P.mining.seekerBonusBps);expect(plain.bonusBps).toBe(0);
  expect(manifest.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seeker).toEqual(cap.seeker);
  expect(manifest.captures.find((c:{wallet:string})=>c.wallet===f.wallet).seeker).toMatchObject({status:'no_link',sourceUniverse:'recorded-seeker-link-events'});
  // Missing daily journals are never zero-filled by enrollment wiring: the unstaged next day refuses at the
  // unchanged activity reader, and the composed wired capture refuses with a typed source code (never a crash).
  await expect(readMiningWalletActivity(f.conn.db,{wallet:f.buyer,day:cal.next,policyVersion:1})).rejects.toMatchObject({name:'MiningWalletActivityError',code:expect.stringMatching(/^DAY_(COVERAGE_UNAVAILABLE|OPEN)$/)});
  await expect(captureMiningWalletQualification(f.conn.db,q,f.buyer,cal.next,[f.paidBaseId],undefined,2,undefined,e.wiring)).rejects.toMatchObject({code:expect.any(String)});
 }),120_000);

 it('a failed or mismatched positive proof refuses; it never degrades to ordinary, no_link or a reduced bonus',()=>withEnrolledLinkWorld(async(f,cal)=>{
  const e=await enrollBuyer(f,cal);
  const stage=await f.stageResources(cal.first,day1,undefined,{policyVersion:2,seekerEnrollment:e.seekerEnrollment});
  const q=stage.sources.qualification;
  const capture=(wallet:string,bases:string[],wiring=e.wiring,policyVersion:1|2=2,seeker?:SeekerMiningQualificationWiring)=>captureMiningWalletQualification(f.conn.db,q,wallet,cal.first,bases,undefined,policyVersion,seeker,wiring);
  await expect(capture(f.buyer,[f.paidBaseId],{...e.wiring,enrollmentId:randomUUID()})).rejects.toMatchObject({name:'MiningSeekerEnrollmentQualificationError',code:'SOURCE_UNAVAILABLE'});
  await expect(capture(f.buyer,[f.paidBaseId],{...e.wiring,enrollmentSignature:seekerCoverageFixture().input.signature})).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  for(const archive of e.archives.archives)archive.reader.getGenesisHash.mockRejectedValueOnce(Error('archive offline'));
  await expect(capture(f.buyer,[f.paidBaseId])).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  e.archives.archives[1].reader.getGenesisHash.mockResolvedValueOnce(f.buyer);
  await expect(capture(f.buyer,[f.paidBaseId])).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  // Another wallet cannot borrow the buyer's enrollment.
  await expect(capture(f.wallet,[f.baseId])).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  // Mixed v1/v2 wiring and the ingot policy refuse before any Seeker read.
  const v1={coverageSignature:e.wiring.enrollmentSignature,providers:e.wiring.providers} as unknown as SeekerMiningQualificationWiring;
  await expect(capture(f.buyer,[f.paidBaseId],e.wiring,2,v1)).rejects.toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
  await expect(capture(f.buyer,[f.paidBaseId],e.wiring,1)).rejects.toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
  const original=await capture(f.buyer,[f.paidBaseId]);
  expect(original.seeker).toMatchObject({linkSource:'committed-enrollment-interval'});
  // Post-frontier changes (revocation, then deletion) refuse a new capture; nothing falls back to no_link.
  await f.conn.sql`update seeker_links set revoked_at=${cal.closed+'T02:00:00Z'} where wallet=${f.buyer}`;
  await expect(capture(f.buyer,[f.paidBaseId])).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  await f.conn.sql`delete from seeker_links where wallet=${f.buyer}`;
  await expect(capture(f.buyer,[f.paidBaseId])).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
  // Unwired, the same player still meets the unchanged legacy gate: no fallback in either direction.
  await expect(captureMiningWalletQualification(f.conn.db,q,f.buyer,cal.first,[f.paidBaseId],undefined,2)).rejects.toMatchObject({name:'MiningSeekerLinkHistoryError',code:'IDENTITY_COVERAGE_UNAVAILABLE'});
  // The retained original still replays offline and paused, with the bonus once.
  for(const archive of e.archives.archives)archive.reader.getGenesisHash.mockRejectedValue(Error('archive offline'));
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  expect(deriveMiningWalletQualification(clone(original) as Parameters<typeof deriveMiningWalletQualification>[0],q.expectedGenesisHash,2,true,2)[0]?.bonusBps).toBe(P.mining.seekerBonusBps);
  // Composed path: a wired wallet whose earning day precedes activity coverage still refuses at the unchanged
  // activity reader, which the capture consults before any Seeker branch. Enrollment never stands in for it.
  await f.conn.sql`update playtest_activity_coverage set started_at=${cal.closed+'T00:00:00Z'}`;
  await expect(capture(f.buyer,[f.paidBaseId])).rejects.toMatchObject({name:'MiningWalletActivityError',code:'DAY_COVERAGE_UNAVAILABLE'});
 }),120_000);

 it('replay: forged, mixed-source, downgraded or proof-less enrolled captures fail closed',()=>withEnrolledLinkWorld(async(f,cal)=>{
  const e=await enrollBuyer(f,cal);
  const stage=await f.stageResources(cal.first,day1,undefined,{policyVersion:2,seekerEnrollment:e.seekerEnrollment});
  const genesis=stage.sources.qualification.expectedGenesisHash;
  const cap=await captureMiningWalletQualification(f.conn.db,stage.sources.qualification,f.buyer,cal.first,[f.paidBaseId],undefined,2,undefined,e.wiring);
  const freeCap=await captureMiningWalletQualification(f.conn.db,stage.sources.qualification,f.wallet,cal.first,[f.baseId],undefined,2);
  expect(freeCap.seeker).toMatchObject({status:'no_link'});
  const derive=(c:Json,allow=true,version:1|2=2,policyVersion:1|2=2)=>deriveMiningWalletQualification(c as Parameters<typeof deriveMiningWalletQualification>[0],genesis,policyVersion,allow,version);
  const accepted=derive(clone(cap));expect(accepted[0]?.bonusBps).toBe(P.mining.seekerBonusBps);
  // Grafting the buyer's valid proof and projection onto another wallet's own capture fails the proof-to-capture binding.
  const graft={...clone(freeCap),seeker:{...(clone(cap.seeker) as Json),wallet:f.wallet,link:{...(clone(cap.seeker) as Json).link,wallet:f.wallet}},seekerQualification:clone(cap.seekerQualification)};
  expect(()=>derive(graft)).toThrow(/SOURCE_CONFLICT/);
  const legacyNoLink={wallet:f.buyer,day:cal.first,policyVersion:1,status:'no_link',openingLink:null,closingLink:null,changes:[],activeThroughout:false};
  const cases:[string,(c:Json)=>void,RegExp][]=[
   ['foreign wallet on the projection',c=>{c.seeker.wallet=f.wallet;},/SEEKER_HISTORY_UNAVAILABLE/],
   ['foreign day on the projection',c=>{c.seeker.day=cal.next;},/SEEKER_HISTORY_UNAVAILABLE/],
   // af5e61f0a (D153.218, 2026-09-30) made an unknown discriminator value a refused profile before any branch is chosen,
   // instead of letting any own linkSource key select the strict enrolled branch and fail its comparison. Still fail-closed;
   // what this case pins is that the legacy source-universe label never selects a qualifying branch.
   ['legacy source-universe claim on the projection',c=>{c.seeker.linkSource='recorded-seeker-link-events';},/SEEKER_HISTORY_UNAVAILABLE/],
   ['manufactured legacy status',c=>{c.seeker.status='continuous_link';},/SOURCE_CONFLICT/],
   ['manufactured birth identity',c=>{c.seeker.identity={birthEventId:'1',bornAt:cal.earlier+'T00:00:00.000000Z',observedBirthAt:cal.earlier+'T00:00:00.000000Z'};},/SOURCE_CONFLICT/],
   ['manufactured empty history',c=>{c.seeker.changes=[];},/SOURCE_CONFLICT/],
   ['rewritten mint',c=>{c.seeker.link.sgtMint=foreignKey();},/SOURCE_CONFLICT/],
   ['rewritten Seeker wallet',c=>{c.seeker.link.seekerWallet=foreignKey();},/SOURCE_CONFLICT/],
   ['link bound to another game wallet',c=>{c.seeker.link.wallet=f.wallet;},/SOURCE_CONFLICT/],
   ['revoked link claimed active',c=>{c.seeker.link.revokedAt=cal.closed+'T02:00:00.000000Z';},/SOURCE_CONFLICT/],
   ['missing link',c=>{delete c.seeker.link;},/SOURCE_CONFLICT/],
   ['manufactured key inside the link',c=>{c.seeker.link.birthEventId='1';},/SOURCE_CONFLICT/],
   ['foreign enrollment id on the projection',c=>{c.seeker.enrollmentId=randomUUID();},/SOURCE_CONFLICT/],
   ['discriminator stripped (legacy impersonation)',c=>{delete c.seeker.linkSource;},/SOURCE_CONFLICT/],
   ['legacy no_link shape substituted while keeping the proof',c=>{c.seeker=legacyNoLink;},/SOURCE_CONFLICT/],
   ['proof deleted (downgrade to ordinary)',c=>{delete c.seekerQualification;},/SEEKER_HISTORY_UNAVAILABLE/],
   ['proof relabelled version1',c=>{c.seekerQualification.version=1;},/SOURCE_CONFLICT/],
   ['retargeted nonce inside the proof (chain witness conflict)',c=>{c.seekerQualification.interval.enrollment.nonce='ab'.repeat(32);},/EVIDENCE_CONFLICT|SOURCE_CONFLICT/],
   ['proof bound to another enrollment id',c=>{c.seekerQualification.interval.enrollmentId=randomUUID();},/SOURCE_CONFLICT/],
  ];
  for(const [reason,mutate,pattern] of cases){const changed=clone(cap);mutate(changed);expect(()=>derive(changed),reason).toThrow(pattern);}
  // Older profiles never gain the projection: ingot3/4, ordinary5/7 and the v1 Seeker profile6/8 refuse.
  expect(()=>deriveFundedMiningWallet({...clone(cap),bases:(cap.bases as unknown as Json[]).map(b=>({...b,reservedUnits:1}))} as Parameters<typeof deriveFundedMiningWallet>[0],genesis,2)).toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
  expect(()=>derive(clone(cap),false)).toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
  expect(()=>derive(clone(cap),true,2,1)).toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
  expect(()=>derive(clone(cap),true,1)).toThrow(/SOURCE_CONFLICT/);
  const relabelled=clone(cap);relabelled.seekerQualification.version=1;
  expect(()=>derive(relabelled,true,1)).toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
  const proofless=clone(cap);delete proofless.seekerQualification;
  expect(()=>derive(proofless,false,1)).toThrow(/SEEKER_HISTORY_UNAVAILABLE/);
 }),120_000);

 it('default marker order (control): the retained legacy+v2 capture shape replays identically under the new code and cannot mix with the projection',()=>withEnrolledLinkWorld(async(f,cal)=>{
  const buyer=await coverageOrder(f,f.buyer);
  expect(buyer).toMatchObject({afterFloor:true,markerBeforeObserved:true,markerBeforeCreated:true});
  const e=await enrollBuyer(f,cal);
  const stage=await f.stageResources(cal.first,day1,undefined,{policyVersion:2,seekerEnrollment:e.seekerEnrollment});
  const genesis=stage.sources.qualification.expectedGenesisHash;
  const cap=await captureMiningWalletQualification(f.conn.db,stage.sources.qualification,f.buyer,cal.first,[f.paidBaseId],undefined,2,undefined,e.wiring);
  expect(cap.seeker).toMatchObject({linkSource:'committed-enrollment-interval'});
  // The exact object the base capture stored beside the same qualification2 proof.
  const legacy=await readMiningSeekerLinkHistory(f.conn.db,{wallet:f.buyer,day:cal.first,policyVersion:1});
  expect(legacy).toMatchObject({status:'continuous_link',sourceUniverse:'recorded-seeker-link-events'});
  const retained=resourceBases({...clone(cap),seeker:clone(legacy)}) as Parameters<typeof deriveResourceMiningWallet>[0];
  const current=deriveResourceMiningWallet(resourceBases(clone(cap)) as Parameters<typeof deriveResourceMiningWallet>[0],genesis,true,2);
  expect(deriveResourceMiningWallet(retained,genesis,true,2)).toEqual(current);
  expect(current[0]?.bonusBps).toBe(P.mining.seekerBonusBps);
  // A legacy history carrying the new discriminator is a mixed source and refuses.
  const mixed=resourceBases({...clone(cap),seeker:{...clone(legacy),linkSource:'committed-enrollment-interval'}}) as Parameters<typeof deriveResourceMiningWallet>[0];
  expect(()=>deriveResourceMiningWallet(mixed,genesis,true,2)).toThrow(/SOURCE_CONFLICT/);
  // A retained pre-fix manifest9 (legacy seeker beside the v2 proof) still audits unchanged.
  const prepared=await stage.prepare(stage.request);if(prepared.status!=='prepared')throw Error('Useful original required');
  const manifest=JSON.parse(prepared.manifestJson);expect(manifest.version).toBe(9);
  const asRetained=structuredClone(manifest);asRetained.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seeker=clone(legacy);
  await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(asRetained),publication:prepared.publication})).resolves.toBeDefined();
  const asMixed=structuredClone(manifest);asMixed.captures.find((c:{wallet:string})=>c.wallet===f.buyer).seeker={...clone(legacy),linkSource:'committed-enrollment-interval'};
  await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(asMixed),publication:prepared.publication})).rejects.toThrow();
 },{delayedSeekerMarker:false}),120_000);

 it('a valid prospective enrollment never stands in for a player who predates identity or free-Gems coverage',async()=>{
  await withSeekerMiningEnrollmentFixture(async f=>{
   const identity=seekerMintBirthFixture().input;
   await f.clock('2020-01-01T12:00:00Z');await f.link(f.wallet,identity.mint,identity.linkedWallet);
   await f.clock('2020-01-01T13:00:00Z');await captureMiningSeekerEnrollment(f.conn.db,f.wallet);
   await initializeFreeGemsEvidence(f.conn.db);
   const challenge=await readMiningSeekerEnrollmentChallenge(f.conn.db,{wallet:f.wallet});
   const sources=createSeekerEnrollmentArchives(challenge.enrollment);await f.close();
   const proof=await captureMiningSeekerEnrollmentQualification(f.conn.db,sources.wiring,{wallet:f.wallet,day:f.request.day});
   expect(replayMiningSeekerEnrollmentQualification(proof).bonusBps).toBe(P.mining.seekerBonusBps);
   expect(proof.interval.events.filter(event=>event.sourceTable==='players')).toEqual([]);
   // The funded capture reads activity and free-Gems evidence first and unconditionally; both still refuse.
   await expect(readMiningWalletActivity(f.conn.db,{wallet:f.wallet,day:f.request.day,policyVersion:1})).rejects.toMatchObject({code:'IDENTITY_COVERAGE_UNAVAILABLE'});
   await expect(readFreeGemsEvidence(f.conn.db,{wallet:f.wallet,day:f.request.day})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  },{preCoverageBirth:true,birthAt:'2019-12-31T12:00:00Z'});
 },120_000);
});
