import {fmtDur} from '../../../lib/duration';
import type {ReactNode} from 'react';
import {PkCloseSquare,PkIconSquare,PkSecondaryButton} from '../Button';
import {PkIcon} from '../Icon';
import {PkSheetTitlePlate} from '../Plate';
import './VoyageSheets.css';
import './VoyageAdapter.css';

/** Body only: the shared host owns modal semantics, focus, scrim and dismissal. */
export function VoyageAdapterFrame({title,status,busy,error,onClose,onRefresh,onHistory,children}:{title:string;status:string;busy:boolean;error:string|null;onClose:()=>void;onRefresh:()=>void;onHistory:()=>void;children:ReactNode}):React.JSX.Element {
  return <section className="pk-voyage pk-voyage-adapter" aria-label={title} aria-busy={busy}>
    <header className="pk-voyage__header"><div className="pk-voyage__art" aria-hidden="true"><PkIcon name="ui:expedition-kit" size={64}/></div>
      <div className="pk-voyage__title"><PkSheetTitlePlate ui={{title,titleTag:null}}/></div>
      <div className="pk-voyage__tools"><PkIconSquare icon="replay" verb="STONE" contentDescription="Voyage history" onClick={onHistory}/><PkCloseSquare onClick={onClose}/></div>
      <p className="pk-voyage__status">{status}</p></header>
    <div className="pk-voyage__scroll" tabIndex={0} aria-label={`${title} contents`}>
      {busy?<p role="status">Checking…</p>:null}{error?<p role="alert">{error}</p>:null}{children}
    </div><footer className="pk-voyage__footer"><PkSecondaryButton label="REFRESH" enabled={!busy} onClick={onRefresh}/></footer>
  </section>;
}

export const voyageName=(id:string)=>id.replaceAll('_',' ').replaceAll('-',' ').replace(/\b\w/g,c=>c.toUpperCase());
export interface VoyageTermsUi {routeId:string;realmId:string;resourceId:string;durationSec:number;routeCatalogueVersion?:number|undefined;rewardTableVersion?:number|undefined;policyVersion?:number|undefined;fitting?:{itemId:string;policyVersion:number;resourceId?:string|undefined;originalDurationSec?:number|undefined;originalNetQuantity?:string|undefined}|undefined;supplies?:readonly {resourceId:string;quantity:string}[]|undefined;grossQuantity:string;islandPoolQuantity:string;netQuantity:string;secondaryOutput?:{resourceId:string;grossQuantity:string;islandPoolQuantity:string;netQuantity:string}|undefined}
/** Displays the original supplied terms, including companion cargo; no client payout arithmetic. */
export function VoyageTerms({route}:{route:VoyageTermsUi}):React.JSX.Element {
  const cargo=[route,...(route.secondaryOutput?[route.secondaryOutput]:[])];
  return <div className="pk-voyage-adapter__terms"><h3>{voyageName(route.routeId)}</h3><p>{voyageName(route.realmId)} · {fmtDur(route.durationSec)}</p>
    {cargo.map((item,index)=><dl key={item.resourceId} aria-label={index?'Companion cargo':'Primary cargo'}>
      <div><dt>{voyageName(item.resourceId)} to stores</dt><dd>{BigInt(item.netQuantity).toLocaleString('en-US')}</dd></div>
      <div><dt>Gross cargo</dt><dd>{BigInt(item.grossQuantity).toLocaleString('en-US')}</dd></div>
      <div><dt>Island pool</dt><dd>{BigInt(item.islandPoolQuantity).toLocaleString('en-US')}</dd></div>
    </dl>)}
    {route.fitting?<p>Fitted equipment: {voyageName(route.fitting.itemId)} · Fitting policy {route.fitting.policyVersion}{route.fitting.resourceId?` · ${voyageName(route.fitting.resourceId)}`:''}</p>:null}
    {route.fitting?<p>The fitted tool travels with the journey and is unavailable until its return is collected.</p>:null}
    {route.fitting?<p>Without equipment: {route.fitting.originalDurationSec===undefined?'…':fmtDur(route.fitting.originalDurationSec)} · {route.fitting.originalNetQuantity===undefined?'…':BigInt(route.fitting.originalNetQuantity).toLocaleString('en-US')} {voyageName(route.resourceId)} to stores.</p>:null}
    {route.supplies?<div aria-label="Journey supplies">{route.supplies.map(item=><p key={item.resourceId}>Supplies used at departure: {BigInt(item.quantity).toLocaleString('en-US')} {voyageName(item.resourceId)}</p>)}</div>:null}
    <details><summary>Route details</summary><p>Route version {route.routeCatalogueVersion??'unknown'} · Reward version {route.rewardTableVersion??'unknown'}{route.policyVersion===undefined?'':` · Route policy ${route.policyVersion}`}</p></details>
  </div>;
}
