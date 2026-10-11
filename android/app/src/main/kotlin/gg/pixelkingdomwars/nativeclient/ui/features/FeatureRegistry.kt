package gg.pixelkingdomwars.nativeclient.ui.features

import java.util.Collections

enum class HostKind { BUILDING, ISLAND, HUD }
enum class Visibility { ALWAYS, WHEN_AVAILABLE, HISTORY_ONLY }
enum class FeatureSurface {
    COMMAND, TAB, SECTION, HISTORY_LINK, HUD_SLOT, CARD_ENTRY,
    CARD_DETAIL, MAP_PANEL, SPOT, ISLAND_PANEL, EMPTY_STATE_LINK,
}
enum class FeatureIconState { RESOLVED, DYNAMIC, BUNDLED_RESOLVER_REQUIRED, SHAPE_CONTRACT, UNRESOLVED }

class FeatureIcon(
    val state: FeatureIconState,
    val key: String?,
    val sourceKey: String? = null,
    candidates: List<String> = emptyList(),
) {
    val candidates: List<String> = Collections.unmodifiableList(ArrayList(candidates))
    init {
        require(sourceKey == null || sourceKey.isNotBlank())
        require(candidates.all { it.isNotBlank() } && candidates.distinct().size == candidates.size)
        when (state) {
            FeatureIconState.RESOLVED -> require(!key.isNullOrBlank())
            FeatureIconState.SHAPE_CONTRACT -> require(key != null && key.startsWith("shape:") && key.length > 6)
            FeatureIconState.DYNAMIC -> require(key == null && candidates.isNotEmpty())
            FeatureIconState.BUNDLED_RESOLVER_REQUIRED, FeatureIconState.UNRESOLVED -> require(key == null)
        }
    }
}

enum class FeatureAction { FINISH_NOW, COLLECT, REARM, WALL_ROW, REMOVE_OBSTACLE, BID_OR_TOP_UP, WITHDRAW_BID }
enum class FeatureScene { SCOUT, BATTLE }

sealed interface FeatureTarget {
    data class Sheet(val destination: Destination) : FeatureTarget
    data object SelectedBuildingInfo : FeatureTarget
    data object SelectedBuildingUpgrade : FeatureTarget
    data object SelectedRealmPermit : FeatureTarget
    data class SelectedIslandSpot(val islandId: String) : FeatureTarget {
        init { require(islandId.isNotBlank()) }
    }
    data object SelectedReachUnlock : FeatureTarget
    data object SelectedLandParcel : FeatureTarget
    data object SelectedHeroGear : FeatureTarget
    data class OwnedAction(val action: FeatureAction) : FeatureTarget
    data class Scene(val scene: FeatureScene) : FeatureTarget
    data class WorldHandoff(val island: String, val then: Destination? = null) : FeatureTarget {
        init { require(island.isNotBlank()) }
    }
    data class HomeHandoff(val destination: Destination.FocusBuilding) : FeatureTarget
}

/** Immutable metadata, not a second registration or an action owner. */
data class Feature(
    val id: FeatureId,
    val title: String,
    val hostKind: HostKind,
    val hostId: String,
    val surface: FeatureSurface,
    val gate: Gate,
    val icon: FeatureIcon,
    val target: FeatureTarget,
    val order: Int,
    val visibility: Visibility,
    val primary: Boolean = false,
    val primaryGate: Gate = Gate.Open,
    val shortcutOf: FeatureId? = null,
    val fallbackHost: String? = null,
    val sourceHost: String = hostId,
    val badge: String = "NONE",
) {
    init {
        require(id.value.isNotBlank() && title.isNotBlank() && hostId.isNotBlank() && sourceHost.isNotBlank())
        require(order >= 0 && badge.isNotBlank())
        require(fallbackHost == null || fallbackHost.isNotBlank())
    }
}

data class FeatureProjection(
    val feature: Feature,
    val gate: GateResult,
    val visible: Boolean,
    val enabled: Boolean,
    val primary: Boolean,
)

sealed interface FeatureResolution {
    data class Navigate(val destination: Destination) : FeatureResolution
    data class Action(val action: FeatureAction) : FeatureResolution
    data class Scene(val scene: FeatureScene) : FeatureResolution
    data class WorldHandoff(val island: String, val then: Destination?) : FeatureResolution
    data class HomeHandoff(val destination: Destination.FocusBuilding) : FeatureResolution
    data class Locked(val reason: String) : FeatureResolution
    data object Hidden : FeatureResolution
}

class FeatureRegistry private constructor(input: List<Feature>) {
    val rows: List<Feature> = Collections.unmodifiableList(ArrayList(input))
    private val byId: Map<FeatureId, Feature> = Collections.unmodifiableMap(rows.associateBy { it.id })

    init {
        require(byId.size == rows.size) { "Duplicate feature ID" }
        require(rows.all { it.shortcutOf == null || it.shortcutOf in byId }) { "Shortcut target is missing" }
        require(rows.none { it.shortcutOf == it.id }) { "A feature cannot shortcut itself" }
        require(rows.all { it.visibility != Visibility.HISTORY_ONLY || it.target.historyOnly() }) {
            "A history-only feature cannot target new work"
        }
    }

    operator fun get(id: FeatureId): Feature? = byId[id]

    fun project(ctx: GateContext): List<FeatureProjection> =
        immutableProjection(resolvePrimaryConflicts(rows.map { it.project(ctx) }, context = ctx))

    fun forSurface(kind: HostKind, hostId: String, surface: FeatureSurface, ctx: GateContext): List<FeatureProjection> {
        if (hostId.isBlank()) return emptyList()
        val selected = rows.filter { it.hostKind == kind && it.surface == surface && it.matchesHost(hostId, ctx) }
            .sortedBy { it.order }
        // Wildcard and multi-building templates now share the actual rendered host.
        return immutableProjection(resolvePrimaryConflicts(selected.map { it.project(ctx) }, renderedHost = hostId))
    }

    /** Resolves passive routing metadata only. The existing runtime bridge still checks its live owner. */
    fun resolve(id: FeatureId, ctx: GateContext): FeatureResolution {
        val feature = byId[id] ?: return FeatureResolution.Locked("This feature is not available")
        val projection = project(ctx).first { it.feature.id == id }
        if (!projection.visible) return FeatureResolution.Hidden
        if (!projection.enabled) return FeatureResolution.Locked((projection.gate as? GateResult.Locked)?.reason ?: "This feature is not available")
        return when (val target = feature.target) {
            is FeatureTarget.Sheet -> FeatureResolution.Navigate(target.destination.withSelectedRoute(ctx))
            FeatureTarget.SelectedBuildingInfo -> selectedBuilding(feature, ctx)?.let {
                FeatureResolution.Navigate(Destination.BuildingInfo(it.buildingId))
            } ?: missingSelection()
            FeatureTarget.SelectedBuildingUpgrade -> selectedBuilding(feature, ctx)?.let {
                FeatureResolution.Navigate(Destination.Upgrade(it.buildingId))
            } ?: missingSelection()
            FeatureTarget.SelectedHeroGear -> selectedBuilding(feature, ctx)?.let { building ->
                when (building.type) {
                    "heroaltar" -> FeatureResolution.Navigate(Destination.Heroes("vex", "GEAR"))
                    "siegestool" -> FeatureResolution.Navigate(Destination.Heroes("theodor", "GEAR"))
                    else -> missingSelection()
                }
            } ?: missingSelection()
            FeatureTarget.SelectedRealmPermit -> ctx.selection.spot?.takeIf { it.islandId == "seeker-island" }?.let {
                FeatureResolution.Navigate(Destination.RealmPermit(it.spot))
            } ?: missingSelection()
            is FeatureTarget.SelectedIslandSpot -> ctx.selection.spot?.takeIf { it.islandId == target.islandId }?.let {
                FeatureResolution.Navigate(Destination.IslandSpot(islandAddress(it.islandId), it.spot))
            } ?: missingSelection()
            FeatureTarget.SelectedReachUnlock -> ctx.selection.tile?.takeIf { it.canonicalReach }?.let {
                FeatureResolution.Navigate(Destination.SolanaReachUnlock(it.tileId))
            } ?: missingSelection()
            FeatureTarget.SelectedLandParcel -> ctx.selection.tile?.takeIf { !it.canonicalReach }?.let {
                FeatureResolution.Navigate(Destination.LandGate("parcel", it.tileId))
            } ?: missingSelection()
            is FeatureTarget.OwnedAction -> FeatureResolution.Action(target.action)
            is FeatureTarget.Scene -> FeatureResolution.Scene(target.scene)
            is FeatureTarget.WorldHandoff -> FeatureResolution.WorldHandoff(target.island, target.then)
            is FeatureTarget.HomeHandoff -> FeatureResolution.HomeHandoff(
                target.destination.copy(then = target.destination.then?.withSelectedRoute(ctx)))
        }
    }

    companion object {
        fun of(rows: List<Feature>): FeatureRegistry = FeatureRegistry(rows)
        fun canonical(): FeatureRegistry = canonicalRegistry
        private val canonicalRegistry: FeatureRegistry by lazy { FeatureRegistry(canonicalFeatures()) }
    }
}

private fun Feature.project(ctx: GateContext): FeatureProjection {
    val result = gate.check(ctx)
    val pass = result == GateResult.Pass
    val visible = visibility == Visibility.ALWAYS || pass
    return FeatureProjection(this, result, visible, visible && pass,
        visible && pass && primary && primaryGate.check(ctx) == GateResult.Pass)
}

private fun resolvePrimaryConflicts(input: List<FeatureProjection>, renderedHost: String? = null, context: GateContext? = null): List<FeatureProjection> {
    val conflicts = input.filter { it.primary }.groupBy {
        val selectedHost = context?.let { ctx -> ctx.selection.building?.takeIf { selected ->
            it.feature.hostKind == HostKind.BUILDING && selected.baseId == ctx.baseId &&
                it.feature.matchesHost(selected.type, ctx)
        }?.type }
        Triple(it.feature.hostKind, renderedHost ?: selectedHost ?: it.feature.hostId, it.feature.surface)
    }.values.filter { it.size > 1 }.flatten().map { it.feature.id }.toSet()
    if (conflicts.isEmpty()) return input
    return input.map {
        if (it.feature.id !in conflicts) it else it.copy(
            gate = GateResult.Locked("Choose a current action before continuing"), enabled = false, primary = false)
    }
}

private fun immutableProjection(rows: List<FeatureProjection>): List<FeatureProjection> =
    Collections.unmodifiableList(ArrayList(rows))

private fun FeatureTarget.historyOnly(): Boolean = when (this) {
    is FeatureTarget.Sheet -> destination is Destination.WalletHistory ||
        (destination is Destination.Harvester && destination.tab == "HISTORY")
    else -> false
}

private fun Feature.matchesHost(requested: String, ctx: GateContext): Boolean {
    // A fallback is sheet metadata (Keep -> Stores -> Trade), never another Keep command.
    // The existing KeepStores/Market owner queries rows.fallbackHost explicitly after its live guard.
    return when (id.value) {
        "building.info", "building.upgrade", "building.finish" ->
            ctx.selection.building?.let { it.baseId == ctx.baseId && it.type == requested } == true
        "hero.gear" -> requested == "heroaltar" || requested == "siegestool"
        "trap.rearm" -> requested in setOf("spiketrap", "powdermine", "pitfall", "airmine")
        else -> hostId == requested
    }
}

private fun selectedBuilding(feature: Feature, ctx: GateContext): BuildingSelection? =
    ctx.selection.building?.takeIf { it.baseId == ctx.baseId && feature.matchesHost(it.type, ctx) }

private fun Destination.withSelectedRoute(ctx: GateContext): Destination = when (this) {
    is Destination.Lodge -> if (tab == "SEND" && routeId == null && ctx.selection.routeId != null) copy(routeId = ctx.selection.routeId) else this
    else -> this
}

private fun islandAddress(id: String): String = when (id) {
    "seeker-island" -> "seeker"
    "solana-island" -> "solana"
    "divine-isle" -> "divine"
    else -> id
}

private fun missingSelection(): FeatureResolution.Locked = FeatureResolution.Locked("Choose the current place first")
