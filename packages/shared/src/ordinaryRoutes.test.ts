import {expect,it} from 'vitest';
import {PHASE_E_ADVANCED_EXPEDITIONS as V1,PHASE_E_ORDINARY_ROUTES as C,PHASE_E_VEHICLES} from './constants';
import {ORDINARY_ROUTE_IDS,OrdinaryRouteIdSchema,ordinaryRoute} from './ordinaryRoutes';
import {advancedExpeditionPreview,AdvancedExpeditionSnapshotSchema} from './phaseEAdvancedExpeditions';
import {PHASE_E_VEHICLE_FAMILY_IDS} from './phaseEVehicles';
import {REALM_IDS} from './baseVisual';
import {AdvancedExpeditionRequestSchema} from './advancedExpeditionApi';
it('pins the 32 supplied art identities to exactly one destination for every realm and grade',()=>{
 expect(ORDINARY_ROUTE_IDS).toHaveLength(32);
 const groups={glasswake:'seeker-reach',aurora:'frostveil',emberwake:'cinderfall',whispering:'elderwood',mintwake:'crownlands',prismforge:'sunscar',lumenreef:'thornwake'};
 for(const [chain,realmId] of Object.entries(groups))for(let grade=1;grade<=4;grade++)expect(ordinaryRoute(`${chain}-${grade}`)).toEqual({chain,index:grade-1,realmId,grade});
 for(const [i,id] of ['aurora-5','emberwake-5','emberwake-6','whispering-5'].entries())expect(ordinaryRoute(id)).toMatchObject({realmId:'stormcairn',grade:i+1});
 for(const realm of REALM_IDS)expect(ORDINARY_ROUTE_IDS.map(ordinaryRoute).filter(r=>r.realmId===realm).map(r=>r.grade).sort()).toEqual([1,2,3,4]);
 for(const id of ['glasswake_1','glasswake-0','glasswake-01','emberwake-7','aurora-5\n'])expect(OrdinaryRouteIdSchema.safeParse(id).success).toBe(false);
 expect(Object.isFrozen(ordinaryRoute('aurora-5'))).toBe(true);
});
it('scales immutable family defaults, provisions and exact tax at every admitted tier without granting paid access',()=>{
 for(const routeId of ORDINARY_ROUTE_IDS)for(const family of PHASE_E_VEHICLE_FAMILY_IDS)for(const tier of PHASE_E_VEHICLES.tiers){
  const meta=ordinaryRoute(routeId),selection={routeId,family,tier,homeRealmId:'crownlands' as const};
  if(tier<meta.grade){expect(()=>advancedExpeditionPreview(selection,2)).toThrow(/tier/i);continue;}
  const p=advancedExpeditionPreview(selection,2),v1=advancedExpeditionPreview({...selection,routeId:'paid_frostveil'},1),factor=C.gradeFactors[meta.grade];
  expect(p.durationSec).toBe(v1.durationSec*factor);expect(BigInt(p.grossQuantity)).toBe(BigInt(v1.grossQuantity)*BigInt(factor));
  expect(p.supplies).toEqual(v1.supplies.map(s=>({...s,quantity:String(BigInt(s.quantity)*BigInt(factor))})));
  expect(BigInt(p.islandPoolQuantity)*BigInt(V1.v1.basisPoints)).toBe(BigInt(p.grossQuantity)*BigInt(V1.v1.islandPoolBps));
  expect(BigInt(p.netQuantity)+BigInt(p.islandPoolQuantity)).toBe(BigInt(p.grossQuantity));
  expect(p.accessRequirement).toBe(meta.realmId===selection.homeRealmId?'home':'paid_realm');expect(AdvancedExpeditionSnapshotSchema.parse(p)).toEqual(p);
  for(const homeRealmId of REALM_IDS)expect(advancedExpeditionPreview({...selection,homeRealmId},2).accessRequirement).toBe(homeRealmId===meta.realmId?'home':'paid_realm');
  expect(AdvancedExpeditionSnapshotSchema.safeParse({...p,policyVersion:1}).success).toBe(false);
  expect(AdvancedExpeditionSnapshotSchema.safeParse({...p,supplies:v1.supplies}).success).toBe(factor===1);
 }
});
it('requires explicit known version and keeps historical underscore routes while admitting exact hyphenated commands',()=>{
 const selection={family:'survey_balloon',tier:1,homeRealmId:'frostveil',routeId:'aurora-1'};
 for(const version of [undefined,0,1,3])expect(()=>advancedExpeditionPreview(selection,version)).toThrow();
 const request={idempotencyKey:'10000000-0000-4000-8000-000000000001',baseId:'10000000-0000-4000-8000-000000000002',installationId:'10000000-0000-4000-8000-000000000003',routeId:'aurora-1',policyVersion:2};
 expect(AdvancedExpeditionRequestSchema.parse(request)).toEqual(request);
 for(const routeId of ['aurora--1','aurora-','aurora-1?proof=yes'])expect(AdvancedExpeditionRequestSchema.safeParse({...request,routeId}).success).toBe(false);
 expect(AdvancedExpeditionRequestSchema.safeParse({...request,routeId:'coastal_survey',policyVersion:1}).success).toBe(true);
});
it('keeps the public native/API vectors reproducible, including all historical v1 routes and below-grade holds',async()=>{
 const {default:v}=await import('./testFixtures/ordinaryRouteVectors.json');
 expect(v.constants.ordinaryRoutes).toEqual(C);expect(v.constants.advanced).toEqual(V1);expect(v.constants.vehicles).toEqual(PHASE_E_VEHICLES);
 expect(v.v1).toHaveLength(152);expect(v.v2).toHaveLength(320);expect(v.tierHold).toHaveLength(192);
 for(const row of [...v.v1,...v.v2])expect(AdvancedExpeditionSnapshotSchema.parse(row)).toEqual(row);
 for(const selection of v.tierHold)expect(()=>advancedExpeditionPreview(selection,2)).toThrow(/tier/i);
});
