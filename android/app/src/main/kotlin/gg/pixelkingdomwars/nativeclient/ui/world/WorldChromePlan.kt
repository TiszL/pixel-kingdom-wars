package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.ui.sheets.map.FilterChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.MapTagUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.RailTileUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.model.FantasyParcel
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.live.worldReachTileApplies

/** World-map chrome metrics in dp. Presentation only; the globe camera frames itself from the measured chrome. */
object WorldChrome {
    /** Gap between the safe area and any floating chrome. */
    const val EDGE = 6
    const val GAP = 4
    /** Bar plate: the 6dp forged rims around 40dp tabs. */
    const val HEADER = 52
    /** 40dp realm chips centred in a 48dp touch row. */
    const val REALM_ROW = 48
    const val SEARCH_ROW = 48
    /** The four mode docks (EXPLORE / WARZONE / BASES / MOTION). */
    const val MODE_ROW = 44
    /** Landscape icon rail on the right edge. */
    const val RAIL = 48
    const val ZOOM = 44
    const val SIDE_PANEL_SHORT = 300
    const val SIDE_PANEL_WIDE = 360
}

data class WorldChromePlan(
    /** Tools as a vertical icon rail on the right edge (short landscape) instead of stacked rows. */
    val rail: Boolean,
    /** Details as a side panel instead of a bottom sheet. */
    val sidePanel: Boolean,
    val panelWidth: Int,
    /** Full-width chrome standing over the globe from the top edge, panel closed. */
    val stackedChrome: Int,
    val globeHeightFraction: Float,
    val globeWidthFraction: Float,
)

/** Short landscape (Seeker ≈ 915×411): one 52dp header bar carrying BASE, the realm chips and CAMPAIGN, and a
 * 48dp icon rail on the right, so the globe keeps ~0.84 of the height and ~0.93 of the width. Portrait stacks
 * header, realm chips, the search row and the mode docks: 210dp at 360×740 leaves 0.71 of the height (0.66 at
 * 360×640), above the 0.55 floor, so the four modes stay a dock row instead of moving into the panel header. */
fun worldChromePlan(widthDp: Int, heightDp: Int): WorldChromePlan {
    val rail = widthDp >= 600 && heightDp <= 480
    val sidePanel = rail || widthDp > 760
    val panelWidth = if (rail) WorldChrome.SIDE_PANEL_SHORT else WorldChrome.SIDE_PANEL_WIDE
    val stacked = WorldChrome.EDGE + WorldChrome.HEADER + WorldChrome.GAP +
        (if (rail) 0 else WorldChrome.REALM_ROW + WorldChrome.GAP + WorldChrome.SEARCH_ROW + WorldChrome.GAP + WorldChrome.MODE_ROW)
    val height = (heightDp - stacked - WorldChrome.EDGE).coerceAtLeast(0).toFloat() / heightDp.coerceAtLeast(1)
    val width = if (rail) (widthDp - 2 * WorldChrome.EDGE - WorldChrome.RAIL - WorldChrome.GAP).coerceAtLeast(0).toFloat() / widthDp.coerceAtLeast(1) else 1f
    return WorldChromePlan(rail, sidePanel, panelWidth, stacked, height, width)
}


// Final map chrome adapters. These only project existing catalogue/read state, never issue actions.
internal fun worldIslandDestination(railId: String): String? = when (railId) {
    "seeker" -> "seeker-island"
    "solana" -> "solana-island"
    "divine" -> "divine-isle"
    else -> null
}

internal fun worldIslandRailId(ownerId: String?): String? = when (ownerId) {
    "seeker-island" -> "seeker"
    "solana-island" -> "solana"
    "divine-isle" -> "divine"
    else -> null
}

/** The designed PlaceLabel name of a Phase E island on the globe (map/ SPEC §1.5 and every map frame: "SEEKER", "SOLANA",
 *  "DIVINE" in the 104 dp chip). The full title ("Solana Island", 94 dp of VT323 18) overflowed the chip's 72 dp text
 *  box and showed "Solana I…" (owner 2026-10-06, screenshot 6); the island's sheet header still carries the full name. */
internal fun worldIslandPlaceName(ownerId: String?): String? = worldIslandRailId(ownerId)?.uppercase()

internal fun worldChromeBaseIsCurrent(selectedBaseId: String?, snapshotBaseId: String?): Boolean =
    selectedBaseId != null && selectedBaseId == snapshotBaseId

/** e7eb2ce9: World resources are live readouts, with no drawer affordance or new navigation owner. */
internal fun worldChromeReadouts(rows: List<ResourceChipUi>): List<ResourceChipUi> = rows.map { it.copy(drawerHandle = false) }

internal fun worldSearchRowId(realmId: String, tileId: Int): String = "$realmId:$tileId"

/** A map-search kingdom row's title (map-search.png: "Spot7Raider · Lv 12"). */
internal fun searchRowTitle(name: String, level: Int): String = "$name · Lv $level"

/** A map-search kingdom row's place line (map-search.png: "Frostveil · no shield"): the realm, then the shield exactly as the
 *  map's read carried it (nothing when the read said nothing, never a guess), or the owner search's trophies. */
internal fun searchRowPlace(realmName: String, shield: Boolean?, trophies: Int?): String = buildList {
    add(realmName)
    when (shield) { false -> add("no shield"); true -> add("shielded"); null -> Unit }
    trophies?.let { add("${RealmHudModel.fmtN(it)} trophies") }
}.joinToString(" · ")

/** The realm map's title-plate sub-line (map-realm.png: "3,150 kingdoms here"): the server's count with separators, "…"
 *  until it is read. While the zoom waits at a band gate, the gate's own cue replaces "here" ("· detail 40%"). */
internal fun realmChromeSubtitle(kingdoms: Int?, cue: String?): String =
    "${kingdoms?.let(RealmHudModel::fmtN) ?: "…"} kingdoms ${cue?.let { "· $it" } ?: "here"}"

internal fun worldChromeRail(realms: List<GlobeRealmInfo>, enabledIslandIds: List<String>, homeRealmId: String?): List<RailTileUi> =
    buildList {
        for ((id, caption) in listOf("seeker" to "Seeker", "solana" to "Solana", "divine" to "Divine")) {
            if (worldIslandDestination(id) in enabledIslandIds)
                add(RailTileUi(id, "ui:$id-navigation", caption))
        }
        realms.forEach { realm ->
            val home = realm.id == homeRealmId
            add(RailTileUi(realm.id, null, realm.name, tag = if (home) MapTagUi("YOU", Verb.GOLD) else null, home = home))
        }
    }

/** Counts describe this loaded map window; absence of a completed feed is not a zero. */
internal fun worldChromeFilters(bases: List<RealmHudBase>, filter: RealmFilter, feedReady: Boolean, shieldFed: Boolean): List<FilterChipUi> =
    buildList {
        fun count(n: Int) = if (feedReady) n.toString() else "…"
        add(FilterChipUi("all", "ALL", count(bases.size), filter.kind == "all"))
        add(FilterChipUi("mine", "MINE", count(bases.count { it.mine }), filter.kind == "mine", listOf(Verb.GOLD)))
        if (shieldFed) add(FilterChipUi("unshielded", "NO SHIELD", count(bases.count { it.shield == false }), filter.kind == "unshielded"))
        add(FilterChipUi("lvl", "LV ${filter.lo}–${filter.hi}", "", filter.lo > 1 || filter.hi < 20))
    }

/** Optional minimap only. The same rectangle must be sent to GL and its Compose frame. */
internal fun worldChromeMinimap(plan: RealmHudPlan, width: Float, height: Float, safe: HudInsets): Map<String, HudRect> {
    val original = plan.rect("minimap") ?: return emptyMap()
    val top = safe.top + if (width < 600f && width <= height) 160f else 92f
    val bottom = height - safe.bottom - 112f
    val available = bottom - top
    if (available < 60f) return emptyMap()
    val scale = minOf(1f, available / original.h, (width - safe.left - safe.right - 32f) / original.w)
    return mapOf("minimap" to HudRect(safe.left + 8f, top, original.w * scale, original.h * scale))
}


/** Same bounded anchor placement as the original labels, with the designed island label's actual 112×48 shell. */
internal fun worldChromeGlobeLabels(anchorIds: IntArray, anchorXY: FloatArray, count: Int, density: Float,
    realmNames: List<String>, type: HudType, uiRects: List<HudRect>, width: Float, height: Float, hideIndex: Int?): List<WorldLabels.Placed> {
    val obstacles = uiRects.mapTo(ArrayList()) { it.ltrb() }
    val placed = ArrayList<WorldLabels.Placed>()
    for (k in (0 until count).sortedBy { anchorIds[it] }) {
        val id = anchorIds[k]
        if (id == hideIndex) continue
        val island = PhaseEIslands.byAnchor(id)
        val name = island?.title ?: realmNames.getOrNull(id)?.takeIf { it.isNotBlank() } ?: continue
        val (w, h) = if (island != null) 112f to 48f else WorldLabels.placeSize(name, type)
        val position = GlobeHudPlan.placeLabel((anchorXY[2 * k] / density).toDouble(), (anchorXY[2 * k + 1] / density).toDouble(),
            w.toDouble(), h.toDouble(), obstacles, width.toDouble(), height.toDouble()) ?: continue
        obstacles += doubleArrayOf(position[0], position[1], position[0] + w, position[1] + h)
        placed += WorldLabels.Placed(id, position[0].toFloat(), position[1].toFloat(), w, h)
    }
    return placed
}

/** The designed half sheet the globe draws over the map (MS-UI3 mount): a Phase E island (seeker-panel, solana-island's
 *  Public Workshop, divine-panel), a parcel (map-base) or a selected archipelago island (archipelago-panel); since c-gap-map
 *  also the realm, the warzone status, the archipelago chain list (EXPLORE) and MY PARCEL without land (WorldMapSheets.kt),
 *  which drew the old dark web frame until then. */
internal enum class WorldGlobeSheet { NONE, ISLAND, PARCEL, ARCHIPELAGO, REALM, WARZONE, EXPLORE, PARCEL_HELP }

/** Which designed sheet the globe opens for [ui]; a parcel waits for this base's world read ([parcelRead]). Only on the
 *  globe itself: a dive in flight, a realm map or a leave draws none. */
internal fun worldGlobeSheet(ui: WorldHudUi, parcelRead: Boolean): WorldGlobeSheet = when {
    ui.mode != WorldHudMode.GLOBE -> WorldGlobeSheet.NONE
    ui.panel == GlobePanel.ISLAND && ui.islandId != null -> WorldGlobeSheet.ISLAND
    ui.panel == GlobePanel.PARCEL && parcelRead -> WorldGlobeSheet.PARCEL
    ui.panel == GlobePanel.EXPLORE && ui.archipelagoId != null -> WorldGlobeSheet.ARCHIPELAGO
    ui.panel == GlobePanel.EXPLORE -> WorldGlobeSheet.EXPLORE
    ui.panel == GlobePanel.REALM && ui.realmId != null -> WorldGlobeSheet.REALM
    ui.panel == GlobePanel.WARZONE -> WorldGlobeSheet.WARZONE
    ui.panel == GlobePanel.PARCEL_HELP -> WorldGlobeSheet.PARCEL_HELP
    else -> WorldGlobeSheet.NONE
}

/** Whether the old dark globe panel frame (GlobeHud's HudPanel) draws. Never since c-gap-map: every globe panel is a
 *  designed map half sheet ([worldGlobeSheet]); owner 2026-10-06, "I should not see any even 1 of old screens". Kept as
 *  the one switch the globe plan reads, so the old frame cannot come back for a state by accident. */
@Suppress("UNUSED_PARAMETER")
internal fun worldGlobeFramePanel(ui: WorldHudUi): Boolean = false

/** The realm map's designed status sheets (c-gap-map, in place of the old dark warzone and level-range panels). */
internal enum class RealmPanelSheet { NONE, WARZONE, LEVEL }

/** Which status sheet the realm map draws: the warzone status or the LV range, never over a kingdom card or the search
 *  drawer (map/SPEC §1.6 "one sheet at a time"; owner 2026-10-06 "none of screens should overlay each other"). */
internal fun realmPanelSheet(cardOpen: Boolean, searchShown: Boolean, warzoneOpen: Boolean, levelOpen: Boolean): RealmPanelSheet = when {
    cardOpen || searchShown -> RealmPanelSheet.NONE
    warzoneOpen -> RealmPanelSheet.WARZONE
    levelOpen -> RealmPanelSheet.LEVEL
    else -> RealmPanelSheet.NONE
}

/** The realm map's card body (MS-UI3 mount): the Solana Reach Seeker-tile sheet (reach-tile) for a reserved Seeker parcel,
 *  else the designed kingdom sheet (map-base); none without a card or this base's world read. */
internal enum class WorldRealmSheet { NONE, REACH, KINGDOM }

internal fun worldRealmSheet(cardOpen: Boolean, parcelRead: Boolean, parcel: FantasyParcel?): WorldRealmSheet = when {
    !cardOpen || !parcelRead -> WorldRealmSheet.NONE
    worldReachTileApplies(parcel) -> WorldRealmSheet.REACH
    else -> WorldRealmSheet.KINGDOM
}
