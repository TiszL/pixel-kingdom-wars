# Native fantasy world surface

Owner-approved world8 art is rendered by a React-owned Canvas surface. No concept
page, iframe, sample deed owner, simulated eligibility or demo battle state is
used. `MapScreen` selects this surface only with `VITE_FEATURE_FANTASY_WORLD=1`;
flag-off retains the deployed Earth surface for the staged dual-address rollout.

## Ownership and geography

- `@shardkeep/shared/fantasyWorld` is the sole deed-address authority. Paintings,
  cloud pixels, island decoration and labels cannot add owned/available land.
- `/globe/fantasy`, `/globe/fantasy/parcels` and individual parcel responses supply
  actual owner summaries, availability and action gates. Directory responses must
  match the client's catalog hash. Bulk marker fields are deliberately restricted:
  `tileId`, `name`, `avatarUrl`, `keepLevel` and, since D-NEXT (owner 2026-09-26:
  shielded state on the public realm feed), the effective `shielded` boolean, which is the
  raid gate's rule at request time and never a shield clock. `validateFantasyViewport`
  still keeps only the first four, so this surface draws no shield domes yet.
- `data.ts` fences private responses by wallet, selected base and selection epoch
  during render, before effects clear an old result. Viewport reads are quantized,
  split across longitude wrapping, and never exceed the existing API area limit.
  Polling pauses while hidden. Deferred responses cannot revive an old viewer.
- Purchase drafts contain a typed fantasy tile address. Reserved Solana parcels
  and all exploration islands have no purchase or claim action. The backend must
  independently enforce every restriction.

## Drawing and lifecycle

`art/fantasy-world-v1/globe/manifest.json` records the immutable approved PNGs.
The normal asset generator verifies and copies them to `/atlas/fantasy/globe/`.
`art.ts` verifies each SHA and dimensions before decode, uses a build-versioned
URL and retries a mismatched cache once with a fresh request. The web manifest is
pinned to the source manifest by a test.

`runtime/renderer.mjs` selectively ports the approved sphere, frozen geographic
mask, Crystal Vale, island geometry, pixel clouds and effects. Regional paintings
and island atlases load lazily; caches belong to one mounted surface. Detail,
color and picking use the same geographic sampler. Teardown aborts reads, retires
pending decode results, clears caches, disconnects observers and cancels frames.
Clouds stay below labels and cannot intercept pointers. Conservative geographic
indexes avoid all-island scans per terrain pixel; tests compare every global degree
and every authored coast row against the original sampler. Far-hemisphere clouds
do not allocate or repaint empty frames. Visible animations retain
20 fps clouds / 8 fps island updates; hidden/offscreen canvases pause.

`FantasyGlobe` exposes typed focus/view methods. Pointer cancellation, off-canvas
release, pinch, keyboard inspection and current-game double-tap thresholds are
covered by tests. Camera changes stay in refs during dragging; React receives
coarse gesture commits. Initial home focus shows the realm; MY PARCEL enters the
exact deed scale. Close zoom is bounded at 256× so the northernmost Frostveil
row can reach the existing 50 CSS-pixel focus target on a 320px globe. The visual
camera latitude limit is ±85°; no catalog membership or tile coordinates change.
Selection uses the latest camera even before its next raster frame. Native owner search is debounced and resolves directly to a
fantasy parcel; the existing warzone status panel and canonical chat slot are
preserved. Server shields use their existing countdown/rule-boundary
contract in a separate leaf to avoid repainting the globe every second.

## Campaign

`campaign-presentation.json` contains only the approved chapter names, lore and
route artwork coordinates. `/campaign` supplies all stage identities, encounters,
progress and unlocks. ATTACK/REPLAY enters the existing game raid flow; SCOUT asks
`/campaign/:stage/preview` and uses the actual BattleScene and five-tier walls.
The server's visual context travels alongside its snapshot. No local encounter,
reward, progress simulation or obsolete concept wall compositor is included.

## Verification checkpoint

`pnpm --filter @shardkeep/web exec vitest run src/ui/fantasy
src/ui/screens/mapTerrain.test.ts src/ui/screens/globe/GlobeLayer.test.ts
src/ui/screens/globe/GlobeLayer.retry.test.ts` passed 94 tests on 2026-09-10.
Web typecheck and scoped hooks lint passed. Browser, physical Seeker, full release
build/update rehearsals and owner acceptance are recorded separately;
this module-level checkpoint does not claim production approval.

Performance note: an isolated CPU benchmark using real approved PNG bytes (but
without browser canvas/GPU or DOM costs) reduced warm close-zoom raster medians
from roughly 130 ms to 22 ms after direct regional lookup and indexed island
culling. These are implementation diagnostics, not a physical Seeker FPS claim.

Keyboard/touch acceptance additions: use a northern Frostveil parcel (for example
ordinary tile 14030), open MY PARCEL, inspect under the zoomed grid and rotate
across longitude wrapping. Check Enter immediately after an arrow/zoom action;
it must inspect the current camera. Explore's named chain/island buttons are the
keyboard alternative to tapping the same non-owned island geometry. Cancelled
and lost-capture gestures must never inspect or claim land.

Final full-web checkpoint (2026-09-10, after normal asset generation):
`pnpm --filter @shardkeep/web exec vitest run --maxWorkers=2` passed **251 suites /
3,359 tests**; full web lint and typecheck passed. This includes pre-frame camera
selection, northern phone parcel sizing, native browser Ctrl/Cmd zoom shortcuts,
and restoring the authored cloud atlas after a transient download failure.
The earlier run that overlapped atlas regeneration was superseded by this clean
full run; no missing-asset tests were skipped or removed.
