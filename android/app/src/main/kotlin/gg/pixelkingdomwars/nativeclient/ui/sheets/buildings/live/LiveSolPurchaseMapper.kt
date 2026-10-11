package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.data.BasePurchaseUiState
import gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseFeeLine
import gg.pixelkingdomwars.nativeclient.ui.kingdom.basePurchaseSol
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.MoneyStage
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildersSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.ExpandUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.MoneyOp

/*
 * The pure presentation of one SOL base purchase (builder hire, land expansion, the SOL step of a Mine / Gold Forge
 * upgrade) raised in place on Home (buildings/SPEC.md R2.1, E1.2; DESIGN-SYSTEM §6 Seal and Money sequence). Nothing here
 * decides money: every flag is read from the EXISTING owner's state (BasePurchaseUiState: `canPay`, `quoteFresh`,
 * `hydrated`, the saved purchase) and only echoed. The owner keeps every rule: the draft and its key are saved before the
 * quote POST, `attempted` is saved before the wallet opens, nothing auto-retries, and recovery is GET-only.
 */

/** Wording the existing owner and its screen already use (BasePurchaseRepository.review, BasePurchaseScreen). */
internal const val SOL_RECOVER_FIRST = "Recover the saved purchase first."
internal const val SOL_NOT_AVAILABLE = "This purchase is not available right now."
internal const val SOL_GETTING_PRICE = "GETTING YOUR PRICE…"
internal const val SOL_NETWORK_FEE = "+ SMALL NETWORK FEE"
/** The Seal's consent line (DESIGN-SYSTEM §6 ConfirmDialog / Seal; buildings/SPEC.md E1.2). */
internal const val SOL_SIGN_ONCE = "Paid from your wallet. You sign once."
/** builders.png hire line. */
internal const val SOL_BUILDERS_STAY = "Hired builders stay for good."
/** BasePurchaseScreen's own "mine" fact. */
internal const val SOL_UPGRADE_STARTS = "Payment starts the upgrade; it finishes when its build timer ends."

/** Where one SOL purchase stands for a designed sheet: [price] (SOL, only from a review of this exact purchase), the
 *  money [stage], whether its answer is [uncertain] ("Being checked" + CHECK, never "Nothing was spent"), the [reason]
 *  a door says, and which taps may reach the owner. */
internal data class SolPurchaseView(val price: PriceUi, val stage: MoneyStage, val uncertain: Boolean, val reason: String?,
    val canRaise: Boolean, val canConfirm: Boolean, val canRetry: Boolean, val finished: Boolean)

/** The owner's review of THIS purchase (kind, deed and building all match); null for none or another purchase's. */
internal fun solReview(state: BasePurchaseUiState, kind: String, baseId: String?, buildingId: String?): BasePurchaseOffer? =
    state.review?.takeIf { baseId != null && it.kind == kind && it.baseId == baseId && it.buildingId == buildingId }

/**
 * [paying] is the owner's own wallet-step flag (`BasePurchaseViewModel.paying`); [busy] is true only while THIS visit's
 * explicit BUY / RETRY tap is still running (the owner's `busy` alone also covers its routine GET checks).
 * One saved purchase blocks every base purchase (the store holds one), so another kind's or deed's saved purchase
 * refuses with the owner's own sentence and leaves recovery to DETAILS.
 */
internal fun solPurchaseView(state: BasePurchaseUiState, kind: String, baseId: String?, buildingId: String?,
    paying: Boolean, busy: Boolean): SolPurchaseView {
    val review = solReview(state, kind, baseId, buildingId)
    val price = review?.let { PriceUi(Currency.SOL, basePurchaseSol(it.amountLamports), PriceStatus.OK) }
        ?: PriceUi(Currency.SOL, null, PriceStatus.CHECKING)
    fun shut(stage: MoneyStage, uncertain: Boolean = false, reason: String? = null, canRetry: Boolean = false) =
        SolPurchaseView(price, stage, uncertain, reason, canRaise = false, canConfirm = false, canRetry = canRetry,
            finished = stage == MoneyStage.SENT && !uncertain && reason == null)
    val available = state.supported && state.enabled
    val saved = state.saved
    if (saved == null) {
        if (paying || busy) return shut(MoneyStage.CHECK_WALLET)
        // Only a settled answer speaks: the availability probe clears `supported` while it asks (BasePurchaseScreen).
        if (baseId == null || state.loaded && !state.busy && !available) return shut(MoneyStage.READY, reason = SOL_NOT_AVAILABLE)
        return SolPurchaseView(price, MoneyStage.READY, false, state.error?.takeIf { !state.busy }, canRaise = true,
            canConfirm = review != null && state.loaded && available && !state.busy, canRetry = false, finished = false)
    }
    val offer = saved.offer
    if (offer.kind != kind || offer.baseId != baseId || offer.buildingId != buildingId) return shut(MoneyStage.READY, reason = SOL_RECOVER_FIRST)
    if (paying) return shut(MoneyStage.CHECK_WALLET)
    val purchase = saved.purchase
    return when {
        // The quote reply was lost (a draft without a quote): this visit's own request is still out, or it is being checked.
        purchase == null -> if (busy) shut(MoneyStage.CHECK_WALLET) else shut(MoneyStage.SENDING, uncertain = true)
        // Credited is SENT only once the original deed was refreshed; a receipt for another deed needs its OK under DETAILS.
        purchase.status == "credited" -> when {
            !state.hydrated -> shut(MoneyStage.SENDING, uncertain = true)
            !state.unavailable.isNullOrBlank() -> shut(MoneyStage.SENT, reason = state.unavailable)
            else -> shut(MoneyStage.SENT)
        }
        // The wallet was opened: pending, expired or failed, the realm confirms it. Never "Nothing was spent".
        saved.attempted -> shut(MoneyStage.SENDING, uncertain = true)
        purchase.status == "pending" -> when {
            busy -> shut(MoneyStage.CHECK_WALLET)
            // A declined wallet left this unpaid quote payable: RETRY, only while the owner itself says canPay.
            state.loaded && available && state.quoteFresh -> shut(MoneyStage.FAILED, canRetry = state.canPay)
            else -> shut(MoneyStage.READY, reason = SOL_RECOVER_FIRST)
        }
        // Never attempted and ended by the server: the owner retires it by itself on its next check.
        else -> shut(MoneyStage.READY, reason = SOL_RECOVER_FIRST)
    }
}

/** The consent fee line: the owner screen's own line (Shards, build time), else its network-fee line; null before a review. */
internal fun solFeeLine(review: BasePurchaseOffer?): String? = review?.let { basePurchaseFeeLine(it) ?: SOL_NETWORK_FEE }

/** The SOL Seal for [view], or null when this purchase cannot be raised (the Seal then animates out). While the price is
 *  still being asked the token reads "…" and a status line says so; [SolPurchaseView.reason] is added as the owner wrote it. */
internal fun solSealUi(view: SolPurchaseView, title: String, lines: List<String>, armedAtMs: Long,
    confirmLabel: String = title.substringBefore(' '), gets: PriceUi? = null): SealUi? {
    if (!view.canRaise) return null
    val status = view.reason ?: SOL_GETTING_PRICE.takeIf { view.price.status == PriceStatus.CHECKING }
    return SealUi(title, lines + listOfNotNull(status), view.price, confirmLabel, armedAtMs, gets = gets)
}

/** The Seal's "get" token for an expansion: the land after it ("16×16 land"); null while its size is unknown. */
internal fun expandSealGets(size: Int?): PriceUi? =
    size?.let { PriceUi(Currency.ITEM, "$it×$it", PriceStatus.OK, icon = "layout", description = "$it×$it land") }

/** What a tap on the sheet's purchase primary (HIRE / EXPAND / RETRY / Being checked) does. */
internal enum class SolTap { RAISE, CHECK, RETRY, WAIT, EXPLAIN }

internal fun solPrimaryTap(view: SolPurchaseView): SolTap = when {
    view.uncertain -> SolTap.CHECK
    view.stage == MoneyStage.FAILED -> if (view.canRetry) SolTap.RETRY else SolTap.EXPLAIN
    view.stage != MoneyStage.READY -> SolTap.WAIT
    view.canRaise -> SolTap.RAISE
    else -> SolTap.EXPLAIN
}

/** What the Seal's armed primary does: BUY through the owner, keep waiting for the review's price, or close and say why. */
internal enum class SolConfirm { BUY, WAIT_PRICE, REFUSE }

internal fun solConfirmTap(view: SolPurchaseView): SolConfirm = when {
    view.canConfirm -> SolConfirm.BUY
    view.canRaise -> SolConfirm.WAIT_PRICE
    else -> SolConfirm.REFUSE
}

/** Expansion raises the Seal in place only with a live owner; the candidate's free test expansion keeps its review screen. */
internal fun expandInPlace(hasPurchase: Boolean, testExpansion: Boolean): Boolean = hasPurchase && !testExpansion

/** The Builders sheet with the purchase's state on its HIRE primary (builders.png): the review's price once it is known,
 *  the money stage, "Being checked" for an uncertain answer, HIRE off with the owner's reason while another purchase or a
 *  pause blocks it, and the stone DETAILS door ([recovery]) while a saved purchase needs it. */
internal fun buildersWithPurchase(ui: BuildersSheetUi, view: SolPurchaseView, recovery: Boolean): BuildersSheetUi {
    val moving = view.uncertain || view.stage != MoneyStage.READY
    val blocked = !view.canRaise && !moving
    val hire = ui.hire?.let { h ->
        val price = if (view.price.status == PriceStatus.OK && h.price.status == PriceStatus.OK) view.price else h.price
        h.copy(price = if (blocked) price.copy(status = PriceStatus.UNAVAILABLE) else price, stage = view.stage,
            checking = view.uncertain, offReason = view.reason.takeIf { blocked })
    }
    return ui.copy(hire = hire, recovery = recovery)
}

/** EXPAND with the purchase's state (keep-expand.png, SPEC E1.2): the money sequence or "Being checked" + CHECK, kept even
 *  on a paused base (a payment in flight is never hidden behind a read-only reason); the owner's reason while blocked; the
 *  footer hint returns to "you confirm in the Seal"; the stone DETAILS door ([recovery]) while a saved purchase needs it. */
internal fun expandWithPurchase(ui: ExpandUi, view: SolPurchaseView, recovery: Boolean): ExpandUi {
    val moving = view.uncertain || view.stage != MoneyStage.READY
    val blocked = !view.canRaise && !moving
    val price = if (view.price.status == PriceStatus.OK && ui.price.status == PriceStatus.OK) view.price else ui.price
    return ui.copy(price = price, saved = if (moving) MoneyOp(view.stage, view.uncertain) else null,
        readOnly = if (moving) null else ui.readOnly ?: view.reason.takeIf { blocked }, reviewHint = null, recovery = recovery)
}
