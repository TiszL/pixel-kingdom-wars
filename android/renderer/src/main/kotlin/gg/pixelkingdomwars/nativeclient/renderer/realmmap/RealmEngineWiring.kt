package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Bands
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.DeedPx
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GroundCost
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Idle
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.PlotOffset

/**
 * Production inputs of the realm engine, built only from generated sources: the presentation constants from
 * `WorldEngineConstants.kt` (exported from the pinned web contracts by `tools/world-golden.mjs`) and the game numbers
 * from the constants catalogue the host reads (`CAMPAIGN.claimTilesByKeep`, `CAMPAIGN_LAYOUT.wallRingsByKeep`,
 * `BASE_GROUND_WORLD_GEOMETRY.worldTiles`, `GRID.tilePx`). Nothing here is a Kotlin copy of a number.
 */
object RealmEngineWiring {
    /** core.js `resize()`: the engine's dpr is `Math.min(2, devicePixelRatio)`; the web states it in code, not contracts. */
    private const val DPR_CAP = 2.0

    fun config(): RealmEngineConfig {
        val rest = DoubleArray(Bands.REST.size * 2)
        for ((i, r) in Bands.REST.withIndex()) { rest[2 * i] = r[0].toDouble(); rest[2 * i + 1] = r[1].toDouble() }
        val bands = RealmBands(
            farEnd = Bands.FAR_END.toDouble(), mapStart = Bands.MAP_START.toDouble(), trueStart = Bands.TRUE_START.toDouble(),
            trueFull = Bands.TRUE_FULL.toDouble(), impostor = doubles(Bands.IMPOSTOR), rest = rest, restEaseMs = Bands.REST_EASE_MS.toDouble(),
            selectD = Bands.SELECT_D.toDouble(), myBaseD = Bands.MY_BASE_D.toDouble(), twins = doubles(Bands.TWINS), herds = Bands.HERDS.toDouble(),
            creatures = Bands.CREATURES.toDouble(), sway = Bands.SWAY.toDouble(), snap = Bands.SNAP.toDouble(), sMax = Bands.S_MAX.toDouble(),
            uiDots = Bands.UI_DOTS.toDouble(), uiIcons = Bands.UI_ICONS.toDouble(), keepMinCss = Bands.KEEP_MIN_CSS.toDouble(),
        )
        val rehearsal = RealmRehearsal(
            idleMs = GpuSafe.REHEARSE_IDLE_MS.toDouble(), gapMs = GpuSafe.REHEARSE_GAP_MS.toDouble(), retryMs = GpuSafe.REHEARSE_RETRY_MS.toDouble(),
            retryMaxMs = GpuSafe.REHEARSE_RETRY_MAX_MS.toDouble(), box = GpuSafe.REHEARSE_BOX, stallMs = GpuSafe.REHEARSE_STALL_MS.toDouble(),
            mapReadyHoldMs = GpuSafe.REHEARSE_MAP_READY_HOLD_MS.toDouble(), trueSet = GpuSafe.REHEARSE_TRUE_SET.toSet(), order = GpuSafe.REHEARSE_ORDER,
        )
        return RealmEngineConfig(
            bands, rehearsal, groundPx = GpuSafe.GROUND_PX.copyOf(), heavy = GpuSafe.HEAVY.copyOf(),
            chartPassFetches = GroundCost.PASS_CHART.toDouble(), mapPassFetches = GroundCost.PASS_MAP.toDouble(),
            truePassFetches = GroundCost.PASS_TRUE.toDouble(), displayBudget = GroundCost.DISPLAY_BUDGET.toDouble(),
            resolveBudget = GroundCost.RESOLVE_BUDGET.toDouble(), evictMs = Idle.EVICT_MS.toDouble(),
            coldUploadBytes = GpuSafe.COLD_UPLOAD_BYTES.toLong(), dprCap = DPR_CAP,
            deedThisRealm = DeedPx.THIS_REALM, deedOtherRealm = DeedPx.OTHER_REALM,
            // DEED_DEG: the catalog lattice is 720 × 360 deeds over 360° × 180° (GLOBE-PRODUCTION-PLAN §2.4.2)
            deedDeg = 360.0 / RealmGrid.LATTICE_W,
        )
    }

    /** Plot rules from the catalogue's keep-level tables (game numbers) and the pinned `PLOT_OFFSET` / `PLOT_CENTRE`. */
    fun plots(claimTilesByKeep: IntArray, wallRingsByKeep: IntArray, worldTiles: Int): RealmPlotRules =
        RealmPlotRules(claimTilesByKeep, wallRingsByKeep, worldTiles, PlotOffset.CENTRE, PlotOffset.LENS_MARGIN, PlotOffset.RIM_GAP,
            PlotOffset.PLOT_MARGIN, PlotOffset.SALT)

    /** `DEED_ART` = worldTiles × GRID.tilePx, both from the catalogue. */
    fun deedArt(worldTiles: Int, tilePx: Int): Double = worldTiles.toDouble() * tilePx

    /** The game numbers the realm map reads, from the active constants catalogue (`catalogue.json`). [constants] is the
     *  parsed `constants` object the N3 lanes read their game numbers from (BASES `DecorGame.fromCatalogue`, LIFE's tile
     *  geometry); only the sections the host admitted are in it. */
    class CatalogueNumbers(val plots: RealmPlotRules, val deedArt: Double, val constants: com.badlogic.gdx.utils.JsonValue? = null)

    /** Parse `constants.{CAMPAIGN, CAMPAIGN_LAYOUT, BASE_GROUND_WORLD_GEOMETRY, GRID}` from the catalogue JSON. */
    fun fromCatalogue(catalogueJson: String): CatalogueNumbers {
        val c = com.badlogic.gdx.utils.JsonReader().parse(catalogueJson).get("constants") ?: throw IllegalArgumentException("catalogue has no constants")
        val tiles = c.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles")
        val tilePx = c.get("GRID").getInt("tilePx")
        return CatalogueNumbers(
            plots(c.get("CAMPAIGN").get("claimTilesByKeep").asIntArray(), c.get("CAMPAIGN_LAYOUT").get("wallRingsByKeep").asIntArray(), tiles),
            deedArt(tiles, tilePx),
            c,
        )
    }

    private fun doubles(v: IntArray) = DoubleArray(v.size) { v[it].toDouble() }
}
