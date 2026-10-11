/** Immutable D153.181 funded event rules. Subpath only: no client-side source
 * authority. Callers obtain entries and scores from their original SQL source. */
import {z} from 'zod';
import {CLANS,PHASE_E_CHARTER_TOURNAMENT as P,RAID_ENERGY} from './constants';
import {ORDINARY_REFINED_IDS,type OrdinaryRefinedId} from './phaseEOrdinaryCrafting';
import {RAW_RESOURCE_STORAGE_MAX} from './phaseEResources';
export const CharterTournamentAmountSchema=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=RAW_RESOURCE_STORAGE_MAX);
export const CharterTournamentAmountsSchema=z.object(Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,CharterTournamentAmountSchema])) as Record<OrdinaryRefinedId,typeof CharterTournamentAmountSchema>).strict();
export const CharterTournamentBudgetSchema=CharterTournamentAmountsSchema.refine(v=>Object.values(v).some(n=>BigInt(n)>0n));
export type CharterTournamentAmounts=z.infer<typeof CharterTournamentAmountsSchema>;
export const CHARTER_TOURNAMENT_POLICY={...P,rosterCap:CLANS.rosterCap,freeRaidsPerBaseDay:RAID_ENERGY.freePerDay,prizeItems:ORDINARY_REFINED_IDS,fragments:'held',prizeSource:'funded-existing-refined-stock'} as const;
export function tournamentSchedule(weekStart:string){
 const at=new Date(weekStart);if(!Number.isFinite(at.getTime())||at.toISOString()!==weekStart||at.getUTCDay()!==P.entryWeekdayUtc||at.getUTCHours()||at.getUTCMinutes()||at.getUTCSeconds()||at.getUTCMilliseconds())throw new Error('CHARTER_TOURNAMENT_WEEK');
 const day=86_400_000,play=at.getTime()+P.entryDurationDays*day,end=play+P.playDurationDays*day;
 return {entryStartsAt:at.toISOString(),playStartsAt:new Date(play).toISOString(),playEndsAt:new Date(end).toISOString(),occupationEndsAt:new Date(end+P.occupationDurationDays*day).toISOString()};
}
export interface TournamentRankingInput{clanId:string;roster:string[]}
export interface TournamentScore{clanId:string;stars:number;destruction:number;completedRaids:number}
export function tournamentSettlement(entries:readonly TournamentRankingInput[],scores:readonly TournamentScore[],fundedBudget:unknown,sponsor:string){
 const budget=CharterTournamentBudgetSchema.parse(fundedBudget),seenClans=new Set<string>(),seenWallets=new Set<string>();
 for(const e of entries){if(!z.uuid().safeParse(e.clanId).success||e.clanId!==e.clanId.toLowerCase()||seenClans.has(e.clanId)||e.roster.length<1||e.roster.length>CLANS.rosterCap)throw new Error('CHARTER_TOURNAMENT_ROSTER');seenClans.add(e.clanId);
  for(const w of e.roster){if(!w||seenWallets.has(w))throw new Error('CHARTER_TOURNAMENT_ROSTER');seenWallets.add(w);}}
 const seenScores=new Set<string>();const rankings=scores.map(s=>{const e=entries.find(e=>e.clanId===s.clanId);if(!e||seenScores.has(s.clanId))throw new Error('CHARTER_TOURNAMENT_SCORE');seenScores.add(s.clanId);
  if(!Number.isSafeInteger(s.completedRaids)||s.completedRaids<1||s.completedRaids>e.roster.length*P.raidsPerWallet||!Number.isSafeInteger(s.stars)||s.stars<0||s.stars>s.completedRaids*P.maxStarsPerRaid||!Number.isSafeInteger(s.destruction)||s.destruction<0||s.destruction>s.completedRaids*P.maxDestructionPerRaid)throw new Error('CHARTER_TOURNAMENT_SCORE');
  return {...s,rosterSize:e.roster.length};}).sort((a,b)=>{const stars=BigInt(b.stars)*BigInt(a.rosterSize)-BigInt(a.stars)*BigInt(b.rosterSize);if(stars)return stars<0n?-1:1;const destruction=BigInt(b.destruction)*BigInt(a.rosterSize)-BigInt(a.destruction)*BigInt(b.rosterSize);return destruction?(destruction<0n?-1:1):a.clanId<b.clanId?-1:a.clanId>b.clanId?1:0;});
 const occupations=rankings.slice(0,P.divineSites).map((r,i)=>({site:i+1,clanId:r.clanId}));
 const balances=new Map<string,Record<OrdinaryRefinedId,bigint>>();
 const balance=(wallet:string)=>{let b=balances.get(wallet);if(!b){b=Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,0n])) as Record<OrdinaryRefinedId,bigint>;balances.set(wallet,b);}return b;};
 const refund=balance(sponsor);
 for(const item of ORDINARY_REFINED_IDS){let remaining=BigInt(budget[item]);if(occupations.length){const clanShare=remaining/BigInt(occupations.length);for(const winner of occupations){const e=entries.find(e=>e.clanId===winner.clanId)!;const memberShare=clanShare/BigInt(e.roster.length);for(const wallet of e.roster){balance(wallet)[item]+=memberShare;remaining-=memberShare;}}}refund[item]+=remaining;}
 const entitlements=[...balances].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([wallet,amounts])=>({wallet,amounts:Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,amounts[i].toString()])) as CharterTournamentAmounts}));
 return {rankings,occupations,entitlements};
}
