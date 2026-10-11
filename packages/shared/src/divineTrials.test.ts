import {expect,it} from 'vitest';
import {divineTrialCanonicalJson,divineTrialSchedule,divineTrialSettlement,DIVINE_TRIAL_POLICY} from './divineTrials';
import {ORDINARY_REFINED_IDS} from './phaseEOrdinaryCrafting';
const a='11111111111111111111111111111112',b='11111111111111111111111111111113';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const budget=(n:string)=>Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,n]));
it('ranks real qualifying best attempts with ASCII ties and earliest ordinal, not abandoned/zero-star attempts',()=>{
 const score={wallet:a,attemptId:id(1),ordinal:1,stars:2,destruction:80};
 const s=divineTrialSettlement([score,{...score,attemptId:id(2),ordinal:2},{...score,wallet:b,attemptId:id(3),ordinal:1}],budget('9'),a);
 expect(s.rankings.map(r=>[r.wallet,r.ordinal])).toEqual([[a,1],[b,1]]);
 expect(s.occupations).toEqual([{site:'divine-individual-001',wallet:a},{site:'divine-individual-002',wallet:b}]);
 expect(s.entitlements).toEqual([{wallet:a,amounts:budget('5')},{wallet:b,amounts:budget('4')}]);
 expect(divineTrialSettlement([{...score,stars:0}],budget('9'),a).occupations).toEqual([]);
 expect(()=>divineTrialSettlement([score,score],budget('9'),a)).toThrow();
});
it('vacancies return all actual funded stock; caps occupations but retains private rankings',()=>{
 expect(divineTrialSettlement([],budget('7'),a).entitlements).toEqual([{wallet:a,amounts:budget('7')}]);
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 const scores=Array.from({length:501},(_,i)=>({wallet:'111111111111111111111111111111'+alphabet[Math.floor(i/58)]!+alphabet[i%58]!,attemptId:id(i+1),ordinal:1,stars:1,destruction:50}));
 const s=divineTrialSettlement(scores,budget('1001'),a);expect(s.rankings).toHaveLength(501);expect(s.occupations).toHaveLength(500);
 for(const item of ORDINARY_REFINED_IDS)expect(s.entitlements.reduce((n,r)=>n+BigInt(r.amounts[item]),0n)).toBe(1001n);
});
it('freezes canonical week and explicit fragments hold; bounds canonical commitments',()=>{
 expect(divineTrialSchedule('2035-01-06T00:00:00.000Z')).toEqual({entryStartsAt:'2035-01-06T00:00:00.000Z',playStartsAt:'2035-01-07T00:00:00.000Z',playEndsAt:'2035-01-08T00:00:00.000Z',occupationEndsAt:'2035-01-15T00:00:00.000Z'});
 expect(()=>divineTrialSchedule('2035-01-07T00:00:00.000Z')).toThrow();expect(DIVINE_TRIAL_POLICY.fragments).toBe('held');
 expect(divineTrialCanonicalJson({b:[2,1],a:0})).toBe('{"a":0,"b":[2,1]}');
 expect(()=>divineTrialCanonicalJson({x:NaN})).toThrow();expect(()=>divineTrialCanonicalJson({get x(){throw Error('accessor');}})).toThrow();
});
