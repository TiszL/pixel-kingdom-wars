/** Dedicated disposable-DB world for the committed-marker Seeker ABSENCE reader.
 * Wraps the accepted enrollment fixture clock (table-backed, so the 0269 seal stays
 * valid) over the recorded Seeker-link history world. Default = the coverage order
 * under test: identity coverage 2020-01-01T00:00, captured birth 01:00, Seeker-link
 * marker 02:00, no link. Clocks are local synthetic fixtures; nothing is a live source. */
import {withSeekerMiningEnrollmentFixture} from './seekerMiningEnrollment';
import {readMiningSeekerAbsenceInterval} from '../../src/mining/seekerMiningAbsence';

type Base=Parameters<Parameters<typeof withSeekerMiningEnrollmentFixture>[0]>[0];
type Options=NonNullable<Parameters<typeof withSeekerMiningEnrollmentFixture>[1]>;
export type SeekerAbsenceFixture=Base&{
 /** Read the absence interval for a closed day (default the fixture's 2020-01-02) and wallet (default f.wallet). */
 read:(day?:string,wallet?:string)=>ReturnType<typeof readMiningSeekerAbsenceInterval>;
 /** Mark the wallet's link revoked (journaled UPDATE at the current fixture clock). */
 revoke:(wallet?:string)=>Promise<void>;
 /** Hand-delete the wallet's link rows (journaled DELETE; production never does this). */
 unlink:(wallet?:string)=>Promise<void>;
};
export const ABSENCE_WORLD={coverageAt:'2020-01-01T00:00:00Z',birthAt:'2020-01-01T01:00:00Z',markerAt:'2020-01-01T02:00:00Z',day:'2020-01-02',closedAt:'2020-01-04T00:00:00Z'} as const;
export async function withSeekerMiningAbsenceFixture(run:(f:SeekerAbsenceFixture)=>Promise<void>,options:Options={}){
 await withSeekerMiningEnrollmentFixture(async f=>{
  const read=(day=f.request.day,wallet=f.wallet)=>readMiningSeekerAbsenceInterval(f.conn.db,{wallet,day});
  const revoke=async(wallet=f.wallet)=>{await f.conn.sql`update seeker_links set revoked_at=public.shardkeep_mining_free_clock() where wallet=${wallet}`;};
  const unlink=async(wallet=f.wallet)=>{await f.conn.sql`delete from seeker_links where wallet=${wallet}`;};
  await run({...f,read,revoke,unlink});
 },{beforeMarkerBirth:true,coverageAt:ABSENCE_WORLD.coverageAt,birthAt:ABSENCE_WORLD.birthAt,markerAt:ABSENCE_WORLD.markerAt,...options});
}
