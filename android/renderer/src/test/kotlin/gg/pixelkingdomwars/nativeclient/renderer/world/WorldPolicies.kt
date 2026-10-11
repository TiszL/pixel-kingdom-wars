package gg.pixelkingdomwars.nativeclient.renderer.world

/**
 * The web presentation constants these tests run with, as `contracts.js` / `scatter.js` / `groundcost.js` define them at
 * `globe-realms` 8fbe2075 (files last changed in 90264c97). Test inputs only: at run time they come from the
 * generated `WorldEngineConstants.kt` (plan §4.3, lane NT), so production code holds no copy.
 */
internal object WebPin {
    /** contracts.js GPU_SAFE. */
    val GPU_SAFE = GpuSafePolicy(slowMs = 50.0, severeMs = 250.0, window = 6, need = 3, severeNeed = 2, upMs = 12.0, upAfter = 240,
        coldUploadBytes = 256 * 1024L, lossStop = 2, storeMs = 24 * 3600 * 1000L)
    /** contracts.js GPU_SAFE.groundPx[0]. */
    const val GROUND_PX_L0 = 1.5
    /** contracts.js IDLE. */
    val IDLE = IdlePolicy(fullMs = 20_000, fullCapFps = 20, capFps = 8, freezeMs = 60_000)
    /** scatter.js LIFE_CAPS.submitted.phone. */
    const val LIFE_CAP_PHONE = 40_000
    val LADDER_INPUTS = LadderInputs(GROUND_PX_L0, LIFE_CAP_PHONE)

    /** groundcost.js PASS.map + PASS.true: a MAP→TRUE fade draws both display programs over the ground target. */
    const val GROUND_FADE_FETCHES = 61.0 + 22.0
    /** groundcost.js subTileFetches() and pageFetches(6), and resolveBudget(canvasPx) on the three Seeker buffers. */
    const val SUB_TILE_FETCHES = 6_183_980L
    const val PAGE_FETCHES = 1_391_810L
    val RESOLVE_BUDGET_PAGES = mapOf(1_859_076L to 3, 1_695_366L to 2, 1_424_000L to 1) // subs = 1 on all three
    /** lane-life.md: worst-case LIFE vertex fetches on the phone at the 40k submitted cap (12.0 per canvas px there). */
    const val LIFE_VS_FETCHES_AT_CAP = 15_900_000.0
}
