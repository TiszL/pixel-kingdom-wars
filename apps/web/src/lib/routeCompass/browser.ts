import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {API_URL} from '../api';
import {SOLANA_CLUSTER} from '../cluster';
import {mutationGate} from '../mutationGate';
import {parseCompassIdentity,need,same,type CompassIdentity} from './journal';
import {compassRead,compassOriginal} from './transport';
import type {CompassPorts} from './controller';
export const browserCompassIdentity=(wallet:string)=>parseCompassIdentity({origin:window.location.origin,api:new URL(API_URL,window.location.origin).href.replace(/\/$/,''),cluster:SOLANA_CLUSTER,wallet});
export function createCompassBrowserPorts(input:{identity:CompassIdentity;lifecycle:()=>{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}}):CompassPorts{
 const identity=parseCompassIdentity(input.identity);
 return {key:()=>crypto.randomUUID(),capture:(fresh,baseId)=>{const revision=authCookies.assertSession(),generation=authCookies.captureGeneration(),epoch=input.lifecycle().epoch,selection=useApp.getState().baseSelectionEpoch;const guard=()=>{authCookies.assertResponse(revision);const state=useApp.getState(),page=input.lifecycle();need(same(identity,browserCompassIdentity(identity.wallet))&&authCookies.current(generation)&&state.authed&&state.wallet===identity.wallet&&page.active&&page.visible&&page.epoch===epoch&&(!baseId||state.selectedBaseId===baseId&&state.baseSelectionEpoch===selection)&&(!fresh||page.actionsEnabled&&mutationGate.getSnapshot()),'The account, kingdom or Compass view changed. Recover the saved original.');};guard();return guard;},
 lock:async(name,run)=>{need(navigator.locks?.request,'This browser cannot coordinate Compass commands across tabs.');return navigator.locks.request('route-compass:'+name,{mode:'exclusive',ifAvailable:true},async lock=>{need(lock,'Another tab is handling this Compass command.');return run();});},
 read:(r,guard)=>compassRead(identity,r,guard),original:(command,method,firstAttempt,guard,retain,refused)=>compassOriginal({identity,command,method,firstAttempt,guard,retain,refused})};
}
