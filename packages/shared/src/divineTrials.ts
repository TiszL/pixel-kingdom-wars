/** D184 immutable equal-trial policy and settlement math. Parsing/pure helpers
 * confer no admission, score, source, settlement or stock-credit authority. */
import {z} from 'zod';
import {PHASE_E_DIVINE_TRIALS as P} from './constants';
import {ORDINARY_REFINED_IDS,type OrdinaryRefinedId} from './phaseEOrdinaryCrafting';
import {CharterTournamentAmountsSchema,CharterTournamentBudgetSchema,type CharterTournamentAmounts} from './charterTournament';
export const DivineTrialAmountsSchema=CharterTournamentAmountsSchema;
export const DivineTrialBudgetSchema=CharterTournamentBudgetSchema;
export type DivineTrialAmounts=CharterTournamentAmounts;
export const DivineTrialIdSchema=z.uuid().refine(v=>v===v.toLowerCase()&&v!=='00000000-0000-0000-0000-000000000000');
export const DivineTrialWalletSchema=z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);
export const DIVINE_TRIAL_POLICY={...P,prizeItems:ORDINARY_REFINED_IDS,fragments:'held',prizeSource:'funded-existing-refined-stock',tieBreak:'wallet-ascii',heroes:'none',energy:'none'} as const;
/** The exact commitment grammar is compact JSON with ASCII-key lexical order.
 * Reject accessors/non-JSON/unsafe numbers before serialization; arrays retain order. */
export function divineTrialCanonicalJson(value:unknown):string{
 let nodes=0,size=0;const add=(s:string)=>{size+=s.length;if(size>P.maxPayloadBytes)throw Error('DIVINE_TRIAL_JSON_LIMIT');return s;};
 const json=(v:unknown,depth:number):string=>{
  if(++nodes>P.maxJsonNodes||depth>P.maxJsonDepth)throw Error('DIVINE_TRIAL_JSON_LIMIT');
  if(v===null||typeof v==='boolean')return add(JSON.stringify(v));
  if(typeof v==='number'){if(!Number.isSafeInteger(v))throw Error('DIVINE_TRIAL_JSON_NUMBER');return add(JSON.stringify(v));}
  if(typeof v==='string'){if(v.length>P.maxStringLength)throw Error('DIVINE_TRIAL_JSON_STRING');return add(JSON.stringify(v));}
  if(Array.isArray(v)){if(v.length>P.maxReplayEvents)throw Error('DIVINE_TRIAL_JSON_ARRAY');return add('[')+v.map(x=>json(x,depth+1)).join(',')+add(']');}
  if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error('DIVINE_TRIAL_JSON_VALUE');
  const keys=Object.keys(v).sort();if(keys.length>P.maxObjectKeys||Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!k.length||k.length>P.maxStringLength||!/^[\x20-\x7e]+$/.test(k)))throw Error('DIVINE_TRIAL_JSON_KEYS');
  return add('{')+keys.map(k=>{const p=Object.getOwnPropertyDescriptor(v,k);if(!p||!('value'in p)||!p.enumerable)throw Error('DIVINE_TRIAL_JSON_ACCESSOR');return add(JSON.stringify(k)+':')+json(p.value,depth+1);}).join(',')+add('}');
 };const result=json(value,0);if(new TextEncoder().encode(result).length>P.maxPayloadBytes)throw Error('DIVINE_TRIAL_JSON_LIMIT');return result;
}
export function divineTrialSchedule(weekStart:string){
 const t=new Date(weekStart);if(!Number.isFinite(t.getTime())||t.toISOString()!==weekStart||t.getUTCDay()!==P.entryWeekdayUtc||t.getUTCHours()||t.getUTCMinutes()||t.getUTCSeconds()||t.getUTCMilliseconds())throw Error('DIVINE_TRIAL_WEEK');
 const day=86_400_000,play=t.getTime()+P.entryDurationDays*day,end=play+P.playDurationDays*day;
 return {entryStartsAt:weekStart,playStartsAt:new Date(play).toISOString(),playEndsAt:new Date(end).toISOString(),occupationEndsAt:new Date(end+P.occupationDurationDays*day).toISOString()};
}
export const DivineTrialScoreSchema=z.object({wallet:DivineTrialWalletSchema,attemptId:DivineTrialIdSchema,ordinal:z.number().int().min(1).max(P.attemptsPerWallet),stars:z.number().int().min(0).max(P.maxStars),destruction:z.number().int().min(0).max(P.maxDestruction)}).strict();
export type DivineTrialScore=z.infer<typeof DivineTrialScoreSchema>;
export function divineTrialSettlement(scores:readonly DivineTrialScore[],fundedBudget:unknown,sponsorWallet:string){
 const budget=DivineTrialBudgetSchema.parse(fundedBudget),sponsor=DivineTrialWalletSchema.parse(sponsorWallet),ids=new Set<string>(),ordinals=new Set<string>(),best=new Map<string,DivineTrialScore>();
 for(const raw of scores){const s=DivineTrialScoreSchema.parse(raw),key=s.wallet+':'+s.ordinal;if(ids.has(s.attemptId)||ordinals.has(key))throw Error('DIVINE_TRIAL_DUPLICATE_SCORE');ids.add(s.attemptId);ordinals.add(key);
  if(s.stars<P.minWinningStars)continue;const old=best.get(s.wallet);if(!old||s.stars>old.stars||s.stars===old.stars&&(s.destruction>old.destruction||s.destruction===old.destruction&&s.ordinal<old.ordinal))best.set(s.wallet,s);
 }
 const rankings=[...best.values()].sort((a,b)=>b.stars-a.stars||b.destruction-a.destruction||(a.wallet<b.wallet?-1:a.wallet>b.wallet?1:0));
 const occupations=rankings.slice(0,P.divineSites).map((r,i)=>({site:`divine-individual-${String(i+1).padStart(3,'0')}`,wallet:r.wallet}));
 const balances=new Map<string,Record<OrdinaryRefinedId,bigint>>(),get=(w:string)=>{let b=balances.get(w);if(!b){b=Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,0n])) as Record<OrdinaryRefinedId,bigint>;balances.set(w,b);}return b;};
 const refund=get(sponsor);for(const item of ORDINARY_REFINED_IDS){let remaining=BigInt(budget[item]);if(occupations.length){const share=remaining/BigInt(occupations.length);for(const o of occupations){get(o.wallet)[item]+=share;remaining-=share;}}refund[item]+=remaining;}
 const entitlements=[...balances].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([wallet,amounts])=>({wallet,amounts:Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,amounts[i].toString()])) as DivineTrialAmounts}));
 return {rankings,occupations,entitlements};
}
