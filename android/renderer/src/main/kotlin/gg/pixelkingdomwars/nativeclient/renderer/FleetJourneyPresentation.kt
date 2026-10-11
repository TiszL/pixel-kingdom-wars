package gg.pixelkingdomwars.nativeclient.renderer

import java.util.Collections

/**
 * N-C5 (owner D153.248): a fresh, original-bound fleet departure or committed return
 * plays the installation's OWN authored one-second track once — the craft moves by the
 * authored offsets AND opacity, the Aurora Wake rides the craft contact, the shared gate
 * effect bursts at the family's authored berth seat — and then the ordinary service plan
 * rests again. This file has no network dependency: the app mapper turns root's strict
 * event into [RenderFleetJourney]. Nothing here is stored on a [BaseScene] or inside a
 * replayable scene submission; a journey the renderer is handed plays at most once and
 * is dropped whenever its scene, berth, installation, art or lifecycle is not current.
 * Present render facts carry no installation/expedition identity, so exact identity is never
 * claimed from family alone: every installed scene submission (even the same base), any asset or
 * art replacement, pause, battle or other base ends every flight (conservative), and only the
 * starter family can start at all until a typed current advanced mapping is admitted.
 *
 * Journey ART is an injectable admitted capability ([FleetJourneyArt]). The active
 * contract-15 pack carries no vehicle clips, geometry, tracks or gate effects and the
 * Wake clip only in the unactivated contract-16 candidate, so with current content every
 * journey resolves to no plan and draws nothing: offsets, craft and Wake are never invented.
 */
enum class RenderJourneyKind { DEPARTURE, RETURN }

data class RenderJourneyVehicle(val family: String, val tier: Int?)

/** The ORIGINAL frozen Wake capture, mapped: legacy absence, an actual Off selection and an
 *  unavailable source stay distinct; only [Available] may draw, and only hash-equal. */
sealed interface RenderJourneyWake {
    object Legacy : RenderJourneyWake
    object Off : RenderJourneyWake
    object Unavailable : RenderJourneyWake
    data class Available(val outputId: String, val bindingSha256: String,
        val sourceManifestSha256: String, val sourceIndexSha256: String) : RenderJourneyWake
}

/** One typed journey handed to the renderer. [key] is the producer's dedup key
 *  (kind:family:receipt); the renderer never derives, replays or persists it. */
data class RenderFleetJourney(val key: String, val kind: RenderJourneyKind, val baseId: String, val berthId: String,
    val installationId: String, val vehicle: RenderJourneyVehicle, val wake: RenderJourneyWake)

/** Authored track data, carried as DATA: frame index, offset in berth-cell pixels, opacity. */
data class JourneyStep(val frame: Int, val offsetPx: ServicePoint, val opacity: Float)
data class JourneyTrack(val fps: Float, val departure: List<JourneyStep>, val back: List<JourneyStep>,
    val effectAttachmentPx: ServicePoint, val sharedFxRef: String?)
/** The docked craft clip: its anchor IS the authored contact; [dockOffsetPx] is the authored
 *  vehicle-cell-top-left minus berth-cell-top-left translation, applied once. */
data class JourneyVehicleArt(val atlasPath: String, val frames: List<String>, val fps: Float,
    val cell: ServicePoint, val contactPx: ServicePoint, val dockOffsetPx: ServicePoint)
/** A centre-anchored 64-cell effect or Wake clip. [frames] is the authored normal sequence, unchanged;
 *  [still] is the SEPARATELY authored reduced-motion frame key (its own packed cell, never a member of
 *  [frames] — the sidecar's `*_still_f1` shares no RGBA digest with any normal frame). */
data class JourneyEffectArt(val atlasPath: String, val frames: List<String>, val fps: Float, val cell: ServicePoint, val still: String?)

/** Admitted journey art for a family, or null. Absent in the active pack (see file header). */
interface FleetJourneyArt {
    fun track(family: String): JourneyTrack?
    fun vehicle(family: String, tier: Int?): JourneyVehicleArt?
    fun gateEffect(kind: RenderJourneyKind): JourneyEffectArt?
    /** Only when every hash of [wake] equals the packed Aurora binding; otherwise null. */
    fun wake(wake: RenderJourneyWake.Available): JourneyEffectArt?
}

data class JourneyPlan(val kind: RenderJourneyKind, val fps: Float, val steps: List<JourneyStep>, val vehicle: JourneyVehicleArt,
    val effect: JourneyEffectArt?, val effectAttachmentPx: ServicePoint, val wake: JourneyEffectArt?, val reducedMotion: Boolean) {
    val durationMs: Float get() = steps.size * 1000f / fps
    val atlasPaths: Set<String> get() = setOfNotNull(vehicle.atlasPath, effect?.atlasPath, wake?.atlasPath)
}

/** Authored families are dash-named in the admitted art and underscore-named on the wire. */
internal fun journeyFamilyKey(family: String): String = family.replace('_', '-')

/** The plan [journey] selects for [building], or null. R1 rules: the row must be this COMPLETED
 *  berth (level ≥ 1, not under construction). A STARTER event (family `starter`, null tier) needs the
 *  current starter installation on this berth. An ADVANCED event (N-C5-FACTS) needs a supported wire
 *  family, a typed tier 1..4 carried BY THE EVENT (a missing tier is never filled from facts) and exactly
 *  one CURRENT advanced berth row ([RenderServiceFacts.currentAdvancedBerths]) for this berth whose installed
 *  family AND tier equal the event: no starter fallback, no same-family/other-tier row, no inference from
 *  the event or the art; an unknown/refused/battle-mapped projection (null list) selects nothing. Two
 *  explicitly installed siblings on one berth are contradictory facts and refuse either event. Presence is
 *  carried as a fact and never gates selection: a fresh departure may arrive while the pre-command scene
 *  still says OCCUPIED, and no presence creates a journey by itself. Both track and craft resolve through
 *  the matching family's own art key (journeyFamilyKey) with the mapped tier; a named gate effect must be
 *  admitted; the Wake only for an available hash-equal capture. Every admitted array/number is
 *  validated (finite, positive, bounded, ordinal, non-empty) and COPIED into the plan, so a
 *  mutable or malformed provider can neither crash the GL frame nor change a started flight.
 *  Under reduced motion the authored contract is an immediate transition: no movement, no Wake,
 *  the effect's authored still only. */
fun selectJourneyPlan(art: FleetJourneyArt?, building: RenderBuilding, facts: RenderServiceFacts,
    journey: RenderFleetJourney, reducedMotion: Boolean): JourneyPlan? {
    if (art == null || building.id != journey.berthId || building.underConstruction || (building.level ?: 0) < 1) return null // null level is not a completed berth
    if (building.service?.facility != "berth" || building.type != "berth") return null
    val wire = journey.vehicle
    val starterInstalled = facts.berths?.any { it.buildingId == building.id && it.installation != null } == true
    val advancedInstalled = facts.currentAdvancedBerths?.any { it.buildingId == building.id && it.installation != null } == true
    if (starterInstalled && advancedInstalled) return null // contradictory installed siblings: no precedence is chosen
    val familyKey: String; val tier: Int?
    if (wire.family == "starter") {
        if (wire.tier != null) return null
        val installation = facts.berths?.singleOrNull { it.buildingId == building.id }?.installation ?: return null
        if (installation.family != "starter") return null
        familyKey = "starter"; tier = null
    } else {
        val eventTier = wire.tier ?: return null // never take a missing tier from the facts
        if (wire.family !in PhaseEFleetArt.advancedFamilies || eventTier !in PhaseEFleetArt.tiers) return null
        val rows = facts.currentAdvancedBerths ?: return null // unknown, refused or battle-mapped: nothing is current
        val installation = rows.singleOrNull { it.buildingId == building.id }?.installation ?: return null // missing or duplicate rows refuse
        if (installation.family != wire.family || installation.tier != eventTier) return null // exact family AND tier; no sibling tier
        familyKey = journeyFamilyKey(wire.family); tier = eventTier
    }
    val track = art.track(familyKey)?.let(::admittedTrack) ?: return null
    val steps = if (journey.kind == RenderJourneyKind.DEPARTURE) track.departure else track.back
    val vehicle = art.vehicle(familyKey, tier)?.let(::admittedVehicle) ?: return null
    val effect = if (track.sharedFxRef != null) art.gateEffect(journey.kind)?.let(::admittedEffect) ?: return null else null
    val wakeArt = (journey.wake as? RenderJourneyWake.Available)?.let(art::wake)
    val wake = if (wakeArt == null) null else admittedEffect(wakeArt) ?: return null // present but malformed Wake art refuses the flight
    return JourneyPlan(journey.kind, track.fps, steps, vehicle, effect, track.effectAttachmentPx, wake, reducedMotion)
}

private fun finitePositive(value: Float): Boolean = value.isFinite() && value > 0f
private fun finitePoint(point: ServicePoint): Boolean = point.x.isFinite() && point.y.isFinite()
private fun positivePoint(point: ServicePoint): Boolean = finitePositive(point.x) && finitePositive(point.y)
private fun <T> frozen(values: List<T>): List<T> = java.util.Collections.unmodifiableList(ArrayList(values))
/** Authored timeline: frame == index (the accepted primary parseSteps rule), finite offsets, opacity in [0,1]. */
private fun admittedSteps(steps: List<JourneyStep>): List<JourneyStep>? {
    if (steps.isEmpty() || steps.size > MAX_TRACK_STEPS) return null
    for ((index, step) in steps.withIndex()) if (step.frame != index || !finitePoint(step.offsetPx) || !step.opacity.isFinite() || step.opacity < 0f || step.opacity > 1f) return null
    return frozen(steps)
}
private fun admittedTrack(track: JourneyTrack): JourneyTrack? {
    if (!finitePositive(track.fps) || !finitePoint(track.effectAttachmentPx)) return null
    val departure = admittedSteps(track.departure) ?: return null
    val back = admittedSteps(track.back) ?: return null
    return JourneyTrack(track.fps, departure, back, track.effectAttachmentPx, track.sharedFxRef)
}
private fun admittedFrames(frames: List<String>): List<String>? =
    if (frames.isEmpty() || frames.size > MAX_CLIP_FRAMES || frames.any { it.isBlank() }) null else frozen(frames)
private fun admittedVehicle(vehicle: JourneyVehicleArt): JourneyVehicleArt? {
    if (vehicle.atlasPath.isBlank() || !finitePositive(vehicle.fps) || !positivePoint(vehicle.cell) || !finitePoint(vehicle.contactPx) || !finitePoint(vehicle.dockOffsetPx)) return null
    val frames = admittedFrames(vehicle.frames) ?: return null
    return JourneyVehicleArt(vehicle.atlasPath, frames, vehicle.fps, vehicle.cell, vehicle.contactPx, vehicle.dockOffsetPx)
}
private fun admittedEffect(effect: JourneyEffectArt): JourneyEffectArt? {
    if (effect.atlasPath.isBlank() || !finitePositive(effect.fps) || !positivePoint(effect.cell)) return null
    val frames = admittedFrames(effect.frames) ?: return null
    if (effect.still != null && effect.still.isBlank()) return null // a declared still must name a cell; membership in [frames] is NOT required
    return JourneyEffectArt(effect.atlasPath, frames, effect.fps, effect.cell, effect.still)
}
/** Bounded input sizes only (resource limits, not authored facts). */
private const val MAX_TRACK_STEPS = 64
private const val MAX_CLIP_FRAMES = 64

/** N-C5 RESIDENCY: the ONE authoritative journey eligibility read, shared by host preparation and by submission (which
 *  re-checks under the playback gate at insertion). The installed [admission] must belong to the CURRENT requested scene
 *  generation (a pending replacement is not eligible), carry prepared assets whose fleet residency was prepared with the
 *  EXACT current [source] and [capability] and whose adapter IS the admission's art, the source must still be current,
 *  the scene must be [baseId], and the existing permission/lifecycle condition [enabled] must hold. Pure; nothing else. */
internal fun eligibleJourneyAdmission(admission: JourneyAdmission?, requestedGeneration: Long, source: ServiceAssetSource?,
    capability: PhaseEFleetArt?, baseId: String, enabled: Boolean): JourneyAdmission? {
    if (!enabled || admission == null || source == null || capability == null) return null
    if (admission.generation != requestedGeneration) return null
    val fleet = admission.assets?.fleet ?: return null
    if (fleet.source !== source || fleet.capability !== capability || admission.art !== fleet.journeyArt) return null
    if (admission.scene.baseId == null || admission.scene.baseId != baseId) return null
    if (!runCatching { source.isCurrent() }.getOrDefault(false)) return null
    return admission
}

/** One sprite of a journey frame, its authored opacity and the VERIFIED resident cell it draws from
 *  (resolved against the admission's own atlas at admission time — never the flattened global frame map). */
internal data class JourneySprite(val sprite: BaseVisualSprite, val alpha: Float, val cell: ServicePackedCell)

/** One resident atlas exactly as the admission's asset set holds it: its path and packed cell map. */
internal data class JourneyResidentAtlas(val path: String, val cells: Map<String, ServicePackedCell>)

/** The verified cells of one admitted journey, per art piece, each resolved in the ONE resident
 *  atlas at that piece's exact path under the same admission generation. Owned, unmodifiable. */
internal class JourneyResidency(val vehicle: Map<String, ServicePackedCell>, val effect: Map<String, ServicePackedCell>?, val wake: Map<String, ServicePackedCell>?)

/** Resolve EVERY normal frame key AND the separate still of every piece of [plan] in exactly one resident
 *  atlas whose path equals the piece's atlas path. No atlas, two atlases at that path, a missing cell or a
 *  missing still → null (the journey drops). Nothing is loaded or queued; nothing is substituted. */
internal fun verifiedJourneyCells(plan: JourneyPlan, resident: Collection<JourneyResidentAtlas>): JourneyResidency? {
    fun resolve(atlasPath: String, keys: Collection<String>): Map<String, ServicePackedCell>? {
        val atlas = resident.singleOrNull { it.path == atlasPath } ?: return null
        val cells = LinkedHashMap<String, ServicePackedCell>()
        for (key in keys) cells[key] = atlas.cells[key] ?: return null
        return Collections.unmodifiableMap(cells)
    }
    val vehicle = resolve(plan.vehicle.atlasPath, plan.vehicle.frames) ?: return null
    val effect = plan.effect?.let { resolve(it.atlasPath, it.frames + listOfNotNull(it.still)) ?: return null }
    val wake = plan.wake?.let { resolve(it.atlasPath, it.frames + listOfNotNull(it.still)) ?: return null }
    return JourneyResidency(vehicle, effect, wake)
}

/** One immutable renderer admission: the installed base scene, its generation, the asset set
 *  resident with it and the journey-art capability at that instant. Reference identity is the
 *  proof — a flight proved against another admission (older scene, replaced assets or art,
 *  revoked lifecycle) never starts and never draws. */
internal class JourneyAdmission(val scene: BaseScene, val generation: Long, val assets: ServiceSceneAssets?, val art: FleetJourneyArt?, val lifetime: Long)

/** Private renderer state: at most one journey per berth, each bound to the exact admission it
 *  was proved against. Every method shares one monitor: GL installs/revokes admissions and reads
 *  flights, Main starts them; start and draw both re-check the admission under the monitor, so an
 *  admission captured before an install or revocation can neither insert nor draw afterwards. */
/** CONTINUITY (pure): the next snapshot proves the SAME installation — identity row with the same installation id, wire family and tier
 *  on the SAME berth, whose building keeps the geometry the flight started on, in the same base. Anything else (different/unknown
 *  installation, moved/replaced berth, other base, no identity) is false. Never consults frozen facts, events or clocks. */
internal fun journeyContinuity(next: BaseScene, journey: RenderFleetJourney, startedOn: RenderBuilding): Boolean {
    if (next.baseId == null || next.baseId != journey.baseId) return false
    val building = next.buildings.firstOrNull { it.id == journey.berthId } ?: return false
    val level = building.level ?: return false // an unknown level is never continuity proof
    if (level < 1 || building.underConstruction || building.type != startedOn.type || building.tileX != startedOn.tileX || building.tileY != startedOn.tileY
        || building.footprintWidth != startedOn.footprintWidth || building.footprintHeight != startedOn.footprintHeight) return false
    val rows = next.services.currentFleetIdentity ?: return false
    val row = rows.singleOrNull { it.berthId == journey.berthId } ?: return false
    return row.installationId == journey.installationId && row.family == journey.vehicle.family && row.tier == journey.vehicle.tier
}

internal class FleetJourneyPlayback {
    private class Running(val journey: RenderFleetJourney, val plan: JourneyPlan, val startMs: Long, val admission: JourneyAdmission, val residency: JourneyResidency)
    private val running = linkedMapOf<String, Running>()
    /** CONTINUITY: flights that carried proof at request time, waiting for the fresh admission to rebind them (or drop them). They keep
     *  drawing from their still-active old residency only while no admission exists and no revoke/art change intervened. */
    private val preserved = linkedMapOf<String, Running>()
    private var preservedLifetime = Long.MIN_VALUE
    /** The request token whose proof the preserved originals carry; the production draw gate binds to it. */
    private var preservedToken = Long.MIN_VALUE
    private var current: JourneyAdmission? = null
    /** The art capability as Main last set it, read ONLY under this monitor when GL installs. */
    private var art: FleetJourneyArt? = null
    /** Monotonic lifetime: every revocation (and art replacement) advances it; an install carrying an
     *  older lifetime observed before that revocation is stale and refused. */
    private var lifetime = 0L

    /** The admission Main may prove a journey against right now, or null (nothing can start). */
    @Synchronized fun admission(): JourneyAdmission? = current
    /** The lifetime GL observes before deciding to install; a later revoke/replaceArt invalidates it. */
    @Synchronized fun lifetime(): Long = lifetime
    /** GL: a base scene with its resident assets is installed. The art is captured HERE, under the
     *  monitor (never passed in from outside), and the install is refused when [observedLifetime] is
     *  older than the current one — a revoke or newer request happened after GL looked. A stale install
     *  cannot mutate the newer request's admission or originals. */
    @Synchronized fun install(scene: BaseScene, generation: Long, assets: ServiceSceneAssets?, observedLifetime: Long,
        resident: Collection<JourneyResidentAtlas>? = assets?.allAtlases?.values?.map { JourneyResidentAtlas(it.path, it.cells) }): Boolean {
        if (observedLifetime != lifetime) return false
        running.clear()
        val admission = JourneyAdmission(scene, generation, assets, art, lifetime)
        current = admission
        // CONTINUITY: rebind each preserved original ONLY against this admission — the same art capability, the installed scene's own
        // identity/geometry proof re-read, and every cell of its immutable plan resolved in THESE fresh resident atlases (never the
        // released ones). A missing Wake/craft/effect cell, a changed art or a failed proof drops the whole visual; nothing restarts.
        if (preserved.isNotEmpty() && resident != null) for ((berthId, run) in preserved) {
            val startedOn = run.admission.scene.buildings.firstOrNull { it.id == berthId } ?: continue
            // Ownership, not adapter identity: every preparation makes its own adapter, so the proof is the SAME immutable capability
            // and the SAME asset source owned by both admissions' fleet residencies (absent fleet ownership on either side = no proof).
            val previous = run.admission.assets?.fleet ?: continue; val fresh = assets?.fleet ?: continue
            if (previous.capability !== fresh.capability || previous.source !== fresh.source) continue
            if (!journeyContinuity(scene, run.journey, startedOn)) continue
            // The original Wake keeps its identity: the fresh residency must still admit the captured binding (same three pins).
            val wake = run.journey.wake
            if (run.plan.wake != null && (wake !is RenderJourneyWake.Available || !fresh.wakeAdmitted(wake))) continue
            val residency = verifiedJourneyCells(run.plan, resident) ?: continue // fresh exact cells only — never the old ones
            if (run.plan.wake != null && residency.wake == null) continue
            running[berthId] = Running(run.journey, run.plan, run.startMs, admission, residency)
        }
        preserved.clear()
        return true
    }
    /** Pause, dispose, permission off, source change or a battle: nothing starts or draws until the next install. */
    @Synchronized fun revoke() { running.clear(); preserved.clear(); current = null; lifetime += 1 }
    /** Failure and the current-request check share the request monitor: an old failure cannot revoke its successor. */
    @Synchronized fun failPreparation(isCurrent: () -> Boolean): Boolean {
        if (!isCurrent()) return false
        revoke()
        return true
    }
    /** GL delivery ownership is committed against the SAME request monitor as authorization.
     * The callback contains only reference/state updates and the existing install/revoke calls;
     * uploads, disposal and notifications must remain outside. Optional art may still be absent. */
    @Synchronized fun commitDelivery(isCurrent: () -> Boolean, commit: () -> Unit): Boolean {
        if (!isCurrent()) return false
        commit()
        return true
    }
    /** A staged GL delivery may discard its own resources after being superseded, but never
     * revoke the newer request's originals or predecessor. Main lifecycle revokes stay unconditional. */
    @Synchronized fun revokeDelivery(token: Long, currentToken: () -> Long): Boolean =
        failPreparation { token == currentToken() }
    /** Request thread (N-C5 RESIDENCY R3): ONE short transition under THIS monitor — the same lock [start], [arm] and
     *  [install] take — that advances the requested scene generation (the caller's [advanceGeneration], an atomic
     *  increment and nothing more), ends the installed admission and returns the token WITH the lifetime the new
     *  preparation is authorized under. Nothing can interleave between the increment, the revoke and the predecessor
     *  read: a competing cancellation lands either wholly before (then the returned predecessor already accounts for it)
     *  or wholly after (then it makes this preparation stale). No IO, traces, callbacks or preparation belong inside. */
    @Synchronized fun authorizeRequest(advanceGeneration: () -> Long,
        /** CONTINUITY: decided HERE, atomically with the generation advance, for each ALREADY RUNNING flight of the installed admission
         *  against the NEXT scene (pure, IO-free: [journeyContinuity] with the building the flight started on). True keeps the original
         *  (start time, plan, identity) pending rebinding at the next install; false ends it before any asynchronous preparation. */
        retain: (RenderFleetJourney, RenderBuilding) -> Boolean = { _, _ -> false }): Pair<Long, Long> {
        val token = advanceGeneration()
        val admitted = current
        val candidates = LinkedHashMap<String, Running>()
        if (admitted != null) for ((berthId, run) in running) if (run.admission === admitted && run.admission.lifetime == lifetime) candidates[berthId] = run
        // A second harmless request before the install re-proves the SAME preserved originals (age unchanged, never new ingress).
        if (admitted == null && preservedLifetime == lifetime) candidates.putAll(preserved)
        preserved.clear()
        for ((berthId, run) in candidates) {
            val startedOn = run.admission.scene.buildings.firstOrNull { it.id == berthId } ?: continue
            if (runCatching { retain(run.journey, startedOn) }.getOrDefault(false)) preserved[berthId] = run
        }
        running.clear(); current = null; lifetime += 1
        preservedLifetime = lifetime; preservedToken = token
        return token to lifetime
    }
    /** GL (N-C5 RESIDENCY): ONE checked arming transition for a staged delivery. [predecessor] is the lifetime the
     *  delivery's preparation was AUTHORIZED under (captured when it was published); if any revoke or art change
     *  happened since, the delivery is stale and stays unavailable until a fresh preparation (null). Otherwise every
     *  flight ends, no admission exists until the install, [art] becomes the captured art, and the returned TICKET is
     *  the only lifetime the later install may present — carried unchanged through upload/activation waits, never
     *  re-sampled, so a revoke after arming still refuses that install. */
    @Synchronized fun arm(art: FleetJourneyArt?, predecessor: Long): Long? {
        if (predecessor != lifetime) return null // a superseded arm cannot cancel the newer request's originals
        running.clear(); current = null; this.art = art; lifetime += 1
        preservedLifetime = lifetime // the same authorized preparation: preserved originals travel with the ticket
        return lifetime
    }
    /** Main replaced the art capability (null or not): flights end, the lifetime advances (any GL install
     *  decided before this is stale) and the current admission is re-issued with the new art. */
    @Synchronized fun replaceArt(art: FleetJourneyArt?) {
        running.clear(); preserved.clear(); this.art = art; lifetime += 1
        current = current?.let { JourneyAdmission(it.scene, it.generation, it.assets, art, lifetime) }
    }
    /** Atomic with install/revoke: false when [admission] is no longer the installed one or nothing could play. */
    @Synchronized fun start(journey: RenderFleetJourney, plan: JourneyPlan, nowMs: Long, admission: JourneyAdmission, residency: JourneyResidency,
        /** N-C5 RESIDENCY R2: the caller's SAME live eligibility read (current requested generation, source validity, capability,
         *  prepared assets, base, permission), evaluated HERE under the gate immediately before any flight mutates. Cheap and
         *  IO-free by contract; a Boolean captured earlier is not acceptable. No atomicity against external state is promised. */
        stillEligible: () -> Boolean = { true }): Boolean {
        if (admission !== current || admission.lifetime != lifetime) return false
        if (plan.steps.isEmpty() || !plan.fps.isFinite() || plan.fps <= 0f) return false
        if (plan.reducedMotion && (plan.effect?.still == null)) return false // immediate transition, nothing to hold
        if (plan.reducedMotion && plan.effect?.still?.let { residency.effect?.get(it) } == null) return false // an unresolved still drops
        if (!stillEligible()) return false // the proof outside the gate went stale: nothing mutates
        running[journey.berthId] = Running(journey, plan, nowMs, admission, residency)
        return true
    }
    /** CONTINUITY production draw decision (GL, under the monitor): a preserved original may draw in the pending gap ONLY when it is
     *  bound to the CURRENT request ([requestToken]) and lifetime, no admission exists yet, and the assets it was proved against are
     *  the still-owned ACTIVE assets with the current source and capability. Ordinary and new-ingress gates stay where they are. */
    @Synchronized fun continuityDrawable(building: RenderBuilding, activeAssets: ServiceSceneAssets?, source: ServiceAssetSource?, capability: PhaseEFleetArt?, requestToken: Long, enabled: Boolean): Boolean {
        if (!enabled || !runCatching { source?.isCurrent() == true }.getOrDefault(false)) return false
        val run = preserved[building.id] ?: return false
        if (current != null || preservedLifetime != lifetime || preservedToken != requestToken) return false
        val owned = run.admission.assets ?: return false
        if (activeAssets == null || owned !== activeAssets || source == null || capability == null) return false
        val fleet = owned.fleet ?: return false
        return fleet.source === source && fleet.capability === capability && run.journey.baseId == run.admission.scene.baseId
    }
    @Synchronized fun isActive(): Boolean = running.isNotEmpty() || preserved.isNotEmpty()
    @Synchronized fun isActive(berthId: String): Boolean = running.containsKey(berthId) || preserved.containsKey(berthId)

    /** Sprites of the journey playing on [building] at [nowMs], or nothing. A flight whose admission
     *  is no longer the installed one is dropped. The berth sprite's seat is its full-cell bottom
     *  pivot (56,112 of the 112 cell), as the service visuals draw it. */
    @Synchronized fun sprites(building: RenderBuilding, nowMs: Long, depth: Float, tilePixels: Float, output: MutableList<JourneySprite>): Boolean {
        val live = running[building.id]
        // CONTINUITY: a preserved original keeps drawing from its still-active residency only in the gap (no admission, same lifetime).
        val run = live ?: preserved[building.id]?.takeIf { current == null && preservedLifetime == lifetime && it.journey.baseId == it.admission.scene.baseId } ?: return false
        if (live != null && (live.admission !== current || live.admission.lifetime != lifetime || live.journey.baseId != live.admission.scene.baseId)) { running.remove(building.id); return false }
        val age = (nowMs - run.startMs).coerceAtLeast(0L).toFloat()
        val plan = run.plan
        if (age >= plan.durationMs) { running.remove(building.id); preserved.remove(building.id); return false }
        val seatX = (building.tileX + building.footprintWidth / 2) * tilePixels
        val seatY = (building.tileY + building.footprintHeight) * tilePixels
        val stepIndex = ((age * plan.fps) / 1000f).toInt().coerceIn(0, plan.steps.lastIndex)
        val step = plan.steps[stepIndex]
        val effect = plan.effect
        if (effect != null) {
            val x = seatX + plan.effectAttachmentPx.x - BERTH_PIVOT_X
            val y = seatY + plan.effectAttachmentPx.y - BERTH_CELL_BOTTOM
            if (plan.reducedMotion) {
                val still = effect.still
                if (still != null) { val cell = run.residency.effect?.get(still) ?: run { running.remove(building.id); return false }
                    output += JourneySprite(sprite(effectClip(effect, "journey-effect-still", 0f), still, x, y, depth + EFFECT_DEPTH), 1f, cell) }
            } else if (age < effect.frames.size * 1000f / effect.fps) {
                val clip = effectClip(effect, "journey-effect", effect.fps); val key = clip.frame(age, 0, false)
                val cell = run.residency.effect?.get(key) ?: run { running.remove(building.id); return false }
                output += JourneySprite(sprite(clip, key, x, y, depth + EFFECT_DEPTH), 1f, cell)
            }
        }
        if (plan.reducedMotion) return true
        val vehicle = plan.vehicle
        // Craft contact in world pixels: berth seat + (dock translation + contact − berth pivot) + authored offset.
        val x = seatX + vehicle.dockOffsetPx.x + vehicle.contactPx.x - BERTH_PIVOT_X + step.offsetPx.x
        val y = seatY + vehicle.dockOffsetPx.y + vehicle.contactPx.y - BERTH_CELL_BOTTOM + step.offsetPx.y
        val craft = AuthoredClip("journey-craft", vehicle.atlasPath, listOf(vehicle.frames), listOf("s"), vehicle.fps,
            vehicle.contactPx.x / vehicle.cell.x, vehicle.contactPx.y / vehicle.cell.y, 1f, vehicle.cell.x, vehicle.cell.y, true, null, emptyMap())
        val craftKey = craft.frame(age, 0, true); val craftCell = run.residency.vehicle[craftKey] ?: run { running.remove(building.id); return false }
        output += JourneySprite(sprite(craft, craftKey, x, y, depth + CRAFT_DEPTH), step.opacity, craftCell)
        val wake = plan.wake
        if (wake != null) {
            val clip = effectClip(wake, "journey-wake", wake.fps); val key = clip.frame(age, 0, true)
            val cell = run.residency.wake?.get(key) ?: run { running.remove(building.id); return false }
            output += JourneySprite(sprite(clip, key, x, y, depth + WAKE_DEPTH), step.opacity, cell)
        }
        return true
    }

    private fun effectClip(art: JourneyEffectArt, key: String, fps: Float) =
        AuthoredClip(key, art.atlasPath, listOf(art.frames), listOf("s"), fps, .5f, .5f, 1f, art.cell.x, art.cell.y, false, null, emptyMap())
    private fun sprite(clip: AuthoredClip, frameKey: String, x: Float, y: Float, depth: Float) =
        BaseVisualSprite(clip, frameKey, x, y, clip.cellWidth * clip.scale, clip.cellHeight * clip.scale, clip.anchorX, clip.anchorY, depth)

    companion object {
        /** A predecessor no lifetime ever equals: a re-published delivery whose authorization was lost arms nothing. */
        const val STALE_PREDECESSOR = Long.MIN_VALUE
        /** Admitted berth geometry: full-cell bottom pivot (horizontalPivot 56, cellBottom 112). */
        const val BERTH_PIVOT_X = 56f
        const val BERTH_CELL_BOTTOM = 112f
        /** The Wake trails under the hull; the gate effect bursts over it. */
        const val WAKE_DEPTH = .4f
        const val CRAFT_DEPTH = .5f
        const val EFFECT_DEPTH = .6f
    }
}
