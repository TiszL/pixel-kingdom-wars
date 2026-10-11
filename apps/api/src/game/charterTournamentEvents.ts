/** D153.181 existing refined stock escrow. SQL fixes immutable source, ranks and
 * original wallet entitlements; fresh deed authority only selects a claim base. */
import {PublicKey} from '@solana/web3.js';
import {eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {CHARTER_TOURNAMENT_POLICY,CharterTournamentBudgetSchema,tournamentSchedule,type CharterTournamentAmounts} from '@shardkeep/shared/charterTournament';
import type {Db,DbOrTx} from '../db/client';
import type {SaleDomain} from '../db/charterSales';
import {players} from '../db/schema';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from './stableBasePrerequisites';
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const address=z.string().refine(v=>{try{return new PublicKey(v).toBase58()===v&&v!==PublicKey.default.toBase58();}catch{return false;}});
const domainSchema=z.object({genesisHash:address,economyProgram:address,craftProgram:address,treasury:address}).strict();
export const FundCharterTournamentSchema=z.object({id:uuid,baseId:uuid,weekStart:z.string(),budget:CharterTournamentBudgetSchema}).strict();
export interface CharterTournamentEventState{version:1;id:string;domain:SaleDomain;sponsorWallet:string;entryStartsAt:string;playStartsAt:string;playEndsAt:string;occupationEndsAt:string;policy:typeof CHARTER_TOURNAMENT_POLICY;budget:CharterTournamentAmounts;funding:{baseId:string;stock:{itemId:string;before:string;after:string;quantity:string}[];fundedAt:string};terminal:unknown|null}
export interface CharterTournamentFundingOptions{domain:SaleDomain;sponsorWallet:string;clock?:()=>Date}
export interface CharterTournamentClaim{eventId:string;wallet:string;baseId:string;amounts:CharterTournamentAmounts;claimedAt:string}
const enabled=()=>{if(!phaseECharterEnabled())throw new HttpError(503,'Charter tournaments are unavailable','PHASE_E_DISABLED');};
const fail=(code:string,status=409):never=>{throw new HttpError(status,'Charter tournament is unavailable',code);};
export async function readCharterTournamentEvent(db:DbOrTx,eventId:string):Promise<CharterTournamentEventState>{
 uuid.parse(eventId);
 const rows=await db.execute(sql`SELECT public.charter_tournament_event_terms(e.id)||jsonb_build_object('funding',e.funding,'terminal',t.record) AS state FROM public.charter_tournament_events e LEFT JOIN public.charter_tournament_event_terminals t ON t.event_id=e.id WHERE e.id=${eventId}::uuid`);
 if(!rows[0])return fail('CHARTER_TOURNAMENT_NOT_FOUND',404);
 const state=rows[0]['state'] as CharterTournamentEventState;
 if(state.id!==eventId||!isDeepStrictEqual(state.policy,CHARTER_TOURNAMENT_POLICY)||!isDeepStrictEqual(tournamentSchedule(state.entryStartsAt),{entryStartsAt:state.entryStartsAt,playStartsAt:state.playStartsAt,playEndsAt:state.playEndsAt,occupationEndsAt:state.occupationEndsAt}))throw new Error('CHARTER_TOURNAMENT_SOURCE');
 CharterTournamentBudgetSchema.parse(state.budget);return state;
}
function matchFunding(state:CharterTournamentEventState,actor:string,cmd:z.infer<typeof FundCharterTournamentSchema>,domain:SaleDomain){
 if(state.sponsorWallet!==actor||state.funding.baseId!==cmd.baseId||state.entryStartsAt!==cmd.weekStart||!isDeepStrictEqual(state.budget,cmd.budget)||!isDeepStrictEqual(state.domain,domain))return fail('IDEMPOTENCY_BODY_MISMATCH');return state;
}
export async function fundCharterTournamentEvent(db:Db,actor:string,command:z.infer<typeof FundCharterTournamentSchema>,authority:StableBaseMutationContext,options:CharterTournamentFundingOptions):Promise<CharterTournamentEventState>{
 const cmd=FundCharterTournamentSchema.parse(command),domain=domainSchema.parse(options.domain);address.parse(actor);address.parse(options.sponsorWallet);tournamentSchedule(cmd.weekStart);
 if(actor!==options.sponsorWallet)return fail('CHARTER_TOURNAMENT_SPONSOR',403);
 const existing=await db.execute(sql`SELECT id FROM public.charter_tournament_events WHERE id=${cmd.id}::uuid`);
 if(existing[0])return matchFunding(await readCharterTournamentEvent(db,cmd.id),actor,cmd,domain);
 enabled();if(authority.baseId!==cmd.baseId)return fail('CHARTER_TOURNAMENT_BASE',400);
 return db.transaction(async tx=>{
  const [player]=await tx.select().from(players).where(eq(players.wallet,actor)).for('update',{noWait:true});if(!player)return fail('CHARTER_TOURNAMENT_OWNER',404);
  const again=await tx.execute(sql`SELECT id FROM public.charter_tournament_events WHERE id=${cmd.id}::uuid`);if(again[0])return matchFunding(await readCharterTournamentEvent(tx,cmd.id),actor,cmd,domain);
  await lockStablePrerequisiteBase(tx,actor,authority);enabled();
  const now=new Date((options.clock??(()=>new Date()))().getTime());if(!Number.isFinite(now.getTime())||now.getTime()>=Date.parse(cmd.weekStart))return fail('CHARTER_TOURNAMENT_WINDOW');
  await tx.execute(sql`INSERT INTO public.charter_tournament_events(id,domain,week_start,sponsor_wallet,policy,budget,funding,funded_at,tx_key) VALUES(${cmd.id}::uuid,${JSON.stringify(domain)}::jsonb,${cmd.weekStart}::timestamptz,${actor},${JSON.stringify(CHARTER_TOURNAMENT_POLICY)}::jsonb,${JSON.stringify(cmd.budget)}::jsonb,${JSON.stringify({baseId:cmd.baseId})}::jsonb,${now.toISOString()}::timestamptz,pg_current_xact_id()::text)`);
  return readCharterTournamentEvent(tx,cmd.id);
 });
}
export async function closeCharterTournamentEvent(db:Db,eventId:string,options:{clock?:()=>Date}={}):Promise<CharterTournamentEventState>{
 uuid.parse(eventId);return db.transaction(async tx=>{
  const rows=await tx.execute(sql`SELECT id FROM public.charter_tournament_events WHERE id=${eventId}::uuid FOR UPDATE NOWAIT`);if(!rows[0])return fail('CHARTER_TOURNAMENT_NOT_FOUND',404);
  const state=await readCharterTournamentEvent(tx,eventId);if(state.terminal)return state;
  const now=new Date((options.clock??(()=>new Date()))().getTime());if(!Number.isFinite(now.getTime()))throw new Error('CHARTER_TOURNAMENT_CLOCK');
  await tx.execute(sql`INSERT INTO public.charter_tournament_event_terminals(event_id,record,completed_at,tx_key) VALUES(${eventId}::uuid,'{}',${now.toISOString()}::timestamptz,pg_current_xact_id()::text)`);return readCharterTournamentEvent(tx,eventId);
 });
}
export async function readCharterTournamentClaim(db:DbOrTx,actor:string,eventId:string):Promise<CharterTournamentClaim|null>{
 address.parse(actor);uuid.parse(eventId);await db.execute(sql`SELECT public.shardkeep_charter_tournament_event_source()`);
 const rows=await db.execute(sql`SELECT event_id AS "eventId",wallet,base_id AS "baseId",amounts,to_char(claimed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "claimedAt" FROM public.charter_tournament_prize_claims WHERE event_id=${eventId}::uuid AND wallet=${actor}`);
 return rows[0] as unknown as CharterTournamentClaim??null;
}
export async function claimCharterTournamentPrize(db:Db,actor:string,command:{eventId:string;baseId:string},authority:StableBaseMutationContext,options:{clock?:()=>Date}={}):Promise<CharterTournamentClaim>{
 const cmd=z.object({eventId:uuid,baseId:uuid}).strict().parse(command);address.parse(actor);
 const same=(prior:CharterTournamentClaim)=>{if(prior.baseId!==cmd.baseId)return fail('IDEMPOTENCY_BODY_MISMATCH');return prior;};
 const prior=await readCharterTournamentClaim(db,actor,cmd.eventId);if(prior)return same(prior);
 if(authority.baseId!==cmd.baseId)return fail('CHARTER_TOURNAMENT_BASE',400);
 return db.transaction(async tx=>{
  const [player]=await tx.select().from(players).where(eq(players.wallet,actor)).for('update',{noWait:true});if(!player)return fail('CHARTER_TOURNAMENT_OWNER',404);
  const again=await readCharterTournamentClaim(tx,actor,cmd.eventId);if(again)return same(again);
  await lockStablePrerequisiteBase(tx,actor,authority);
  const now=new Date((options.clock??(()=>new Date()))().getTime());if(!Number.isFinite(now.getTime()))throw new Error('CHARTER_TOURNAMENT_CLOCK');
  await tx.execute(sql`INSERT INTO public.charter_tournament_prize_claims(event_id,wallet,base_id,amounts,stock,claimed_at,tx_key) VALUES(${cmd.eventId}::uuid,${actor},${cmd.baseId}::uuid,'{}','[]',${now.toISOString()}::timestamptz,pg_current_xact_id()::text)`);
  return (await readCharterTournamentClaim(tx,actor,cmd.eventId))!;
 });
}
