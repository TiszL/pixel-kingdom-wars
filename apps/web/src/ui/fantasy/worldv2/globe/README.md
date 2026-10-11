# Web World v2 flat globe (chunk A)

Imperative, framework-free port of the concept globe for the web (PLAN.md lane L3, D-186). `createGlobe(canvas, options)` in `globe.mjs`; types in `globe.d.mts`. The React root (`worldv2/WorldV2.tsx`, lane L6) lazily imports it and maps its events onto the frozen host contract.

## Sources and pins
- **Shader:** `flat.glsl.js` is byte-identical to the concept at `02e9da84` (same at `8acdf059`).
- **Preprocessor:** `glsl.mjs` is the realm engine's `PREAMBLE` + `preprocessGLSL`, verbatim.
- **Stage lock:** `stages.test.mjs` pins all six preprocessed stages to native's `world-shaders.lock.json` (`goldens/stages.lock.json`), so the web draws native's bytes (R14).
- **JS:** `camera.mjs`, `motion.mjs`, `picking.mjs`, `content.mjs` and `labels.mjs` port `8acdf059` `src/main.js`, using native's Kotlin ports (`GlobeCameraV2`, `GlobeGestures`, `GlobePicking`, `GlobeGeography`, `GlobeApproach`, `DiveCoverClock`, `GlobeContent`, `PhaseEIslandLayer`, `ExplorationIslandLayer`) as the reference.
- **Presentation constants:** `pin.mjs` holds native's `GlobeV2Pin.kt`.
- **Goldens:** `goldens/camera.json`, `picking.json` and `islands.json` are native's golden exports (`tools/globe2-pin.mjs` at the pin), copied unchanged. Re-copy them on a re-pin; never edit them.

## Inputs the host provides
- **`chains`:** the host's `ARCHIPELAGOS` / `FANTASY_CHAINS`. Island picks come back as `{ chainId, islandId: '<chain>-<slot+1>' }`, the ids `focusIsland` and the EXPLORE panel already use.
- **`fileUrl(path)`:** world-pack files under `/atlas/world-v2/<packVersion>/` (lane L2). Optional `expectedSha256(path)` verifies each file.
- **`readIslandArt(path)`:** the host's sha-verified `loadFantasyPixels`, used for `generated/<chain>-detail(-mask).png`.
- **`phaseEIslands`:** Seeker, Solana and Divine (D-172/D-182). They are drawn, picked and framed only when this is set (RG-3).

## Not ported
- The relief pipeline, deed-detail tiles, demo bases, realm panel/HUD DOM, `?diag`/`?export` and the Google Fonts link (`purity.test.mjs`).
- Native's Phase E *near slot* (a 2048² art for the island the camera is close to). The web draws native's 1024² far layer at every zoom. Add the slot if the owner finds the islands soft up close.
- Native's half-scale ladder and pipeline rehearsal. These are GPU-memory measures specific to Android.

## Behaviour the host builds on
- **`ready`:** fires once the first frame is on the canvas; the host lifts its veil then. Construction throws when WebGL2 is missing, so the host falls back to the CPU globe.
- **View reporting:** `view()` and the `view` event use the host scale, where the home frame is zoom 1 and the globe always reports below 5.
- **`setView`:** views at zoom 5 and above are realm-map views; the caller routes them to the realm engine.
- **Enter map:** `diveInto(realm)` emits `approach(realm)` at once (the D-177 prefetch), then `dive({ realmId, lon, lat, sStart })` when the flight ends.
- **Cloud cover:** it rises only if the realm map is still loading 400 ms after the `dive` event. `diveReady()` stops the rise; `diveResult(true)` parts the clouds and puts the globe to sleep (one engine awake); a `leave()`, `wake()` or `cancelDive()` during the parting cancels that sleep, so a quick exit never leaves the globe frozen; `diveResult(false)` reopens the realm and blocks the auto-dive for 5 s.
- **Back during the approach:** `cancelDive()`.
- **Leaving a realm:** `leave({ realmId, lon, lat })` and `wake()` resolve only after a globe frame has been drawn, so the reverse fade never shows a black frame.
- **Context loss:** the globe reloads its content and keeps the camera and selection. `snapshot()`/`restore()` carry the state across a full `dispose()`.

## Tests
`node --test --test-reporter=spec 'src/ui/fantasy/worldv2/**/*.test.mjs'`, which is part of `pnpm --filter @shardkeep/web test`; vitest excludes these files. Node 23 treats the bare directory `src/ui/fantasy/worldv2/globe` as a module path, not a folder, so pass the glob.
