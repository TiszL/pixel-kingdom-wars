import {describe,expect,it} from 'vitest';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {applyEquipmentFitting,type EquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {PaidStarterCommandRouteSchema} from './command';
import {parseStarterExpeditionCommand,matchStarterExpeditionProof} from '../starterExpedition/journal';
import {id,identity,installation} from '../starterExpedition/fixtures.test-support';
import observation from './access.fixture.json';

const preview=()=>paidStarterRoutePreview('paid_frostveil');
describe('original paid route review grammar',()=>{
 it('keeps omitted optional equipment fields omitted across the durable JSON round trip',()=>{
  const original=preview(),parsed=PaidStarterCommandRouteSchema.parse(original);
  expect(parsed).toEqual(original);expect(Object.hasOwn(parsed,'fitting')).toBe(false);expect(Object.hasOwn(parsed,'secondaryOutput')).toBe(false);
  expect(PaidStarterCommandRouteSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(original);
 });
 it('preserves historical quantities and duration without applying current route tuning',()=>{
  const original={...preview(),durationSec:123,grossQuantity:'103',netQuantity:'98',islandPoolQuantity:'5'};
  expect(PaidStarterCommandRouteSchema.parse(original)).toEqual(original);
 });
 it.each(Object.keys(preview()))('still requires the original %s field',key=>{
  const original:Record<string,unknown>={...preview()};delete original[key];
  expect(()=>PaidStarterCommandRouteSchema.parse(original)).toThrow('Invalid original paid route review fields.');
 });
 it.each([
  {itemId:'route_compass',policyVersion:1},
  {itemId:'survey_lens',policyVersion:1,resourceId:'heartwood_logs'},
 ] satisfies EquipmentFitting[])('retains the complete $itemId review snapshot and rejects unknown equipment fields',fitting=>{
  const original=applyEquipmentFitting(preview(),fitting);
  expect(PaidStarterCommandRouteSchema.parse(original)).toEqual(original);
  expect(()=>PaidStarterCommandRouteSchema.parse({...original,fitting:{...original.fitting,extra:true}})).toThrow();
 });
 it.each([
  {itemId:'route_compass',policyVersion:1},
  {itemId:'survey_lens',policyVersion:1,resourceId:'heartwood_logs'},
 ] satisfies EquipmentFitting[])('binds accepted $itemId proofs to all original equipment terms after restart',fitting=>{
  const route=applyEquipmentFitting(preview(),fitting),at=observation.finality.observedAt,installed={...installation(),installedAt:at,berthCompletedAt:at};
  const command=parseStarterExpeditionCommand({request:{idempotencyKey:id(2),baseId:installed.baseId,installationId:installed.installationId,
   routeId:route.routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion,fitting},route,installation:installed});
  const reopened=parseStarterExpeditionCommand(JSON.parse(JSON.stringify(command)));
  const proof={wallet:observation.wallet,idempotencyKey:id(2),serverNow:at,status:'accepted',return:null,
   receipt:{wallet:observation.wallet,request:command.request,expeditionId:id(2),installationId:installed.installationId,
    route:{...route,access:{...route.access,observation}},departedAt:at,returnsAt:new Date(Date.parse(at)+route.durationSec*1000).toISOString(),termId:id(6),termHash:'ab'.repeat(32)}};
  expect(matchStarterExpeditionProof(proof,{...identity,wallet:observation.wallet},reopened).status).toBe('accepted');
  const different=applyEquipmentFitting({...preview(),grossQuantity:'100',netQuantity:'80',islandPoolQuantity:'20'},fitting);
  expect(()=>matchStarterExpeditionProof({...proof,receipt:{...proof.receipt,route:{...different,access:{...different.access,observation}}}},
   {...identity,wallet:observation.wallet},reopened)).toThrow('accepted route differs');
 });
 it('rejects unknown top-level fields, supplied invalid optional fields and forged access evidence',()=>{
  for(const extra of [{extra:true},{fitting:null},{secondaryOutput:null},{access:{...preview().access,observation:{}}}])
   expect(()=>PaidStarterCommandRouteSchema.parse({...preview(),...extra})).toThrow();
 });
 it('retains destination and quantity conservation checks independently of optional fields',()=>{
  for(const extra of [{realmId:'cinderfall'},{resourceId:'heartwood_logs'},{grossQuantity:'103'}])
   expect(()=>PaidStarterCommandRouteSchema.parse({...preview(),...extra})).toThrow();
 });
});
