# Pinned dependency corrections

## Phaser 4.1.0 — limited-step elapsed time (M34)

`phaser@4.1.0.patch` corrects one expression in `TimeStep.stepLimitFPS`, in the
source and both package-export bundles. Vite imports `dist/phaser.esm.js`, not
the source module; patching source alone would leave the released game broken.

The original limiter delivers its entire accumulated delta, then retains the
fractional remainder for the next frame. That delivers the same time twice,
accelerating scene timers, actor animations and raid playheads relative to
wall-time tweens. Actual completed-replay browser A/B and the installed engine
both reproduced it. The patch delivers only complete due periods and retains
the *undelivered* fraction. Thus delivered time plus queued remainder equals
accepted smoothed time, with less than one frame period outstanding.

Frame scheduling, the 60 FPS mobile cap, smoothing, pause/reset behavior,
uncapped desktop playback and all server/SIM clocks remain unchanged. No engine
upgrade or replacement loop is introduced. The ordinary frozen-lockfile install
applies the patch; `apps/web/src/game/phaserTimeStep.test.ts` exercises the real
installed engine and verifies both consumed bundles. The API Docker dependency
stage also copies patches before its filtered frozen install.

On a deliberate Phaser upgrade, check whether upstream fixes this calculation,
remove or adapt this patch, and retain elapsed-time conservation and real
1x/2x/browser resume verification. Do not remove the regression tests or silently
ignore unapplied patches.

## Phaser 4.1.0 — GPU tilemap animation index (realm kit, 2026-09-21)

The same patch file corrects one expression in `Tileset.createAnimationDataTexture`
(source and both bundles). `TilemapGPULayer.generateLayerDataTexture` writes the
value from `_animationDataIndexMap` into the layer data texture and the
`TilemapGPULayer` fragment shader reads that value as a **texel index**: the
animation's total duration at `n`, its frame-pair offset at `n + 1`. The animation
records are two texels wide, but the map stored the bare animation ordinal, so only
the first animation of a tileset resolved; every later one read a neighbouring
record's frame offset as its duration and an arbitrary texel as its frame list. The
realm kit's animated water (thirty animated cells) rendered as random shore
fragments. The patch stores `animations.length * 2`, the texel where the record
starts. `apps/web/src/game/phaserTilesetAnimation.test.ts` drives the installed
`Tileset` and pins both bundles.

On a Phaser upgrade, check whether upstream fixed the ordinal/texel mismatch
(either side may have moved) before dropping this hunk.

## Phaser 4.1.0 — GPU tilemap empty tile (realm kit, 2026-09-23)

The same patch file adds an empty-tile exit to `TilemapGPULayer-frag` `main()`
(source and both bundles). For an empty cell (index −1, flag bit 28) the shader's
`getTileTexelCoord` answers texel `(0, 0)` and `main()` sampled the tileset there
anyway; `getColorSamples` flips y and the sheet is uploaded `flipY` with REPEAT
wrap, so every empty cell of every GPU layer drew the sheet's **bottom-left pixel**.
Crownlands, Frostveil and Sunscar hid it only because that pixel is transparent.
Cinderfall's 512×1024 sheet is packed to its last slot (511), the pixel is opaque
ash (119,105,89), and its mostly-empty overlay layer painted that colour over 75%
of the widest view: the road broke into rectangles, the charcoal yard became a
checkerboard, the court ring and the east lava river vanished. The patch discards
the fragment of an empty tile before any tileset sample. Do not "fix" it with
CLAMP_TO_EDGE: `v = 1.0` then reads the top-left pixel, opaque in every sheet.
`apps/web/src/game/phaserTilemapGpuEmptyTile.test.ts` reads the installed shader
and pins both bundles.

Remaining gap: under `FEATURE_BORDERFILTER` (LINEAR filtering) a tile's edge still
blends in its empty neighbour's texel `(0, 0)`. The realm kit samples NEAREST, so
the path is unused; fix it before a GPU layer turns LINEAR on. On a Phaser upgrade,
check whether upstream made empty tiles transparent before dropping this hunk.
