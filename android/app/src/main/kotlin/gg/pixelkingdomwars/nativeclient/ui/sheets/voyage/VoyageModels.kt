package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.runtime.Immutable
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi

/*
 * Design component: the shared UI state of the voyage cluster (design/final/voyage/SPEC.md §0.5): vehicles, routes,
 * route previews, trips and rewards, used by the Lodge sheet (SEND, CHOOSE AN ISLAND, TRIPS, collect) and the Berth sheet
 * (FLEET, starter, install, SERVICE).
 *
 * Field names follow SPEC §0.5. Two deliberate differences, both from UX-ARCHITECTURE §7.1 ("numbers arrive already
 * formatted from mappers"), which outranks the SPEC's sketch types:
 * - SPEC `Instant` fields (`returnsAt`, `departedAt`) arrive as formatted text plus a 0..1 progress; the mapper re-emits
 *   them every 5 s (SPEC §5a "updated every 5 s"). No composable here reads a clock.
 * - SPEC `Long` quantities arrive formatted ("108", "1.2K"); the mapper formats, the composable only adds the "+".
 * Every count stays an `Int?` where the UI must reason about it (trips left, tiers, grades); null is unknown and draws "…".
 *
 * Presentation only: no repository, view model, network or graph type.
 */

/** The five vehicle families, in the Berth's fixed quay order (SPEC §7: the quay always reads the same). */
enum class VehicleFamily { STARTER, SURVEY_BALLOON, CARGO_CUTTER, COURIER_AIRSHIP, EXPEDITION_BARGE }

/** Where a berth's vehicle stands. */
enum class VehicleStatus {
    /** In its berth, ready to sail. */
    DOCKED,
    /** At sea on a trip. */
    AWAY,
    /** No trips left: needs SERVICE at the Berth. */
    WORN_OUT,
    /** The berth has no vehicle of this family. */
    EMPTY,
    /** A service (restore / upgrade) is in flight for it. */
    BUSY_SERVICE,
}

/** One vehicle, or one empty berth (SPEC §0.5 `VehicleUi`). */
@Immutable data class VehicleUi(
    /** Its family (drives art, names and the quay slot). */
    val family: VehicleFamily,
    /** Tier 1..4; null when EMPTY. The starter has no tier (null). */
    val tier: Int?,
    /** The server installation id; null when EMPTY. Every vehicle callback hands this back. */
    val installationId: String?,
    /** The berth this vehicle belongs to. */
    val berthId: String,
    /** Where it stands. */
    val status: VehicleStatus,
    /** Trips left on this install (server: completedUsesPerInstall − (completedTotal − allowanceStart)); null = unknown. */
    val tripsLeft: Int?,
    /** Trips per install (server `PHASE_E_VEHICLES.completedUsesPerInstall`, never a client constant); null = unknown. */
    val tripsMax: Int?,
    /** AWAY only: time until it is back, formatted ("1h 12m"); "…" while unknown; null when not away. */
    val returnsAt: String?,
    /** The highest route grade it may sail (= tier); the starter is 0 (starter routes only). */
    val maxGrade: Int,
)

/** Who may sail a route without a permit. */
enum class Access { HOME, PAID_REALM }

/** My vehicle on a route right now (SPEC §0.5 `RouteUi.myTrip`). */
@Immutable data class TripRef(
    /** The trip id (TRIPS scrolls to it; a BACK tile collects it). */
    val tripId: String,
    /** AT_SEA draws the blue AWAY tag, READY the green BACK tag. */
    val state: TripState,
)

/** One of the 32 archipelago islands (SPEC §0.5 `RouteUi`; server `PHASE_E_ORDINARY_ROUTES`). */
@Immutable data class RouteUi(
    /** "glasswake-3" (chain-index+1). */
    val routeId: String,
    /** The chain atlas name ("glasswake"); with [index] it locates the route card and cutout art. */
    val chain: String,
    /** The atlas cell index (columns 3, cell 320). */
    val index: Int,
    /** "Glasswake Keys 3". */
    val displayName: String,
    /** "elderwood". */
    val realmId: String,
    /** "Elderwood". */
    val realmName: String,
    /** The realm's raw resource ("heartwood_logs"). */
    val resourceId: String,
    /** 1..4. */
    val grade: Int,
    /** HOME or PAID_REALM (needs a permit). */
    val access: Access,
    /** My vehicle there now (AT_SEA) or back (READY); null when none. */
    val myTrip: TripRef?,
    /** Added: the realm resource's icon (a `voyage:` name, see VoyageArt.kt). */
    val resourceIcon: String = "",
    /** Added: the realm resource's display name ("Heartwood Logs"). */
    val resourceName: String = "",
    /** Added: PAID_REALM only — why a permit cannot be bought now (unaffordable / unavailable); null = it can. */
    val permitReason: String? = null,
    /** Added: false while this chain's atlas is not on the device (the tile shows "Island art loading"). */
    val artAvailable: Boolean = true,
)

/** One supply a trip uses up when it sails (SPEC §3 item 10). */
@Immutable data class SupplyUi(
    /** Server resource id. */
    val resourceId: String,
    /** 32 dp icon. */
    val icon: String,
    /** "Thorn Fibre". */
    val name: String,
    /** How many the trip needs, formatted ("6"); "…" unknown. */
    val need: String,
    /** How many the player has, formatted ("46"); "…" unknown. */
    val have: String,
    /** True when the player has fewer than [need]: blood rim, red have, GO. Never auto-buys. */
    val short: Boolean,
    /** The shortfall as a sentence ("Need 4 more Thorn Fibre"); used as the SEND reason. */
    val shortLine: String? = null,
    /** Where it is earned (Harvester / Lodge); null hides GO. */
    val earnedAt: FeatureId? = null,
)

/** Equipment fitted on the vehicle that adds a secondary output (Route Compass / Survey Lens). */
@Immutable data class FittingUi(
    /** 32 dp art ("voyage:route-compass"). */
    val icon: String,
    /** "+ a survey find". */
    val line: String,
    /** "Route Compass fitted". */
    val fitted: String,
)

/** A realm permit for a PAID_REALM route (SPEC §3 item 11, §12 Q2: per trip, a SOL Seal at SEND). */
@Immutable data class PermitUi(
    /** The SOL price ("about 0.03 SOL" is built from it). */
    val price: PriceUi,
    /** "Cinderfall". */
    val realmName: String,
)

/** The server's route preview for (installationId, routeId); never computed in the client (SPEC §0.5 `PreviewUi`). */
@Immutable data class PreviewUi(
    /** SPEC `durationSec`, formatted ("3h 20m"). */
    val duration: String,
    /** Local return time ("21:40"). */
    val returnsAtLocal: String,
    /** Found on the island, formatted ("120"). */
    val grossQuantity: String,
    /** Left to the island pool, formatted ("12"). */
    val islandPoolQuantity: String,
    /** What comes home, formatted ("108"). */
    val netQuantity: String,
    /** What it uses up when it sails (max 2 shown). */
    val supplies: List<SupplyUi>,
    /** Fitted equipment, or null (the row then links to the Workshop). */
    val fitting: FittingUi?,
    /** PAID_REALM only: the permit, or null. */
    val permit: PermitUi?,
    /** Added: the main cargo's 64 dp icon (the realm raw resource, or the starter route's). */
    val resourceIcon: String = "",
    /** Added: the main cargo's name ("Heartwood Logs"). */
    val resourceName: String = "",
)

/** A trip's lifecycle. */
enum class TripState { AT_SEA, READY, COLLECTING, COLLECTED }

/** What a trip brings or brought back (SPEC §0.5 `RewardUi`). */
@Immutable data class RewardUi(
    val resourceId: String,
    /** Formatted amount without a sign ("108"); the UI draws "+108". "…" unknown. */
    val quantity: String,
    val kind: Kind,
    /** Added: 32 dp icon. */
    val icon: String = "",
    /** Added: display name ("Heartwood Logs"). */
    val name: String = "",
) {
    /** Main cargo, or a survey find from fitted equipment. */
    enum class Kind { CARGO, SURVEY_FIND }
}

/** One trip at sea or back (SPEC §0.5 `TripUi`). */
@Immutable data class TripUi(
    val tripId: String,
    /** The vehicle that sailed. */
    val vehicle: VehicleUi,
    /** The island; null for a starter route. */
    val route: RouteUi?,
    /** The starter route id ("coastal_survey") when [route] is null. */
    val starterRouteId: String?,
    /** SPEC `departedAt` + `returnsAt` → 0..1 of the way (null = unknown). */
    val progress: Float?,
    /** Time left, formatted ("1h 12m"); "…" unknown; null once READY. */
    val returnsAt: String?,
    val state: TripState,
    /** What it will bring (AT_SEA). */
    val expected: List<RewardUi>,
    /** What it brought (READY onwards), from the server return. */
    val returned: List<RewardUi>?,
    /** Added: row title ("Glasswake Keys 3", "Coastal Survey"). */
    val title: String = route?.displayName ?: "",
    /** Added: seconds left, for ordering only (READY first, then soonest); null = unknown (sorted last). */
    val secondsLeft: Long? = null,
    /** Added: the scheduled time passed but the server has no return yet: "Due back · checking". */
    val dueChecking: Boolean = false,
    /** Added: the expanded row's departure line ("Sailed 18:20"). */
    val departedLine: String? = null,
)

/** A starter route choice (SPEC §3a): COAST, LONG, INTRO, plus `common_<realm>` when advertised. */
@Immutable data class StarterRouteUi(
    /** Server id ("coastal_survey"). */
    val id: String,
    /** The segment label ("COAST"). */
    val label: String,
    /** Screen-reader / row name ("Coastal Survey"). */
    val name: String,
    /** Added: the cargo's 32 dp icon ("voyage:ember-nodules"); a common route shows it on its chip. */
    val icon: String = "",
    /** Added: a `common_<realm>` route (another realm's coast): drawn in the second, scrolling row. */
    val common: Boolean = false,
)

/** A departure in flight from a previous session (SPEC §3 "pending recovery"). */
@Immutable data class PendingDepartureUi(
    /** "Your Cutter's departure is being checked". */
    val line: String,
    /** True while the by-key read runs (CHECK shows dots). */
    val checking: Boolean = false,
)

/** A crafted vehicle in the player's wallet (SPEC §8 `OwnedVehicleUi`). */
@Immutable data class OwnedVehicleUi(
    val assetId: String,
    /** 1..4; null = unknown. */
    val tier: Int?,
)

/** Where a SOL action (install / service / permit) stands (SPEC §8 `sealState`). */
enum class VoyageSealState { IDLE, ARMED, CHECK_WALLET, SENDING, SENT, ERROR }

/**
 * A failed or uncertain money step (design correction 7). [authoritative] = the server or wallet gave a definite refusal,
 * so "Nothing was sent" may be said; otherwise (timeout, lost response) the UI says it is being checked and keeps the
 * recovery action.
 */
@Immutable data class VoyageMoneyErrorUi(
    /** One sentence ("Wallet didn't answer.", "This balloon is no longer in your wallet"). */
    val message: String,
    /** True only for a definite refusal. */
    val authoritative: Boolean,
    /** True when the request can be checked by key (process death, lost response): shows CHECK, never a second INSTALL. */
    val recoverable: Boolean = !authoritative,
)
