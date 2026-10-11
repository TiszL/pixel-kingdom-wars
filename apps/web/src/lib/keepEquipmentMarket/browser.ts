import {authCookies} from '../../auth/authCookieCoordinator';
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as P} from '@shardkeep/shared';
import type {GameWallet} from '../../auth/useGameWallet';
import {useApp} from '../../state/store';
import {mutationGate} from '../mutationGate';
import {browserCharterIdentity} from '../charter/browser';
import {charterIdentity,type CharterIdentity} from '../charter/journal';
import {KeepEquipmentReviewSchema,type KeepEquipmentPurchase} from '@shardkeep/shared/keepEquipmentMarketApi';
import {canonicalKeepEquipmentMessage,prepareKeepEquipmentSigning,signKeepEquipment,need,type KeepEquipmentSigningTrust} from './signing';
import {createKeepEquipmentCurrentChecks,type KeepEquipmentCurrentConnection} from './current';
import {requestKeepMarket} from './transport';
import type {KeepMarketPorts} from './controller';
export {browserCharterIdentity as browserKeepMarketIdentity};
export function createKeepMarketBrowserPorts(input:{identity:CharterIdentity;trust:KeepEquipmentSigningTrust|null;wallet:()=>GameWallet;connection:KeepEquipmentCurrentConnection;lifecycle:()=>{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean;recoveryEnabled?:boolean}}):KeepMarketPorts{
 const identity=charterIdentity(input.identity),trust=input.trust===null?null:structuredClone(input.trust),wallet=input.wallet,lifecycle=input.lifecycle,checks=trust?createKeepEquipmentCurrentChecks(input.connection,trust):null;
 const capture:KeepMarketPorts['capture']=(action,baseId,purpose)=>{const revision=authCookies.assertSession(),generation=authCookies.captureGeneration(),epoch=lifecycle().epoch,selection=useApp.getState().baseSelectionEpoch;const guard=()=>{
  authCookies.assertResponse(revision);const state=useApp.getState(),page=lifecycle();
  need(JSON.stringify(identity)===JSON.stringify(browserCharterIdentity(identity.wallet))&&authCookies.current(generation)&&state.authed&&state.wallet===identity.wallet&&page.active&&page.visible&&page.epoch===epoch
   &&(!action||state.baseSelectionEpoch===selection&&(baseId===undefined||state.selectedBaseId===baseId)&&mutationGate.getSnapshot()&&(page.actionsEnabled||purpose==='saved-delivery'&&page.recoveryEnabled===true)),'The account, selected kingdom or market view changed. Recover the saved purchase.');
 };guard();return guard;};
 async function review(value:KeepEquipmentPurchase,guard:()=>void,retain:(raw:unknown)=>Promise<void>){
  need(trust&&checks,'Independent equipment payment trust is unavailable. Saved purchases remain accessible.');
  const own=capture(true,undefined,value.wire?'saved-delivery':undefined),started=performance.now(),assertFresh=()=>{guard();own();const age=performance.now()-started;need(age>=0&&age<P.reviewMaxAgeMs,'Payment review expired. Refresh this same purchase.');};
  assertFresh();await canonicalKeepEquipmentMessage(value);
  const raw=await requestKeepMarket({actor:identity.wallet,request:{kind:'fill',action:'review',id:value.fill.id},isCurrent:()=>{assertFresh();return true;},retain});
  const parsed=KeepEquipmentReviewSchema.parse(raw);await checks(value,parsed,started,assertFresh);assertFresh();
  return {feeLamports:parsed.current.costs.feeLamports,rentLamports:parsed.current.costs.rentLamports,totalLamports:parsed.current.costs.totalLamports,assertFresh};
 }
 return {capture,key:()=>crypto.randomUUID(),lock:async(name,run)=>{need(navigator.locks?.request,'This browser cannot safely coordinate market purchases across tabs.');return navigator.locks.request('keep-equipment:'+name,{mode:'exclusive',ifAvailable:true},async lock=>{need(lock,'Another tab is handling this purchase.');return run();});},
  request:(request,guard,retain)=>requestKeepMarket({actor:identity.wallet,request,isCurrent:()=>{guard();return true;},retain}),review,
  sign:async(value,guard,beforeWallet,displayed,retain)=>{
   need(trust,'Independent equipment payment trust is unavailable.');const signer={...wallet()},key=signer.publicKey?.toBase58(),sign=signer.signVersionedTransaction;
   const signingGuard=()=>{guard();need(key===identity.wallet&&typeof sign==='function'&&wallet().publicKey?.toBase58()===key&&wallet().signVersionedTransaction===sign,'Original payment wallet changed.');};
   signingGuard();const prepared=await prepareKeepEquipmentSigning(value,trust,identity.wallet),quote=await review(value,signingGuard,retain);
   need(quote.feeLamports===displayed.feeLamports&&quote.rentLamports===displayed.rentLamports&&quote.totalLamports===displayed.totalLamports,'Network costs changed. Review the same purchase again.');
   quote.assertFresh();await beforeWallet();quote.assertFresh();return signKeepEquipment(prepared,signer);
  }};
}
