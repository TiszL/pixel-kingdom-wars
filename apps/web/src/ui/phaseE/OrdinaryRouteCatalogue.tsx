import {useId,useState} from 'react';
import {PHASE_E_ORDINARY_ROUTES} from '@shardkeep/shared';
import {REALM_IDS} from '@shardkeep/shared/baseVisual';
import {ORDINARY_ROUTE_IDS,ordinaryRoute} from '@shardkeep/shared/ordinaryRoutes';
import {advancedExpeditionPreview,type AdvancedExpeditionSnapshot} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import type {AdvancedFleetVehicle} from '@shardkeep/shared/advancedFleetApi';
import {Btn} from '../primitives';
import {hudChipStyle} from '../hudChrome';
import {OrdinaryRouteArt} from './OrdinaryRouteArt';
const label=(id:string)=>id.replaceAll('_',' ').replaceAll('-',' ').replace(/\b\w/g,c=>c.toUpperCase());
export function OrdinaryRouteCatalogue({vehicle,previews,disabled,onDispatch}:{vehicle:AdvancedFleetVehicle;previews:readonly AdvancedExpeditionSnapshot[];disabled:boolean;onDispatch:(preview:AdvancedExpeditionSnapshot)=>void}){
 const [realm,setRealm]=useState('all'),filterId=useId();
 const admitted=new Map(previews.filter(p=>p.policyVersion===PHASE_E_ORDINARY_ROUTES.policyVersion&&p.family===vehicle.family&&p.tier===vehicle.tier).map(p=>[p.routeId,p]));
 const homeRealmId=admitted.values().next().value?.homeRealmId;
 const routes=ORDINARY_ROUTE_IDS.filter(id=>realm==='all'||ordinaryRoute(id).realmId===realm);
 return <section aria-label="Named expedition routes"><h4>Named routes</h4><p>Longer trips carry more cargo and use more provisions. Each completed trip uses one vehicle use. Access and provisions are checked again at departure.</p>
  <label htmlFor={filterId}>Destination realm</label><select id={filterId} value={realm} onChange={e=>setRealm(e.target.value)} style={{width:'100%',minHeight:44,marginBottom:12}}><option value="all">All destinations</option>{REALM_IDS.map(id=><option key={id} value={id}>{label(id)}</option>)}</select>
  {routes.map(id=>{const route=ordinaryRoute(id),preview=admitted.get(id),insufficient=vehicle.tier<route.grade;
   // Display the installed immutable policy even when no current preview exists.
   // Below-grade rows explicitly describe the minimum qualifying tier instead.
   const estimate=preview??advancedExpeditionPreview({family:vehicle.family,tier:insufficient?route.grade:vehicle.tier,homeRealmId:homeRealmId??route.realmId,routeId:id},PHASE_E_ORDINARY_ROUTES.policyVersion);
   const held=disabled||vehicle.away||vehicle.pendingService||vehicle.remainingUses===0||insufficient||!preview;
   return <article key={id} data-route-id={id} style={{...hudChipStyle(),display:'block',padding:12,marginBottom:12,borderRadius:10}}>
    <div style={{display:'flex',gap:12,alignItems:'center'}}><OrdinaryRouteArt routeId={id}/><div><h5 style={{margin:'0 0 6px',fontSize:16}}>{label(id)}</h5><span>{id}</span><p style={{margin:'6px 0'}}>Grade {route.grade} · {label(route.realmId)} · requires tier {route.grade}</p></div></div>
    <p>{insufficient?`Requires tier ${route.grade}. Estimate at minimum tier ${route.grade}.`:'Installed policy estimate.'} {estimate.durationSec} seconds · {estimate.grossQuantity} gross {label(estimate.resourceId)} · {estimate.islandPoolQuantity} economy tax · {estimate.netQuantity} net.</p>
    <p>Provisions: {estimate.supplies.map(s=>s.quantity+' '+label(s.resourceId)).join(', ')}.</p>
    <p>{homeRealmId===undefined?'HOME or paid realm access is not yet known; refresh routes for this kingdom.':route.realmId===homeRealmId?'HOME destination of this kingdom.':'Paid realm access required for this destination.'} {preview?'Server preview available; this does not verify current permission.':!insufficient?'No current server preview; dispatch is held.':''}</p>
    <Btn style={{minHeight:44,width:'100%'}} disabled={held} onClick={()=>{if(!held&&preview)onDispatch(preview);}}>DISPATCH {label(id).toUpperCase()}</Btn>
   </article>;
  })}
 </section>;
}
