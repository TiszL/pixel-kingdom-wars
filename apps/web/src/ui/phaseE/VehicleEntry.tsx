import { phaseEWebEnabled, withPhaseEWebHold } from './webHold';
import {useLayoutEffect,useRef,useState} from 'react';
import {inspectConfiguredBasePanel,useApp,type UserCommandHandle} from '../../state/store';
import {PhaseEEntryButton} from './PhaseEActionDock';
import type {VehicleSigningTrust} from '../../lib/vehicles/signing';
import {useUserCommand} from '../pk/useUserCommand';
import {isVehicleRecoveryFeature,VEHICLE_RECOVERY_PANEL} from '../pk/vehicleRecoveryRegistry';
function VehicleRecoveryDoor(): React.JSX.Element {
  const [opening,setOpening]=useState(false),[notice,setNotice]=useState<string|null>(null);
  const mounted=useRef(false),pending=useRef<{handle:UserCommandHandle|null}|null>(null);
  useLayoutEffect(()=>{
    mounted.current=true;
    const off=useApp.subscribe((state,prior)=>{
      // requestUserCommand owns wallet/base/panel scope. These extra transitions
      // also retire auth or screen ABA before React can commit an effect cleanup.
      if(state.authed!==prior.authed||state.screen!==prior.screen) pending.current?.handle?.();
      if(state.authed!==prior.authed||state.wallet!==prior.wallet||state.screen!==prior.screen
        ||state.selectedBaseId!==prior.selectedBaseId||state.baseSelectionEpoch!==prior.baseSelectionEpoch
        ||state.basePanel!==prior.basePanel) setNotice(null);
    });
    return ()=>{mounted.current=false;off();const old=pending.current;pending.current=null;old?.handle?.();};
  },[]);
  const request=useUserCommand(()=>phaseEWebEnabled()&&useApp.getState().authed);
  const open=():void=>{
    if(!mounted.current||pending.current)return;
    const before=useApp.getState();
    if(!phaseEWebEnabled()||!before.authed||!before.wallet||(before.screen!=='base'&&before.screen!=='build'))return;
    const feature=inspectConfiguredBasePanel(VEHICLE_RECOVERY_PANEL).feature;
    if(!isVehicleRecoveryFeature(feature)){setNotice('Vehicle history is unavailable. Please try again.');return;}
    if(before.basePanel?.kind===VEHICLE_RECOVERY_PANEL.kind&&before.basePanel.featureId===VEHICLE_RECOVERY_PANEL.featureId)return;
    const owned:{handle:UserCommandHandle|null}={handle:null};pending.current=owned;setOpening(true);setNotice(null);
    owned.handle=request(()=>{
      useApp.getState().openBasePanel(VEHICLE_RECOVERY_PANEL);
      const panel=useApp.getState().basePanel;
      return panel?.kind===VEHICLE_RECOVERY_PANEL.kind&&panel.featureId===VEHICLE_RECOVERY_PANEL.featureId;
    },()=>{
      const current=useApp.getState(),configured=inspectConfiguredBasePanel(VEHICLE_RECOVERY_PANEL).feature;
      return phaseEWebEnabled()&&current.authed&&current.wallet===before.wallet&&current.screen===before.screen
        &&current.selectedBaseId===before.selectedBaseId&&current.baseSelectionEpoch===before.baseSelectionEpoch
        &&current.basePanel===before.basePanel&&configured===feature&&isVehicleRecoveryFeature(configured);
    });
    owned.handle.onSettled(result=>{
      if(!mounted.current||pending.current!==owned)return;
      pending.current=null;setOpening(false);
      if(result.status==='rejected'||result.status==='fulfilled'&&result.value!==true)
        setNotice('Vehicle history is unavailable. Please try again.');
    });
  };
  return <><PhaseEEntryButton variant="sec" disabled={opening} onClick={open}>VEHICLE HISTORY</PhaseEEntryButton>
    {notice?<p role="status">{notice}</p>:null}</>;
}

function VehicleEntryEnabled(_props:{actionsEnabled:boolean;trust?:VehicleSigningTrust|null}): React.JSX.Element|null {
  const screen=useApp(s=>s.screen),wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed);
  if(!wallet||!authed)return null;
  // 3bbc26c6: only the accepted base/build recovery door is reachable.
  // Caller capability and signing trust do not enter this recovery-only path.
  return screen==='base'||screen==='build'?<VehicleRecoveryDoor/>:null;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const VehicleEntry = withPhaseEWebHold(VehicleEntryEnabled);
