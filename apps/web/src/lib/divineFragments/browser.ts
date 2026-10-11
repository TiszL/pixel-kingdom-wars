import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { API_URL,api } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { mutationGate } from '../mutationGate';
import { parseDivineFragmentsIdentity,same,type DivineFragmentsIdentity } from './journal';
import type { DivineFragmentsPorts } from './controller';
import {divineFragmentOriginal} from './transport';
export const divineFragmentsIdentity=(wallet:string)=>parseDivineFragmentsIdentity({origin:window.location.origin,api:new URL(API_URL,window.location.origin).href.replace(/\/$/,''),cluster:SOLANA_CLUSTER,wallet});
export function createDivineFragmentsBrowserPorts(input:{identity:DivineFragmentsIdentity;lifecycle():{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}}):DivineFragmentsPorts{
 return {capture:baseId=>{if(!same(input.identity,divineFragmentsIdentity(input.identity.wallet)))throw Error('Fragment origin, server or network changed.');const revision=authCookies.assertSession(),generation=authCookies.captureGeneration(),epoch=input.lifecycle().epoch,selection=useApp.getState().baseSelectionEpoch;
   return()=>{authCookies.assertResponse(revision);const state=useApp.getState(),page=input.lifecycle();if(!authCookies.current(generation)||!state.authed||state.wallet!==input.identity.wallet||!page.active||!page.visible||page.epoch!==epoch
    ||baseId!==undefined&&(!mutationGate.getSnapshot()||!page.actionsEnabled||state.selectedBaseId!==baseId||state.baseSelectionEpoch!==selection))throw Error('The account, kingdom or fragment view changed. Check its saved receipt.');};},
  get:async(path,guard)=>{guard();const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),LAND_CHECKOUT_RECOVERY.requestTimeoutMs);try{const result=await api.getPrivate(path,{signal:abort.signal,isCurrent:()=>{guard();return true;}});abort.signal.throwIfAborted();guard();return result;}finally{clearTimeout(timer);}},
  original:(command,method,guard,retain)=>divineFragmentOriginal({identity:input.identity,command,method,isCurrent:()=>{guard();return true;},retain}),
  lock:async(name,run)=>{if(!navigator.locks?.request)throw Error('Update your browser to coordinate fragment requests across tabs.');return navigator.locks.request(name,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)throw Error('Another tab is handling this fragment journal.');return run();});},key:()=>crypto.randomUUID()};
}
