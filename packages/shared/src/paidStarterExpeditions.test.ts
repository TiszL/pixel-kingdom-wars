/** DTO consistency fixtures only; finalized source authority is tested in API. */
import {describe,expect,it} from 'vitest';
import {REALM_IDS} from './baseVisual';
import {PHASE_E_PAID_STARTER_ROUTES as P,PHASE_E_STARTER_ROUTES as C} from './constants';
import {StarterRouteIdSchema,starterRoutePreview} from './phaseEExpeditions';
import {PHASE_E_RAW_RESOURCE_IDS} from './phaseEResources';
import {ExpeditionRealmAccessObservationSchema,PaidStarterRouteIdSchema,PaidStarterRoutePreviewSchema,PaidStarterExpeditionRouteSnapshotSchema,paidStarterRoutePreview,paidStarterRouteAtDeparture} from './paidStarterExpeditions';
import {StarterExpeditionRouteSnapshotSchema,StarterExpeditionEnvelopeSchema,StarterExpeditionViewSchema} from './starterExpeditionApi';
const key=(last:string)=>'1'.repeat(31)+last,id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const wallet=key('2'),program=key('3'),config=key('4'),access=key('5'),programData=key('6');
const loader='BPFLoaderUpgradeab1e11111111111111111111111',sysvar='Sysvar1111111111111111111111111111111111111',clock='SysvarC1ock11111111111111111111111111111111';
const at='2035-01-01T00:00:00.000Z',second=BigInt(Date.parse(at)/1000);
function observation(){return {version:1 as const,wallet,realm:0,accessAddress:access,configAddress:config,expiresAt:String(second+1n),
 finality:{commitment:'finalized' as const,contextSlot:'150',observedAt:at,chainUnixTimestamp:String(second)},
 source:{trust:'trusted-finalized-rpc-reviewed-program' as const,stateProvenance:'fresh-reviewed-deployment' as const,genesisHash:key('7'),programId:program,reviewedDeploymentSlot:90,reviewedProgramDataSha256:'ab'.repeat(32),upgradeAuthority:key('8'),
  accounts:[program,programData,config,access,clock].map((address,i)=>({address,exists:true as const,owner:i<2?loader:i===4?sysvar:program,executable:i===0,dataSha256:'ab'.repeat(32)}))}};}
function route(){const preview=paidStarterRoutePreview('paid_frostveil');return {...preview,access:{...preview.access,observation:observation()}};}
function envelope(){const r=route(),request={idempotencyKey:id(1),baseId:id(2),installationId:id(3),routeId:r.routeId,routeVersion:r.routeCatalogueVersion,rewardVersion:r.rewardTableVersion};
 return {wallet,idempotencyKey:id(1),serverNow:at,status:'accepted' as const,receipt:{wallet,request,expeditionId:id(1),installationId:id(3),route:r,departedAt:at,returnsAt:new Date(Date.parse(at)+r.durationSec*1000).toISOString(),termId:id(4),termHash:'ab'.repeat(32)},return:null};}
describe('paid starter routes are distinct from common previews and historical admission',()=>{
 it('pins all eight explicit destinations and reuses the existing coastal economics',()=>{
  expect(P.routeCatalogueVersion).toBe(3);expect(P.rewardTableVersion).toBe(C.rewardTableVersion);expect(P.durationSec).toBe(C.routes.coastal_survey.durationSec);expect(P.grossRaw).toBe(C.routes.coastal_survey.grossRaw);
  expect(PaidStarterRouteIdSchema.options).toEqual(['paid_frostveil','paid_elderwood','paid_sunscar','paid_crownlands','paid_seeker_reach','paid_stormcairn','paid_thornwake','paid_cinderfall']);
  for(const [index,routeId] of PaidStarterRouteIdSchema.options.entries()){
   const r=paidStarterRoutePreview(routeId),coastal=starterRoutePreview(REALM_IDS[index]!,'coastal_survey');expect(PaidStarterRoutePreviewSchema.parse(r)).toEqual(r);
   expect(r).toMatchObject({realmId:REALM_IDS[index],resourceId:coastal.resourceId,durationSec:coastal.durationSec,grossQuantity:coastal.grossQuantity,netQuantity:coastal.netQuantity,islandPoolQuantity:coastal.islandPoolQuantity,access:{kind:'paid_realm',policyVersion:1}});
   expect(r.access).not.toHaveProperty('observation');expect(StarterRouteIdSchema.safeParse(routeId).success).toBe(false);
  }expect(StarterRouteIdSchema.options).toHaveLength(11);
 });
 it('strictly separates current previews from paid history and rejects altered current costs',()=>{
  const p=paidStarterRoutePreview('paid_frostveil');expect(PaidStarterExpeditionRouteSnapshotSchema.safeParse(p).success).toBe(false);
  for(const patch of [{realmId:'elderwood'},{durationSec:p.durationSec+1},{grossQuantity:'999'},{access:{...p.access,observation:observation()}},{rewardTableVersion:99}])expect(PaidStarterRoutePreviewSchema.safeParse({...p,...patch}).success).toBe(false);
  expect(()=>paidStarterRoutePreview('unknown' as never)).toThrow();
 });
 it('accepts authentic-shaped historical proof without re-reading today\'s reward table',()=>{
  const r=route();expect(StarterExpeditionRouteSnapshotSchema.parse(r)).toEqual(r);expect(ExpeditionRealmAccessObservationSchema.parse(r.access.observation)).toEqual(r.access.observation);
  const changed={...r,grossQuantity:'103',netQuantity:'98',islandPoolQuantity:'5'};expect(StarterExpeditionRouteSnapshotSchema.parse(changed)).toEqual(changed);
 });
 it('never treats stripped paid history as HOME and binds the destination to its indexed observation',()=>{
  const r=route(),{access:_,...stripped}=r;
  expect(paidStarterRouteAtDeparture(stripped,at,wallet)).toBe(false);
  for(const value of [stripped,{...r,access:null},{...r,access:{kind:'paid_realm',policyVersion:1}},{...r,access:{...r.access,policyVersion:2}},
   {...r,routeCatalogueVersion:2},{...r,rewardTableVersion:3},{...r,resourceId:'heartwood_logs'},
   {...r,access:{...r.access,observation:{...observation(),realm:1}}}])expect(StarterExpeditionRouteSnapshotSchema.safeParse(value).success).toBe(false);
  for(const grossQuantity of ['bad','01','1'.repeat(100000)]){
   expect(PaidStarterExpeditionRouteSnapshotSchema.safeParse({...r,grossQuantity}).success).toBe(false);
   expect(StarterExpeditionRouteSnapshotSchema.safeParse({...r,grossQuantity}).success).toBe(false);
  }
 });
 it('binds original receipt wallet and exclusive departure expiry but never checks return or recovery time',()=>{
  const e=envelope();expect(StarterExpeditionEnvelopeSchema.parse(e)).toEqual(e);expect(paidStarterRouteAtDeparture(e.receipt.route,at,wallet)).toBe(true);
  for(const o of [{...observation(),wallet:key('9')},{...observation(),expiresAt:String(second)},{...observation(),finality:{...observation().finality,observedAt:new Date(Date.parse(at)+1).toISOString()}},{...observation(),finality:{...observation().finality,chainUnixTimestamp:String(second+1n)}}]){
   const route={...e.receipt.route,access:{...e.receipt.route.access,observation:o}};expect(StarterExpeditionEnvelopeSchema.safeParse({...e,receipt:{...e.receipt,route}}).success).toBe(false);expect(paidStarterRouteAtDeparture(route,at,wallet)).toBe(false);
  }
  const late={...e,serverNow:'2036-01-01T00:00:00.000Z',return:{returnId:id(5),returnedAt:'2036-01-01T00:00:00.000Z'}};expect(StarterExpeditionEnvelopeSchema.parse(late)).toEqual(late);
 });
 it('bounds source arrays before traversing elements and rejects malformed scalars or unknown authority',()=>{
  const o=observation(),badChild=Object.defineProperty({},'address',{get(){throw Error('Oversized array must not visit its children');}});
  expect(()=>ExpeditionRealmAccessObservationSchema.safeParse({...o,source:{...o.source,accounts:Array(10000).fill(badChild)}})).not.toThrow();
  for(const patch of [{wallet:'1'.repeat(100000)},{realm:'0'},{realm:8},{expiresAt:'01'},{expiresAt:'9223372036854775808'},{paymentAuthorized:true},
   {finality:{...o.finality,contextSlot:'18446744073709551616'}},{finality:{...o.finality,contextSlot:'89'}},{source:{...o.source,reviewedDeploymentSlot:Number.MAX_SAFE_INTEGER+1}}])expect(ExpeditionRealmAccessObservationSchema.safeParse({...o,...patch}).success).toBe(false);
 });
 it('pins five initialized account roles and declared deployment/config/access identities',()=>{
  const o=observation();for(const [index,patch] of [[0,{executable:false}],[1,{dataSha256:'cd'.repeat(32)}],[2,{address:key('9')}],[3,{exists:false}],[4,{owner:program}]] as const){
   const accounts=o.source.accounts.map((r,i)=>i===index?{...r,...patch}:r);expect(ExpeditionRealmAccessObservationSchema.safeParse({...o,source:{...o.source,accounts}}).success).toBe(false);
  }
  for(const accounts of [o.source.accounts.slice(1),[...o.source.accounts].reverse(),[...o.source.accounts,o.source.accounts[0]!]])expect(ExpeditionRealmAccessObservationSchema.safeParse({...o,source:{...o.source,accounts}}).success).toBe(false);
 });
 it('preserves the original buyer in a transferred-base flight while exposing only eleven current previews',()=>{
  const e=envelope(),{wallet:_,request:__,...flight}=e.receipt;
  const view={wallet:key('9'),baseId:id(2),serverNow:at,features:{starterExpeditions:{version:1,receipts:1}},acceptingDepartures:false,home:{source:'free_assignment',version:1,realmId:'crownlands'},
   routes:StarterRouteIdSchema.options.map(id=>starterRoutePreview('crownlands',id)),installation:{installationId:id(3),baseId:id(2),berthId:id(6),family:'starter',completedBuildJobId:id(7),berthCompletedAt:at,installedAt:at},flight,lodgeCompletedAt:at,
   rawStock:PHASE_E_RAW_RESOURCE_IDS.map(resourceId=>({resourceId,available:'0',reserved:'0',total:'0'}))};
  expect(StarterExpeditionViewSchema.parse(view)).toEqual(view);expect(StarterExpeditionViewSchema.safeParse({...view,routes:[...view.routes,paidStarterRoutePreview('paid_frostveil')]}).success).toBe(false);
 });
});
