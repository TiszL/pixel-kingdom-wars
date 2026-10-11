/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FANTASY_CATALOG_HASH, fantasyTileAt } from '@shardkeep/shared/fantasyWorld';
import type { BasesDto } from '../../lib/api';
import type { FantasyGlobeData, FantasyParcelData, FantasyOwnedTile } from './data';
import type { FantasyGlobeProps } from './FantasyGlobe';
import type { FantasyGlobeHandle } from './types';

const transport=vi.hoisted(()=>({
  data:null as FantasyGlobeData|null,pending:false,error:null as Error|null,retry:vi.fn(),
  parcel:null as FantasyParcelData|null,props:null as FantasyGlobeProps|null,
  search:[] as Array<{tileId:number;realmId:string;name:string;keepLevel:number;trophies:number}>,
  focusTile:vi.fn(),focusRealm:vi.fn(),setView:vi.fn(),get:vi.fn(),openBase:vi.fn(),emit:vi.fn(),
}));
vi.mock('./data',()=>({
  useFantasyDirectory:()=>({data:transport.data,pending:transport.pending,error:transport.error,retry:transport.retry}),
  useFantasyParcel:()=>({data:transport.parcel,pending:false,error:null,retry:vi.fn()}),
  useFantasyViewport:()=>({data:null,pending:false,error:null,retry:vi.fn()}),
  useFantasySearch:()=>({data:transport.search,pending:false,error:null,retry:vi.fn()}),
}));
vi.mock('./FantasyGlobe',async importOriginal=>{
  const actual=await importOriginal<typeof import('./FantasyGlobe')>(),react=await import('react');
  return {...actual,FantasyGlobe:react.forwardRef<FantasyGlobeHandle,FantasyGlobeProps>((props,ref)=>{
    transport.props=props;
    react.useEffect(()=>props.onTerrainStatus?.({ready:true,pending:false,error:null,retry:()=>{}}),[props.onTerrainStatus]);
    react.useImperativeHandle(ref,()=>({focusTile:transport.focusTile,focusRealm:transport.focusRealm,
      setView:transport.setView,focusIsland:vi.fn(),view:()=>({lon:26,lat:23,zoom:1}),stats:()=>null}));
    return null;
  })};
});
vi.mock('../../lib/api',async importOriginal=>({...await importOriginal<typeof import('../../lib/api')>(),api:{get:transport.get}}));
vi.mock('../../state/baseSnapshot',()=>({selectBaseSnapshot:transport.openBase}));
vi.mock('../../lib/events',()=>({bus:{emit:transport.emit}}));
vi.mock('../../lib/mobileBackGuard',()=>({useMobileBackHandler:vi.fn()}));
vi.mock('./FantasyShieldStatus',()=>({FantasyShieldStatus:()=>null}));
import { useApp } from '../../state/store';
import { FantasyWorldLayer } from './FantasyWorldLayer';

const crown=fantasyTileAt(26,23)!;
const originalState=useApp.getState();
let host:HTMLDivElement,root:Root;
function directory(paid=false):BasesDto {
  return {enabled:true,worldId:'fantasy-v1',maxActive:5,nextLandPurchaseKind:'entry',
    capabilities:{baseScopedReads:true,baseScopedMutations:true,cellReservations:true},
    bases:[{id:'starter',deedAssetId:null,status:'active',keepLevel:1,builders:1,expansions:0,
      landPaidAt:paid?'2026-09-10T00:00:00Z':null,slot:1,earthCell:null,countryA3:null}]};
}
function world(ownedTiles:FantasyOwnedTile[]=[],selectedTileId:number|null=null):FantasyGlobeData {
  return {worldId:'fantasy-v1',catalogHash:FANTASY_CATALOG_HASH,ready:true,realms:[],
    me:{baseId:'starter',selectedTileId,ownedTiles}};
}
function owner(active=true):FantasyOwnedTile {
  return {tileId:crown.tileId,baseId:'assigned-base',realmId:crown.realmId,name:'My keep',keepLevel:2,active,selected:false};
}
function parcel():FantasyParcelData {
  return {worldId:'fantasy-v1',tile:crown,availability:'occupied',detail:{
    player:{wallet:'defender-wallet',name:'REAL KEEPER',avatarUrl:null,clanTag:null,seeker:false,keepLevel:4,trophies:1200},
    deed:{assetId:'asset',status:'minted',metadata:{name:'Land Deed',symbol:'DEED',description:'A base',external_url:'/deed/asset.json',image:'/deed/defender.png',attributes:[]}},
    base:{id:'defender-base',completedStructures:22,defenses:6,walls:30,landWidth:18},
    shield:{active:false,source:null,expiresAt:null,remainingMs:0,suppressedByWarzone:false},
    warzone:{active:false,boundaryAt:null,remainingMs:null},shielded:false,
    actions:{scout:{allowed:true,blockedBy:null},attack:{allowed:false,blockedBy:'keep_too_far_below',keepReach:{attackerKeep:11,defenderKeep:4,minDefenderKeep:9}}},
    availableLootRanges:{oneStar:{min:'100',max:'299'},twoStars:{min:'250',max:'599'},threeStars:{min:'500',max:'999'}},
  }};
}
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===text)!;
const mount=async()=>{await act(async()=>root.render(<FantasyWorldLayer/>));};
beforeEach(()=>{
  (globalThis as typeof globalThis &{IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  transport.data=world();transport.pending=false;transport.error=null;transport.parcel=null;transport.search=[];
  useApp.setState({...originalState,wallet:'viewer',selectedBaseId:'starter',entryPaid:false,baseDirectory:directory(),screen:'map',landPurchase:null});
});
afterEach(async()=>{
  await act(async()=>root.unmount());host.remove();useApp.setState(originalState,true);vi.resetAllMocks();
});

describe('My Parcel follows assigned ownership, never inventing geography',()=>{
  it.each(['realm','parcel','explore'] as const)('collapses %s details to a focusable reopen control and releases the camera',async(context)=>{
    transport.data=world([owner()]);await mount();
    if(context==='parcel')await act(async()=>button('MY PARCEL').click());
    if(context==='explore')await act(async()=>button('EXPLORE').click());
    const toggle=host.querySelector<HTMLButtonElement>('.fantasy-panel-toggle')!;
    const title=toggle.textContent!.replace(' −','');
    expect(transport.props!.panelOpen).toBe(true);
    toggle.focus();
    await act(async()=>toggle.click());
    expect(host.querySelector('.fantasy-world')?.classList.contains('panel-closed')).toBe(true);
    expect(host.querySelector('.fantasy-panel-content')).toBeNull();
    expect(transport.props!.panelOpen).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe(`Open ${title} details`);
    expect(toggle.textContent).toContain(`${title} DETAILS`);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.tabIndex).toBe(0);
    await act(async()=>toggle.click());
    expect(transport.props!.panelOpen).toBe(true);
    expect(host.querySelector('.fantasy-panel-content')).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe(`Collapse ${title} details`);
  });
  it('helps an unplotted starter inspect land without selecting or reserving a parcel',async()=>{
    await mount();expect(button('MY PARCEL').disabled).toBe(false);
    await act(async()=>button('MY PARCEL').click());
    expect(host.textContent).toContain('No assigned parcel yet');
    expect(host.textContent).toContain('Your starting base has no world parcel yet');
    await act(async()=>button('INSPECT AVAILABLE LAND').click());
    expect(transport.setView).toHaveBeenCalledWith(expect.objectContaining({zoom:16}));
    expect(transport.props!.selectedTileId).toBeNull();
    expect(useApp.getState().landPurchase).toBeNull();
    expect(transport.get).not.toHaveBeenCalled();
  });
  it('focuses another assigned active base when the selected starter has no parcel',async()=>{
    transport.data=world([owner()]);await mount();
    await act(async()=>button('MY PARCEL').click());
    expect(transport.focusTile).toHaveBeenCalledWith(crown.tileId);
    expect(transport.props!.selectedTileId).toBe(crown.tileId);
    expect(button('OPEN THIS BASE').disabled).toBe(false);
    transport.openBase.mockResolvedValue(true);
    await act(async()=>button('OPEN THIS BASE').click());
    expect(transport.openBase).toHaveBeenCalledWith('assigned-base');
    expect(useApp.getState().screen).toBe('base');
  });
  it('keeps an inactive assigned deed reachable even when public inspection has no detail',async()=>{
    transport.data=world([owner(false)]);transport.parcel={worldId:'fantasy-v1',tile:crown,availability:'occupied',detail:null};await mount();
    await act(async()=>button('MY PARCEL').click());
    expect(transport.props!.selectedTileId).toBe(crown.tileId);
    await act(async()=>button('MANAGE INACTIVE DEED').click());
    expect(useApp.getState().screen).toBe('bases');expect(transport.openBase).not.toHaveBeenCalled();
  });
  it('directs a paid unassigned deed to Your Bases without offering another land purchase',async()=>{
    useApp.setState({baseDirectory:directory(true),entryPaid:true});await mount();
    await act(async()=>button('MY PARCEL').click());
    expect(host.textContent).toContain('Your deed has no world parcel shown yet');
    expect(button('INSPECT AVAILABLE LAND')).toBeUndefined();
    await act(async()=>button('OPEN YOUR BASES').click());expect(useApp.getState().screen).toBe('bases');
  });
  it('distinguishes a pending or failed lookup from no ownership and recovers when data arrives',async()=>{
    transport.data=null;transport.pending=true;await mount();await act(async()=>button('MY PARCEL').click());
    expect(host.textContent).toContain('Finding your land');expect(host.textContent).not.toContain('No assigned parcel');
    transport.pending=false;transport.error=new Error('Offline');await mount();
    expect(host.textContent).toContain('Land lookup unavailable');
    await act(async()=>button('RETRY LAND LOOKUP').click());expect(transport.retry).toHaveBeenCalledOnce();
    transport.error=null;transport.data=world([owner()]);await mount();
    expect(host.textContent).toContain('Your parcel is ready');
    await act(async()=>button('SHOW MY PARCEL').click());expect(transport.focusTile).toHaveBeenCalledWith(crown.tileId);
  });
});

describe('real owner inspection and scouting',()=>{
  it('search submits the returned real parcel, puts scout before the image, and retains server raid blocks',async()=>{
    transport.search=[{tileId:crown.tileId,realmId:crown.realmId,name:'REAL KEEPER',keepLevel:4,trophies:1200}];transport.parcel=parcel();await mount();
    await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(transport.focusTile).toHaveBeenCalledWith(crown.tileId);expect(transport.props!.selectedTileId).toBe(crown.tileId);
    const scout=button('SCOUT'),image=host.querySelector('img.fantasy-deed-picture')!;
    expect(scout.disabled).toBe(false);expect(button('RAID').disabled).toBe(true);
    expect(scout.compareDocumentPosition(image)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.textContent).toContain('L4');expect(host.textContent).toContain('L11');
    transport.get.mockResolvedValue({name:'REAL KEEPER',keepLevel:4,trophies:1200,previewSec:10,visualContext:{worldId:'fantasy-v1',biome:'crownlands',artVersion:2}});
    await act(async()=>scout.click());
    expect(transport.get).toHaveBeenCalledWith('/map/scout/defender-base?baseId=starter');
    expect(useApp.getState().screen).toBe('scout');
    expect(transport.emit).toHaveBeenCalledWith('battle:enter',expect.objectContaining({scout:true,visualContext:expect.objectContaining({artVersion:2})}));
  });
  it('does not navigate from a stale scouting response after a newer world selection',async()=>{
    transport.parcel=parcel();await mount();await act(async()=>transport.props!.onSelect(crown));
    let finish!:(value:unknown)=>void;transport.get.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    await act(async()=>button('SCOUT').click());expect(button('SCOUTING…').disabled).toBe(true);
    await act(async()=>button('EXPLORE').click());
    await act(async()=>finish({name:'Old target',keepLevel:4,trophies:1200,previewSec:10}));
    expect(useApp.getState().screen).toBe('map');expect(transport.emit).not.toHaveBeenCalled();
    expect(host.querySelector('.fantasy-panel-content')?.textContent).toContain('The outer archipelagos');
  });
});
