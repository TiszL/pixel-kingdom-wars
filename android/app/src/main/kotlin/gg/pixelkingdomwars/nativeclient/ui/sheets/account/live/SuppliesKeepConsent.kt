package gg.pixelkingdomwars.nativeclient.ui.sheets.account.live

import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ui.KeepConfirmPreference
import gg.pixelkingdomwars.nativeclient.ui.KeepSpendIntent
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.SealUi

/**
 * The KEEP consent in front of a supply item buy (account SPEC §3: BUY raises the Seal; DESIGN-SYSTEM §6: the kit Seal is
 * the one consent for every KEEP spend). The design has no KEEP-spend wording of its own yet, so the Seal carries the
 * existing `KeepSpendConfirm` strings word for word and the server price; nothing here is new consent copy.
 */
internal fun suppliesKeepConsentUi(intent: KeepSpendIntent, armedAtMs: Long): SealUi {
    val amount = fmtN(intent.costKeep)
    return SealUi(
        title = "SPEND KEEP?",
        lines = listOf("SPEND $amount KEEP TO ${intent.what}${if (intent.immediate) " IMMEDIATELY" else ""}?",
            "KEEP IS THE HARD CURRENCY — NOT SHARDS."),
        price = PriceUi(Currency.KEEP, amount, PriceStatus.OK),
        confirmLabel = "CONFIRM · $amount",
        armedAtMs = armedAtMs,
    )
}

/** What the player is asked to agree to: the KEEP offer, its item, the server price, the BUY label it quoted, and the
 *  projection it was read from (the confirm re-checks against that exact view). */
internal data class SuppliesKeepBuy(val offerId: String, val itemId: String, val costKeep: String, val what: String,
    val shown: SuppliesProjection)

/** Tap time: the KEEP item offer [offerId] that [latest] still admits exactly as [displayed] drew it; null for a SOL offer,
 *  a changed row or a price that is not a whole server KEEP amount. */
internal fun suppliesKeepBuy(displayed: SuppliesProjection, latest: SuppliesProjection, offerId: String): SuppliesKeepBuy? {
    val target = suppliesBuyTarget(displayed, latest, offerId) as? SupplyTarget.Item ?: return null
    val row = latest.ui.offers.singleOrNull { it.id == offerId } ?: return null
    if (row.price.currency != Currency.KEEP) return null
    val price = row.price.amount?.takeIf { it.matches(KEEP_AMOUNT) } ?: return null
    return SuppliesKeepBuy(offerId, target.itemId, price, row.buyLabel, latest)
}

/** Confirm time: the item to buy only while [latest] still shows the same item at the same server price the Seal quoted.
 *  Anything else (a refresh, another kingdom, a new price, a sold-out row) is null and nothing is spent. */
internal fun suppliesKeepConfirmed(consent: SuppliesKeepBuy, latest: SuppliesProjection): SupplyTarget.Item? {
    val target = suppliesBuyTarget(consent.shown, latest, consent.offerId) as? SupplyTarget.Item ?: return null
    val row = latest.ui.offers.singleOrNull { it.id == consent.offerId } ?: return null
    return target.takeIf { it.itemId == consent.itemId && row.price.currency == Currency.KEEP && row.price.amount == consent.costKeep }
}

/** The intent the KEEP guard holds: the server price and exactly what the BUY button quoted. A purchase hurries nothing,
 *  so it is never "immediately"; the player's existing KEEP-confirm preference decides whether it asks. */
internal fun suppliesKeepIntent(buy: SuppliesKeepBuy, onConfirm: () -> Unit): KeepSpendIntent =
    KeepSpendIntent(costKeep = buy.costKeep, what = buy.what, immediate = false, onConfirm = onConfirm)

/** The preference a host that passes none gets: always ask, and never store an opt-out (fails safe). */
internal object SuppliesAlwaysAsk : KeepConfirmPreference {
    override fun on(): Boolean = true
    override fun set(on: Boolean) {}
}

internal fun suppliesKeepPreference(keepConfirm: KeepConfirmPreference?): KeepConfirmPreference = keepConfirm ?: SuppliesAlwaysAsk

/** Said when the offer the player chose is no longer the one on sale (tap or confirm time). */
internal const val SUPPLIES_CHANGED = "Supplies changed or are unavailable. Refresh and choose the offer again."

/** Said when a control is tapped after the account or kingdom changed under the sheet (the mapper's own status line). */
internal const val SUPPLIES_STALE = "Your account or kingdom changed. Open Supplies again."

private val KEEP_AMOUNT = Regex("[1-9][0-9]{0,31}")
