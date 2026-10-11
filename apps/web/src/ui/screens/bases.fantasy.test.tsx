/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fantasyTileAt } from '@shardkeep/shared/fantasyWorld';
import { api, type BasesDto } from '../../lib/api';
import { useApp } from '../../state/store';

vi.mock('../fantasy/data',()=>{
  const empty=()=>({data:null,pending:false,error:null,retry:vi.fn()});
  return {useFantasyDirectory:empty,useFantasyViewport:empty,useFantasySearch:empty,
    useFantasyParcel:(_:unknown,tileId:number|null)=>({...empty(),data:tileId===null?null:{availability:'available',detail:null}})};
});
vi.mock('../fantasy/FantasyGlobe',async importOriginal=>{
  const actual=await importOriginal<typeof import('../fantasy/FantasyGlobe')>();
  return {...actual,FantasyGlobe:({onSelect}:{onSelect(tile:ReturnType<typeof fantasyTileAt>):void})=><button onClick={()=>onSelect(fantasyTileAt(26,23))}>INSPECT ORDINARY TEST TILE</button>};
});
vi.mock('../../lib/mobileBackGuard',()=>({useMobileBackHandler:vi.fn()}));
import { FantasyWorldLayer } from '../fantasy/FantasyWorldLayer';
import BasesScreen from './bases';

let root:Root,host:HTMLDivElement;
const tile=fantasyTileAt(26,23)!;
function directory(count=1):BasesDto {
  return {enabled:true,worldId:'fantasy-v1',maxActive:5,nextLandPurchaseKind:'deed',
    capabilities:{baseScopedReads:true,baseScopedMutations:true,cellReservations:true},
    bases:Array.from({length:count},(_,i)=>({id:`base-${i}`,deedAssetId:`mint-${i}`,status:'active',slot:(i+1) as 1|2|3|4|5,
      keepLevel:5,builders:2,expansions:0,landPaidAt:'2026-09-10',earthCell:null,countryA3:null,fantasyLocation:tile}))};
}
function Route(){const screen=useApp(s=>s.screen);return screen==='bases'?<BasesScreen/>:screen==='entry'?<output>CHECKOUT</output>:<FantasyWorldLayer/>;}
const button=(text:string)=>[...host.querySelectorAll('button')].find(node=>node.textContent?.includes(text))!;
beforeEach(()=>{
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  vi.stubEnv('VITE_FEATURE_FANTASY_WORLD','1');
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  useApp.getState().setAuth('test-wallet');
  useApp.setState({screen:'map',mapTab:'world',selectedBaseId:'base-0',baseDirectory:directory(),entryPaid:true,landPurchase:null});
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();useApp.getState().setAuth(null);vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('WORLD → base directory → native land selection',()=>{
  it('shows the persisted realm and sends the chosen ordinary tile to checkout without a payment mutation',async()=>{
    const read=vi.spyOn(api,'get').mockResolvedValue(directory()),pay=vi.spyOn(api,'postRaw');
    await act(async()=>root.render(<Route/>));
    await act(async()=>button('YOUR BASES').click());
    expect(read).toHaveBeenCalledWith('/bases');
    expect(host.textContent).toContain(`CROWNLANDS · TILE ${tile.tileId}`);
    expect(host.textContent).toContain('YOUR NEXT LAND TILE');
    expect(host.textContent).not.toContain('EARTH');
    await act(async()=>button('BUY ANOTHER LAND DEED').click());
    // worldIntent: World v2 opens in choose-land mode for a deed purchase (its hint), D-186.
    expect(useApp.getState()).toMatchObject({screen:'map',mapTab:'world',worldIntent:'choose-land',landPurchase:{kind:'deed',earthCell:null}});
    await act(async()=>button('INSPECT ORDINARY TEST TILE').click());
    await act(async()=>button('CHOOSE THIS LAND').click());
    expect(useApp.getState()).toMatchObject({screen:'entry',landPurchase:{kind:'deed',earthCell:null,
      landAddress:{kind:'fantasy',worldId:'fantasy-v1',tileId:tile.tileId}}});
    expect(pay).not.toHaveBeenCalled();
  });
  it('preserves the server purchase rail and five active slots when an extra deed would be inactive',async()=>{
    const fresh={...directory(5),nextLandPurchaseKind:'entry' as const};
    vi.spyOn(api,'get').mockResolvedValue(fresh);
    useApp.setState({screen:'bases',baseDirectory:fresh,entryPaid:true});
    await act(async()=>root.render(<Route/>));
    expect(host.textContent).toContain('5 / 5');
    expect(host.textContent).toContain('AN ADDITIONAL DEED STAYS INACTIVE');
    await act(async()=>button('BUY ANOTHER LAND DEED').click());
    expect(useApp.getState()).toMatchObject({screen:'map',landPurchase:{kind:'entry',earthCell:null}});
    expect(useApp.getState().baseDirectory?.bases).toHaveLength(5);
  });
  it('never sends a migrated flag-off client back into the Earth purchase picker',async()=>{
    vi.stubEnv('VITE_FEATURE_FANTASY_WORLD','0');
    vi.spyOn(api,'get').mockResolvedValue(directory());useApp.setState({screen:'bases'});
    await act(async()=>root.render(<Route/>));
    expect(host.textContent).toContain(`CROWNLANDS · TILE ${tile.tileId}`);
    expect(host.textContent).not.toContain('EARTH');
    expect(button('BUY ANOTHER LAND DEED').disabled).toBe(true);
    expect(host.textContent).toContain('UPDATE THE GAME');
  });
});
