import { versionedPublicAsset } from '../lib/version';

/** Owner-authored inventory icons live outside the generated Phaser atlas.
 * Keep this resolver in the lazy UI graph so Shop and Inventory render the
 * same item identity without pulling the handout subset into first paint. */
const ITEM_ART: Readonly<Record<string, string>> = {
  gem: versionedPublicAsset('/items/pe/gem-64.png'),
  itm_helm: new URL('../../../../art/source/inventory/itm_helm.svg', import.meta.url).href,
  itm_amulet: new URL('../../../../art/source/inventory/itm_amulet.svg', import.meta.url).href,
  itm_chest: new URL('../../../../art/source/inventory/itm_chest.svg', import.meta.url).href,
  itm_cloak: new URL('../../../../art/source/inventory/itm_cloak.svg', import.meta.url).href,
  itm_gloves: new URL('../../../../art/source/inventory/itm_gloves.svg', import.meta.url).href,
  itm_ring: new URL('../../../../art/source/inventory/itm_ring.svg', import.meta.url).href,
  itm_boots: new URL('../../../../art/source/inventory/itm_boots.svg', import.meta.url).href,
  itm_banner: new URL('../../../../art/source/inventory/itm_banner.svg', import.meta.url).href,
  itm_hammer: new URL('../../../../art/source/inventory/itm_hammer.svg', import.meta.url).href,
  itm_shield: new URL('../../../../art/source/inventory/itm_shield.svg', import.meta.url).href,
  itm_deed_earth: new URL('../../../../art/source/inventory/itm_deed_earth.svg', import.meta.url).href,
};

export function itemArtUrl(asset: string): string | null {
  return ITEM_ART[asset] ?? null;
}
