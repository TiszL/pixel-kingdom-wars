import {describe,it,expect} from 'vitest';
import {tournamentSchedule,tournamentSettlement,CharterTournamentBudgetSchema} from './charterTournament';
import {ORDINARY_REFINED_IDS} from './phaseEOrdinaryCrafting';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const budget=(n:string)=>Object.fromEntries(ORDINARY_REFINED_IDS.map(i=>[i,n]));
describe('D181 fixed funded tournament rights',()=>{
 it('fixes UTC boundaries including month rollover and refuses shifted entry',()=>{
  expect(tournamentSchedule('2026-10-31T00:00:00.000Z')).toEqual({entryStartsAt:'2026-10-31T00:00:00.000Z',playStartsAt:'2026-11-01T00:00:00.000Z',playEndsAt:'2026-11-02T00:00:00.000Z',occupationEndsAt:'2026-11-09T00:00:00.000Z'});
  expect(()=>tournamentSchedule('2026-10-30T00:00:00.000Z')).toThrow();
  expect(()=>tournamentSchedule('2026-10-31T00:00:01.000Z')).toThrow();
 });
 it('only accepts finite original refined stock, excluding gems and navigation kits',()=>{
  expect(CharterTournamentBudgetSchema.parse(budget('9223372036854775807'))).toEqual(budget('9223372036854775807'));
  for(const invalid of [budget('0'),budget('9223372036854775808'),budget('01'),{...budget('1'),gems:'1'},{...budget('1'),navigation_kit:'1'}])expect(()=>CharterTournamentBudgetSchema.parse(invalid)).toThrow();
 });
 it('compares per frozen member with integer cross products then UUID lexical order',()=>{
  const entries=[{clanId:id(3),roster:['c','d']},{clanId:id(2),roster:['b']},{clanId:id(1),roster:['a']}];
  const scores=[{clanId:id(3),stars:6,destruction:150,completedRaids:2},{clanId:id(2),stars:3,destruction:75,completedRaids:1},{clanId:id(1),stars:3,destruction:75,completedRaids:1}];
  expect(tournamentSettlement(entries,scores,budget('10'),'sponsor').rankings.map(r=>r.clanId)).toEqual([id(1),id(2),id(3)]);
 });
 it('fixes original wallet entitlements and refunds both division remainders',()=>{
  const result=tournamentSettlement([{clanId:id(1),roster:['a','b']},{clanId:id(2),roster:['c','d','e']}],[{clanId:id(1),stars:1,destruction:1,completedRaids:1},{clanId:id(2),stars:1,destruction:1,completedRaids:1}],budget('11'),'sponsor');
  expect(result.entitlements.map(e=>[e.wallet,e.amounts.frostglass])).toEqual([['a','2'],['b','2'],['c','1'],['d','1'],['e','1'],['sponsor','4']]);
  for(const item of ORDINARY_REFINED_IDS)expect(result.entitlements.reduce((n,e)=>n+BigInt(e.amounts[item]),0n)).toBe(11n);
 });
 it('does not manufacture winners from entry alone and returns the entire unused budget',()=>{
  const result=tournamentSettlement([{clanId:id(1),roster:['a']}],[],budget('13'),'sponsor');
  expect(result.rankings).toEqual([]);expect(result.occupations).toEqual([]);expect(result.entitlements).toEqual([{wallet:'sponsor',amounts:budget('13')}]);
 });
 it('only first fifty qualified clans occupy a fixed numbered site; zero-star completed play still qualifies',()=>{
  const entries=Array.from({length:51},(_,i)=>({clanId:id(i+1),roster:[`w${i}`]}));
  const result=tournamentSettlement(entries,entries.map(e=>({clanId:e.clanId,stars:0,destruction:0,completedRaids:1})),budget('101'),'sponsor');
  expect(result.rankings).toHaveLength(51);expect(result.occupations).toHaveLength(50);expect(result.occupations.at(-1)).toEqual({site:50,clanId:id(50)});expect(result.entitlements.find(e=>e.wallet==='w50')).toBeUndefined();
 });
 it('rejects duplicate frozen membership and scores without a corresponding entry',()=>{
  expect(()=>tournamentSettlement([{clanId:id(1),roster:['a']},{clanId:id(2),roster:['a']}],[],budget('1'),'sponsor')).toThrow();
  expect(()=>tournamentSettlement([], [{clanId:id(1),stars:1,destruction:1,completedRaids:1}],budget('1'),'sponsor')).toThrow();
 });
});
