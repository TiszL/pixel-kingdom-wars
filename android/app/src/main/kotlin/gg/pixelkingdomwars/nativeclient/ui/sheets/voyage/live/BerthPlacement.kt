package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.network.buildCountPresentation
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleUi
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Free vehicle placement (owner, 2026-10-06: "cant install exploration vehicles and (we should remove pre chosen spots for
 * placing vehicles) player should be able to install them where they want as on other buildings").
 *
 * Server truth (apps/api): a vehicle is installed into ONE Berth building. `berthId` is `buildings.id`; `berth_id` is UNIQUE
 * on both `fleet_installations` (starter) and `vehicle_activation_reservations` (crafted), and the reservation trigger refuses
 * a Berth that already holds the starter with VEHICLE_BERTH_OCCUPIED (drizzle 0204 line 51, 0205 line 12). A Berth is an
 * ordinary 2 x 2 building that POST /build places on any free tile inside the claim (`geometryCheck`), up to the server's
 * advertised `constructionCapacity.berth.max` (shared `effectiveBuildCountCapForKeep`: one per vehicle family plus the
 * starter when vehicles are on). So "where they want" IS the Berth the player placed:
 *  - INSTALL goes into the vacant Berth the player chose (a quay tap, or the Berth they opened), never a client-picked slot;
 *  - with no vacant Berth, INSTALL starts the ordinary building placement (ghost, footprint, PLACE band) for a new Berth;
 *  - otherwise the refusal says why. Every count and gate is the server's or the catalogue's.
 * Pure: no Compose, no repository, no network call, no money.
 */

/** Whether a NEW Berth can be placed now, and why not ([reason] in plain words). Built by the host from its base + catalogue. */
data class BerthPlacementFacts(val canPlace: Boolean, val reason: String? = null)

/** Where INSTALL on an empty vehicle family goes. */
sealed interface BerthInstallDoor {
    /** Into this vacant, completed Berth. */
    data class Into(val berthId: String) : BerthInstallDoor
    /** No vacant Berth: place a new one on the base, where the player wants it. */
    data object Place : BerthInstallDoor
    /** Neither right now; the reason (never a guess). */
    data class Refused(val reason: String) : BerthInstallDoor
}

/** A new Berth is still being built: its vehicle installs once the construction finishes. */
const val BERTH_BEING_BUILT: String = "Your new Berth is still being built"

/** No vacant Berth and no placement door on this host: the BUILD tray still places one. */
const val BERTH_PLACE_FROM_BUILD: String = "Place a new Berth from BUILD, then install it there"

/** The base cannot start a Berth right now (content, art or server gate); the building flow says the same. */
const val BERTH_PLACEMENT_UNAVAILABLE: String = "A new Berth is not available to place right now"

/** The base's completed Berths, in base order; null while the base is not loaded. */
internal fun completedBerthIds(buildings: List<Building>?): List<String>? =
    buildings?.filter { it.type == BERTH_TYPE && !it.underConstruction && it.level >= 1 }?.map { it.id }

/** True while a placed Berth is still under construction; null while the base is not loaded. */
internal fun berthUnderConstruction(buildings: List<Building>?): Boolean? =
    buildings?.any { it.type == BERTH_TYPE && (it.underConstruction || it.level < 1) }

/** The Berth that holds this base's starter boat (its views, else the accepted install receipt), or null. */
internal fun starterBerthId(i: VoyageLiveInputs): String? =
    i.starterFleetView?.installation?.berthId ?: i.starterView?.installation?.berthId
        ?: i.starterFleet?.journal?.operation?.proof?.receipt?.installation?.takeIf { it.baseId == i.baseId }?.berthId

/**
 * Berths that already hold a vehicle or are reserved for one: the starter's, every crafted fleet row's, and every crafted
 * installation request this device made for this base (a server reservation is permanent: it is never released, so its
 * Berth stays taken even after a refusal). Null while the crafted fleet of this base is unknown; with no vehicle client on
 * this build the crafted side counts as none.
 */
internal fun occupiedBerthIds(i: VoyageLiveInputs): Set<String>? {
    val rows: List<JsonObject> = if (i.vehicles == null) emptyList() else fleetRows(i.vehicles, i.baseId) ?: return null
    val occupied = LinkedHashSet<String>()
    starterBerthId(i)?.let { occupied.add(it) }
    rows.mapNotNullTo(occupied) { it.prim("berthId") }
    i.vehicles?.journal?.records.orEmpty()
        .filter { it.kind == "installation" && it.request.prim("baseId") == i.baseId }
        .mapNotNullTo(occupied) { it.request.prim("berthId") }
    return occupied
}

/** Completed Berths with no vehicle in or reserved for them, in base order; null while either side is unknown. */
internal fun vacantBerthIds(i: VoyageLiveInputs): List<String>? {
    val completed = completedBerthIds(i.buildings) ?: return null
    val occupied = occupiedBerthIds(i) ?: return null
    return completed.filter { it !in occupied }
}

/**
 * INSTALL's destination: the vacant Berth the player [chosen] on the quay, else the vacant Berth they opened
 * ([VoyageLiveInputs.selectedBerthId]), else their first vacant Berth. With none, a NEW Berth is placed when the host's
 * [VoyageLiveInputs.berthPlacement] says it can be; a Berth still being built, a full base or an unknown read say why.
 */
internal fun berthInstallDoor(i: VoyageLiveInputs, chosen: String?): BerthInstallDoor {
    val vacant = vacantBerthIds(i) ?: return BerthInstallDoor.Refused(UNKNOWN)
    val pick = chosen?.takeIf { it in vacant } ?: i.selectedBerthId?.takeIf { it in vacant } ?: vacant.firstOrNull()
    if (pick != null) return BerthInstallDoor.Into(pick)
    if (berthUnderConstruction(i.buildings) == true) return BerthInstallDoor.Refused(BERTH_BEING_BUILT)
    val placement = i.berthPlacement ?: return BerthInstallDoor.Refused(BERTH_PLACE_FROM_BUILD)
    return if (placement.canPlace) BerthInstallDoor.Place else BerthInstallDoor.Refused(placement.reason ?: UNKNOWN)
}

/**
 * The quay header (no pre-chosen spots): one slot per Berth the player placed, in base order. Each shows the vehicle docked
 * in it (a crafted one before the starter if a stale read names both) or an EMPTY Berth carrying its own building id.
 */
internal fun berthQuayByBuilding(buildings: List<Building>?, vehicles: List<VehicleUi>): List<VehicleUi> =
    completedBerthIds(buildings).orEmpty().map { id ->
        vehicles.firstOrNull { it.berthId == id && it.family != VehicleFamily.STARTER }
            ?: vehicles.firstOrNull { it.berthId == id }
            ?: emptyBerth(VehicleFamily.STARTER, id)
    }

/**
 * Can a NEW Berth be placed on [base] now? The Keep gate is the catalogue's `BUILD_COSTS.berth.requiresKeepLevel`; the count
 * is the build tray's own `buildCountPresentation` (the server's advertised `constructionCapacity` first); [available] is the
 * Kingdom's own construction gate for "berth" (content, art, server flag). Null while the base or catalogue is unknown.
 */
fun berthPlacementFacts(base: BaseSnapshot?, catalogue: JsonObject?, available: Boolean): BerthPlacementFacts? {
    if (base == null || catalogue == null) return null
    val keep = base.player.keepLevel
    val required = berthKeepGate(catalogue)
    if (required != null && keep < required) return BerthPlacementFacts(false, "Unlocks at Keep $required")
    val count = buildCountPresentation(catalogue, BERTH_TYPE, keep, base.buildings.map { it.type }, base.raw["constructionCapacity"])
        ?: return null
    if (count.atCap) return BerthPlacementFacts(false, "Berth limit reached · max ${count.max}")
    if (!available) return BerthPlacementFacts(false, BERTH_PLACEMENT_UNAVAILABLE)
    return BerthPlacementFacts(true)
}

/** `constants.BUILD_COSTS.berth.requiresKeepLevel` from the catalogue, or null when the pack has none. */
private fun berthKeepGate(catalogue: JsonObject): Int? {
    val costs = (catalogue["constants"] as? JsonObject)?.get("BUILD_COSTS") as? JsonObject
    return ((costs?.get(BERTH_TYPE) as? JsonObject)?.get("requiresKeepLevel") as? JsonPrimitive)?.content?.toIntOrNull()
}

/**
 * The legacy Vehicle controls' INSTALL list: completed Berths that the server's own base presentation shows empty, minus
 * every Berth this device already reserved. The old list offered every completed Berth, including the one holding the
 * starter boat, which the server refuses (VEHICLE_BERTH_OCCUPIED).
 */
fun vacantBerthsForInstall(base: BaseSnapshot?, reservedBerthIds: Collection<String>): List<String> {
    val b = base ?: return emptyList()
    val held = HashSet<String>(reservedBerthIds)
    b.servicePresentation?.berths?.forEach { if (it.installation != null) held.add(it.buildingId) }
    b.advancedServicePresentation?.berths?.forEach { if (it.installation != null) held.add(it.buildingId) }
    return b.buildings.filter { it.type == BERTH_TYPE && !it.underConstruction && it.level >= 1 && it.id !in held }.map { it.id }
}
