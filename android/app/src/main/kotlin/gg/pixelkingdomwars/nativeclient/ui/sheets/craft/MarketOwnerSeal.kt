package gg.pixelkingdomwars.nativeclient.ui.sheets.craft

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import gg.pixelkingdomwars.nativeclient.charter.CharterGrammar
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketRecord
import gg.pixelkingdomwars.nativeclient.data.KeepEquipmentMarketState
import gg.pixelkingdomwars.nativeclient.data.MarketReview
import gg.pixelkingdomwars.nativeclient.data.MarketTradeState
import gg.pixelkingdomwars.nativeclient.model.marketPercent
import gg.pixelkingdomwars.nativeclient.model.marketSol
import gg.pixelkingdomwars.nativeclient.ui.phasee.keepMarketAmount
import gg.pixelkingdomwars.nativeclient.ui.phasee.keepMarketName
import java.math.BigDecimal

/** Presentation eligibility only. The original repository still validates and executes the explicit command. */
internal fun marketFreshPurchaseReview(
    state: MarketTradeState, buying: MarketReview.Purchase?, paying: Boolean, mfa: Boolean,
): MarketReview.Purchase? = (state.review as? MarketReview.Purchase)?.takeIf {
    state.loaded && state.supported && !state.busy && buying == null && !paying && !mfa &&
        state.saved == null && state.pending.isEmpty()
}

/** A saved/attempted command or a payment review always keeps the existing recovery presentation. */
internal fun keepMarketFreshCommandReview(state: KeepEquipmentMarketState): KeepEquipmentMarketRecord? =
    state.commandReview?.takeIf {
        state.paymentReview == null && state.selected == it && it.response == null && it.attempts.isEmpty() &&
            it.signed == null && it.consent == null && !it.held && !it.discardedUnsent
    }

/** A UI tap latch, not a payment owner. It admits the exact displayed review once, before busy can recompose. */
internal class MarketSealTap<T>(private val shown: T) {
    private var consumed = false
    fun take(current: T?, enabled: Boolean): Boolean {
        if (consumed || !enabled || current != shown) return false
        consumed = true
        return true
    }
}

internal fun marketPurchaseReviewSeal(
    review: MarketReview.Purchase, itemName: String, itemArt: String?, feeBps: Int?, feeLamports: String?,
    armedAtMs: Long, enabled: Boolean,
): MarketSealUi {
    val offer = review.offer
    val price = marketSol(offer.priceLamports)
    return MarketSealUi(
        title = "BUY ${itemName.uppercase()}",
        pay = SealSideUi("sol", 48, price, "SOL", "Pay $price SOL"),
        gets = SealSideUi(itemArt ?: craftItemIcon(offer.itemId), 64, "1", itemName, "Receive $itemName"),
        lines = listOf("From ${offer.seller}", "Delivers to ${review.buyerBaseId ?: "wallet custody"}", "Listing ${offer.id}"),
        finePrint = feeBps?.let { MarketFinePrintUi("ui:market-menu", "The realm's cut:",
            "${marketPercent(it)}% of the price, taken from the seller's share.") },
        note = "Paid from your wallet in SOL. " + (feeLamports?.let { "Network fee estimate: ${marketSol(it)} SOL." }
            ?: "The wallet also charges a network fee."),
        confirmLabel = "BUY", confirmSub = "$price SOL", armedAtMs = armedAtMs,
        confirmEnabled = enabled, message = if (enabled) null else "Reconnect your wallet to pay.",
    )
}

/** The owner's command stage stays explicit: reserve first, then review/approve/send payment in its existing UI. */
internal fun keepMarketCommandSeal(
    review: KeepEquipmentMarketRecord, selectedBase: String?, armedAtMs: Long, allowed: Boolean, busy: Boolean,
): MarketSealUi {
    val request = review.request
    val preview = review.preview
    val item = CharterGrammar.text(requireNotNull(request["itemId"] ?: preview?.get("itemId")))
    val name = keepMarketName(item)
    val quantity = CharterGrammar.text(requireNotNull(request["quantity"] ?: preview?.get("availableQuantity")))
    val target = CharterGrammar.text(requireNotNull(request["baseId"] ?: request["buyerBaseId"] ?: preview?.get("sellerBaseId")))
    val decimals = CharterGrammar.number(review.policy.getValue("decimals")).toInt()
    val itemSide = SealSideUi(craftItemIcon(item), 64, quantity, name, "$quantity $name")
    val destination = "Original kingdom: $target" + if (target == selectedBase) " (this kingdom)" else ""
    val context = listOf(destination, "Request ${review.key}")
    val commonNote = "Changing current choices will not change this saved request."
    val stage = if (busy) MarketSealStage.BUSY else MarketSealStage.READY
    val enabled = allowed && !busy
    val message = if (!allowed) "Orders are paused on this base." else null
    if (review.kind == "cancellation") return MarketSealUi(
        title = "RETURN UNSOLD ${name.uppercase()}", pay = itemSide,
        gets = SealSideUi("ui:market-menu", 48, null, "original stores", "Return unsold stock to its original kingdom"),
        lines = listOf("Returns only the unreserved remainder. Existing purchases stay reserved.") + context,
        finePrint = null, note = commonNote, confirmLabel = "RETURN", confirmSub = "unsold stock",
        armedAtMs = armedAtMs, stage = stage, confirmEnabled = enabled, message = message,
    )
    val unit = CharterGrammar.amount(requireNotNull(request["unitPriceBaseUnits"] ?: preview?.get("unitPriceBaseUnits")))
    val total = keepMarketAmount((unit * quantity.toBigInteger()).toString(), decimals)
    val each = keepMarketAmount(unit.toString(), decimals)
    if (review.kind == "listing") {
        val seller = CharterGrammar.number(review.policy.getValue("sellerBps")).toBigInteger()
        val basis = CharterGrammar.number(review.policy.getValue("basisPoints")).toBigInteger()
        fun percent(amount: java.math.BigInteger) = BigDecimal(amount).movePointRight(2).divide(BigDecimal(basis)).stripTrailingZeros().toPlainString()
        return MarketSealUi(
            title = "LIST $quantity ${name.uppercase()}", pay = itemSide,
            gets = SealSideUi("ui:market-menu", 48, null, "your stall", "List on your stall"),
            lines = listOf("Buyers pay $each KEEP each.") + context,
            finePrint = MarketFinePrintUi("ui:market-menu", "The realm's cut:",
                "${percent(basis - seller)}% of each sale is burned. ${percent(seller)}% goes to your wallet."),
            note = "Paid out to your wallet as items sell. $commonNote",
            confirmLabel = "LIST", confirmSub = "$quantity $name", armedAtMs = armedAtMs,
            stage = stage, confirmEnabled = enabled, message = message,
        )
    }
    require(review.kind == "fill")
    return MarketSealUi(
        title = "BUY $quantity ${name.uppercase()}",
        pay = SealSideUi("keep", 48, total, "KEEP", "Purchase total $total KEEP"), gets = itemSide,
        lines = listOf("Reserve these units for the saved kingdom.") + context,
        finePrint = null,
        note = "You will review wallet payment next. An unresolved reservation remains saved.",
        confirmLabel = "RESERVE", confirmSub = "$total KEEP", armedAtMs = armedAtMs,
        stage = stage, confirmEnabled = enabled, message = message,
    )
}

/** Modal presentation over the existing owner screen; the kit alone supplies the required 55% scrim. */
@Composable internal fun MarketOwnerSealDialog(ui: MarketSealUi, onConfirm: () -> Unit, onBack: () -> Unit) {
    Dialog(onDismissRequest = onBack, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect { window?.setDimAmount(0f) }
        MarketSealV2(ui, MarketSealActions(onConfirm = onConfirm, onBack = onBack),
            Modifier.windowInsetsPadding(WindowInsets.safeDrawing))
    }
}
