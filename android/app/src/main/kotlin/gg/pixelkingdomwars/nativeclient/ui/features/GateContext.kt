package gg.pixelkingdomwars.nativeclient.ui.features

import java.util.Collections

data class BuildingGateState(val level: Int, val complete: Boolean) {
    init {
        require(level >= 0) { "Building level must be nonnegative" }
        require(!complete || level > 0) { "A completed building must exist" }
    }
}

data class BuildingSelection(val baseId: String, val buildingId: String, val type: String) {
    init {
        require(baseId.isNotBlank() && buildingId.isNotBlank() && type.isNotBlank())
    }
}

data class IslandSpotSelection(val islandId: String, val spot: Int) {
    init { require(islandId.isNotBlank() && spot >= 0) }
}

/** canonicalReach is supplied by M2/MS-D's admitted catalogue mapping, never inferred here. */
data class MapTileSelection(val tileId: Int, val canonicalReach: Boolean) {
    init { require(tileId >= 0) }
}

data class FeatureSelection(
    val building: BuildingSelection? = null,
    val spot: IslandSpotSelection? = null,
    val tile: MapTileSelection? = null,
    val routeId: String? = null,
) {
    init { require(routeId == null || routeId.isNotBlank()) }
}

/**
 * Already admitted observations. Missing facts remain unknown. No API, clock, catalogue
 * decoder, callback, wallet, or repository is retained by this detached value.
 */
class GateContext(
    val baseId: String? = null,
    val walletLinked: GateFact = GateFact.Unknown,
    val keepLevel: Int? = null,
    buildings: Map<String, BuildingGateState> = emptyMap(),
    serverFeatures: Map<String, GateFact> = emptyMap(),
    ownerFacts: Map<String, GateFact> = emptyMap(),
    history: Map<String, GateFact> = emptyMap(),
    val selection: FeatureSelection = FeatureSelection(),
) {
    val buildings: Map<String, BuildingGateState> = immutableFacts(buildings)
    val serverFeatures: Map<String, GateFact> = immutableFacts(serverFeatures)
    val ownerFacts: Map<String, GateFact> = immutableFacts(ownerFacts)
    val history: Map<String, GateFact> = immutableFacts(history)

    init {
        require(baseId == null || baseId.isNotBlank())
        require(keepLevel == null || keepLevel >= 0)
    }
}

private fun <V> immutableFacts(input: Map<String, V>): Map<String, V> {
    require(input.keys.all { it.isNotBlank() }) { "Fact keys must be nonblank" }
    return Collections.unmodifiableMap(LinkedHashMap(input))
}
