package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.data.StarterFleetState
import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.network.fmtDur
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionView
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetInstallation
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetView
import gg.pixelkingdomwars.nativeclient.ui.economy.starterLabel
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RewardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleUi
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRoute
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
import java.math.BigInteger
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Shared pure pieces of the voyage cluster's LIVE mappers (Lodge + Berth sheets, K/ui/sheets/voyage/ files). They read the
 * state the current screens already receive — `StarterExpeditionState` / `StarterFleetState` (starter boat), the
 * `VehicleState` JSON snapshots of `/vehicles/fleet`, `/vehicles/client/routes`, `/vehicles/client/assets-v2` and the
 * vehicle journal (crafted vehicles), the `VehiclePolicy` and its `OrdinaryRoutes` catalogue — and turn them into the
 * voyage Ui types. No Compose, no repository, no network call: every function here is a pure function of its arguments.
 *
 * Honesty rules kept everywhere: a missing or malformed server value reads "…" (UNKNOWN), never 0; no cost, duration,
 * cargo or trip count is computed in the client — each is the server's own figure, only formatted here.
 */

/** The single reason every voyage MONEY action (crafted install, service, realm permit, paid starter realm) gives until
 *  the MS-M3 money lane wires the Seals. The live Actions stubs refuse with exactly this text; nothing is charged. */
const val VOYAGE_MONEY_PENDING: String = "wiring pending: MS-M3"

/** Existing Berth server-off copy; a held service or absent policy is not a retryable read failure. */
const val VEHICLE_UNAVAILABLE_REASON: String = "Vehicles are not open on this server yet"
fun vehicleUnavailableReason(reason: VehicleUnavailable?): String? = when (reason) {
    VehicleUnavailable.MISSING_POLICY, VehicleUnavailable.SERVICE_HELD -> VEHICLE_UNAVAILABLE_REASON
    null -> null
}

/** Owner Seeker 2026-10-06 (QA, vehicles switched off): the quiet line the Berth shows where crafted vehicles would be, while
 *  the free starter boat stays fully usable. A closed crafted service is not a failed read: it never offers RETRY. */
const val CRAFTED_VEHICLES_OFF: String = "Crafted vehicles are not open on this server yet"

/** Registry rows the live voyage sheets hand back (UX-ARCHITECTURE §6.2 ids where one exists). */
internal object VoyageLiveIds {
    val LODGE = FeatureId("building.lodge")
    val HARVESTER = FeatureId("building.harvester")
    val BERTH_FLEET = FeatureId("berth.fleet")
}

/** The building types the base snapshot uses for the two voyage buildings (BuildTray / VehicleRegistration). */
internal const val LODGE_TYPE = "lodge"
internal const val BERTH_TYPE = "berth"

/**
 * The policy facts the mappers need, lifted out of [VehiclePolicy] so the mappers stay JVM-testable without a full
 * policy document. Every field is null when the policy (or that part of it) is missing: unknown, never a default.
 */
data class VoyagePolicyFacts(
    /** Server `vehicles.tiers` (ascending). */
    val tiers: List<Long>? = null,
    /** Server `vehicles.completedUsesPerInstall`: the trips one install gives. */
    val tripsPerInstall: Long? = null,
    /** The installed `ordinaryRoutes` catalogue (the 32 islands); null when this policy has none. */
    val routes: List<OrdinaryRoute>? = null,
)

/**
 * Everything both voyage mappers read, as the app already holds it today (HOOKUP-lodge-live.md / HOOKUP-berth-live.md
 * name where each one is observed). Null always means "no snapshot yet / not configured", never "empty".
 */
data class VoyageLiveInputs(
    /** The selected base's buildings (`BaseState.base?.buildings`, only when its baseId is the selected one). */
    val buildings: List<Building>?,
    /** `AccountState.selectedBaseId`. Snapshots for another base are ignored. */
    val baseId: String?,
    /** `StarterExpeditionViewModel.state` (starter routes, flight, raw stock, home realm, departure journal). */
    val starter: StarterExpeditionState?,
    /** `StarterFleetViewModel.state` (starter boat installation, eligible berths, install journal). */
    val starterFleet: StarterFleetState?,
    /** `VehicleViewModel.state` (crafted fleet / route previews / wallet assets JSON + the vehicle journal); null when
     *  the vehicle client is not configured on this build (crafted vehicles then count as none). */
    val vehicles: VehicleState?,
    /** `voyagePolicyFacts(client.policy())`. */
    val policy: VoyagePolicyFacts,
    /** Why game orders are blocked right now (update gate / raid interlock), in the existing screens' words; null = allowed. */
    val ordersBlockedReason: String? = null,
    /** A linked wallet exists (`WalletLogin` / `VehicleViewModel.wallet != null`). Crafted installs need one. */
    val walletLinked: Boolean = false,
    /** Build-tray reason the Berth cannot be built yet ("Unlocks at Keep 5"); null when it can or unknown. */
    val berthUnlockReason: String? = null,
    /** The mapper's clock (the host re-emits every 5 s while a trip is at sea). */
    val nowMs: Long,
    /** The device zone for "back at 21:40". */
    val zone: ZoneId = ZoneId.systemDefault(),
    /** The Berth building the player opened (the Kingdom selection), when it is a Berth; null otherwise. */
    val selectedBerthId: String? = null,
    /** Whether a NEW Berth can be placed now (BerthPlacement.kt); null when the host did not supply it (unknown). */
    val berthPlacement: BerthPlacementFacts? = null,
) {
    /** The starter expedition view of THIS base, or null. */
    val starterView: StarterExpeditionView? get() = starter?.view?.takeIf { it.baseId == baseId }
    /** The starter fleet view of THIS base, or null. */
    val starterFleetView: StarterFleetView? get() = starterFleet?.view?.takeIf { it.baseId == baseId }
}

/** Reads [VoyagePolicyFacts] from the live policy; a malformed part reads null (unknown) instead of throwing. */
fun voyagePolicyFacts(policy: VehiclePolicy?): VoyagePolicyFacts = if (policy == null) VoyagePolicyFacts() else VoyagePolicyFacts(
    tiers = runCatching { policy.tiers }.getOrNull(),
    tripsPerInstall = runCatching { policy.completedUses }.getOrNull(),
    routes = runCatching { policy.ordinaryRoutes?.routes }.getOrNull(),
)

// ---------- tolerant JSON reads (the snapshots were validated by the repository; a missing key still never throws) ----------

internal fun JsonObject.prim(key: String): String? = when (val v = this[key]) {
    null, JsonNull -> null
    is JsonPrimitive -> v.content
    else -> null
}
internal fun JsonObject.long(key: String): Long? = prim(key)?.toLongOrNull()
internal fun JsonObject.flag(key: String): Boolean? = prim(key)?.toBooleanStrictOrNull()
internal fun JsonObject.child(key: String): JsonObject? = this[key] as? JsonObject
internal fun JsonObject.children(key: String): List<JsonObject> = (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

// ---------- numbers and names ----------

private val PLAIN_INTEGER = Regex("0|[1-9][0-9]*")

/** A plain non-negative server integer string as a BigInteger; null for anything else. */
internal fun serverAmount(value: String?): BigInteger? = value?.trim()?.takeIf { it.matches(PLAIN_INTEGER) }?.let(::BigInteger)

/** "1,200" from an exact server amount; "…" when missing or malformed (never "0" for an unknown, unlike `fmtN`). */
internal fun voyageAmount(value: String?): String = serverAmount(value)?.let { "%,d".format(Locale.US, it) } ?: UNKNOWN

/** Server lamports as SOL text ("0.00002"); null when missing or malformed. */
internal fun lamportsToSol(lamports: String?): String? =
    serverAmount(lamports)?.toBigDecimal()?.movePointLeft(9)?.stripTrailingZeros()?.toPlainString()

/** Server family id → UI family ("cargo_cutter" → CARGO_CUTTER); null for an unknown family. */
internal fun vehicleFamilyOf(server: String?): VehicleFamily? = when (server) {
    "starter" -> VehicleFamily.STARTER
    "survey_balloon" -> VehicleFamily.SURVEY_BALLOON
    "cargo_cutter" -> VehicleFamily.CARGO_CUTTER
    "courier_airship" -> VehicleFamily.COURIER_AIRSHIP
    "expedition_barge" -> VehicleFamily.EXPEDITION_BARGE
    else -> null
}

/** "Heartwood Logs" from "heartwood_logs" (the current screens' `islandShareResource` rule). */
internal fun voyageResourceName(id: String): String = id.split('_').joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

/** The voyage art name of a raw resource or item ("heartwood_logs" → "voyage:heartwood-logs"; VoyageArt.kt table). */
internal fun voyageIcon(id: String): String = "voyage:" + id.replace('_', '-')

/** Full realm name ("Solana Reach" for seeker-reach), from the current screens' canonical alias table. */
internal fun voyageRealmName(realmId: String): String = starterLabel(realmId)

/** "Glasswake 3" from the catalogue id "glasswake-3". The design's "Glasswake Keys 3" needs a chain display-name table
 *  the catalogue does not carry (HOOKUP-lodge-live.md, gaps). */
internal fun routeDisplayName(routeId: String): String =
    routeId.split('-').filter { it.isNotEmpty() }.joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

/**
 * Realm → its raw resource, a COPY of the wire identity table `starterResourceRealms` (network module
 * `starter/StarterValues.kt`, internal there, so the app module cannot read it). Identity data pinned by the backend
 * REALM_IDS order, not tuning. Used only for an island with no server preview yet; a preview's own `resourceId` wins.
 * Rule 7: surfaced, not blended — promote the network table to public and delete this copy (HOOKUP-lodge-live.md).
 */
internal val REALM_RESOURCE: Map<String, String> = linkedMapOf(
    "frostveil" to "frost_quartz", "elderwood" to "heartwood_logs", "sunscar" to "sunstone_rubble",
    "crownlands" to "crown_iron_ore", "seeker-reach" to "rough_prism", "stormcairn" to "storm_ore",
    "thornwake" to "thorn_fibre", "cinderfall" to "ember_nodules",
)

// ---------- time (the mapper is handed `nowMs`; nothing here reads a clock) ----------

internal fun isoMs(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

/** Whole seconds from [nowMs] to an ISO instant, rounded up; 0 once passed; null when missing or bad. */
internal fun secondsLeft(iso: String?, nowMs: Long): Long? =
    isoMs(iso)?.let { ((it - nowMs + 999).floorDiv(1000L)).coerceAtLeast(0L) }

/** 0..1 of the way from departure to return; null when either instant is unknown. */
internal fun tripProgress(departedIso: String?, returnsIso: String?, nowMs: Long): Float? {
    val a = isoMs(departedIso) ?: return null
    val b = isoMs(returnsIso) ?: return null
    if (b <= a) return null
    return ((nowMs - a).toFloat() / (b - a).toFloat()).coerceIn(0f, 1f)
}

/** "21:40" in [zone]. */
internal fun localClock(epochMs: Long, zone: ZoneId): String =
    DateTimeFormatter.ofPattern("HH:mm", Locale.US).withZone(zone).format(Instant.ofEpochMilli(epochMs))

/** The shared D-070 duration words ("3h 20m"), or "…" when unknown. */
internal fun voyageDuration(seconds: Long?): String = seconds?.let(::fmtDur) ?: UNKNOWN

/** An away vehicle's time-to-back line: "1h 12m", "Due back" once the scheduled time passed, "…" when unknown. */
internal fun backInText(seconds: Long?): String = when {
    seconds == null -> UNKNOWN
    seconds > 0 -> fmtDur(seconds)
    else -> "Due back"
}

// ---------- buildings ----------

/** "LV 4" of the highest completed building of [type]; "…" when the base is not loaded or has none. */
internal fun voyageLevelTag(buildings: List<Building>?, type: String): String =
    buildings?.filter { it.type == type && !it.underConstruction }?.maxOfOrNull { it.level }?.let { "LV $it" } ?: UNKNOWN

/** True / false when the base snapshot is loaded; null while it is not. */
internal fun hasCompleted(buildings: List<Building>?, type: String): Boolean? =
    buildings?.any { it.type == type && !it.underConstruction && it.level >= 1 }

/** The first completed Berth's building id, or null. Owner 2026-10-06: never an install destination for a crafted vehicle
 *  (the starter usually holds it); installs go through [berthInstallDoor]. */
internal fun firstBerthId(buildings: List<Building>?): String? =
    buildings?.firstOrNull { it.type == BERTH_TYPE && !it.underConstruction && it.level >= 1 }?.id

// ---------- vehicles ----------

/** The crafted fleet rows of [baseId], or null while `/vehicles/fleet` has no snapshot for it (unknown, not empty). */
internal fun fleetRows(vehicles: VehicleState?, baseId: String?): List<JsonObject>? {
    val fleet = vehicles?.fleet ?: return null
    if (baseId == null || fleet.prim("baseId") != baseId) return null
    return fleet.children("vehicles")
}

/** The journal's expedition records of [baseId] (pending first, then archives; one per id). */
internal fun expeditionRecords(vehicles: VehicleState?, baseId: String?): List<VehicleRecord> =
    vehicles?.journal?.records.orEmpty().filter { it.kind == "expedition" && it.request.prim("baseId") == baseId }.distinctBy { it.id }

/** The receipt of an accepted expedition record, or null (no response yet / outcome unknown). */
internal fun expeditionReceipt(r: VehicleRecord): JsonObject? = r.response?.child("receipt")

/** The scheduled return of the newest receipt for [installationId] that has no return yet, or null. */
internal fun awayReturnsAt(records: List<VehicleRecord>, installationId: String): String? =
    records.mapNotNull { r -> expeditionReceipt(r)?.takeIf { it.prim("installationId") == installationId && r.response?.child("return") == null } }
        .mapNotNull { it.prim("returnsAt") }.maxByOrNull { isoMs(it) ?: Long.MIN_VALUE }

/**
 * One crafted fleet row → [VehicleUi]. Status order: a pending service is BUSY_SERVICE, an away vehicle AWAY, zero
 * trips left WORN_OUT, else DOCKED. Trips left is the server's `remainingUses`; the max is the policy's
 * `completedUsesPerInstall`. An unknown tier reaches no graded island (maxGrade 0), never a guessed one.
 */
internal fun craftedVehicle(row: JsonObject, tripsPerInstall: Long?, records: List<VehicleRecord>, nowMs: Long): VehicleUi? {
    val family = vehicleFamilyOf(row.prim("family"))?.takeIf { it != VehicleFamily.STARTER } ?: return null
    val id = row.prim("installationId") ?: return null
    val tier = row.long("tier")?.toInt()
    val left = row.long("remainingUses")?.toInt()
    val status = when {
        row.flag("pendingService") == true -> VehicleStatus.BUSY_SERVICE
        row.flag("away") == true -> VehicleStatus.AWAY
        left == 0 -> VehicleStatus.WORN_OUT
        else -> VehicleStatus.DOCKED
    }
    val back = if (status == VehicleStatus.AWAY) backInText(secondsLeft(awayReturnsAt(records, id), nowMs)) else null
    return VehicleUi(family, tier, id, row.prim("berthId") ?: "", status, left, tripsPerInstall?.toInt(), back, tier ?: 0)
}

/** The starter boat → [VehicleUi]: no tier, starter routes only (maxGrade 0), no trip allowance (tripsLeft / tripsMax
 *  null: the server sends none for the starter; the card prints "…", never a made-up count). */
internal fun starterVehicle(installation: StarterFleetInstallation, flightReturnsAt: String?, nowMs: Long): VehicleUi =
    VehicleUi(VehicleFamily.STARTER, null, installation.installationId, installation.berthId,
        if (flightReturnsAt != null) VehicleStatus.AWAY else VehicleStatus.DOCKED, null, null,
        flightReturnsAt?.let { backInText(secondsLeft(it, nowMs)) }, 0)

/** An EMPTY berth row of [family] (berth id = the Berth building's, or "" while unknown). */
internal fun emptyBerth(family: VehicleFamily, berthId: String?): VehicleUi =
    VehicleUi(family, null, null, berthId ?: "", VehicleStatus.EMPTY, null, null, null, 0)

// ---------- rewards ----------

/** The cargo a route snapshot brings (net to the kingdom) plus its fitted secondary output, as the server states them. */
internal fun routeRewards(route: JsonObject?, secondary: JsonObject?): List<RewardUi> = listOfNotNull(
    route?.let { r -> r.prim("resourceId")?.let { RewardUi(it, voyageAmount(r.prim("netQuantity")), RewardUi.Kind.CARGO, voyageIcon(it), voyageResourceName(it)) } },
    secondary?.let { s -> s.prim("resourceId")?.let { RewardUi(it, voyageAmount(s.prim("netQuantity")), RewardUi.Kind.SURVEY_FIND, voyageIcon(it), voyageResourceName(it)) } },
)
