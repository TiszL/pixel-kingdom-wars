package gg.pixelkingdomwars.nativeclient.ui.land

import gg.pixelkingdomwars.nativeclient.data.FantasyCatalog
import gg.pixelkingdomwars.nativeclient.data.LandPhase
import gg.pixelkingdomwars.nativeclient.model.LandDeposit
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.kit.priceText
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.account.*
import gg.pixelkingdomwars.nativeclient.wallet.SolanaCluster

/** Display-only adapters. LandViewModel and LandRepository retain all reservation, signing and recovery work. */
internal fun liveLandPrice(state: LandUiState): PriceUi {
    val amount = state.reservation?.amountLamports?.takeIf { it.matches(Regex("[1-9][0-9]*")) }?.toBigIntegerOrNull()
    return PriceUi(Currency.SOL, amount?.let(::solTextTrimmed), when {
        amount == null -> PriceStatus.CHECKING
        state.checkout.estimate?.funded == false -> PriceStatus.SHORT
        else -> PriceStatus.OK
    })
}

internal fun liveLandGate(state: LandUiState, busy: Boolean = false): LandGateUi = LandGateUi(
    price = liveLandPrice(state), alreadyOwned = state.landOwned && !state.additionalDeed,
    walletLinked = !state.wallet.isNullOrBlank(),
    realms = state.realms.map { RealmChipUi(it.realmId, state.realmName(it.realmId), null) },
    serverOffReason = when {
        busy || state.checkout.busy -> "A land request is finishing. Please wait."
        state.checkout.unavailable != null -> state.checkout.unavailable
        state.bounds == null -> "Land recovery rules are loading."
        state.reservationBlocked -> "Finish checking your saved land reservation first."
        else -> state.world.unavailable
    },
    title = if (state.additionalDeed) "FOUND ANOTHER KEEP" else "CLAIM YOUR LAND",
    subtitle = if (state.additionalDeed) "A new deed for another place on the map" else "Your base gets a place on the map",
    // The frame's words (land-gate.png). "Your base stays" is the whole promise: free-tier carry-over is an owner decision.
    priceLine = if (state.additionalDeed) "Another Kingdom Deed. The server freezes its exact tile and price next."
        else "One land per wallet. Your base stays.",
)

/** The only hold SETTLE can clear by itself: a realm is chosen but no exact tile is drafted yet. */
internal const val LAND_CHOOSE_TILE = "Choose a tile below or on the map, then review its exact price."

/** A listed candidate the viewport read or a parcel inspection already showed as taken. */
internal fun landTileHeld(cell: TileCell): Boolean = cell.occupied || cell.availability in setOf("occupied", "held", "reserved")

/**
 * SETTLE IN <REALM> as land-realm.png draws it (realm card → SETTLE → Seal, no tile grid): when the only hold is the missing
 * tile, the first candidate of the chosen realm the picker did not see taken. The existing owner still inspects that exact
 * parcel (the same metered read a tile tap makes) before it is drafted and reserved; null = nothing SETTLE may do by itself.
 */
internal fun landSettleTile(state: LandUiState, busy: Boolean): Int? {
    if (state.picker.realmId == null || landDraftUnavailable(state, busy) != LAND_CHOOSE_TILE) return null
    return state.picker.tiles.firstOrNull { !landTileHeld(it) }?.tileId
}

/** A chosen realm is not a tile: reserveDrafted must follow the existing owner's parcel inspection. */
internal fun landDraftUnavailable(state: LandUiState, busy: Boolean): String? = when {
    busy || state.checkout.busy || state.picker.loading -> "A land request is finishing. Please wait."
    state.checkout.unavailable != null -> state.checkout.unavailable
    state.bounds == null -> "Land recovery rules are unavailable."
    state.reservationBlocked -> "Finish checking your saved land reservation first."
    state.reservation != null -> "Your reserved tile is already saved. Review that land first."
    state.checkout.phase != LandPhase.IDLE -> "Your saved land purchase needs attention first."
    state.checkout.draftedTile == null -> LAND_CHOOSE_TILE
    state.picker.parcel != null && (state.picker.parcel.tile.tileId != state.checkout.draftedTile ||
        !state.picker.parcel.available || (state.picker.realmId != null && state.picker.parcel.tile.realmId != state.picker.realmId)) ->
        "The selected tile changed. Inspect it again."
    else -> null // A World-owner draft can return without this list picker's parcel snapshot.
}

/**
 * The realm sheet (land-realm.png): server counts grouped ("3,112 kingdoms"), Solana Reach as the locked SKR card (its tap
 * says plainly that the SKR unlock is not open), and the foot "SETTLE IN <REALM>" with "<price> SOL · one land per
 * wallet". The price is the server's frozen quote, so it reads "…" until a tile is reserved; a picked tile joins the
 * sub-line. An additional deed never says "one land per wallet".
 */
internal fun liveRealmPicker(state: LandUiState, busy: Boolean = false): RealmPickerUi {
    // A realm with a free listed candidate settles on SETTLE itself (landSettleTile), so its primary is live.
    val reason = landDraftUnavailable(state, busy).takeUnless { landSettleTile(state, busy) != null }
    val realm = state.picker.realmId?.let(state::realmName)
    val price = liveLandPrice(state)
    val tile = state.checkout.draftedTile
    // A tile drafted on the map may sit outside the listed realm: name the realm only when the inspected parcel agrees.
    val tileInRealm = tile == null || state.picker.parcel?.tile?.let { it.tileId == tile && it.realmId == state.picker.realmId } == true
    val label = when {
        realm != null && tileInRealm -> "SETTLE IN ${realm.uppercase()}"
        tile != null -> "REVIEW TILE $tile"
        else -> "CHOOSE A REALM"
    }
    return RealmPickerUi(state.realms.map { row ->
        val lock = when {
            row.realmId == FantasyCatalog.SEEKER_REALM -> RealmLock.SKR_UNLOCK
            row.available <= 0 -> RealmLock.FULL
            else -> RealmLock.NONE
        }
        // Null lockReason draws the designed "SKR unlock" / "Full right now" words.
        RealmCardUi(row.realmId, state.realmName(row.realmId), "${exactAmount(row.occupied.toString())} kingdoms", null, lock)
    }, state.picker.realmId, price, loading = state.world.loading,
        primaryOverride = PrimaryLook(
            label,
            listOfNotNull(tile?.let { "Tile ${exactAmount(it.toString())}" }, "${priceText(price)} SOL",
                if (state.additionalDeed) "exact price is frozen next" else "one land per wallet").joinToString(" · "),
            Verb.GOLD, if (reason == null) CommandState.ENABLED else CommandState.DISABLED, reason,
        ))
}

/** What a locked realm card's tap says. Solana Reach is not an ordinary land sale, and its SKR unlock has no rail yet. */
internal fun lockedRealmMessage(realmId: String, realmName: String): String =
    if (realmId == FantasyCatalog.SEEKER_REALM) "$realmName opens with SKR, not with a land payment. That unlock is not open yet."
    else "$realmName is full right now. Choose another realm."

internal data class LandReview(
    val wallet: String, val kind: String, val cluster: SolanaCluster, val reservation: LandDeposit, val realmName: String,
)

internal fun captureLandReview(state: LandUiState): LandReview? {
    if (state.checkout.phase != LandPhase.READY) return null
    val wallet = state.wallet?.takeIf(String::isNotBlank) ?: return null
    val quote = state.reservation ?: return null
    if (runCatching { quote.requireReservation(state.checkout.purchaseKind) }.isFailure) return null
    return LandReview(wallet, state.checkout.purchaseKind, state.checkout.cluster, quote,
        quote.fantasyLocation?.realmId?.let(state::realmName) ?: "the Shattered Realms")
}

internal fun landReviewCurrent(review: LandReview, state: LandUiState): Boolean =
    state.checkout.phase == LandPhase.READY && state.wallet == review.wallet && state.checkout.purchaseKind == review.kind &&
        state.checkout.cluster == review.cluster && state.reservation == review.reservation

/** Unknown funding is checked by the existing owner before wallet approval; a known shortfall never reaches signing. */
internal fun landPayUnavailable(state: LandUiState, busy: Boolean, signerAvailable: Boolean, @Suppress("UNUSED_PARAMETER") now: Long): String? = when {
    busy || state.checkout.busy -> "A land request is finishing. Please wait."
    state.checkout.unavailable != null -> state.checkout.unavailable
    state.bounds == null -> "Land recovery rules are unavailable."
    state.checkout.phase != LandPhase.READY -> "Your saved land purchase is being checked."
    captureLandReview(state) == null -> "The exact land reservation is unavailable."
    !signerAvailable -> "A wallet app is needed to approve this payment."
    state.checkout.estimate?.funded == false -> "Add SOL to your wallet, then check funding again."
    // A local countdown cannot retire or strand a saved reservation. The explicit owner pay() rereads
    // the server's window before any wallet prompt; open() has no active-checkout deposit-refresh API.
    else -> null
}

/**
 * The BUY LAND Seal (land-seal.png): "BUY LAND IN <REALM>?", the server's exact SOL → DEED, then the frame's lines in its
 * order (paid from your wallet, what the base gets, the fee fine print last but the network line), plus the frozen tile
 * so the player sees which parcel they sign for. An additional deed keeps its own copy: it is not the one land per wallet.
 */
internal fun liveLandSeal(review: LandReview, armedAtMs: Long): SealUi {
    val exact = requireNotNull(review.reservation.amountLamports).toBigInteger()
    val tile = review.reservation.landAddress?.tileId
    return landSealUi(review.realmName, PriceUi(Currency.SOL, solTextTrimmed(exact), PriceStatus.OK), armedAtMs).copy(
        lines = listOfNotNull(
            "Paid from your wallet. You sign once.",
            if (review.kind == "deed") null else "Your base gets a tile in ${review.realmName} and a deed you own.",
            "Tile ${tile?.let { exactAmount(it.toString()) } ?: "…"} in ${review.realmName}. This exact parcel and price are frozen.",
            if (review.kind == "deed") "A new Kingdom Deed for this parcel. The network fee is shown in your wallet."
                else "One land per wallet. The network fee is shown in your wallet.",
            if (review.cluster == SolanaCluster.DEVNET) "Devnet test SOL. Select Devnet in your wallet." else "Solana mainnet.",
        ),
    )
}

internal fun liveLandDone(state: LandUiState): LandDoneUi? {
    if (state.checkout.phase != LandPhase.CREDITED) return null
    val reservation = state.reservation ?: return null
    val id = reservation.id?.takeIf(String::isNotBlank) ?: return null
    val tile = reservation.landAddress?.tileId ?: return null
    val realm = reservation.fantasyLocation?.realmId?.let(state::realmName) ?: "Your realm"
    // The frame's three facts (land-done.png). The deed line waits for the mint; the kingdom name and Keep portrait are not
    // in the land state, so the ribbon names "YOUR KINGDOM" and the well shows the deed.
    return LandDoneUi(id, "YOUR KINGDOM", null, listOf(
        LandFactUi("itm_deed_earth", if (state.deedReady) "Kingdom Deed is in your wallet" else "Your land is secured. The deed is still minting."),
        LandFactUi("map", "$realm · tile ${exactAmount(tile.toString())}"),
        LandFactUi("trophy", "Leagues and the Gold Forge are open"),
    ))
}

internal fun landCheckoutLine(state: LandUiState): String? = when (state.checkout.phase) {
    LandPhase.RESTORING -> "Restoring your saved land purchase."
    LandPhase.RESERVING -> "Checking the tile and freezing its exact price."
    LandPhase.PAYING -> "Check your wallet to approve this exact land payment."
    LandPhase.CONFIRMING -> "We are checking your payment automatically. It is safe to leave; your purchase stays saved."
    LandPhase.FAILED -> "Your payment was seen, but land could not be granted. Your saved payment is kept for support."
    LandPhase.CREDITED -> if (state.deedReady) "Your Kingdom Deed is ready." else "Your payment is confirmed. You can play while the deed finishes minting."
    else -> null
}
