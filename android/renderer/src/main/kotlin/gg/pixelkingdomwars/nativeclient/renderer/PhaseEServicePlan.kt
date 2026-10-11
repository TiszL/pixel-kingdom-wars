package gg.pixelkingdomwars.nativeclient.renderer

import java.util.Collections

/** A render-only selection. Group names are requirements, never proof of installed pixels. */
data class ServiceLayer(val group: String, val frames: List<String>, val fps: Float, val loop: Boolean,
    val cell: ServicePoint, val scale: Float, val origin: ServicePoint, val offset: ServicePoint)
data class ServicePlan(val signature: String, val layers: List<ServiceLayer>, val groups: Set<String>, val terminal: ServicePlan? = null)
data class ServiceSelection(val plan: ServicePlan?, val status: String)
enum class ServiceCombatState { IDLE, DAMAGED, COLLAPSE, DESTROYED }

/** Display-only identity shared by the current Home scene and its info portrait.
 * Absent installation facts select the bare starter building, never an installed
 * starter vehicle. Malformed positive facts refuse; an absent sibling does not
 * erase a valid installation. The caller still owns permission and pixel admission. */
fun completedBerthAppearance(building: RenderBuilding, facts: RenderServiceFacts): String? {
    if (building.type != "berth" || building.service != RenderServiceIdentity("berth", null) ||
        building.underConstruction || (building.level ?: 0) < 1) return null
    val starterRows = facts.berths.orEmpty().filter { it.buildingId == building.id }
    val advancedRows = facts.currentAdvancedBerths.orEmpty().filter { it.buildingId == building.id }
    if (starterRows.size > 1 || advancedRows.size > 1) return null
    val starter = starterRows.singleOrNull()?.installation
    val advanced = advancedRows.singleOrNull()?.installation
    if (starter != null && advanced != null) return null
    if (starter != null) return "starter-berth".takeIf { starter.family == "starter" }
    if (advanced != null) {
        // Closed authored vocabulary only; no private art capability is created.
        if (advanced.family !in PhaseEFleetArt.advancedFamilies || advanced.tier !in PhaseEFleetArt.tiers) return null
        return "${PhaseEFleetArt.dashed(advanced.family)}-berth"
    }
    return "starter-berth"
}

/** Canonical service activity semantics with an explicit static Home Berth opt-in.
 * No timers, stock, installation, realm or game availability is inferred, and
 * metadata alone never enables art. */
fun selectServicePlan(art: PhaseEServiceArt?, building: RenderBuilding, realmId: String?, facts: RenderServiceFacts,
    enabled: Boolean, reducedMotion: Boolean, job: String? = null, combat: ServiceCombatState? = null,
    /** Ordinary current Home only; the private fleet caller retains its prior selection. */
    staticBerth: Boolean = false): ServiceSelection {
    val service = building.service ?: return ServiceSelection(null, "")
    require(service.facility == building.type)
    if (building.underConstruction || job == "build") return ServiceSelection(null, "Under construction")
    val activity = facts.activity?.singleOrNull { it.buildingId == building.id }?.state
    val status = when {
        combat != null -> ""
        job == "upgrade" -> "Upgrading"
        activity == RenderServiceState.WORKING -> "Working"
        activity == RenderServiceState.READY -> "Ready"
        else -> ""
    }
    if (!enabled || art == null) return ServiceSelection(null, status)
    val installation = facts.berths?.singleOrNull { it.buildingId == building.id }?.installation
    val staticBerthAppearance = if (service.facility == "berth" && staticBerth && combat == null)
        completedBerthAppearance(building, facts) ?: return ServiceSelection(null, status) else null
    if (service.facility == "berth" && staticBerthAppearance == null &&
        (installation?.family != "starter" || installation.presence != RenderStarterPresence.AWAY)) return ServiceSelection(null, status)
    val appearanceId = when (service.facility) {
        "harvester" -> realmId?.let { "harvester-$it-t${service.tier}" } ?: return ServiceSelection(null, status)
        "berth" -> staticBerthAppearance ?: "${installation!!.family}-berth"
        else -> "${service.facility}-t${service.tier}"
    }
    // Renderer16 (C4): a Market wearing an admitted Awning draws the Awning appearance —
    // only when the frozen/current projection names this building, the binding hashes
    // equal the packed extension's and the Awning tier is the Market's COMPLETED tier.
    // Every other case (legacy absence, unavailable, hash or tier disagreement, no
    // extension in this pack) keeps the ordinary Market appearance.
    val awning = if (service.facility == "market") facts.awnings?.singleOrNull { it.buildingId == building.id } else null
    val cosmetic = awning?.let { art.cosmetics?.admitted(it.outputId, it.bindingSha256, it.sourceManifestSha256, it.sourceIndexSha256, service.tier) }
    val appearance = cosmetic ?: art.appearances[appearanceId] ?: return ServiceSelection(null, status)
    val state = when {
        combat != null -> if (combat == ServiceCombatState.IDLE && service.facility == "berth") "away" else combat.name.lowercase()
        service.facility == "berth" -> if (staticBerthAppearance == null || installation?.presence == RenderStarterPresence.AWAY ||
            facts.currentAdvancedBerths?.singleOrNull { it.buildingId == building.id }?.installation?.presence == RenderAdvancedPresence.AWAY) "away" else "intact"
        job == "upgrade" -> "idle"
        else -> activity?.name?.lowercase() ?: "idle"
    }
    val terminalState = if (state == "collapse") "destroyed" else state
    var plan = resolveServicePlan(art, appearance, if (reducedMotion) terminalState else state, reducedMotion)
    // A separately authored neutral still preserves status; it is NOT an authored
    // reduced-motion Working/Ready frame. The missing FX image is never emitted.
    if (plan == null && reducedMotion && state in setOf("working", "ready")) plan = resolveServicePlan(art, appearance, "idle", true)
    if (state == "collapse") {
        val terminal = resolveServicePlan(art, appearance, "destroyed", true)
        if (plan == null) plan = terminal
        else if (terminal != null && !reducedMotion) plan = plan.copy(groups = Collections.unmodifiableSet(plan.groups + terminal.groups), terminal = terminal)
    }
    return ServiceSelection(plan, status)
}

/** Exact authored graph resolution, including cross-group rubble and overlay seats. */
fun resolveServicePlan(art: PhaseEServiceArt, appearance: ServiceAppearance, state: String, reducedMotion: Boolean): ServicePlan? {
    if (art.appearances[appearance.id] !== appearance || state !in appearance.states) return null
    val origin = ServicePoint(appearance.geometry.horizontalPivot / appearance.geometry.cell.x,
        appearance.geometry.cellBottom / appearance.geometry.cell.y)
    fun clip(id: String, origin: ServicePoint, offset: ServicePoint): List<ServiceLayer>? {
        val clip = art.clips.getValue(id)
        val frames = if (reducedMotion) when (val reduced = clip.reducedMotion) {
            is ServiceReducedMotion.Frame -> listOf(clip.frames[reduced.index].key)
            else -> return null
        } else clip.playbackIndices.map { clip.frames[it].key }
        return listOf(ServiceLayer(art.groupFor(frames.first()).id, Collections.unmodifiableList(frames), clip.fps,
            !reducedMotion && clip.loop, clip.cell, appearance.geometry.drawScale, origin, offset))
    }
    fun resolve(id: String, name: String, origin: ServicePoint, offset: ServicePoint): List<ServiceLayer>? = when (val value = art.appearances.getValue(id).states.getValue(name)) {
        is ServiceArtState.Still -> listOf(ServiceLayer(art.groupFor(value.key).id, listOf(value.key), 0f, false,
            art.appearances.getValue(id).geometry.cell, appearance.geometry.drawScale, origin, offset))
        is ServiceArtState.Clip -> clip(value.clip, origin, offset)
        is ServiceArtState.Alias -> resolve(value.target.appearance, value.target.state, origin, offset)
        is ServiceArtState.Composition -> {
            val parts = value.parts.map { resolve(it.appearance, it.state, origin, offset) }
            if (parts.any { it == null }) null else {
                val overlay = value.overlay?.let { offset ->
                    val effect = art.clips.getValue(value.overlayClip)
                    val anchor = if (value.overlayClip == "pe_fx_craft-success") art.effectAnchor else ServicePoint(effect.anchorPx.x / effect.cell.x, effect.anchorPx.y / effect.cell.y)
                    clip(value.overlayClip, anchor, offset)
                }
                if (value.overlay != null && overlay == null) null else parts.flatMap { it!! } + overlay.orEmpty()
            }
        }
    }
    val layers = resolve(appearance.id, state, origin, ServicePoint(0f, 0f)) ?: return null
    return ServicePlan("${appearance.id}:$state:$reducedMotion", Collections.unmodifiableList(layers), Collections.unmodifiableSet(layers.map { it.group }.toSet()))
}
