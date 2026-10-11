package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.features.BuildingSelection
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId

/** The Home owner's callbacks. Enqueue is not a launch result and never releases selection. */
internal class PhaseEBuildingDispatcher(
    val openFeature: (FeatureId) -> Unit,
    val openResources: (FeatureId, Destination.Resources) -> Unit,
    private val currentSelection: () -> BuildingSelection?,
) {
    fun openBuilding(renderedBaseId: String?, renderedBuilding: Building, currentBase: BaseSnapshot?) {
        val selected = currentSelection() ?: return
        if (selected.baseId != renderedBaseId || selected.buildingId != renderedBuilding.id ||
            selected.type != renderedBuilding.type) return
        val feature = PhaseEBuildingActions.canonicalFeature(
            currentBase, renderedBuilding.id, renderedBaseId, renderedBuilding.type,
        ) ?: return
        // HomeRouteDispatcher owns fresh registry admission and queued generation revalidation.
        openFeature(feature)
    }
}

/** Legacy activity adapter; FeatureRegistry owns the canonical feature IDs and surface metadata. */
internal object PhaseEBuildingActions {
    private val canonicalDoors = mapOf(
        "workshop" to FeatureId("workshop.craft"),
        "market" to FeatureId("market.trade"),
        "harvester" to FeatureId("harvester.harvest"),
        "lodge" to FeatureId("lodge.expedition"),
        "berth" to FeatureId("berth.fleet"),
    )

    /** Exact current building only. Feature/owner gates are still evaluated by the single Home dispatcher. */
    fun canonicalFeature(base: BaseSnapshot?, buildingId: String, renderedBaseId: String?,
        renderedType: String): FeatureId? {
        if (base == null || renderedBaseId.isNullOrBlank() || base.baseId != renderedBaseId) return null
        val building = base.buildings.singleOrNull { it.id == buildingId } ?: return null
        if (building.type != renderedType || building.underConstruction || building.level <= 0) return null
        return canonicalDoors[building.type]
    }

    private val buildingActions = linkedMapOf(
        "workshop" to listOf(PhaseEActivity.INGOT_WORKSHOP, PhaseEActivity.REFINING, PhaseEActivity.WORKSHOP, PhaseEActivity.COSMETICS),
        "market" to listOf(PhaseEActivity.KEEP_MARKET),
        "harvester" to listOf(PhaseEActivity.HARVESTERS),
        "lodge" to listOf(PhaseEActivity.STARTER_EXPEDITIONS, PhaseEActivity.PAID_EXPEDITIONS, PhaseEActivity.VEHICLES),
        "berth" to listOf(PhaseEActivity.STARTER_FLEET, PhaseEActivity.VEHICLES),
    )
    val buildingTypes: Set<String> get() = buildingActions.keys

    /** [advertised] is supplied by validated current feature reads, never by saved journals or a build flag alone.
     * Cosmetic admission additionally checks its actual Market/Lodge in the snapshot adapter, preserving Wake's hold.
     * Market is a discovery host only; this does not add a server trading authorization gate. */
    @JvmStatic fun actions(base: BaseSnapshot?, buildingId: String, snapshotBaseId: String?,
        advertised: Set<PhaseEActivity>): List<PhaseEActivity> {
        if (base?.baseId == null || base.baseId != snapshotBaseId) return emptyList()
        val building = base.buildings.singleOrNull { it.id == buildingId } ?: return emptyList()
        if (building.underConstruction || building.level <= 0) return emptyList()
        return buildingActions[building.type].orEmpty().filter { it in advertised }
    }

    /** Canonical host strings from the approved110-row table; no retired menu home. */
    @JvmStatic fun hosts(activity: PhaseEActivity): Set<String> = when (activity) {
        PhaseEActivity.INGOT_WORKSHOP, PhaseEActivity.REFINING, PhaseEActivity.WORKSHOP, PhaseEActivity.COSMETICS -> setOf("workshop")
        PhaseEActivity.KEEP_MARKET -> setOf("market", "keep")
        PhaseEActivity.HARVESTERS -> setOf("harvester")
        PhaseEActivity.STARTER_FLEET -> setOf("berth")
        PhaseEActivity.STARTER_EXPEDITIONS, PhaseEActivity.PAID_EXPEDITIONS -> setOf("lodge")
        PhaseEActivity.VEHICLES -> setOf("berth", "lodge", "solana-island")
        PhaseEActivity.DIVINE_TRIALS -> setOf("divine-isle")
        PhaseEActivity.FRAGMENTS -> setOf("divine-isle")
        PhaseEActivity.SHARDS, PhaseEActivity.RESOURCES, PhaseEActivity.MINING_TAX -> setOf("seeker-island")
        PhaseEActivity.MINING -> setOf("goldforge")
        PhaseEActivity.REALM_PASSPORT -> setOf("lodge")
        PhaseEActivity.REALM_PERMITS -> setOf("seeker-island")
        PhaseEActivity.FREE_KINGDOM -> setOf("PROFILE_TAB")
        PhaseEActivity.CHARTERS -> setOf("clanhall")
        PhaseEActivity.TOURNAMENTS -> setOf("clanhall", "divine-isle")
    }
}
