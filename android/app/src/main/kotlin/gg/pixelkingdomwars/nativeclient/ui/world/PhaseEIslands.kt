package gg.pixelkingdomwars.nativeclient.ui.world

import android.content.res.AssetManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeContent
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeContentException
import gg.pixelkingdomwars.nativeclient.renderer.globe2.PhaseEIslandLayer
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The Phase E islands' panel copy. Title, accent, sub and lore are the web concept's `src/landmarks.js` ISLAND_INFO at
 * the globe pin (globe-realms 4de21f1a, unchanged since 4606c706). Presentation only, no game number is read from
 * here. The owner made the islands visible to players in release builds (2026-09-26, overriding D-172's test-builds-only)
 * and chose player copy for this panel: no internal "Phase E" kicker or placement caption, the island marked as coming soon.
 */
data class PhaseEIslandInfo(val id: String, val title: String, val kicker: String, val accent: String, val sub: String, val lore: String)

/** What the island panel shows (main.js islandPanel), so its copy and its one action are JVM-testable. */
data class PhaseEIslandPanel(
    val kicker: String, val title: String,
    /** `.hud-epithet`: the island's lore line. */
    val epithet: String,
    /** `.hud-note`: "Coming soon" over the sub without its "Phase E · " prefix. */
    val noteTitle: String, val note: String,
    /** The map button: island maps come later, with Phase E (D-172.2), so it is always disabled. */
    val mapLabel: String, val mapEnabled: Boolean,
)

object PhaseEIslands {
    /** Seeker Island's id (the auction island; `WorldEntry.SeekerIsland` opens it from Profile › WALLET). */
    const val SEEKER_ISLAND_ID = "seeker-island"
    /** Solana Island's id (the Public Workshop island; `WorldEntry.SolanaIsland` opens it from the craft-vehicle doors). */
    const val SOLANA_ISLAND_ID = "solana-island"
    val ALL: List<PhaseEIslandInfo> = listOf(
        PhaseEIslandInfo(SEEKER_ISLAND_ID, "Seeker Island", KICKER, "#ffb066",
            "Phase E · 100 spots — 20 King + 80 regular · 7-day SKR auction terms",
            "The copper beacon of the S-shaped isle calls Seeker holders to the open sea east of Solana Reach."),
        PhaseEIslandInfo(SOLANA_ISLAND_ID, "Solana Island", KICKER, "#5ff2c8",
            "Phase E · 100 workshop licences for crafting",
            "Three crystal terraces rise off the western shore of Solana Reach: observatory, mint forest and the pale harbour."),
        PhaseEIslandInfo("divine-isle", "Divine Isle", KICKER, "#ffd97a",
            "Phase E · 500 solo trials (west) · 50 clan citadels (east)",
            "Split by a turquoise rift, the sacred isle lies alone in the Central Sea."),
    )
    /** The player-facing kicker (owner 2026-09-26), in place of the web concept's "PHASE E · ISLAND". */
    const val KICKER = "ISLAND · COMING SOON"
    /** The web's `mapOffer('Coming soon')` label, also the note's title. */
    const val MAP_SOON = "Coming soon"

    fun byId(id: String?): PhaseEIslandInfo? = ALL.firstOrNull { it.id == id }

    fun accent(id: String?): Color? = byId(id)?.let { parseCssColor(it.accent) }

    fun panel(id: String): PhaseEIslandPanel? = byId(id)?.let {
        PhaseEIslandPanel(it.kicker, it.title, it.lore, MAP_SOON, it.sub.removePrefix("Phase E · "), MAP_SOON, mapEnabled = false)
    }

    // ---- destinations (D-166.1: realms and islands are one language; main.js `destinations`, rail and labels) ----

    /** The globe's label anchor of island [index] (ALL order = the engine's PHASE_E order): after the realms', as the web
     *  numbers its destinations. The engine publishes it only while its Phase E layer is live. */
    fun anchorId(index: Int): Int = PhaseEIslandLayer.ANCHOR_BASE + index

    /** Globe label names by anchor id: the realms' (padded to the engine's realm count, "" = no label) then the islands'. */
    fun labelNames(realmNames: List<String>): List<String> =
        List(PhaseEIslandLayer.ANCHOR_BASE) { realmNames.getOrElse(it) { "" } } + ALL.map { it.title }

    /** The island a label anchor names, or null for a realm's. */
    fun byAnchor(id: Int): PhaseEIslandInfo? = ALL.getOrNull(id - PhaseEIslandLayer.ANCHOR_BASE)

    /** A rail chip (or any HUD pick of the island): the ISLAND panel opens at once and the engine selects and frames the
     *  island (`Select(Island(id))`: its live Phase E layer takes the id; a bundle without the flag has no chip). Its own echo,
     *  `GlobeSelected(null, id)`, then changes nothing ([WorldHudFlow.globeSelected]). Only on the globe. */
    fun select(ui: WorldHudUi, id: String): HudStep =
        if (ui.mode != WorldHudMode.GLOBE || byId(id) == null) HudStep(ui)
        else HudStep(ui.copy(panel = GlobePanel.ISLAND, islandId = id, realmId = null, chainId = null, peek = false, globeSearch = false, hint = false,
            noMap = null, mineCta = false, panelFresh = true, panelSerial = ui.panelSerial + 1), listOf(WorldIntent.Select(WorldTarget.Island(id))))

    /** The rail's island chips, by the world bundle's own flag (`content.json` `"phaseEIslands": true`, D-172), the same
     *  one reading the engine's Phase E stage makes (plan F19: islands in the rail only with the Phase E flag). Every build,
     *  release included since the owner's 2026-09-26 call, packages the bundle with the flag true (checkReleasePhaseEOn). */
    fun chips(worldIndex: ByteArray?): List<PhaseEIslandInfo> =
        if (worldIndex != null && try { GlobeContent.phaseEFlag(worldIndex) } catch (e: GlobeContentException) { false }) ALL else emptyList()

    /** The world bundle's index from the APK's assets (every build type since N5), or null when the APK has none. */
    fun worldIndex(assets: AssetManager): ByteArray? =
        try { assets.open(WORLD_INDEX_ASSET).use { it.readBytes() } } catch (e: java.io.IOException) { null }

    /** Where the bundler puts the world index in the APK (`tools/world-debug-content.mjs`: `world/content.json`). */
    const val WORLD_INDEX_ASSET = "world/" + GlobeContent.WORLD_INDEX

    /** The chips once read in this process (an APK's assets never change); null until the first read lands. */
    @Volatile internal var readChips: List<PhaseEIslandInfo>? = null

    /** The chips for [assets], read at most once per process (IO thread). */
    internal suspend fun loadChips(assets: AssetManager): List<PhaseEIslandInfo> =
        readChips ?: withContext(Dispatchers.IO) { chips(worldIndex(assets)) }.also { readChips = it }
}

/** The rail's Phase E island chips for this build (read off the main thread; none until read). A composition after the
 *  first read starts from it, so the globe's first HUD frame lists the islands (owner 2026-10-06: the islands appear with
 *  the globe, never after it); [WarmPhaseEChips] makes that read behind the World loading screen. */
@Composable internal fun rememberPhaseEChips(): List<PhaseEIslandInfo> {
    val assets = LocalContext.current.assets
    return produceState(PhaseEIslands.readChips ?: emptyList(), assets) { value = PhaseEIslands.loadChips(assets) }.value
}

/** Reads the rail's island chips while the World loading screen shows, so they are in before the globe is. */
@Composable internal fun WarmPhaseEChips() {
    val assets = LocalContext.current.assets
    LaunchedEffect(assets) { PhaseEIslands.loadChips(assets) }
}
