import {describe,expect,it} from 'vitest';
import vector from '../../../../../../packages/shared/testFixtures/ordinaryEquipment.json';
import lens from '../../../../../../packages/shared/testFixtures/surveyLens.json';
import {applyEquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {OrdinaryEquipmentViewV2Schema} from '@shardkeep/shared/ordinaryEquipmentApi';
import {StarterExpeditionViewSchema} from '@shardkeep/shared/starterExpeditionApi';
import {EMPTY,type CompassState} from '../../../lib/routeCompass/controller';
import {parseCompassCommand} from '../../../lib/routeCompass/journal';
import {compassSnapshot,compassCraftModel,compassCraftCommand,compassStarterCommand,compassOperationStage} from './compassAdapter';
const equipment=()=>OrdinaryEquipmentViewV2Schema.parse(lens.view);
const state=():CompassState=>({...EMPTY,loaded:true,equipment:equipment(),starter:StarterExpeditionViewSchema.parse(vector.starterView)});
const current=(s=state())=>compassSnapshot(s,vector.view.wallet,vector.request.baseId,null);
describe('Compass original snapshot boundary — authored, unrun',()=>{
  it('keeps equipment stock scoped to the exact wallet and kingdom',()=>{
    expect(current().equipment).not.toBeNull();expect(current({...state(),equipment:{...equipment(),wallet:'other'}}).equipment).toBeNull();expect(current({...state(),equipment:{...equipment(),baseId:'other'}}).equipment).toBeNull();
  });
  it('hides starter previews from an earlier fitting selection',()=>{
    expect(current({...state(),fitting:{itemId:'survey_lens',policyVersion:1,resourceId:'frost_quartz'}}).starter).toBeNull();
  });
  it('unknown stock remains unknown and blocks craft review',()=>{
    const e=equipment();e.craftingStock=[];const model=compassCraftModel(e,e.recipes[0]!);
    expect(model.canCraft).toBe(false);expect(model.inputs.every(i=>i.have===null)).toBe(true);
  });
  it('server pause and a pending job block another craft without altering the quote',()=>{
    const e=equipment();expect(compassCraftModel({...e,acceptingJobs:false},e.recipes[0]!).canCraft).toBe(false);
    const q=e.recipes[0]!;expect(compassCraftModel({...e,pendingJobs:[{jobId:'job',recipe:q,startedAt:e.serverNow,readyAt:e.serverNow}]},q).canCraft).toBe(false);
  });
  it('craft review retains the original recipe version, quantity and inputs',()=>{
    const e=equipment(),q=e.recipes[0]!,c=compassCraftCommand(e,q.recipeId,vector.request.idempotencyKey);
    expect(c).toEqual(parseCompassCommand({kind:'craft',request:{...vector.request,baseId:e.baseId,recipeId:q.recipeId,recipeVersion:q.recipeVersion,quantity:q.quantity},quote:q}));
  });
  it('a missing recipe does not synthesize a command',()=>{expect(compassCraftCommand(equipment(),'missing','key')).toBeNull();});
  it('a fitted departure preserves the selected installation and immutable route versions',()=>{
    const s=state(),route=s.starter!.routes[0]!;const c=compassStarterCommand(s.starter!,route,s.fitting,vector.request.idempotencyKey);
    expect(c?.request).toMatchObject({baseId:s.starter!.baseId,installationId:s.starter!.installation!.installationId,routeId:route.routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion,fitting:s.fitting});expect(c?.quote).toBe(route);
  });
  it('a missing starter installation cannot produce a departure command',()=>{
    const s=state();expect(compassStarterCommand({...s.starter!,installation:null},s.starter!.routes[0]!,s.fitting,'key')).toBeNull();
  });
  it('saved ambiguity and unattempted drafts keep distinct states',()=>{
    const command=parseCompassCommand({kind:'craft',request:vector.request,quote:vector.view.recipes[0]});
    expect(compassOperationStage({command,attemptRevision:null,proof:null,refusal:null})).toBe('DRAFT');expect(compassOperationStage({command,attemptRevision:1,proof:null,refusal:null})).toBe('CHECKING');
  });
});

it('paid, fleet and routes discard a foreign wallet or kingdom; paid also pins the selected realm',()=>{
  const s=state(),route=applyEquipmentFitting(paidStarterRoutePreview('paid_frostveil'),s.fitting);
  s.paid={wallet:vector.view.wallet,baseId:vector.view.baseId,realm:0,serverNow:vector.view.serverNow,authorization:'none',acceptingDepartures:true,route,coverage:{status:'unavailable'}};
  s.fleet={version:1,wallet:vector.view.wallet,baseId:vector.view.baseId,serverNow:vector.view.serverNow,acceptingNewActions:true,vehicles:[]};
  s.routes={version:1,wallet:vector.view.wallet,baseId:vector.view.baseId,items:[]};
  const read=(input:CompassState,realm=0)=>compassSnapshot(input,vector.view.wallet,vector.view.baseId,realm);
  expect(read(s).paid).toBe(s.paid);expect(read(s).fleet).toBe(s.fleet);expect(read(s).routes).toBe(s.routes);expect(read(s,1).paid).toBeNull();
  for(const key of ['paid','fleet','routes'] as const){for(const field of ['wallet','baseId'] as const){expect(read({...s,[key]:{...s[key],[field]:'foreign'}})[key]).toBeNull();}}
});
