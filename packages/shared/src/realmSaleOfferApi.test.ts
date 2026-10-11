import {describe,it,expect} from 'vitest';
import {PHASE_E_POLICY} from './constants';
import {RealmSaleOfferQuerySchema,RealmSaleCoverageQuerySchema,RealmSaleOfferSchema,RealmSaleCoverageSchema,REALM_SALE_REALMS} from './realmSaleOfferApi';
const wallet='11111111111111111111111111111112';
describe('read-only selected realm sale contracts',()=>{
 it('pins the accepted chain index to realm identity and player-facing name',()=>{
  expect(REALM_SALE_REALMS).toEqual([
   {index:0,id:'frostveil',name:'Frostveil'},{index:1,id:'elderwood',name:'Elderwood'},{index:2,id:'sunscar',name:'Sunscar'},{index:3,id:'crownlands',name:'Crownlands'},
   {index:4,id:'seeker-reach',name:'Solana Reach'},{index:5,id:'stormcairn',name:'Stormcairn'},{index:6,id:'thornwake',name:'Thornwake'},{index:7,id:'cinderfall',name:'Cinderfall'},
  ]);expect(REALM_SALE_REALMS).toHaveLength(PHASE_E_POLICY.seekerIsland.realmCount);
 });
 it('accepts only canonical bounded selection, never caller authority',()=>{
  expect(RealmSaleOfferQuerySchema.parse({spot:'0',realm:'0'})).toEqual({spot:0,realm:0});
  for(const patch of [{spot:'00'},{spot:'1e1'},{spot:'-1'},{spot:String(PHASE_E_POLICY.seekerIsland.totalSpots)},{realm:String(PHASE_E_POLICY.seekerIsland.realmCount)},{wallet},{trust:{}}])expect(RealmSaleOfferQuerySchema.safeParse({spot:'0',realm:'0',...patch}).success).toBe(false);
  expect(RealmSaleCoverageQuerySchema.safeParse({realm:'0',spot:'0'}).success).toBe(false);
 });
 it('requires unavailable and blocked responses to contain no invented offer',()=>{
  const value={version:1,wallet,spot:0,realm:0,status:'unavailable',reason:'SOURCE_UNAVAILABLE',offer:null,authorization:'none'};
  expect(RealmSaleOfferSchema.safeParse(value).success).toBe(true);
  for(const patch of [{authorization:'payment'},{status:'available'},{offer:{}},{reason:'INSUFFICIENT_SOL'},{wallet:'x'.repeat(100000)}])expect(RealmSaleOfferSchema.safeParse({...value,...patch}).success).toBe(false);
 });
 it('distinguishes unobserved coverage from observed absence and rejects fabricated expiry',()=>{
  const value={version:1,wallet,realm:0,status:'unavailable',coverage:null,authorization:'none'};
  expect(RealmSaleCoverageSchema.safeParse(value).success).toBe(true);
  expect(RealmSaleCoverageSchema.safeParse({...value,status:'observed'}).success).toBe(false);
 });
});
