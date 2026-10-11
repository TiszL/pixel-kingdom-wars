import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FANTASY_WORLD } from '@shardkeep/shared';
import { getFantasyTile, type FantasyTile } from '@shardkeep/shared/fantasyWorld';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { ApiError, api } from '../../lib/api';
import { selectedBasePath } from '../../lib/baseSelection';
import { bus } from '../../lib/events';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { selectBaseSnapshot } from '../../state/baseSnapshot';
import { useMobileBackHandler } from '../../lib/mobileBackGuard';
import { GlobeBaseCounts } from '../screens/globe/GlobeBaseCounts';
import { deedImageUrl, recoverDeedImage, parcelActionBlockText, type ParcelScoutReport } from '../screens/globe/parcelDetail';
import { FantasyGlobe, FANTASY_REALMS, FANTASY_CHAINS, type FantasyTerrainStatus } from './FantasyGlobe';
import type { FantasyGlobeHandle, FantasyView, FantasyWorldMarker, FantasyExploration } from './types';
import type { WorldV2Hud } from './worldv2/contract';
import { useFantasyDirectory, useFantasyParcel, useFantasyViewport, useFantasySearch, type FantasyViewBounds, type FantasyViewport } from './data';
import { worldV2Available } from './worldV2Support';
import { FantasyShieldStatus } from './FantasyShieldStatus';
import { WarzoneDetails } from '../screens/warzoneStatus';
import { GameLoading } from '../loading/GameLoading';
import { MAPCHROME } from '../layout';
import './world.css';

// D-186 World v2: its own lazy chunk, fetched only when the build flag is on and the device
// qualifies (worldV2Support). The flag is re-read inside the factory so a flag-off build
// folds the import away and emits no world chunk. Never import worldv2/ any other way here.
const WorldV2=lazy(()=>import.meta.env.VITE_FEATURE_WORLD_V2==='1'?import('./worldv2/WorldV2'):Promise.reject(new Error('World v2 is not in this build')));

/** A WorldV2 chunk that fails to load or render falls back to the CPU globe rather than
 *  leaving the stage empty. */
class WorldV2Boundary extends Component<{onFail(reason:string):void;children:ReactNode},{failed:boolean}> {
  override state={failed:false};
  static getDerivedStateFromError():{failed:boolean}{return {failed:true};}
  override componentDidCatch(error:unknown):void{this.props.onFail(`render: ${error instanceof Error?error.message:String(error)}`);}
  override render():ReactNode{return this.state.failed?null:this.props.children;}
}
const sameBounds=(a:FantasyViewBounds|null|undefined,b:FantasyViewBounds|null|undefined):boolean=>a===b||!a&&!b
  ||!!a&&!!b&&a.west===b.west&&a.east===b.east&&a.south===b.south&&a.north===b.north;
const sameViewport=(a:FantasyViewport,b:FantasyViewport):boolean=>a.width===b.width&&a.height===b.height&&a.centerX===b.centerX&&a.centerY===b.centerY&&sameBounds(a.bounds,b.bounds);

export function FantasyWorldLayer():React.JSX.Element {
  const wallet=useApp(s=>s.wallet),baseId=useApp(s=>s.selectedBaseId),epoch=useApp(s=>s.baseSelectionEpoch);
  const entryPaid=useApp(s=>s.entryPaid),directory=useApp(s=>s.baseDirectory),reduceMotion=useApp(s=>s.reduceMotion),baseShield=useApp(s=>s.base?.shield),loadedBaseId=useApp(s=>s.base?.baseId);
  const setScreen=useApp(s=>s.setScreen),setMapTab=useApp(s=>s.setMapTab),setLandPurchase=useApp(s=>s.setLandPurchase);
  const setScoutReport=useApp(s=>s.setScoutReport),setRaidTarget=useApp(s=>s.setRaidTarget);
  const fingerprint=directory?.bases.map(b=>`${b.id}:${b.status}:${b.slot}`).sort().join('|')??'-';
  const authority=useMemo(()=>({wallet,baseId,key:`${wallet??'-'}:${baseId??'-'}:${epoch}:${entryPaid}:${fingerprint}`}),[wallet,baseId,epoch,entryPaid,fingerprint]);
  const globe=useFantasyDirectory(authority);
  const [selection,setSelection]=useState<{authority:string;tileId:number|null}>({authority:authority.key,tileId:useApp.getState().landPurchase?.landAddress?.tileId??null});
  const selected=selection.authority===authority.key?selection.tileId:null;
  const tile=useMemo(()=>selected===null?null:getFantasyTile(selected),[selected]);
  const parcel=useFantasyParcel(authority,selected);
  const [realmId,setRealmId]=useState('crownlands');
  const [query,setQuery]=useState(''),[warzoneOpen,setWarzoneOpen]=useState(false);
  const search=useFantasySearch(authority,query);
  const [view,setView]=useState<FantasyView>({lon:26,lat:23,zoom:1});
  const [viewportSize,setViewportSize]=useState<FantasyViewport>({width:400,height:400,centerX:200,centerY:200});
  const [worldV2,setWorldV2]=useState(worldV2Available);
  const viewport=useFantasyViewport(authority,view,globe.data!==null,viewportSize);
  const [explore,setExplore]=useState<FantasyExploration|'list'|null>(null);
  const [panelOpen,setPanelOpen]=useState(true);
  const [busy,setBusy]=useState(false);
  const [actionError,setActionError]=useState<string|null>(null);
  const [parcelHelp,setParcelHelp]=useState(false);
  const scoutRequest=useRef(0);
  const [terrainStatus,setTerrainStatus]=useState<FantasyTerrainStatus|null>(null);
  const opening = !terrainStatus?.ready;
  const control=useRef<FantasyGlobeHandle>(null),rail=useRef<HTMLDivElement>(null),focused=useRef<string|null>(null),interacted=useRef(false);
  const realm=FANTASY_REALMS.find(r=>r.id===realmId)??FANTASY_REALMS[3]!;
  const counts=globe.data?.realms.find(r=>r.realmId===realmId);
  const owned=globe.data?.me.ownedTiles??[];
  const myParcel=owned.find(item=>item.tileId===globe.data?.me.selectedTileId)
    ??owned.find(item=>item.baseId===baseId)??owned.find(item=>item.active)??owned[0];
  const hasPaidBase=directory?.bases.some(item=>item.landPaidAt!==null)??false;
  const ownTile=owned.find(item=>item.tileId===selected);
  const detail=parcel.data?.detail??null;
  const activeChain=explore&&explore!=='list'?FANTASY_CHAINS.find(c=>c.id===explore.chainId):null;
  const selectTile=(value:FantasyTile|null):void=>{
    scoutRequest.current++;setBusy(false);setParcelHelp(false);
    setSelection({authority:authority.key,tileId:value?.tileId??null});setExplore(null);setWarzoneOpen(false);setQuery('');setActionError(null);
    if(value){setRealmId(value.realmId);setPanelOpen(true);}
  };
  useEffect(()=>{
    const container=rail.current,node=container?.querySelector<HTMLElement>(`[data-realm="${realmId}"]`);
    if(!container||!node)return;
    const reveal=():void=>{
      const bounds=container.getBoundingClientRect(),button=node.getBoundingClientRect(),style=getComputedStyle(container);
      // Scroll only this rail, retaining its edge padding after a resize.
      const left=bounds.left+container.clientLeft+(parseFloat(style.paddingLeft)||0);
      const right=bounds.left+container.clientLeft+container.clientWidth-(parseFloat(style.paddingRight)||0);
      if(button.left<left)container.scrollLeft=Math.max(0,container.scrollLeft+button.left-left);
      else if(button.right>right)container.scrollLeft+=button.right-right;
    };
    reveal();
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(reveal):null;
    observer?.observe(container);observer?.observe(node);
    window.addEventListener('resize',reveal);
    return()=>{observer?.disconnect();window.removeEventListener('resize',reveal);};
  },[realmId]);
  useEffect(()=>{
    if(!globe.data||focused.current===authority.key)return;
    focused.current=authority.key;
    if(interacted.current)return;
    const drafted=useApp.getState().landPurchase?.landAddress?.tileId;
    const id=drafted??globe.data.me.selectedTileId??globe.data.me.ownedTiles.find(item=>item.active)?.tileId??globe.data.me.ownedTiles[0]?.tileId;
    if(id!==null&&id!==undefined){const selectedTile=getFantasyTile(id);if(selectedTile){if(drafted!==undefined)control.current?.focusTile(id);else control.current?.focusRealm(selectedTile.realmId);setRealmId(selectedTile.realmId);}}
  },[globe.data,authority.key]);
  useEffect(()=>{setActionError(null);setBusy(false);setParcelHelp(false);scoutRequest.current++;},[authority.key]);
  useEffect(()=>()=>{scoutRequest.current++;},[]);
  useMobileBackHandler(()=>{if(query){setQuery('');return true;}if(parcelHelp){setParcelHelp(false);return true;}if(warzoneOpen){setWarzoneOpen(false);return true;}if(explore){setExplore(null);return true;}if(selected!==null){selectTile(null);return true;}setScreen('base');return true;});
  const overview=view.zoom<5;
  // K-211: a re-read (a pan, a new box) leaves viewport.data empty until it lands. The last settled read, with its shield
  // bits, stays until then (a failed read keeps it), fenced to this viewer; else every rival blinks out and, under
  // D-191's Unshielded, the chip and the player's own kingdom go too.
  const [lastFeed,setLastFeed]=useState<{authority:string;markers:FantasyWorldMarker[]}|null>(null);
  const fed=viewport.data?.markers;
  if(fed&&(lastFeed?.markers!==fed||lastFeed.authority!==authority.key))setLastFeed({authority:authority.key,markers:fed});
  const feed=fed??(lastFeed?.authority===authority.key?lastFeed.markers:null);
  const markers=useMemo(()=>{
    const map=new Map<number,FantasyWorldMarker>();
    if(overview){for(const row of globe.data?.realms??[])if(row.anchorTileId!==null&&row.occupied>0)map.set(row.anchorTileId,{tileId:row.anchorTileId,name:`${row.occupied} deeds`,cluster:{count:row.occupied,realmId:row.realmId}});}
    else {for(const marker of feed??[])map.set(marker.tileId,marker);}
    // Overlays keep the feed's D-181 shield (K-188): a dropped dome shows a shielded rival as open.
    for(const marker of globe.data?.me.ownedTiles??[]){const fed=map.get(marker.tileId);map.set(marker.tileId,{...marker,owned:true,...(fed?.cluster?{cluster:fed.cluster}:{}),...(fed?.shielded!==undefined?{shielded:fed.shielded}:{})});}
    // The inspected owner remains readable while a new viewport request is pending; its own read can only add a shield.
    if(tile&&detail){const fed=map.get(tile.tileId);map.set(tile.tileId,{tileId:tile.tileId,name:detail.player.name,
      keepLevel:detail.player.keepLevel,owned:!!ownTile,...(fed?.cluster?{cluster:fed.cluster}:{}),shielded:fed?.shielded===true||detail.shielded===true});}
    return [...map.values()];
  },[globe.data,feed,overview,tile,detail,ownTile]);
  const focusRealm=(id:string):void=>{interacted.current=true;setRealmId(id);selectTile(null);setExplore(null);setPanelOpen(true);control.current?.focusRealm(id);};
  const openExplore=(destination:FantasyExploration):void=>{interacted.current=true;selectTile(null);setExplore(destination);setPanelOpen(true);control.current?.focusIsland(destination.chainId,destination.islandId??undefined);};
  const openMyParcel=():void=>{
    interacted.current=true;
    if(myParcel){selectTile(getFantasyTile(myParcel.tileId));control.current?.focusTile(myParcel.tileId);}
    else{selectTile(null);setParcelHelp(true);setPanelOpen(true);}
  };
  const chooseLand=():void=>{
    if(!tile||tile.allocation!=='ordinary'||parcel.data?.availability!=='available'||!directory)return;
    setLandPurchase({kind:directory.nextLandPurchaseKind,earthCell:null,landAddress:{kind:'fantasy',worldId:'fantasy-v1',tileId:tile.tileId}});setScreen('entry');
  };
  const openBase=async(id:string):Promise<void>=>{
    if(busy)return;setBusy(true);setActionError(null);
    try{if(await selectBaseSnapshot(id)){setScreen('base');bus.emit('base:refresh',undefined);}}catch(cause){setActionError(cause instanceof Error?cause.message:'Unable to open base');}finally{setBusy(false);}
  };
  const scout=async():Promise<void>=>{
    if(!detail?.actions.scout.allowed||busy)return;
    const guard=captureBaseSnapshotGuard(),request=++scoutRequest.current;
    const current=():boolean=>request===scoutRequest.current&&isBaseSnapshotGuardCurrent(guard);
    setBusy(true);setActionError(null);
    try{
      const report=await api.get<ParcelScoutReport&{visualContext?:BaseVisualContext}>(selectedBasePath(`/map/scout/${encodeURIComponent(detail.base.id??detail.player.wallet)}`));
      if(!current())return;
      setScoutReport({name:report.name,keepLevel:report.keepLevel,trophies:report.trophies,previewSec:report.previewSec,returnScreen:'map',
        attackTarget:{kind:'pvp',wallet:detail.player.wallet,...(detail.base.id?{defenderBaseId:detail.base.id}:{}),name:detail.player.name},
        ...(!detail.actions.attack.allowed?{attackUnavailable:parcelActionBlockText(detail.actions.attack.blockedBy,{keepReach:detail.actions.attack.keepReach,shield:detail.shield})??'ATTACK UNAVAILABLE'}:{})});setScreen('scout');
      bus.emit('battle:enter',{snapshot:report,scout:true,...(report.visualContext?{visualContext:report.visualContext}:{})});
    }catch(cause){if(current())setActionError(cause instanceof Error?cause.message:'Scouting unavailable');}finally{if(current())setBusy(false);}
  };
  const attack=():void=>{if(!detail?.actions.attack.allowed)return;setRaidTarget({kind:'pvp',wallet:detail.player.wallet,...(detail.base.id?{defenderBaseId:detail.base.id}:{}),name:detail.player.name});setScreen('battle');};
  const image=detail?deedImageUrl(detail.deed.metadata.image):null;
  const landGate=parcel.error instanceof ApiError&&[402,403].includes(parcel.error.status);
  // Identical props for either renderer; only WorldV2 reports a realm-map ground box.
  const globeProps={view,markers,selectedTileId:selected,selectedRealmId:realmId,panelOpen,reduceMotion,onSelect:selectTile,onExplore:openExplore,
    onRealmSelect:(id:string)=>{selectTile(null);setRealmId(id);setPanelOpen(true);},onViewChange:setView,onTerrainStatus:setTerrainStatus,
    onViewportChange:(size:FantasyViewport)=>setViewportSize(previous=>{const next=previous.bounds?{...size,bounds:previous.bounds}:size;return sameViewport(previous,next)?previous:next;})};
  const fallbackTo2D=(reason:string):void=>{
    console.warn('[worldv2] falling back to the CPU globe:',reason);
    setTerrainStatus(null);setViewportSize(previous=>previous.bounds?{...previous,bounds:null}:previous);setWorldV2(false);
  };
  // D-186 round 3: while World v2 is the renderer its HUD is the world's chrome, fed from these same reads and
  // calling these same actions; the host header stays only under the opening veil (its BASE is the way out).
  // fallbackTo2D sets worldV2 false, which brings the host chrome back unchanged (G5).
  const hostChrome=!worldV2,hostHeader=!worldV2||opening;
  const ownBaseTile=owned.find(item=>item.baseId===(loadedBaseId??baseId));
  const worldHud:WorldV2Hud={directory:globe.data,
    parcel:{tileId:selected,data:parcel.data,pending:parcel.pending,retry:parcel.retry,
      failure:parcel.error?{kind:landGate?'land-gate':'other',message:landGate?'Acquire a Land Deed to inspect occupied bases.':parcel.error.message}:null},
    ownTile:ownTile??null,
    // The dome is the effective shield: a warzone-suppressed row protects nothing.
    ownShield:ownBaseTile?{tileId:ownBaseTile.tileId,shielded:baseShield?.active===true&&baseShield.suppressedByWarzone!==true}:null,
    busy,search:{query,setQuery,results:search.data,pending:search.pending,error:!!search.error,retry:search.retry},
    explore,warzone:{active:!!globe.data?.warzone?.active,open:warzoneOpen,panel:warzoneOpen?<WarzoneDetails onShop={()=>setScreen('shop')}/>:null},
    cardExtras:detail||actionError?<>{actionError&&<p className="hud-body wv2-danger" role="alert">{actionError}</p>}{detail&&<>{image&&<img className="fantasy-deed-picture" src={image} alt={`${detail.player.name}'s deeded base`} onError={e=>recoverDeedImage(e.currentTarget,detail.deed.assetId?`/deed/asset/${encodeURIComponent(detail.deed.assetId)}.png`:`/deed/${encodeURIComponent(detail.player.wallet)}.png`)}/>}<FantasyShieldStatus key={`${authority.key}:${selected}`} detail={detail} onExpire={parcel.retry}/></>}</>:null,
    actions:{scout:()=>void scout(),raid:attack,chooseLand,openBase:id=>void openBase(id),manageDeed:()=>setScreen('bases'),
      explore:openExplore,openCampaign:()=>setMapTab('campaign'),back:()=>setScreen('base'),
      setWarzoneOpen:open=>{if(open)selectTile(null);setWarzoneOpen(open);}}};
  const status=(terrainStatus?.pending||terrainStatus?.error||globe.pending||globe.error||viewport.data?.truncated||(viewport.error&&view.zoom>=5))&&<div className={`fantasy-world-status${worldV2?' wv2-host-status':''}`} role="status">
        {(terrainStatus?.pending||terrainStatus?.error)&&<span>{terrainStatus.error?'Some map details couldn’t load.':'Opening map details…'}{terrainStatus.error&&<button onClick={terrainStatus.retry}>TRY AGAIN</button>}</span>}
        {(globe.error||globe.pending&&!terrainStatus?.pending)&&<span>{globe.error?'Couldn’t load your deeds. Please try again.':'Loading your deeds…'}{globe.error&&<button onClick={globe.retry}>TRY AGAIN</button>}</span>}
        {viewport.data?.truncated&&<span>Showing nearby deeds from {viewport.data.matched}. Zoom closer for each parcel.</span>}
        {viewport.error&&view.zoom>=5&&<span>Nearby deeds unavailable. <button onClick={viewport.retry}>RETRY NEARBY</button></span>}
      </div>;
  const panelTitle=parcelHelp?'MY PARCEL':warzoneOpen?'WARZONE':explore?'EXPLORE':tile?`TILE ${tile.tileId}`:realm.name;
  return <div className={`fantasy-world ${panelOpen?'':'panel-closed'} ${opening?'world-opening':''}${worldV2?' world-v2-live':''}`}>
    {hostHeader&&<header className="fantasy-world-top" style={{height:MAPCHROME.bar,minHeight:MAPCHROME.bar}}><button onClick={()=>setScreen('base')}>‹ BASE</button><strong>THE SHATTERED REALMS</strong><button aria-pressed="true">WORLD</button><button onClick={()=>setMapTab('campaign')}>CAMPAIGN</button></header>}
    {hostChrome&&<nav inert={opening} ref={rail} className="fantasy-realm-rail" style={{minHeight:MAPCHROME.bar}} aria-label="Realms">{FANTASY_REALMS.map((r,i)=><button key={r.id} data-realm={r.id} aria-pressed={r.id===realmId&&!explore} onClick={()=>focusRealm(r.id)} onKeyDown={e=>{const d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(d){e.preventDefault();const next=FANTASY_REALMS[(i+d+FANTASY_REALMS.length)%FANTASY_REALMS.length]!;focusRealm(next.id);rail.current?.querySelector<HTMLButtonElement>(`[data-realm="${next.id}"]`)?.focus();}}}><i style={{background:r.color}}/><span>{r.name}<small>{r.nav}</small></span></button>)}</nav>}
    <main className="fantasy-world-main" inert={opening}><section className="fantasy-world-stage" data-tutorial-target={!entryPaid?'land-globe-cell':undefined} onPointerDownCapture={()=>{interacted.current=true;}}>
      {worldV2?<WorldV2Boundary onFail={fallbackTo2D}><Suspense fallback={null}><WorldV2 ref={control} {...globeProps} fallbackTo2D={fallbackTo2D} hud={worldHud}
        onSpecialIsland={()=>{interacted.current=true;selectTile(null);}}
        onViewportBounds={bounds=>setViewportSize(previous=>sameBounds(previous.bounds,bounds)?previous:{...previous,bounds})}/></Suspense></WorldV2Boundary>
        :<FantasyGlobe ref={control} {...globeProps}/>}
      {!hostChrome&&status}
      {hostChrome&&<div className="fantasy-world-tools"><button className="fantasy-explore-trigger" aria-expanded={!!explore&&panelOpen} onClick={()=>{selectTile(null);setExplore('list');setPanelOpen(true);}}>EXPLORE</button><form role="search" className="fantasy-owner-search" onSubmit={event=>{event.preventDefault();const first=search.data?.[0];if(first){selectTile(getFantasyTile(first.tileId));control.current?.focusTile(first.tileId);}}}>
        <input aria-label="Find land owner" placeholder="Find land owner…" autoComplete="off" maxLength={96} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setQuery('');}}}/>{query&&<button type="button" aria-label="Clear owner search" onClick={()=>setQuery('')}>×</button>}
        {query.trim().length>=2&&<div className="fantasy-owner-results" aria-live="polite">{search.pending&&<p>Searching owners…</p>}{search.error&&<p>Owner search unavailable. <button type="button" onClick={search.retry}>RETRY</button></p>}{search.data?.length===0&&<p>No matching land owners.</p>}{search.data?.map(owner=><button type="button" key={owner.tileId} onClick={()=>{selectTile(getFantasyTile(owner.tileId));control.current?.focusTile(owner.tileId);}}>{owner.name}<small>{FANTASY_REALMS.find(r=>r.id===owner.realmId)?.name} · KEEP {owner.keepLevel} · {owner.trophies} trophies{owner.seeker?' · SEEKER':''}</small></button>)}</div>}
      </form>{globe.data?.warzone?.active&&<button className="fantasy-warzone-badge" onClick={()=>{selectTile(null);setWarzoneOpen(true);setPanelOpen(true);}}>WARZONE</button>}<button onClick={openMyParcel}>MY PARCEL</button><GlobeBaseCounts directory={directory} onOpenBases={()=>setScreen('bases')}/>
      {status}</div>}
    </section>{hostChrome&&<aside className="fantasy-world-panel"><button className="fantasy-panel-toggle" aria-expanded={panelOpen} aria-label={`${panelOpen?'Collapse':'Open'} ${panelTitle} details`} onClick={()=>setPanelOpen(!panelOpen)}>{panelTitle}{!panelOpen&&' DETAILS'} <span aria-hidden="true">{panelOpen?'−':'+'}</span></button>
    {panelOpen&&<div className="fantasy-panel-content">{parcelHelp?<>
      <small className="fantasy-kicker">YOUR WORLD PARCEL</small><h1>{globe.pending?'Finding your land…':globe.error?'Land lookup unavailable':myParcel?'Your parcel is ready':'No assigned parcel yet'}</h1>
      {globe.pending?<p role="status">Reading your owned deeds. You can try My Parcel again when the lookup finishes.</p>:globe.error?<><p>Your land is unchanged. Retry the lookup to locate your parcel.</p><button className="fantasy-primary" onClick={globe.retry}>RETRY LAND LOOKUP</button></>:myParcel?<button className="fantasy-primary" onClick={openMyParcel}>SHOW MY PARCEL</button>:<><p>{hasPaidBase?'Your deed has no world parcel shown yet. Open Your Bases to review its status or manage an eligible inactive deed.':'Your starting base has no world parcel yet. Inspect available land to choose a Land Deed parcel.'}</p>{!hasPaidBase&&<button className="fantasy-primary" onClick={()=>{const destination=realmId==='seeker-reach'?FANTASY_REALMS[3]!:realm;selectTile(null);setRealmId(destination.id);control.current?.setView({lon:destination.lon,lat:destination.lat,zoom:16});}}>INSPECT AVAILABLE LAND</button>}</>}
      <button className="fantasy-primary" onClick={()=>setScreen('bases')}>OPEN YOUR BASES</button>
    </>:warzoneOpen?<><button onClick={()=>setWarzoneOpen(false)}>‹ WORLD</button><WarzoneDetails onShop={()=>setScreen('shop')}/></>:explore?(<>
      <small className="fantasy-kicker">FUTURE RESOURCE EXPEDITIONS</small><h1>{activeChain?.name??'The outer archipelagos'}</h1><p>{activeChain?.lore??'Seven island chains lie beyond the realm coastlines. These gameplay destinations cannot be owned.'}</p>
      <div className="fantasy-explore-list">{!activeChain?FANTASY_CHAINS.map(chain=><button key={chain.id} onClick={()=>openExplore({chainId:chain.id,islandId:null})}>{chain.name}<small>{chain.islands.length} islands · exploration locked</small></button>):<><button onClick={()=>setExplore('list')}>‹ ALL ARCHIPELAGOS</button><button onClick={()=>openExplore({chainId:activeChain.id,islandId:null})}>CHAIN OVERVIEW</button>{activeChain.islands.map((_,i)=><button key={i} aria-pressed={explore!=='list'&&explore.islandId===`${activeChain.id}-${i+1}`} onClick={()=>openExplore({chainId:activeChain.id,islandId:`${activeChain.id}-${i+1}`})}>{activeChain.name} · Island {i+1}</button>)}</>}</div>
      <div className="fantasy-reserved">Exploration locked — coming later</div><button className="fantasy-primary" disabled>DISPATCH LOCKED</button><p className="fantasy-muted">No land deeds are issued for these islands.</p>
    </>):tile?(<>
      <small className="fantasy-kicker">{realm.name} · LAND DEED TILE</small><h1>Tile {tile.tileId}</h1><p className="fantasy-muted">{Math.abs(tile.lat).toFixed(2)}°{tile.lat<0?'S':'N'} · {Math.abs(tile.lon).toFixed(2)}°{tile.lon<0?'W':'E'}</p>
      {tile.allocation!=='ordinary'?<><div className="fantasy-reserved">{tile.allocation==='genesis'?'Genesis owner award allocation':'Reserved for Seeker owners'}</div><p>{tile.allocation==='genesis'?'This tile belongs to the 2,000-tile Genesis Land Deed owner award pool.':'This land is reserved for Seeker owners.'} Awards and claims are not open.</p></>:<>
        {parcel.pending&&<p role="status">Checking this parcel…</p>}{parcel.error&&<p role="alert">{landGate?'Acquire a Land Deed to inspect occupied bases.':parcel.error.message} {!landGate&&<button onClick={parcel.retry}>RETRY</button>}</p>}
        {parcel.data?.availability==='available'&&<><div className="fantasy-reserved">AVAILABLE LAND</div><p>The server will reserve this tile before payment.</p><div data-tutorial-target="land-globe-confirm"><button className="fantasy-primary" aria-label="CHOOSE LAND" onClick={chooseLand} disabled={!directory}>CHOOSE THIS LAND</button></div></>}
        {parcel.data?.availability==='held'&&<p>This parcel is held by an existing reservation.</p>}
        {parcel.data?.availability==='occupied'&&!detail&&<p>This land is already assigned. Its base is not currently available for inspection.</p>}
        {ownTile&&<button className="fantasy-primary" onClick={()=>ownTile.active?void openBase(ownTile.baseId):setScreen('bases')} disabled={busy}>{ownTile.active?'OPEN THIS BASE':'MANAGE INACTIVE DEED'}</button>}
        {detail&&<><h2>{detail.player.name}</h2>{!ownTile&&<><div className="fantasy-actions fantasy-parcel-actions"><button onClick={()=>void scout()} disabled={busy||!detail.actions.scout.allowed}>{busy?'SCOUTING…':'SCOUT'}</button><button className="fantasy-primary" onClick={attack} disabled={busy||!detail.actions.attack.allowed}>RAID</button></div>{!detail.actions.scout.allowed&&<p className="fantasy-muted">{parcelActionBlockText(detail.actions.scout.blockedBy,{shield:detail.shield})}</p>}{!detail.actions.attack.allowed&&<p className="fantasy-muted">{parcelActionBlockText(detail.actions.attack.blockedBy,{keepReach:detail.actions.attack.keepReach,shield:detail.shield})}</p>}<p className="fantasy-muted">Available loot · {detail.availableLootRanges.threeStars.min}–{detail.availableLootRanges.threeStars.max} shards at 3★</p></>}<p>KEEP {detail.player.keepLevel} · {detail.player.trophies.toLocaleString()} trophies</p>{image&&<img className="fantasy-deed-picture" src={image} alt={`${detail.player.name}'s deeded base`} onError={e=>recoverDeedImage(e.currentTarget,detail.deed.assetId?`/deed/asset/${encodeURIComponent(detail.deed.assetId)}.png`:`/deed/${encodeURIComponent(detail.player.wallet)}.png`)}/>}<FantasyShieldStatus key={`${authority.key}:${selected}`} detail={detail} onExpire={parcel.retry}/><p>{detail.base.completedStructures} structures · {detail.base.walls} walls</p>
        </>}
      </>}{actionError&&<p role="alert">{actionError}</p>}<button onClick={()=>selectTile(null)}>‹ REALM OVERVIEW</button>
    </>):(<>
      <small className="fantasy-kicker">{realm.landscape}</small><h1 style={{color:realm.color}}>{realm.name}</h1><p className="fantasy-epithet">{realm.epithet}</p><p>{realm.lore}</p>
      <dl className="fantasy-realm-counts"><div><dt>Deed tiles</dt><dd>{counts?.total.toLocaleString()??'—'}</dd></div><div><dt>Assigned</dt><dd>{counts?.occupied.toLocaleString()??'—'}</dd></div><div><dt>Available</dt><dd>{counts?.available.toLocaleString()??'—'}</dd></div></dl>
      {realmId==='seeker-reach'&&<><button className="fantasy-primary" onClick={()=>{control.current?.setView({lon:-115,lat:38,zoom:3.8});selectTile(null);}}>GENESIS SANCTUARY</button><p className="fantasy-muted">2,000 Genesis award tiles · 3,582 Seeker tiles. Both allocations remain reserved.</p></>}
      <button className="fantasy-primary" onClick={()=>control.current?.setView({lon:realm.lon,lat:realm.lat,zoom:16})}>INSPECT LAND TILES</button>
      <p className="fantasy-muted">{FANTASY_WORLD.totalTiles.toLocaleString()} deed tiles across eight realms. Exploration islands cannot be owned.</p>
    </>)}</div>}</aside>}</main>
    {opening&&<div className="fantasy-world-loading sk-game-loading-shell">
      <GameLoading title={terrainStatus?.error?'Couldn’t open the world':'Opening the world…'}
        failed={!!terrainStatus?.error} detail={terrainStatus?.error?'Check your connection and try again.':undefined} reduceMotion={reduceMotion}>
        {terrainStatus?.error&&<button onClick={terrainStatus.retry}>TRY AGAIN</button>}
      </GameLoading>
    </div>}
  </div>;
}
