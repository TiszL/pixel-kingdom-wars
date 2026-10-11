import type {OrdinaryEquipmentViewV2} from '@shardkeep/shared/ordinaryEquipmentApi';
import type {StarterExpeditionView} from '@shardkeep/shared/starterExpeditionApi';
import type {PaidStarterExpeditionView} from '@shardkeep/shared/paidStarterExpeditionApi';
import {fittingSelection,type EquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import type {CompassState} from '../../../lib/routeCompass/controller';
import {same,terminal,type CompassCommand,type CompassOperation} from '../../../lib/routeCompass/journal';
export function compassSnapshot(state:CompassState,wallet:string|null,baseId:string|null,realm:number|null) {
  const scoped=<T extends {wallet:string;baseId:string}>(value:T|null):T|null=>value?.wallet===wallet&&value.baseId===baseId?value:null;
  const equipment=scoped(state.equipment),starter=scoped(state.starter),paid=scoped(state.paid),fleet=scoped(state.fleet),routes=scoped(state.routes);
  return {equipment,fleet,starter:starter&&same(starter.fitting,state.fitting)?starter:null,
    paid:paid&&paid.realm===realm&&same(fittingSelection(paid.route).fitting,state.fitting)?paid:null,
    routes:routes&&routes.items.every(item=>item.previews.every(preview=>same(fittingSelection(preview).fitting,state.fitting)))?routes:null};
}
export function compassCraftModel(view:OrdinaryEquipmentViewV2,recipe:OrdinaryEquipmentViewV2['recipes'][number]) {
  const inputs=recipe.inputs.map(input=>{const stock=view.craftingStock.find(item=>item.itemId===input.itemId);return {itemId:input.itemId,need:BigInt(input.quantity),have:stock?BigInt(stock.available):null};});
  const reason=!view.acceptingJobs?'New crafting is paused.':view.pendingJobs.length?'The equipment bench is busy.':inputs.some(input=>input.have===null||input.have<input.need)?'Refine the missing materials before crafting.':null;
  return {inputs,canCraft:reason===null,reason,stock:view.equipmentStock.find(item=>item.itemId===recipe.output.itemId)??null};
}
export function compassCraftCommand(view:OrdinaryEquipmentViewV2,recipeId:string,key:string):Extract<CompassCommand,{kind:'craft'}>|null {
  const quote=view.recipes.find(recipe=>recipe.recipeId===recipeId);if(!quote)return null;
  return {kind:'craft',request:{idempotencyKey:key,baseId:view.baseId,recipeId:quote.recipeId,recipeVersion:quote.recipeVersion,quantity:quote.quantity},quote};
}
export function compassStarterCommand(view:StarterExpeditionView,quote:StarterExpeditionView['routes'][number]|PaidStarterExpeditionView['route'],fitting:EquipmentFitting,key:string):Extract<CompassCommand,{kind:'starter'}>|null {
  if(!view.installation)return null;
  return {kind:'starter',request:{idempotencyKey:key,baseId:view.baseId,installationId:view.installation.installationId,routeId:quote.routeId,routeVersion:quote.routeCatalogueVersion,rewardVersion:quote.rewardTableVersion,fitting},quote};
}
export const compassOperationStage=(operation:CompassOperation)=>operation.proof?.status==='accepted'?(terminal(operation.proof)?'COMPLETED':'ACCEPTED'):operation.refusal?'REFUSED':operation.attemptRevision===null?'DRAFT':'CHECKING';
