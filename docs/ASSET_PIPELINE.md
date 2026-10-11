# Asset pipeline

This document describes the asset paths used by the current code.

> **Note for this repository.** The original art masters and the rasterisation
> pipeline described below live in a private workspace. The generated runtime
> output under `apps/web/public/{atlas,brand,audio}` is committed here, together
> with the small subset of `art/` that the web client imports directly, so the
> game builds and runs from a fresh clone without any asset step.

## Source and output boundary

Source masters, manifests, source-pack metadata, and approved audio provenance are
kept with the pipeline. Runtime atlases, standalone brand renders, and published
audio are derived from them under `apps/web/public/{atlas,brand,audio}`. This
separation keeps the source of truth reviewable while allowing every runtime asset
to be rebuilt.

Do not edit a tracked master in place. Corrections arrive as a new versioned
source pack or are promoted through the documented integration process.
Generated files may be regenerated; source masters may not be rewritten by that
process.

## Current source roots

The raster pipeline declares its inputs explicitly in
`scripts/src/rasterize.ts`. Directory names are therefore load-bearing.

| Path | Current role |
|---|---|
| `art/source/assets-v2/` | Frozen baseline, one SVG per sprite. |
| `art/source/expanded-assets/` | Later one-SVG-per-sprite levels and roster additions. |
| `art/source/assets-v3/` | Accepted batch 11–13 reworks and additions. |
| `art/source/defense-rework/` | Batch-13 building, troop, and FX masters. Its manifest uses pixel anchors, normalized once by the loader. |
| `art/source/inventory/` | The 27 permanent inventory and HUD masters selected from the inventory handout. |
| `art/source/troops-rework-core/` | Protected 191-sheet grid source; its original delivery name is recorded in the source layout. |
| `art/source/troops-rework-expanded/` | All-troop grid superset; contributes only basenames not supplied by the protected source. |
| `art/source/buildings-rework/` | Current WARE grid source for buildings, defences, traps, UI art, and runtime aliases. |
| `art/source/brand-wave2/` | Current standalone brand and app-icon source. |

Related current sources use separate producers:

| Path | Producer / consumer |
|---|---|
| `art/source/walls-five-tier/` | Five-tier wall family: 90 PNGs / 560 source frame cells, validated before contextual composition. |
| `art/source/builder-workman/` | PixelLab builder sheet and its pinned motion/provenance contract. |
| `art/source/leagues/` | Four live league tier icons imported by the web UI. |
| `art/source/token-logo/` | Original token marks and the animated avatar-processing regression fixture. |
| `art/game-v4/` | Hash-pinned accepted overlay; strict release promotion resolves each selected runtime claim. |
| `art/fantasy-world-v1/` | Current globe artwork/masks and retained art-version-1 replay terrain. |
| `art/fantasy-ground-v2/ground/` | Eight current full-base terrain paintings and their source manifest. |
| `art/retired-deed-images-v1/` | Required immutable historical NFT images. |
| `art/source/website/` | Versioned landing-page source verified and copied by `landing/*.mjs`. |
| `art/source/soundtrack/` | Two tracked music masters copied byte-for-byte by `scripts/src/audio.ts`. |
| `scripts/audio-presets/` | Deterministic synthesized fallback/UI SFX presets. |
| `scripts/audio-production/masters/` | The 247 review-gated production SFX exports plus their manifest and per-file provenance records. |

## Raster merge contract

The pipeline validates every manifest before packing. Its current contracts are:

- simple sprite roots load in declared order; later sources win basename
  collisions;
- exactly 204 simple-source keys are expected to be shadowed, so an accidental
  new collision fails the build;
- the protected rework-v2 grid source loads before its superset and therefore
  wins their 191 overlapping basenames;
- superseded runtime silhouettes are filtered only after source validation, so
  the original master remains available for provenance without being emitted;
- the WARE pack has its own grid loader and explicit alias/retirement rules;
- anchors are normalized at the input boundary, and invalid fractional anchors
  fail before atlas generation;
- atlas packing uses no rotation or trimming and emits 1x/2x simple atlases;
  the large grid packs stay at their code-defined scale.

These rules deliberately preserve old masters while making the runtime winner
deterministic. Do not “simplify” them by deleting shadowed files.

## Generated surfaces

`pnpm assets` runs the raster and audio producers:

1. validate source manifests and the exact collision contract;
2. render SVGs with crisp edges and nearest-neighbour integer scaling;
3. slice grid sheets and pack the declared atlas groups;
4. write atlas PNG/JSON pairs and `meta.json` under
   `apps/web/public/atlas/`;
5. write standalone current-brand renders under
   `apps/web/public/brand/` and copy the pinned public icon sizes;
6. synthesize deterministic preset SFX, verify and publish approved production
   SFX, then copy the tracked music masters under `apps/web/public/audio/`.

The web client consumes the generated atlases and audio. The API also consumes
the 1x atlas when rendering Land Deed images, so
`apps/web/public/atlas/` must be present in the API container build context even
though the generated directory is not committed.

The landing page is separate: its build scripts verify the pinned
`art/source/website/` inventory and current brand inputs before writing its ignored
`dist/` output.

## Validation

From a clean dependency install:

```bash
pnpm assets
pnpm --filter @shardkeep/scripts test
pnpm --filter @shardkeep/shared test
pnpm --filter @shardkeep/web test
```

The scripts tests pin source counts, collision counts, source-tree digests,
palette/geometry rules, grid slicing, brand inputs, audio catalog hashes, and
published-file contracts. Shared and web tests pin the metadata keys and runtime
loader behavior.

After regeneration, inspect `git status`. Atlas, brand, and audio output should
remain ignored; a change to a tracked public icon should be intentional and
reviewed. Visual changes still require opening the relevant lab or running the
game: scale, grounding, and animation timing cannot all be proven from file
contracts alone.

## Reference-only archive

Integrated deliveries, historical review labs and original terrain studies are
preserved outside the active source tree. The archived source index
records their exact paths and recovery procedure. Their removal does not retire
any current producer root, historical replay terrain, retired-deed image or
supported client generation.
