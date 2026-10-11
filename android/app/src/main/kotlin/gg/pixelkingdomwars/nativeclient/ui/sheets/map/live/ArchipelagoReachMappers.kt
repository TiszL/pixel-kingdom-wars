package gg.pixelkingdomwars.nativeclient.ui.sheets.map.live

import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.FantasyParcel
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ArchipelagoPanelUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachAllocation
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.map.ReachTileUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LODGE_TYPE
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.baseRouteUi
import gg.pixelkingdomwars.nativeclient.vehicle.OrdinaryRoute
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/*
 * LIVE mappers of the two map-cluster sheets the World tab draws for a small island and a Solana Reach Seeker tile
 * (design/final/map/SPEC.md §6 archipelago-panel; design/final/account/SPEC.md §6.2 reach-tile). Pure: no Compose, no
 * repository, no network call.
 *
 * Archipelago: the name is the presentation chain's own name and the island's slot. The route (grade, tier, realm and the
 * SEND door) comes only from the installed island catalogue (`PHASE_E_ORDINARY_ROUTES`, ids `<chain>-<slot+1>`, the list
 * the Lodge's island picker shows), made a RouteUi by the Lodge's own builder [baseRouteUi]; an island it does not list is
 * its name only, no SEND, Report (SPEC §6 "route unknown"). The starter read never names an island: its routes are the
 * starter boat's coast loops (`coastal_survey`, `common_<realm>`, ids without a '-'), so neither those routes nor the
 * starter flight join one. Trips stay empty until the World tab reads the crafted expedition journal; the panel then says
 * "No expeditions here yet".
 *
 * Reach: no Reach unlock repository exists, so a Seeker tile is always [ReachStatus.OFF], with no price and no balance.
 * An amount on that sheet may only come from the server.
 */

/** The archipelago SEND's registry row (the ArchipelagoPanel preview's id). */
private val ARCHIPELAGO_SEND = FeatureId("island.archipelago.send")

/**
 * The archipelago panel for [islandId] (`<chain>/<slot>`, the slot 0-based as the EXPLORE list counts it). [chains] are the
 * presentation chains (`WorldViewModel.chains`), [realmNames] the globe's realm names by id, [buildings] the selected base's
 * buildings (null while unknown), [starter] the starter read (only its home realm: it says which islands are HOME), and
 * [routes] the installed island catalogue (`VoyagePolicyFacts.routes`; null when this server has none: no route is known).
 */
internal fun archipelagoPanelUi(islandId: String, chains: List<JsonObject>, realmNames: Map<String, String>, buildings: List<Building>?,
    starter: StarterExpeditionState?, routes: List<OrdinaryRoute>?): ArchipelagoPanelUi {
    val chainId = islandId.substringBefore('/')
    val slot = islandId.substringAfter('/', "").toIntOrNull()?.takeIf { it >= 0 }
    val chainName = chains.firstOrNull { it.string("id") == chainId }?.string("name")
    val name = listOfNotNull((chainName ?: chainId).uppercase(Locale.ROOT), "ISLE", slot?.let { "${it + 1}" }).joinToString(" ")
    val route = slot?.let { s -> routes?.firstOrNull { it.id == "$chainId-${s + 1}" } }?.let { baseRouteUi(it, starter?.view?.home?.realmId, null) }
    val grade = route?.grade?.takeIf { it > 0 }
    val realmName = route?.let { realmNames[it.realmId] ?: it.realmName }
    return ArchipelagoPanelUi(
        islandId = islandId,
        route = route,
        name = name,
        grade = grade,
        // a vehicle sails islands up to its own tier (VehicleUi.maxGrade = tier): a grade N island needs tier N
        minTier = grade,
        realmLine = realmName?.let { r -> chainName?.let { "$it, near $r" } ?: "Near $r" },
        needsLine = grade?.let { "Needs a tier $it vehicle or better" },
        trips = emptyList(),
        // the island never owns dispatch: SEND carries no price and hands the player to the Lodge, which prices the trip
        send = CommandUi(ARCHIPELAGO_SEND, "ui:lodge-menu", "SEND", null, true, CommandState.ENABLED, null, null, verb = Verb.GOLD, sub = "from your Lodge"),
        // an unknown base never claims there is no Lodge
        hasLodge = buildings == null || buildings.any { it.type == LODGE_TYPE },
    )
}

/** A Solana Reach Seeker tile: the parcel read reserves it for the Seeker allocation (FantasyCatalog's "seeker"). */
internal fun worldReachTileApplies(parcel: FantasyParcel?): Boolean =
    parcel != null && parcel.availability == "reserved" && parcel.tile.allocation == "seeker"

/** The Reach sheet for a Seeker tile, named by its deed column and row as the realm map's card names it. Always OFF: no
 *  Reach unlock owner exists on this client, so there is no price, no SKR balance and no unlock. */
internal fun reachTileUi(parcel: FantasyParcel, columns: Int, hasDeed: Boolean?): ReachTileUi {
    val id = parcel.tile.tileId
    val label = if (columns > 0) "${id % columns}, ${id / columns}" else "%,d".format(Locale.US, id)
    return ReachTileUi(tileLabel = label, allocation = ReachAllocation.SEEKER, price = null, mySkr = null, hasDeed = hasDeed,
        status = ReachStatus.OFF, devnet = false)
}
