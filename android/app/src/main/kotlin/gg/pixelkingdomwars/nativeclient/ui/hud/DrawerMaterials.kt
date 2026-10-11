package gg.pixelkingdomwars.nativeclient.ui.hud

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.data.PassportCurrent
import gg.pixelkingdomwars.nativeclient.data.PassportSection
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.compactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupLayout
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceGroupUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceRowUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.catalogueKey
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.craftItemIcon
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.liveCount

/*
 * The resource drawer's Phase E strips (drawer.png HARVESTERS and WORKSHOP; DESIGN-SYSTEM §6 Resource drawer): the
 * ordinary-crafting owner's current view -> two TILE_STRIP groups. Pure; JVM-tested in DrawerMaterialsTest. Only this
 * wallet's view of this base is shown; another kingdom's or a missing view draws no group at all (never zeros). Counts
 * are the server's spendable `available` strings; only a known "0" gets the empty tint. The crafted kits ride in the same
 * view but belong to the Lodge strip, which carries only Renown ([drawerLodgeGroup]), so they are left out rather than
 * filed as refined.
 */

/** The registry rows the strips' GOs open (both exist in FeatureCatalogue). */
internal val DRAWER_HARVEST = FeatureId("harvester.harvest")
internal val DRAWER_WORKSHOP = FeatureId("workshop.craft")

/** The drawer's tint legend (drawer.png footnote, without the Divine Isle half: no Divine Isle strip is mounted yet). */
internal const val DRAWER_MATERIALS_FOOTNOTE = "Grey = none yet; tap still shows where to earn it."

/** HARVESTERS (raw, one per realm) and WORKSHOP (refined from raw) for [crafting]'s view, only when that view is
 *  [wallet]'s view of [baseId]; empty otherwise. */
internal fun drawerMaterialGroups(crafting: OrdinaryCraftingState?, wallet: String?, baseId: String?): List<ResourceGroupUi> {
    val view = crafting?.view ?: return emptyList()
    if (wallet.isNullOrBlank() || baseId.isNullOrBlank() || view.wallet != wallet || view.baseId != baseId) return emptyList()
    val raw = view.rawStock.map { stock ->
        materialRow(stock.resourceId, stock.available, "Refined into Workshop materials.", "From a Realm Harvester.", DRAWER_HARVEST,
            "ui:harvester-menu")
    }
    val refined = view.craftingStock.filterNot { catalogueKey(it.itemId).endsWith("_kit") }.map { stock ->
        materialRow(stock.itemId, stock.available, "Used in Workshop recipes.", "Refined at the Workshop.", DRAWER_WORKSHOP,
            "ui:workshop-menu")
    }
    return listOfNotNull(
        raw.takeIf { it.isNotEmpty() }?.let {
            ResourceGroupUi("harvesters", "ui:harvester-menu", "HARVESTERS", "raw, one per realm", DRAWER_HARVEST, it, ResourceGroupLayout.TILE_STRIP)
        },
        refined.takeIf { it.isNotEmpty() }?.let {
            ResourceGroupUi("workshop", "ui:workshop-menu", "WORKSHOP", "refined from raw", DRAWER_WORKSHOP, it, ResourceGroupLayout.TILE_STRIP)
        },
    )
}

/** The LODGE strip's GO: the Lodge PASSPORT tab, where the same Renown is shown with its record. */
internal val DRAWER_PASSPORT = FeatureId("lodge.passport")

/**
 * LODGE (drawer.png; owner 2026-10-11 "where is EXP and Renown?"): one RENOWN tile, the server's published cumulative
 * Renown from the account's Realm Passport read (`GET /realm-passport/mining/current`). No group at all unless that read
 * served a number: an unavailable answer or a refused read (503 REALM_PASSPORT_UNAVAILABLE) draws nothing, never a dash
 * or a zero. EXP has no tile: no native read carries player experience.
 */
internal fun drawerLodgeGroup(current: PassportSection<PassportCurrent>?): ResourceGroupUi? {
    val renown = current?.observation?.data?.published?.cumulativeRenown ?: return null
    val known = liveCount(renown)
    val row = ResourceRowUi(id = "renown", icon = "ui:renown", name = "RENOWN",
        value = known?.let { compactAmount(it.toString(), maxGlyphs = 4) } ?: "", purpose = "Your published Realm Passport record.",
        earnedAt = "Recorded in your Realm Passport.", earnedAtFeature = DRAWER_PASSPORT, goIcon = "ui:lodge-menu", empty = known == 0L)
    return ResourceGroupUi("lodge", "ui:lodge-menu", "LODGE", "your passport record", DRAWER_PASSPORT, listOf(row), ResourceGroupLayout.TILE_STRIP)
}

/** One material tile: a 4-glyph count ("14", "2K"), "…" when the server string is not a count; empty only for a known 0. */
private fun materialRow(id: String, available: String, purpose: String, earnedAt: String, go: FeatureId, goIcon: String): ResourceRowUi {
    val known = liveCount(available)
    return ResourceRowUi(
        id = id,
        icon = craftItemIcon(id),
        name = catalogueKey(id).split('_').filter { it.isNotEmpty() }.joinToString(" ").uppercase(),
        value = known?.let { compactAmount(it.toString(), maxGlyphs = 4) } ?: "",
        purpose = purpose,
        earnedAt = earnedAt,
        earnedAtFeature = go,
        goIcon = goIcon,
        empty = known == 0L,
    )
}

/**
 * The crafting state to hand [drawerMaterialGroups] from a composable: the owner's refresh clears its view while it
 * reads, and a routine refresh must not blank strips already shown, so this keeps the last state that had a view until a
 * new one arrives. A different wallet or base still shows nothing ([drawerMaterialGroups] re-checks the scope).
 */
@Composable internal fun rememberDrawerCrafting(current: OrdinaryCraftingState?): OrdinaryCraftingState? {
    // A plain holder, not snapshot state: remembering the last view must not schedule another composition.
    val held = remember { HeldCrafting() }
    if (current?.view != null) held.state = current
    return if (current?.view != null) current else held.state
}

private class HeldCrafting { var state: OrdinaryCraftingState? = null }
