/** D153.209 enrolled-link lane helpers: a funded world whose Seeker-link marker
 * starts AFTER the buyer's captured birth, plus the same committed enrollment and
 * synthetic two-provider archives the accepted manifests9/10 test uses. Clocks,
 * archives and RPC banks are local disposable fixtures; nothing here is a live
 * source, a new SBF execution or an activation. Future days are wall-clock
 * relative only because the v3 cutover must be strictly in the future. */
import {seekerMintBirthFixture} from '../../../../packages/chain/src/testFixtures/miningSeekerHolding';
import {withFundedMiningReplayFixture,type FundedReplayFixture} from './fundedMiningReplay';
import {createSeekerEnrollmentArchives} from './seekerEnrollmentQualification';
import {captureMiningSeekerEnrollment,readMiningSeekerEnrollmentChallenge} from '../../src/mining/seekerMiningEnrollment';
import type {SeekerMiningEnrollmentWiring} from '../../src/mining/seekerEnrollmentQualification';
import type {FundedMiningAllocationSources} from '../../src/mining/fundedMiningAllocation';

export function enrolledLinkCalendar(){
 const d=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
 const earlier=d(0),first=d(1),next=d(2),closed=d(3);
 return {earlier,first,next,closed,resourceClock:()=>new Date(closed+'T12:00:00Z')};
}
export type EnrolledLinkCalendar=ReturnType<typeof enrolledLinkCalendar>;
/** delayedSeekerMarker=true is the coverage-order world; false is the accepted default order (control). */
export function withEnrolledLinkWorld(run:(f:FundedReplayFixture,cal:EnrolledLinkCalendar)=>Promise<void>,options:{delayedSeekerMarker:boolean}={delayedSeekerMarker:true}){
 const cal=enrolledLinkCalendar();
 return withFundedMiningReplayFixture(f=>run(f,cal),{replayFirstDay:cal.first,resourceClock:cal.resourceClock,enrollmentClock:true,...(options.delayedSeekerMarker?{delayedSeekerMarker:true}:{})});
}
/** Mirrors mining-seeker-enrollment-publication.test.ts: link at earlier T18:00,
 * committed enrollment at T19:00, archives observed on the closed day. */
export async function enrollBuyer(f:Pick<FundedReplayFixture,'conn'|'buyer'|'clock'>,cal:Pick<EnrolledLinkCalendar,'earlier'|'closed'>){
 const identity=seekerMintBirthFixture().input;
 await f.clock(cal.earlier+'T18:00:00Z');
 await f.conn.sql`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.buyer},${identity.linkedWallet},${identity.mint})`;
 await f.clock(cal.earlier+'T19:00:00Z');await captureMiningSeekerEnrollment(f.conn.db,f.buyer);
 const challenge=await readMiningSeekerEnrollmentChallenge(f.conn.db,{wallet:f.buyer});
 const archives=createSeekerEnrollmentArchives(challenge.enrollment,{observedAt:cal.closed+'T01:00:00Z'});
 const locator={enrollmentId:archives.wiring.enrollmentId,enrollmentSignature:archives.wiring.enrollmentSignature};
 const seekerEnrollment:NonNullable<FundedMiningAllocationSources['seekerEnrollment']>={enrollmentFor:(wallet:string)=>wallet===f.buyer?locator:null,providers:archives.wiring.providers};
 const wiring:SeekerMiningEnrollmentWiring=archives.wiring;
 return {identity,challenge,archives,locator,seekerEnrollment,wiring};
}
export type CoverageOrder={birthEventId:string;afterFloor:boolean;markerBeforeObserved:boolean;markerBeforeCreated:boolean;identityCoverageBeforeBirth:boolean;gemsCoverageBeforeBirth:boolean;activityCoverageBeforeBirth:boolean};
/** Coverage-order facts read straight from the immutable journal and the source
 * markers, so a silently unforwarded fixture option can never pass as a reproduction. */
export async function coverageOrder(f:Pick<FundedReplayFixture,'conn'>,wallet:string):Promise<CoverageOrder>{
 const rows=await f.conn.sql<CoverageOrder[]>`select e.id::text "birthEventId",(e.id>sc.birth_event_floor) "afterFloor",
  (sc.started_at<=e.observed_at) "markerBeforeObserved",(sc.started_at<=(e.after_state->>'created_at')::timestamptz) "markerBeforeCreated",
  (c.started_at<=(e.after_state->>'created_at')::timestamptz and (e.after_state->>'created_at')::timestamptz<=e.observed_at) "identityCoverageBeforeBirth",
  (g.started_at<=e.observed_at and g.started_at<=(e.after_state->>'created_at')::timestamptz) "gemsCoverageBeforeBirth",
  (a.started_at<=(e.after_state->>'created_at')::timestamptz) "activityCoverageBeforeBirth"
  from public.mining_free_cohort_events e cross join public.mining_seeker_link_coverage sc cross join public.mining_free_coverage c
  cross join public.mining_free_gems_coverage g cross join public.playtest_activity_coverage a
  where sc.id and c.id and g.id and a.key='authoritative-v1' and e.source_table='players' and e.operation='INSERT' and e.wallet=${wallet}`;
 if(rows.length!==1)throw Error('coverage order requires exactly one captured birth');return rows[0]!;
}
