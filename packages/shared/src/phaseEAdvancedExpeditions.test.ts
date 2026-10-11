import {describe,expect,it} from 'vitest';
import {PHASE_E_ADVANCED_EXPEDITIONS as C,PHASE_E_PAID_STARTER_ROUTES,PHASE_E_STARTER_ROUTES,PHASE_E_VEHICLES} from './constants';
import {REALM_IDS} from './baseVisual';
import {PHASE_E_RAW_RESOURCES} from './phaseEResources';
import {PHASE_E_VEHICLE_FAMILY_IDS} from './phaseEVehicles';
import {StarterCommonRouteIdSchema,starterRoutePreview} from './phaseEExpeditions';
import {PaidStarterRouteIdSchema,paidStarterRoutePreview} from './paidStarterExpeditions';
import {advancedExpeditionPreview,AdvancedExpeditionSnapshotSchema,AdvancedExpeditionPreviewSchema,
  AdvancedExpeditionSelectionSchema,type AdvancedExpeditionSelection} from './phaseEAdvancedExpeditions';

const homeRealmId='crownlands' as const;
const profiles=[
  {family:'survey_balloon',minutes:[30,30,30,30],gross:[30,35,40,45],supplies:[{resourceId:'rough_prism',quantity:'1'}]},
  {family:'cargo_cutter',minutes:[30,30,30,30],gross:[40,45,50,55],supplies:[{resourceId:'heartwood_logs',quantity:'2'}]},
  {family:'courier_airship',minutes:[20,16,12,10],gross:[20,20,20,20],supplies:[{resourceId:'ember_nodules',quantity:'1'}]},
  {family:'expedition_barge',minutes:[120,120,120,120],gross:[120,135,150,165],supplies:[{resourceId:'crown_iron_ore',quantity:'1'},{resourceId:'heartwood_logs',quantity:'2'}]},
] as const;
const select=(family:AdvancedExpeditionSelection['family']='survey_balloon',tier:AdvancedExpeditionSelection['tier']=1):AdvancedExpeditionSelection=>
  ({family,tier,homeRealmId,routeId:'paid_frostveil'});

describe('D-153.133 advanced expedition economics without admission authority',()=>{
  for(const p of profiles)for(const tier of PHASE_E_VEHICLES.tiers)it(`${p.family} T${tier} freezes its exact primary profile and whole resource tax`,()=>{
    const value=advancedExpeditionPreview(select(p.family,tier)),gross=p.gross[tier-1]!;
    expect(value).toEqual({policyVersion:1,family:p.family,tier,homeRealmId,routeId:'paid_frostveil',realmId:'frostveil',resourceId:'frost_quartz',
      accessRequirement:'paid_realm',durationSec:p.minutes[tier-1]!*60,grossQuantity:String(gross),netQuantity:String(gross*4/5),islandPoolQuantity:String(gross/5),supplies:p.supplies});
    expect(AdvancedExpeditionSnapshotSchema.parse(value)).toEqual(value);
    expect(AdvancedExpeditionPreviewSchema.parse(value)).toEqual(value);
    expect(BigInt(value.netQuantity)+BigInt(value.islandPoolQuantity)).toBe(BigInt(value.grossQuantity));
  });
  it('uses the existing eight paid destinations without treating a preview as permit evidence',()=>{
    for(const routeId of PaidStarterRouteIdSchema.options)for(const family of PHASE_E_VEHICLE_FAMILY_IDS){
      const v=advancedExpeditionPreview({...select(family),routeId}),starter=paidStarterRoutePreview(routeId);
      expect(v.realmId).toBe(starter.realmId);expect(v.resourceId).toBe(starter.resourceId);expect(v.homeRealmId).toBe(homeRealmId);
      expect(v.accessRequirement).toBe('paid_realm');expect(v).not.toHaveProperty('observation');expect(v).not.toHaveProperty('termId');
      expect(AdvancedExpeditionSnapshotSchema.safeParse({...v,authorized:true}).success).toBe(false);
    }
  });
  it('enforces each family HOME matrix and keeps Balloon alternate HOME outputs unchanged',()=>{
    for(const realm of REALM_IDS)for(const family of PHASE_E_VEHICLE_FAMILY_IDS)for(const tier of PHASE_E_VEHICLES.tiers){
      const routeId=family==='expedition_barge'?'long_survey':'coastal_survey';
      const v=advancedExpeditionPreview({...select(family,tier),homeRealmId:realm,routeId});
      expect(v.realmId).toBe(realm);expect(PHASE_E_RAW_RESOURCES[v.resourceId].realmId).toBe(realm);expect(v.accessRequirement).toBe('home');
      if(family==='survey_balloon')for(const alternate of ['introduction','long_survey'] as const){
        const old=starterRoutePreview(realm,alternate),copy=advancedExpeditionPreview({...select(family,tier),homeRealmId:realm,routeId:alternate});
        expect([copy.durationSec,copy.grossQuantity,copy.netQuantity,copy.islandPoolQuantity]).toEqual([old.durationSec,old.grossQuantity,old.netQuantity,old.islandPoolQuantity]);
        expect(copy.supplies).toEqual(profiles[0].supplies);
      }
      for(const denied of family==='survey_balloon'?[]:family==='expedition_barge'?['introduction','coastal_survey']:['introduction','long_survey'])
        expect(()=>advancedExpeditionPreview({...select(family,tier),routeId:denied})).toThrow();
    }
  });
  it('retains every free common route exclusively for the starter',()=>{
    for(const routeId of StarterCommonRouteIdSchema.options)for(const family of PHASE_E_VEHICLE_FAMILY_IDS){
      expect(()=>advancedExpeditionPreview({...select(family),routeId})).toThrow();
      const common=starterRoutePreview(homeRealmId,routeId);expect(common.netQuantity).toBe('4');expect(common.durationSec).toBe(30*60);
    }
  });
  it('refuses supplied economics, authority, malformed identities and unsupported versions',()=>{
    for(const patch of [{family:'starter'},{family:'Survey Balloon'},{tier:0},{tier:5},{tier:1.5},{tier:'1'},
      {homeRealmId:'unknown'},{routeId:'new_island'},{routeId:'paid_frostveil\n'},{grossQuantity:'99'},{supplies:[]},{authorized:false}])
      expect(AdvancedExpeditionSelectionSchema.safeParse({...select(),...patch}).success).toBe(false);
    for(const version of [0,2,-1,1.5,NaN,Infinity,'1',null])expect(()=>advancedExpeditionPreview(select(),version as number)).toThrow();
  });
  it('rejects mutated original economics, unsorted or duplicate supplies and noncanonical amounts',()=>{
    const v=advancedExpeditionPreview(select('expedition_barge',4));
    for(const patch of [{policyVersion:2},{durationSec:0},{durationSec:v.durationSec+1},{grossQuantity:'170'},{netQuantity:'131'},
      {islandPoolQuantity:'0'},{resourceId:'rough_prism'},{realmId:'crownlands'},{accessRequirement:'home'},
      {supplies:[]},{supplies:[...v.supplies].reverse()},{supplies:[v.supplies[0],v.supplies[0]]},
      {supplies:[{...v.supplies[0],quantity:'2'},v.supplies[1]]},{supplies:[{...v.supplies[0],extra:true},v.supplies[1]]}])
      expect(AdvancedExpeditionSnapshotSchema.safeParse({...v,...patch}).success).toBe(false);
    for(const amount of ['01','0','-1','1.0','1\n','9223372036854775808','9'.repeat(1000),1,null]){
      expect(AdvancedExpeditionSnapshotSchema.safeParse({...v,grossQuantity:amount}).success).toBe(false);
      expect(AdvancedExpeditionSnapshotSchema.safeParse({...v,supplies:[{...v.supplies[0],quantity:amount},v.supplies[1]]}).success).toBe(false);
    }
  });
  it('returns detached immutable copies including supply entries',()=>{
    const input=select('expedition_barge'),first=advancedExpeditionPreview(input),second=advancedExpeditionPreview(input);
    expect(first).toEqual(second);expect(first).not.toBe(second);expect(first.supplies).not.toBe(second.supplies);
    expect(Object.isFrozen(first)).toBe(true);expect(Object.isFrozen(first.supplies)).toBe(true);expect(first.supplies.every(Object.isFrozen)).toBe(true);
    input.tier=4;expect(first.tier).toBe(1);expect(()=>{(first.supplies[0] as {quantity:string}).quantity='999';}).toThrow();
    expect(advancedExpeditionPreview(select('expedition_barge'))).toEqual(first);
  });
  it('keeps frozen v1 and omitted-version previews valid when the current pointer changes (D183 opt-in)',()=>{
    const original=advancedExpeditionPreview(select()),policy=C as unknown as {currentPolicyVersion:number},before=policy.currentPolicyVersion;
    try{policy.currentPolicyVersion=2;expect(AdvancedExpeditionSnapshotSchema.parse(original)).toEqual(original);
      expect(AdvancedExpeditionPreviewSchema.safeParse(original).success).toBe(true);expect(advancedExpeditionPreview(select(),1)).toEqual(original);
      expect(advancedExpeditionPreview(select())).toEqual(original);
    }finally{policy.currentPolicyVersion=before;}
  });
  it('does not reprice or revalidate historical v1 through current starter economics',()=>{
    const originals=[advancedExpeditionPreview(select()),advancedExpeditionPreview({...select(),routeId:'introduction'})];
    const paid=PHASE_E_PAID_STARTER_ROUTES as unknown as {grossRaw:number};
    const introduction=PHASE_E_STARTER_ROUTES.routes.introduction as unknown as {grossRaw:number};
    const beforePaid=paid.grossRaw,beforeIntroduction=introduction.grossRaw;
    try{paid.grossRaw++;introduction.grossRaw++;
      for(const original of originals)expect(AdvancedExpeditionSnapshotSchema.parse(original)).toEqual(original);
    }finally{paid.grossRaw=beforePaid;introduction.grossRaw=beforeIntroduction;}
  });
  it('bounds provision demand using the free starter and measures the full 100-use allowance',()=>{
    expect(C.v1.maxConcurrentPerBase).toBe(1);expect(PHASE_E_VEHICLES.completedUsesPerInstall).toBe(100);
    const totals=[];for(const p of profiles)for(const tier of PHASE_E_VEHICLES.tiers){
      const v=advancedExpeditionPreview(select(p.family,tier)),uses=BigInt(PHASE_E_VEHICLES.completedUsesPerInstall);
      const supplies=v.supplies.reduce((n,s)=>n+BigInt(s.quantity),0n),common=starterRoutePreview(homeRealmId,'common_frostveil');
      // A single concurrent free starter can sustainably earn all provisions,
      // even using only its slower foreign common routes (unit counts, not prices).
      expect(supplies*BigInt(common.durationSec)).toBeLessThanOrEqual(BigInt(common.netQuantity)*BigInt(v.durationSec));
      totals.push([p.family,tier,BigInt(v.netQuantity)*uses,BigInt(v.durationSec)*uses,supplies*uses]);
    }
    expect(totals.filter(v=>v[1]===4)).toEqual([
      ['survey_balloon',4,3600n,180000n,100n],['cargo_cutter',4,4400n,180000n,200n],
      ['courier_airship',4,1600n,60000n,100n],['expedition_barge',4,13200n,720000n,300n],
    ]);
    expect(PHASE_E_STARTER_ROUTES.routes).toEqual({introduction:{durationSec:300,grossRaw:5},coastal_survey:{durationSec:1800,grossRaw:25},long_survey:{durationSec:7200,grossRaw:80}});
  });
});
