import {describe,expect,it} from 'vitest';
import {PaidStarterExpeditionQuerySchema as Query,PaidStarterExpeditionViewSchema as View} from './paidStarterExpeditionApi';
import {paidStarterRoutePreview} from './paidStarterExpeditions';
const baseId='123e4567-e89b-42d3-a456-426614174000',serverNow='2035-01-01T00:00:00.000Z';
const view=()=>({wallet:'11111111111111111111111111111112',baseId,realm:0,serverNow,authorization:'none',acceptingDepartures:true,route:paidStarterRoutePreview('paid_frostveil'),coverage:{status:'covered',expiresAt:String(Date.parse(serverNow)/1000+60),observedAt:serverNow}});
describe('selected paid route view',()=>{
 it('requires an exact explicit canonical base and realm selector',()=>{
  expect(Query.parse({baseId,realm:'0'})).toEqual({baseId,realm:0});
  for(const q of [{realm:'0'},{baseId,realm:'00'},{baseId,realm:0},{baseId,realm:'8'},{baseId,realm:['0','1']},{baseId,realm:'0',wallet:'x'}])expect(Query.safeParse(q).success).toBe(false);
 });
 it('binds destination, time and nonauthorization and refuses injected capabilities',()=>{
  expect(View.parse(view())).toEqual(view());
  for(const v of [{...view(),realm:1},{...view(),authorization:'departure'},{...view(),observation:{}},{...view(),coverage:{...view().coverage,proof:{}}},{...view(),coverage:{...view().coverage,expiresAt:String(Date.parse(serverNow)/1000)}}])expect(View.safeParse(v).success).toBe(false);
 });
 it('never turns unavailable or inactive observations into a proof or raw historical access',()=>{
  for(const coverage of [{status:'unavailable'},{status:'blocked',reason:'NO_COVERAGE'},{status:'blocked',reason:'EXPIRED'}])expect(View.safeParse({...view(),coverage}).success).toBe(true);
  for(const coverage of [{status:'unavailable',expiresAt:'9999999999'},{status:'blocked',reason:'SOURCE'},{status:'covered',expiresAt:'9999999999',observedAt:'2036-01-01T00:00:00.000Z'}])expect(View.safeParse({...view(),coverage}).success).toBe(false);
 });
 it('bounds hostile timestamps and decimal inputs before BigInt or Date operations',()=>{
  for(const serverNow of ['bad','9'.repeat(100000),'9999-99-99T99:99:99.999Z'])expect(View.safeParse({...view(),serverNow}).success).toBe(false);
  for(const expiresAt of ['01','bad','9'.repeat(100000),'9223372036854775808'])expect(View.safeParse({...view(),coverage:{...view().coverage,expiresAt}}).success).toBe(false);
 });
});
