package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomViewModel
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BerthPlacementFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.berthPlacementFacts

/**
 * Free vehicle placement (owner 2026-10-06: "player should be able to install them where they want as on other buildings").
 * A vehicle docks in its own Berth, and a Berth is an ordinary building, so the Berth sheet borrows the Kingdom's own
 * placement: [place] closes the sheet and calls `KingdomViewModel.startPlacement("berth")`, which shows the ghost and
 * footprint and the PLACE band; PLACE sends the chosen tile to POST /build, which validates space, claim, count, builder and
 * cost. [selectedBerthId] is the Berth the player opened (the Kingdom selection, the same source the free starter review
 * uses) and [facts] whether a new Berth can be placed now. No vehicle, wallet or money call lives here.
 */
internal class HomeBerthPlacementDoor(
    val selectedBerthId: () -> String?,
    val facts: () -> BerthPlacementFacts?,
    val place: () -> Unit,
)

/** The door over the Home Kingdom model; [handoff] is the Home sheet host's admitted close-then-open. */
internal fun homeBerthPlacementDoor(kingdom: KingdomViewModel, handoff: (() -> Unit) -> Unit): HomeBerthPlacementDoor =
    HomeBerthPlacementDoor(
        selectedBerthId = { kingdom.state.value.selectedBuilding?.takeIf { it.type == "berth" }?.id },
        facts = { kingdom.state.value.let { s -> berthPlacementFacts(s.base, s.catalogue, s.constructionAvailable("berth")) } },
        place = { handoff { kingdom.startPlacement("berth") } },
    )
