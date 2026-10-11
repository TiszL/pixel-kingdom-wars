/** Synthetic D181 tournament weeks for DB tests, anchored in the real past.
 *
 * 2026-10-10 (release/phase-e-20261010 CI, cluster B): 0286 refuses a raid
 * capture cutoff later than Postgres clock_timestamp() and 0256/0279 refuse a
 * settlement cutoff after it, so a forged clock cannot capture or settle
 * early. No test can fake the database clock, so the old 2035-01-06 fixture
 * week made every raid and settlement inside it refuse. A fixture week is now
 * the latest real entry weekday whose first `closedMs` have already elapsed;
 * every offset inside the week (funding the day before, entry +1h, play,
 * close, the occupation deadline) is unchanged from the calendar it replaces.
 *
 * Default 3 days + 1 minute: play closes at +2 days and the Divine clan
 * settlement source clock runs at +3 days. A caller that also needs the
 * 7-day occupation still in force at the real clock passes a smaller bound;
 * see clan-charter-retirement-occupation.test.ts. */
import {PHASE_E_CHARTER_TOURNAMENT as P} from '@shardkeep/shared';
const DAY=86_400_000;
export function pastTournamentWeek(closedMs=3*DAY+60_000,now=Date.now()){
 const midnight=Math.floor((now-closedMs)/DAY)*DAY;
 const start=midnight-((new Date(midnight).getUTCDay()-P.entryWeekdayUtc+7)%7)*DAY;
 return {fundedAt:new Date(start-DAY).toISOString(),weekStart:new Date(start).toISOString(),enteredAt:new Date(start+3_600_000).toISOString()};
}
/** `offsetMs` after the event's entry start: replaces a literal 2035-01-06 + offset. */
export const tournamentAt=(event:{entryStartsAt:string},offsetMs:number)=>new Date(Date.parse(event.entryStartsAt)+offsetMs);
export const TOURNAMENT_DAY_MS=DAY;
