import { afterEach, describe, expect, it, vi } from 'vitest';
import { fantasyTileAt } from '@shardkeep/shared/fantasyWorld';
import type { BasesDto, WalletBaseDto } from './api';
import { baseLocationLabel, fantasyDirectory } from './baseLocation';

const base: WalletBaseDto = { id:'base-a',deedAssetId:'mint-a',status:'active',slot:1,keepLevel:5,
  builders:2,expansions:0,landPaidAt:'2026-09-10',earthCell:4321,countryA3:'GEO' };
const directory=(row:WalletBaseDto):BasesDto=>({enabled:true,maxActive:5,nextLandPurchaseKind:'deed',bases:[row],
  capabilities:{baseScopedReads:true,baseScopedMutations:true,cellReservations:true}});
afterEach(()=>vi.unstubAllEnvs());
describe('public stable deed location',()=>{
  it('names the persisted realm and tile instead of the historical Earth binding',()=>{
    const tile=fantasyTileAt(26,23)!;
    expect(baseLocationLabel({...base,fantasyLocation:tile},true)).toBe(`CROWNLANDS · TILE ${tile.tileId}`);
  });
  it('keeps unassigned and held deeds private after durable cutover with the client flag off',()=>{
    vi.stubEnv('VITE_FEATURE_FANTASY_WORLD','0');
    const scope=fantasyDirectory({...directory(base),worldId:'fantasy-v1'});
    expect(scope).toBe(true);
    expect(baseLocationLabel({...base,status:'inactive',slot:null},scope)).toBe('DEED LOCATION PENDING');
    expect(baseLocationLabel({...base,landPaidAt:null,deedAssetId:null},scope)).toBe('NO DEEDED LAND');
  });
  it('recognizes assigned locations on compatible servers without the world envelope',()=>{
    vi.stubEnv('VITE_FEATURE_FANTASY_WORLD','0');
    expect(fantasyDirectory(directory({...base,fantasyLocation:fantasyTileAt(26,23)!}))).toBe(true);
  });
  it('retains Earth identity only before cutover with the fantasy client disabled',()=>{
    vi.stubEnv('VITE_FEATURE_FANTASY_WORLD','0');
    expect(fantasyDirectory(directory(base))).toBe(false);
    expect(baseLocationLabel(base,false)).toBe('EARTH · 4321 · GEO');
    vi.stubEnv('VITE_FEATURE_FANTASY_WORLD','1');
    expect(baseLocationLabel(base,fantasyDirectory(directory(base)))).not.toContain('EARTH');
  });
});
