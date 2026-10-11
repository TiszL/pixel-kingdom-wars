# Phase E bound cosmetic source admission

Scope: Artisan Market Awning tiers 1–4 and Aurora Wake, plus only their explicit
rubble, construction-endpoint and ready-effect dependencies. This is source/atlas
admission for accurate preview, not application in Base/Battle/deed/native or a
release. Profile utility NFT records in the original manifest are excluded.
No source is generated, resized, repainted or substituted.

## Four integration answers (recorded before loader implementation)

1. **Scale:** native 1× source density, as E1-ASSET-INTEGRATION §2 records: 112×112
   Awning cells and 64×64 effect cells, authored for 64 world pixels per tile.
   Pack only @1x. Do not apply v2's ×2; a later deed renderer at 32px tiles needs
   its separately reviewed 0.5 draw scale. No protected renderer is changed here.
2. **Indices:** strip positions are zero-based; house `_f<N>` keys are one-based.
   Record sourceIndex alongside each key and decoded RGBA hash. Wake's authored
   sourceFrameIndices [1..8] are provenance, not zero-based crop positions;
   reducedMotionFrame remains zero. Working/Wake loop at8fps; construction and
   collapse have9frames at8fps, one-shot. The shared ready effect has8frames.
3. **Anchor:** all Awning tiers declare pivot [56,104] and footprint [2,2]. Preserve
   that authored visual contact point. E1's selected seating rule uses the full
   source-cell bottom [56,112] on the footprint south edge; contact y104 must not
   be silently used as the seat or called a footprint-centre anchor. Metadata
   records both points and `cellBottomPivotX`. Effects use the E1 centre convention;
   the ready overlay retains exact authored offset [24,0].
4. **Tiers:** four visual tiers, not20 distinct levels. The existing shared tier
   mapping remains authoritative; this loader does not copy gameplay tuning or
   infer entitlement from a tier. No new footprint/gameplay authority is created.

## Provenance and aliases

The immutable source is production-assets under the root recorded in
`docs/phase-e/asset-package.lock.json`. Runtime index SHA256:
04f96c922ca04d93f1bf760e6385713908b971ce82c3aa022602f1fa199e2181.
Original cosmetics manifest SHA256:
b4b67f78efd4d74fa416e78822af9f0e037ad6d3bc30f3fc77127cd169292394.
The manifest is copied byte-for-byte, including its historical runtimeIntegrated
false and excluded profile records; new admission does not rewrite author evidence.
`provenance.json` contains only this exact runtime subset and the current package
zip/docs identity. Relative paths remain resolvable under art/source/phase-e.

Thirty PNGs are required:21 cosmetic sheets/statics, four matching Workshop rubble
rasters, four named construction endpoints, and the actual craft-success strip.
There are30 clip records and132 packed keys:116 Market +8 Wake +8 ready FX. Each
ready clip aliases its tier's idle frames plus the craft-success overlay; no
second idle image is packed. Destroyed uses that tier's exact Workshop rubble.
Construction/collapse endpoints are preserved and checked against named source
rasters, not generic silhouette substitutes.

Runtime clip names are `pe_cos_market_t<T>_<state>`, `pe_cos_wake` and
`pe_cos_ready_fx`; packed keys add `_f<N>`. All belong to on-demand `pe_cosmetics`
at1x. This selects E1's proposed cosmetics namespace without admitting unrelated
Phase E families. The generated sidecar records exact frames, source hashes,
anchors, aliases and preview timing; the source manifest itself is not runtime
metadata. Key collisions with existing roots must fail before generated output
is removed.

The source t1 idle and Wake strip were visually inspected. Full animated/browser
preview is root-owned and pending, and is required separately from pixel/hash
checks. Source/JVM evidence from the prior native task says nothing about this
art or Android rendering. No asset master or protected application path changed.

## Deterministic artifact binding

`meta.peCosmetics` and `pe_cosmetics.manifest.json` expose the same object.
`bindings[outputId]` is `{sha256,value}`. The digest is SHA-256 of UTF-8
`JSON.stringify(value)` with no whitespace, using the loader's explicit insertion
order: version, outputId, sourceId, sourceManifestSha256, sourceIndexSha256,
sourceScale, clips. Each clip starts with id, followed by sourcePath,
sourceSha256, cellW, cellH, anchorPx, anchorKind, optional sourcePivot/footprint,
fps, loop, reducedMotionFrame, optional sourceFrameIndices, frames, and optional
alias/overlay. Frame order follows zero-based strip order; each frame records
sourceIndex, key, rgbaSha256 in that order. This hashes decoded RGBA bytes, not
implementation-dependent PNG compression. Awning clip order is idle, working,
damaged, ready, destroyed, construction, collapse, then its shared ready FX.
Wake binds its single clip. Optional absent fields are omitted, never null.

The output IDs are artisan_market_awning_t1 through artisan_market_awning_t4 and
aurora_wake. The source IDs are artisan-market-t1 through artisan-market-t4 and
manifest member auroraWake. These immutable bindings include exact timing,
geometry, aliases and effect pixels. They identify reviewed source/preview terms;
they are not a capability, renderer readiness, ownership or spending entitlement.

Verified imported source bytes:31 files (30 PNG + original manifest),295,614bytes.
Generated-preview delivery and protected application must be separately accepted.
