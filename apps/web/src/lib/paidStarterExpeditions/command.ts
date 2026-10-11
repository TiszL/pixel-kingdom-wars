/** Saved review is economics, never fabricated finalized access. Reuse the
 * frozen DTO fields without its current-economics refinement: old intent and
 * receipts remain readable after future policy changes current prices. */
import {PHASE_E_PAID_STARTER_ROUTES} from '@shardkeep/shared';
import {PaidStarterRoutePreviewSchema} from '@shardkeep/shared/paidStarterExpeditions';
import {PHASE_E_RAW_RESOURCES} from '@shardkeep/shared/phaseEResources';
export type PaidStarterCommandRoute=ReturnType<typeof PaidStarterRoutePreviewSchema.parse>;
function parse(raw:unknown):PaidStarterCommandRoute{
 const fields=PaidStarterRoutePreviewSchema.shape,keys=Object.keys(fields),required=keys.filter(k=>k!=='fitting'&&k!=='secondaryOutput');
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!Object.hasOwn(fields,k))||required.some(k=>!Object.hasOwn(raw,k)))throw Error('Invalid original paid route review fields.');
 // Preserve omitted equipment fields in old originals and unfitted previews.
 const input=raw as Record<string,unknown>,parsed=Object.fromEntries(Object.entries(fields).filter(([key])=>Object.hasOwn(input,key)).map(([key,schema])=>[key,schema.parse(input[key])])) as PaidStarterCommandRoute;
 if(PHASE_E_PAID_STARTER_ROUTES.routes[parsed.routeId]!==parsed.realmId||PHASE_E_RAW_RESOURCES[parsed.resourceId].realmId!==parsed.realmId
  ||BigInt(parsed.grossQuantity)!==BigInt(parsed.netQuantity)+BigInt(parsed.islandPoolQuantity))throw Error('Original paid review differs from its destination or conserved quantities.');
 return parsed;
}
export const PaidStarterCommandRouteSchema={parse};
export const isPaidStarterCommand=(route:{routeId:string}):boolean=>route.routeId.startsWith('paid_');
