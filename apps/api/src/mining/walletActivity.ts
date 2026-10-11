/** Complete prospective wallet XP/activity facts; no cohort, score or earning right. */
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_MINING_EXPERIENCE_POLICY as POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { collectMiningWalletExperience } from './walletExperience';
import { readExistingMiningWalletIntervalInTransaction } from './existingMiningWallet';

const DAY_MS = 86_400_000;
// Operational read bounds, not gameplay or earning limits. Check aggregate bytes
// before replaying any JSON so many individually valid days cannot exhaust memory.
const MAX_DAYS = 10_000, MAX_ROWS = 10_000, MAX_DAY_BYTES = 4_194_304, MAX_BYTES = 67_108_864;
const walletKey = z.string().min(32).max(44).refine(value => {
 if (value.length < 32 || value.length > 44) return false;
 try { return new PublicKey(value).toBase58() === value; } catch { return false; }
});
const request = z.object({ wallet: walletKey, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), policyVersion: z.literal(POLICY.version) }).strict();
type Code = 'INVALID_INPUT' | 'DAY_OPEN' | 'IDENTITY_COVERAGE_UNAVAILABLE' | 'DAY_COVERAGE_UNAVAILABLE' | 'SOURCE_CONFLICT' | 'SOURCE_UNAVAILABLE' | 'TOO_LARGE' | 'BUSY';
export class MiningWalletActivityError extends Error {
 constructor(readonly code: Code) { super(`Mining wallet activity refused: ${code}`); this.name = 'MiningWalletActivityError'; }
}
function fail(code: Code): never { throw new MiningWalletActivityError(code); }
export interface MiningWalletQualifiedRaid { raidId: string; baseId: string; day: string; firstAcceptedAt: string }
export interface MiningWalletActivityDay { day: string; qualifyingRaidIds: string[]; awardedRaidIds: string[]; awardedXp: number; activityBps: number }

export async function readMiningWalletActivity(db: Db, input: unknown) {
 const parsed = request.safeParse(input); if (!parsed.success) fail('INVALID_INPUT');
 const { wallet, day, policyVersion } = parsed.data, start = Date.parse(`${day}T00:00:00.000Z`);
 if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) fail('INVALID_INPUT');
 const end = new Date(start + DAY_MS).toISOString();
 try {
  const snapshot = await db.transaction(async tx => {
  await tx.execute(sql`lock table public.players,public.mining_free_coverage,public.mining_free_cohort_events,
   public.playtest_activity_coverage,public.mining_activity_evidence,public.mining_wallet_experience_days,
   public.mining_wallet_experience_awards in share mode nowait`);
  const [clock] = await tx.execute<{ closed: boolean; isolation: string }>(sql`select public.shardkeep_mining_free_clock()>=${end}::timestamptz as closed,current_setting('transaction_isolation') as isolation`);
  if (clock?.isolation !== 'read committed') fail('SOURCE_UNAVAILABLE');
  if (clock.closed !== true) fail('DAY_OPEN');
  const [coverage] = await tx.execute<{ identity_at: string; activity_at: string; first_activity_day: string; finite: boolean }>(sql`
   select to_char(i.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') identity_at,
    to_char(a.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') activity_at,
    to_char(date_trunc('day',a.started_at at time zone 'UTC') + case when a.started_at at time zone 'UTC'=date_trunc('day',a.started_at at time zone 'UTC') then interval '0 days' else interval '1 day' end,'YYYY-MM-DD') first_activity_day,
    isfinite(i.started_at) and isfinite(a.started_at) as finite
   from public.mining_free_coverage i cross join public.playtest_activity_coverage a where i.id and a.key='authoritative-v1'`);
  if (!coverage || coverage.finite !== true) fail('IDENTITY_COVERAGE_UNAVAILABLE');
  // The original player INSERT is independent of free-cohort enrollment. Any
  // identity edit, deletion or rebirth through this cutoff makes it ambiguous.
  // All comparisons stay in PostgreSQL; ISO millisecond display is not authority.
  const births = await tx.execute<{ id: string; valid: boolean; born_at: string; observed_at: string; birth_day: string }>(sql`
   select e.id::text,
    (e.operation='INSERT' and e.source_id=${wallet} and e.before_state is null
     and e.after_state->>'wallet'=${wallet} and jsonb_typeof(e.after_state)='object'
     and (select count(*) from jsonb_object_keys(e.after_state))=2
     and isfinite((e.after_state->>'created_at')::timestamptz) and isfinite(e.observed_at)
     and c.started_at<=(e.after_state->>'created_at')::timestamptz
     and (e.after_state->>'created_at')::timestamptz<=e.observed_at) is true valid,
    to_char((e.after_state->>'created_at')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') born_at,
    to_char(e.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') observed_at,
    to_char((e.after_state->>'created_at')::timestamptz at time zone 'UTC','YYYY-MM-DD') birth_day
   from public.mining_free_cohort_events e cross join public.mining_free_coverage c
   where c.id and e.wallet=${wallet} and e.source_table='players' and e.observed_at<${end}::timestamptz order by e.id limit 2`);
  const birth = births[0];
  if (births.length !== 1 || !birth || birth.valid !== true) fail('IDENTITY_COVERAGE_UNAVAILABLE');
  const fromDay = birth.birth_day > coverage.first_activity_day ? birth.birth_day : coverage.first_activity_day;
  const metadata = await coveredDays(tx, { day, policyVersion, fromDay, activityAt: coverage.activity_at });
  return { birth, coverage, fromDay, metadata };
  });
  // Release live identity and source-capture locks before parsing/replaying JSON.
  // The selected journals and original birth are immutable; any later identity
  // event is observed after the already closed cutoff. No replay can backfill.
  const { birth, coverage, fromDay, metadata } = snapshot;
  const activity = await replayDays(db, { wallet, day, policyVersion, metadata, earliestRaidAt: birth.observed_at });
  return {
   ...activity,
   identity: { birthEventId: birth.id, bornAt: birth.born_at, observedBirthAt: birth.observed_at, coverageStartedAt: coverage.identity_at },
   experienceCoverage: { fromDay, throughDay: day, partialBirthDayExcluded: fromDay > birth.birth_day, activityCoverageStartedAt: coverage.activity_at },
   allocationReady: false as const, publicationAuthorized: false as const,
  };
 } catch (error) {
  const e = error as { code?: string; cause?: { code?: string } };
  if (e.code === '55P03' || e.cause?.code === '55P03') fail('BUSY');
  throw error;
 }
}

/** Shared journal replay only. Identity authority is established by the caller's
 * barrier; neither path may manufacture a missing day or use enrollment as XP zero. */
async function coveredDays(tx: Parameters<Parameters<Db['transaction']>[0]>[0], input: {day:string;policyVersion:number;fromDay:string;activityAt:string}) {
 const {day,policyVersion,fromDay,activityAt}=input;
  const span = (Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) / DAY_MS;
  if (!Number.isSafeInteger(span) || span < 0) fail('DAY_COVERAGE_UNAVAILABLE');
  if (span >= MAX_DAYS) fail('TOO_LARGE');
  const metadata = await tx.execute<{ day: string; bytes: number; coverage_matches: boolean }>(sql`
   select x.day::text,coalesce(octet_length(a.evidence::text)+octet_length(a.result::text)+octet_length(x.result::text),0)::int bytes,
    (a.coverage_started_at=date_trunc('milliseconds',${activityAt}::timestamptz)
     and x.source_coverage_started_at=a.coverage_started_at and x.source_hash=a.evidence_hash) is true coverage_matches
   from public.mining_wallet_experience_days x left join public.mining_activity_evidence a
    on a.day=x.day and a.policy_version='battle-evidence-v1'
   where x.policy_version=${policyVersion} and x.day>=${fromDay}::date and x.day<=${day}::date order by x.day limit ${MAX_DAYS + 1}`);
  if (metadata.length !== span + 1) fail('DAY_COVERAGE_UNAVAILABLE');
  let bytes = 0;
  for (let i = 0; i < metadata.length; i++) {
   const item = metadata[i]!;
   if (item.day !== new Date(Date.parse(`${fromDay}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10) || item.bytes === 0) fail('DAY_COVERAGE_UNAVAILABLE');
   if (!item.coverage_matches) fail('SOURCE_CONFLICT');
   bytes += item.bytes;
   if (item.bytes > MAX_DAY_BYTES || bytes > MAX_BYTES) fail('TOO_LARGE');
  }
  const [awardCount] = await tx.execute<{ n: string }>(sql`select count(*)::text n from public.mining_wallet_experience_awards where policy_version=${policyVersion} and day>=${fromDay}::date and day<=${day}::date`);
  if (!awardCount || BigInt(awardCount.n) > BigInt(MAX_ROWS)) fail('TOO_LARGE');
 return metadata;
}
async function replayDays(db:Db,input:{wallet:string;day:string;policyVersion:number;metadata:Awaited<ReturnType<typeof coveredDays>>;earliestRaidAt:string}) {
 const {wallet,day,policyVersion,metadata,earliestRaidAt}=input;
  const days: MiningWalletActivityDay[] = [], qualifiedRaids: MiningWalletQualifiedRaid[] = [], seen = new Set<string>();
  let recordedXp = 0, latestQualifiedAt: string | null = null, latestQualifiedDay: string | null = null, latestDayActivityBps = 0;
  for (const item of metadata) {
   // Both immutable journals were verified present. The existing collector can
   // only take its replay branch here; no missing authority is manufactured.
   const replay = await collectMiningWalletExperience(db, { day: item.day, policyVersion });
   const activity = replay.wallets.find(row => row.wallet === wallet);
   const daily: MiningWalletActivityDay = { day: item.day, qualifyingRaidIds: [...(activity?.qualifyingRaidIds ?? [])], awardedRaidIds: [...(activity?.awardedRaidIds ?? [])], awardedXp: activity?.awardedXp ?? 0, activityBps: activity?.activityBps ?? 0 };
   recordedXp += daily.awardedXp; if (!Number.isSafeInteger(recordedXp)) fail('TOO_LARGE');
   days.push(daily);
   if (qualifiedRaids.length + daily.qualifyingRaidIds.length > MAX_ROWS) fail('TOO_LARGE');
   if (!daily.qualifyingRaidIds.length) continue;
   const raids = await db.execute<{ raid_id: string; base_id: string; first_at: string; after_birth: boolean }>(sql`
    select r->'raid'->>'id' raid_id,r->'raid'->>'baseId' base_id,
     to_char(t.first_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') first_at,
     (t.first_at>=${earliestRaidAt}::timestamptz) is true after_birth
    from public.mining_activity_evidence a cross join lateral jsonb_array_elements(a.evidence->'raids') r
     cross join lateral (select min((e->>'occurredAt')::timestamptz) first_at from jsonb_array_elements(r->'events') e where e->>'sourceKey'='battle_fought') t
    where a.day=${item.day}::date and a.policy_version='battle-evidence-v1' and r->'raid'->>'wallet'=${wallet}
     and r->'raid'->>'id' in (select jsonb_array_elements_text(${JSON.stringify(daily.qualifyingRaidIds)}::jsonb)) order by t.first_at,r->'raid'->>'id' limit ${MAX_ROWS + 1}`);
   if (raids.length !== daily.qualifyingRaidIds.length) fail('SOURCE_CONFLICT');
   for (const raid of raids) {
    if (!raid.after_birth || seen.has(raid.raid_id) || !daily.qualifyingRaidIds.includes(raid.raid_id) || !z.uuid().safeParse(raid.base_id).success || raid.first_at.slice(0, 10) !== item.day) fail('SOURCE_CONFLICT');
    seen.add(raid.raid_id); qualifiedRaids.push({ raidId: raid.raid_id, baseId: raid.base_id, day: item.day, firstAcceptedAt: raid.first_at });
    if (latestQualifiedAt === null || raid.first_at > latestQualifiedAt) { latestQualifiedAt = raid.first_at; latestQualifiedDay = item.day; latestDayActivityBps = daily.activityBps; }
   }
  }
  return {
   wallet, day, policyVersion, recordedXp,
   experienceBps: Number(BigInt(Math.min(recordedXp, POLICY.xpForFullScore)) * BigInt(POLICY.scoreScale) / BigInt(POLICY.xpForFullScore)),
   days, qualifiedRaids, todayQualifyingRaidIds: [...days.at(-1)!.qualifyingRaidIds], latestQualifiedAt, latestQualifiedDay, latestDayActivityBps,
  };
}

export async function readExistingMiningWalletActivity(db:Db,input:unknown) {
 if ('rollback' in db) fail('INVALID_INPUT');
 const parsed=request.extend({baselineId:z.uuid()}).safeParse(input);if(!parsed.success)fail('INVALID_INPUT');
 const {wallet,day,policyVersion,baselineId}=parsed.data;
 try {
  const snapshot=await db.transaction(async tx=>{
   const interval=await readExistingMiningWalletIntervalInTransaction(tx,{wallet,day,baselineId});
   const b=interval.baseline;
   const metadata=await coveredDays(tx,{day,policyVersion,fromDay:b.firstActivityDay,activityAt:b.activityCoverageStartedAt});
   return {interval,metadata};
  });
  const b=snapshot.interval.baseline;
  const activity=await replayDays(db,{wallet,day,policyVersion,metadata:snapshot.metadata,earliestRaidAt:b.firstActivityDay+'T00:00:00.000000Z'});
  return {...activity,allocationReady:false as const,publicationAuthorized:false as const,identity:{kind:'committed-existing-wallet' as const,baselineId,interval:snapshot.interval},
   experienceCoverage:{fromDay:b.firstActivityDay,throughDay:day,partialBirthDayExcluded:b.firstActivityDay>b.player.createdAt.slice(0,10),activityCoverageStartedAt:b.activityCoverageStartedAt}};
 } catch(error) {const e=error as {code?:string;cause?:{code?:string}};if(e.code==='55P03'||e.cause?.code==='55P03')fail('BUSY');throw error;}
}
