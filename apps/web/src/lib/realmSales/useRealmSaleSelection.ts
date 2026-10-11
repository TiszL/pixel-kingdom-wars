import {useEffect,useRef,useState} from 'react';
import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {RealmSaleOfferSchema,RealmSaleCoverageSchema,RealmSaleOfferSelectionSchema,type RealmSaleOfferView,type RealmSaleCoverageView} from '@shardkeep/shared/realmSaleOfferApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {api} from '../api';
type Selection={spot:number;realm:number};
type View={scope:string;epoch:number;loading:boolean;offer:RealmSaleOfferView|null;coverage:RealmSaleCoverageView|null;error:string|null};
/** Current display only: one selected spot/realm, authenticated private GETs.
 * No response can become signing trust, an original purchase or admission. */
export function useRealmSaleSelection(selection:Selection){
 const wallet=useApp(s=>s.wallet),authed=useApp(s=>s.authed),screen=useApp(s=>s.screen),{spot,realm}=selection;
 const generation=authCookies.captureGeneration(),scope=JSON.stringify([wallet,authed,screen,spot,realm,generation]),latest=useRef(scope);latest.current=scope;
 const lifetime=useRef({visible:document.visibilityState!=='hidden',epoch:0});
 const [revision,refresh]=useState(0),[view,setView]=useState<View|null>(null);
 useEffect(()=>{
  const suspend=()=>{lifetime.current.visible=false;lifetime.current.epoch++;setView(null);};
  const resume=()=>{lifetime.current.visible=document.visibilityState!=='hidden';lifetime.current.epoch++;setView(null);refresh(n=>n+1);};
  const visibility=()=>document.visibilityState==='hidden'?suspend():resume();
  document.addEventListener('visibilitychange',visibility);document.addEventListener('freeze',suspend);document.addEventListener('resume',resume);
  window.addEventListener('pagehide',suspend);window.addEventListener('pageshow',resume);window.addEventListener('focus',resume);window.addEventListener('online',resume);
  return()=>{lifetime.current.epoch++;
   document.removeEventListener('visibilitychange',visibility);document.removeEventListener('freeze',suspend);document.removeEventListener('resume',resume);
   window.removeEventListener('pagehide',suspend);window.removeEventListener('pageshow',resume);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);
  };
 },[]);
 useEffect(()=>{
  let active=true;const abort=new AbortController(),epoch=lifetime.current.epoch;
  const current=()=>active&&!abort.signal.aborted&&latest.current===scope&&authCookies.current(generation)&&useApp.getState().authed&&useApp.getState().wallet===wallet&&useApp.getState().screen===screen&&lifetime.current.visible&&lifetime.current.epoch===epoch&&document.visibilityState!=='hidden';
  const empty:View={scope,epoch,loading:false,offer:null,coverage:null,error:null};
  if(!wallet||!authed||!lifetime.current.visible||document.visibilityState==='hidden'||!RealmSaleOfferSelectionSchema.safeParse({spot,realm}).success){setView(empty);return;}
  setView({...empty,loading:true});let pending=2;
  const timer=setTimeout(()=>{if(current())setView({...empty,error:'Current offer and coverage are unavailable. Refresh to check again.'});abort.abort();},LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
  const options={signal:abort.signal,isCurrent:()=>current()&&!abort.signal.aborted};
  const complete=()=>{pending--;if(pending===0){clearTimeout(timer);if(current()&&!abort.signal.aborted)setView(old=>old?.scope===scope&&old.epoch===epoch?{...old,loading:false}:old);}};
  void api.getPrivate(`/seeker/realm-sales/offer?spot=${spot}&realm=${realm}`,options).then(raw=>{
   const offer=RealmSaleOfferSchema.parse(raw);if(offer.wallet!==wallet||offer.spot!==spot||offer.realm!==realm)throw Error('Wrong selected offer');
   if(current()&&!abort.signal.aborted)setView(old=>old?.scope===scope&&old.epoch===epoch?{...old,offer}:old);
  }).catch(()=>{if(current()&&!abort.signal.aborted)setView(old=>old?.scope===scope&&old.epoch===epoch?{...old,error:'The selected offer could not be verified.'}:old);}).finally(complete);
  void api.getPrivate(`/seeker/realm-sales/coverage?realm=${realm}`,options).then(raw=>{
   const coverage=RealmSaleCoverageSchema.parse(raw);if(coverage.wallet!==wallet||coverage.realm!==realm)throw Error('Wrong selected coverage');
   if(current()&&!abort.signal.aborted)setView(old=>old?.scope===scope&&old.epoch===epoch?{...old,coverage}:old);
  }).catch(()=>{if(current()&&!abort.signal.aborted)setView(old=>old?.scope===scope&&old.epoch===epoch?{...old,error:'Current coverage could not be verified.'}:old);}).finally(complete);
  return()=>{active=false;clearTimeout(timer);abort.abort();};
 },[scope,wallet,authed,screen,spot,realm,generation,revision]);
 const visible=view?.scope===scope&&view.epoch===lifetime.current.epoch&&lifetime.current.visible&&document.visibilityState!=='hidden'&&authCookies.current(generation)?view:null;
 return {offer:visible?.offer??null,coverage:visible?.coverage??null,loading:visible?.loading??true,error:visible?.error??null,refresh:()=>{lifetime.current.epoch++;setView(null);refresh(n=>n+1);}};
}
