import {useApp} from '../../../state/store';
import type {BaseFeatureDefinition} from '../featureRegistry';

/** UNAPPLIED feature-side contract under 87ac7014. F2ab owns the QA door.
 * Register this definition instead of the held voyageFeatures Vehicle entry;
 * never register both definitions for the same id. No registration side effect.
 */
export const vehicleRecoveryFeature:BaseFeatureDefinition={
  id:'voyage.vehicle',kind:'voyage',label:'Vehicle history',size:'TALL',
  readOnly:true,dismissal:'controller',canMutate:()=>false,
  canRecover:panel=>panel.kind==='voyage'&&panel.featureId==='voyage.vehicle'
    &&!!useApp.getState().wallet&&useApp.getState().authed,
  load:()=>import('./VehicleRecoveryPanel'),
};
