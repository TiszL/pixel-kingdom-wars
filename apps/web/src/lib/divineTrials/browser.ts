import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {API_URL} from '../api';
import {SOLANA_CLUSTER} from '../cluster';
import {mutationGate} from '../mutationGate';
import {divineIdentity,type DivineIdentity} from './journal';
import {requestDivineTrial} from './transport';
import type {DivinePorts} from './controller';
import {need} from './validation';
export const browserDivineIdentity=(wallet:string)=>divineIdentity({origin:window.location.origin,api:new URL(API_URL,window.location.origin).href.replace(/\/$/,''),cluster:SOLANA_CLUSTER,wallet});
export function createDivineBrowserPorts(input:{identity:DivineIdentity;lifecycle:()=>{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}}):DivinePorts{
 const identity=divineIdentity(input.identity);
 return {key:()=>crypto.randomUUID(),capture:(fresh,baseId)=>{const revision=authCookies.assertSession(),generation=authCookies.captureGeneration(),epoch=input.lifecycle().epoch,selection=useApp.getState().baseSelectionEpoch;const guard=()=>{authCookies.assertResponse(revision);const state=useApp.getState(),page=input.lifecycle();need(JSON.stringify(identity)===JSON.stringify(browserDivineIdentity(identity.wallet))&&authCookies.current(generation)&&state.authed&&state.wallet===identity.wallet&&page.active&&page.visible&&page.epoch===epoch&&(!baseId||state.selectedBaseId===baseId&&state.baseSelectionEpoch===selection)&&(!fresh||page.actionsEnabled&&mutationGate.getSnapshot()),'The account, kingdom or Divine trial view changed. Recover the saved original.');};guard();return guard;},
 lock:async(name,run)=>{need(navigator.locks?.request,'This browser cannot coordinate trial recovery across tabs.');return navigator.locks.request('divine-trial:'+name,{mode:'exclusive',ifAvailable:true},async lock=>{need(lock,'Another tab is handling this trial.');return run();});},
 request:(request,guard,retain)=>requestDivineTrial({wallet:identity.wallet,request,guard,retain})};
}
