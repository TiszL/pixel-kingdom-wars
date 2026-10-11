import {useApp} from '../../../state/store';
import type {BaseFeatureDefinition} from '../featureRegistry';

/** Lazy definitions only. F2ab owns registration and the R0 web hold.
 * New mutations stay held until the original hook has a supported live predicate.
 */
export const voyageFeatures:readonly BaseFeatureDefinition[]=[{
  id:'voyage.vehicle',kind:'voyage',label:'Advanced vehicles',size:'TALL',readOnly:false,dismissal:'controller',
  canMutate:()=>false,
  canRecover:()=>!!useApp.getState().wallet&&useApp.getState().authed,
  load:()=>import('./VehiclePanel'),
},{
  id:'voyage.compass',kind:'voyage',label:'Expedition equipment',size:'TALL',readOnly:false,dismissal:'controller',
  canMutate:()=>false,
  canRecover:()=>!!useApp.getState().wallet&&useApp.getState().authed,
  load:()=>import('./CompassPanel'),
},{
  id:'voyage.paidExpedition',kind:'voyage',label:'Paid realm expeditions',size:'TALL',readOnly:false,dismissal:'controller',
  canMutate:()=>false,
  canRecover:()=>!!useApp.getState().wallet&&useApp.getState().authed,
  load:()=>import('./PaidExpeditionPanel'),
}];
