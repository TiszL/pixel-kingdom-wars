import {beforeEach,expect,it,vi} from 'vitest';
import type {BoundCosmeticAppearance} from '@shardkeep/shared/boundCosmeticApi';
import {BOUND_COSMETIC_IDS} from '@shardkeep/shared/phaseEBoundCosmetics';
import {boundCosmeticAwningApplicationReady} from '../src/game/boundCosmeticApplication';
const renderer=vi.hoisted(()=>({available:vi.fn(),binding:vi.fn()}));
vi.mock('../src/game/baseRender',()=>({baseRenderMarketArtAvailable:renderer.available,baseRenderAwningBinding:renderer.binding}));
// Synthetic renderer bindings test exact custody-to-art matching, not artwork pixels.
const appearances:BoundCosmeticAppearance[]=BOUND_COSMETIC_IDS.filter(id=>id!=='aurora_wake').map((outputId,index)=>({
 version:1,outputId,sourceId:`artisan-market-t${index+1}` as BoundCosmeticAppearance['sourceId'],
 sourceManifestSha256:'a'.repeat(64),sourceIndexSha256:'b'.repeat(64),bindingSha256:String(index+1).repeat(64),
}));
beforeEach(()=>{renderer.available.mockReturnValue(true);renderer.binding.mockImplementation((id:string)=>{
 const a=appearances.find(row=>row.outputId===id);return a?{sha256:a.bindingSha256,sourceManifestSha256:a.sourceManifestSha256,sourceIndexSha256:a.sourceIndexSha256}:null;
});});
it('requires the actual renderer to admit ordinary and Awning art before any binding can enable crafting',()=>{
 expect(boundCosmeticAwningApplicationReady(appearances)).toBe(true);renderer.available.mockReturnValue(false);
 expect(boundCosmeticAwningApplicationReady(appearances)).toBe(false);
});
it.each(['bindingSha256','sourceManifestSha256','sourceIndexSha256'] as const)('refuses a server appearance when %s differs from the admitted renderer',key=>{
 expect(boundCosmeticAwningApplicationReady(appearances.map((a,i)=>i===2?{...a,[key]:'f'.repeat(64)}:a))).toBe(false);
});
it('does not treat partial duplicate or Wake-only coverage as four-tier application readiness',()=>{
 expect(boundCosmeticAwningApplicationReady(appearances.slice(1))).toBe(false);
 expect(boundCosmeticAwningApplicationReady([appearances[0]!,...appearances.slice(0,-1)])).toBe(false);
 expect(boundCosmeticAwningApplicationReady([{...appearances[0]!,outputId:'aurora_wake',sourceId:'auroraWake'},...appearances.slice(1)])).toBe(false);
});
