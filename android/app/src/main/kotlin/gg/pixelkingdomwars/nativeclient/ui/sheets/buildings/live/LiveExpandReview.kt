package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseSol
import gg.pixelkingdomwars.nativeclient.ui.model.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import kotlinx.serialization.json.JsonObject

internal fun consumeExpandTap(open: Boolean, owner: () -> Boolean, close: () -> Unit): Boolean =
    if (owner()) true else if (open) { close(); true } else false

/** Navigation into the existing purchase owner, including its candidate-only free flow. No payment state is owned here. */
internal fun liveExpandReview(state: KingdomUiState, enabled: Boolean, testExpansion: Boolean): ExpandUi? {
    val base = state.base ?: return null
    val catalogue = state.catalogue ?: return null
    val index = base.player.expansions ?: return null
    val offer = expansionOffer(catalogue, index) ?: return null
    val caps = (catalogue["constants"] as? JsonObject)?.get("CAPS") as? JsonObject ?: return null
    val maximum = caps.string("expansionsMax")?.toIntOrNull() ?: return null
    val claim = base.claim ?: return null
    if (claim.max.toLong() - claim.min != offer.size.toLong()) return null
    val ringSize = offer.next ?: offer.size
    val origin = claim.min.toLong() - (ringSize.toLong() - offer.size) / 2
    if (origin !in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) return null
    val newTiles = offer.next?.let { next ->
        val area = next.toLong() * next - offer.size.toLong() * offer.size
        if (area !in 0..Int.MAX_VALUE.toLong()) return null
        area.toInt()
    }
    val purchase = basePurchaseOffer(catalogue, base, "expansion")
    val admitted = enabled && state.ordersAllowed && state.deedActionsAllowed
    return ExpandUi(index, maximum, offer.size, offer.next, newTiles, obstaclesInRing = null,
        reqKeepLevel = offer.requiredKeepLevel, keepLevel = base.player.keepLevel,
        price = PriceUi(Currency.SOL, purchase?.amountLamports?.let(::basePurchaseSol) ?: offer.priceSol,
            if (purchase == null) PriceStatus.UNAVAILABLE else PriceStatus.OK),
        nextReqKeepLevel = if (offer.next == null) null else expansionOffer(catalogue, index + 1)?.requiredKeepLevel,
        ring = RectTiles(origin.toInt(), origin.toInt(), ringSize, ringSize), saved = null,
        readOnly = if (admitted) null else "Expansion is unavailable right now",
        loading = state.home.loading, testExpansion = testExpansion,
        growthLine = offer.next?.let { "Your land grows from ${offer.size}×${offer.size} to $it×$it tiles." },
        reviewHint = if (testExpansion) "Review free test expansion" else "Review before payment")
}

/** A missing pack needs an update; a missing player/claim snapshot needs a base refresh. */
internal fun liveExpandUnavailableReason(state: KingdomUiState): String {
    val refresh = "Expansion details are unavailable. Refresh your kingdom."
    val update = "Expansion details are unavailable. Update the game."
    val base = state.base ?: return refresh
    val index = base.player.expansions ?: return refresh
    val catalogue = state.catalogue ?: return update
    return if (expansionOffer(catalogue, index) == null) update else refresh
}
