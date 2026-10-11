# Ordinary Phase E Market source admission

Scope: the four ordinary Market visual tiers only. The original services manifest
is copied byte-for-byte, including its historical status and Lodge entries; Lodge
pixels are excluded. No masters, generated art, economy, renderer or release is
changed. This adds exact source/atlas evidence for the pending C3 ordinary default.

## Four integration answers (recorded before loader code)

1. Scale: native 1× source density. Building cells are 112×112, drawScale 1;
   the 80×80 sourceCell/packingOffset describes authoring provenance, not another
   runtime crop. Pack only @1x. World/deed scale remains the protected consumer's
   responsibility and requires visual acceptance.
2. Indexing: authored strips use zero-based crop positions. Packed `_f<N>` keys
   are one-based. Working has eight frames at 8 fps looping; construction and
   collapse have nine at 8 fps one-shot; ready FX has eight. Reduced-motion
   selection is frame 0 unless a source says otherwise. Authored working/ready
   clips do not establish that a Market has a gameplay work/completion event.
3. Anchor: every tier has authored pivot/contact [56,104] and footprint [2,2].
   E1 seats the full cell bottom [56,112] on the footprint south edge, not the
   contact line or footprint centre. Metadata retains both. FX uses the centre
   anchor and exact authored ready overlay offset [24,0].
4. Tiers: four visual tiers, not twenty levels. Consumer completed-level mapping
   must derive existing shared Market maximum level and visualTiers, preserve
   current completed tier during upgrade, and treat initial construction separately.

## Exact admission and dependency routing

Source: `production-assets/services/manifest.json` under the named root in
`docs/phase-e/asset-package.lock.json`. SHA256:
f7cbf1bf9646d31baf5d7fcd0706e85348f24c199022dde22292adb3e19f1885.
Runtime index SHA256:
04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181.
`provenance.json` freezes exactly 30 indexed files / 329,134 bytes: the original
manifest, 20 Market PNGs, four shared scaffold endpoints, four rubble rasters and
one shared ready-FX strip. The nine shared PNGs already exist byte-identically;
this admission does not rewrite them or the cosmetic provenance/bindings.

Four on-demand groups `pe_market_t1` through `pe_market_t4` are independently
loadable at native 1×. Each packs 29 building/rubble frames and eight ready-effect
frames (37 per group; 148 total). Clips are `pe_market_t<T>_<state>` plus
`pe_market_t<T>_ready_fx`; frame keys append `_f<N>`. Each `ready` aliases the exact
idle keys plus that same tier group's effect. `destroyed` resolves the manifest's
Workshop rubble alias into the tier group. There is no cosmetics dependency.

`meta.peMarket` and `pe_market.manifest.json` carry identical versioned metadata:
family, atlas groups, scale/index conventions, source manifest/index/provenance
hashes and a clips map. Each clip carries source path/hash, cell geometry, seat,
source pivot/footprint, fps/loop/reduced frame, source-indexed frame keys/RGBA hashes,
and any ready alias/overlay. These are exact source facts, not delivery readiness.

The original t1 construction strip was visually inspected; its scaffold-to-Market
transition is retained. Live animation, world scale, battle/deed parity and native
rendering remain separate C3 acceptance obligations. No protected consumer changed.
