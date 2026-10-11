/** Admission uses the actual deed renderer and exact database appearance, not a
 * feature flag or possession of a recipe. Client preview verification is separate. */
import type {BoundCosmeticAppearance} from '@shardkeep/shared/boundCosmeticApi';
import {BOUND_COSMETIC_IDS} from '@shardkeep/shared/phaseEBoundCosmetics';
import {baseRenderAwningBinding,baseRenderMarketArtAvailable} from './baseRender';

export function boundCosmeticAwningApplicationReady(appearances:readonly BoundCosmeticAppearance[]):boolean{
 const outputs=BOUND_COSMETIC_IDS.filter(id=>id!=='aurora_wake');
 if(!baseRenderMarketArtAvailable()||appearances.length!==outputs.length)return false;
 return outputs.every(output=>{
  const matches=appearances.filter(row=>row.outputId===output),binding=baseRenderAwningBinding(output);
  if(matches.length!==1||!binding)return false;
  const appearance=matches[0]!;
  return binding.sha256===appearance.bindingSha256&&binding.sourceManifestSha256===appearance.sourceManifestSha256
   &&binding.sourceIndexSha256===appearance.sourceIndexSha256;
 });
}
