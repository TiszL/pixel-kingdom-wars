package gg.pixelkingdomwars.nativeclient.ui.sheets.money.live

import gg.pixelkingdomwars.nativeclient.data.ReviewedQuote
import gg.pixelkingdomwars.nativeclient.model.TrainingQuote
import gg.pixelkingdomwars.nativeclient.network.BaseOrderPrice
import gg.pixelkingdomwars.nativeclient.network.trainingConfirmation
import gg.pixelkingdomwars.nativeclient.ui.kit.exactAmount
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import java.math.BigInteger
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * A SHARDS build/upgrade cost from the existing canonical-catalogue lookup, with no copied cost table.
 * [priceCurrent] is the host owner's admission of the current account, base, building/type, level and catalogue
 * generation. [balanceCurrent] independently admits the current base's spendable Shards observation. Retained
 * snapshots alone admit neither flag; both must be cleared on invalidation, refresh failure or scope changes.
 *
 * Null and non-SHARDS prices return null so the existing money review retains its currency, controller and Seal.
 * The host owns genuinely missing-row rendering. A catalogue zero cannot supply SERVER_ZERO: that needs a server review.
 * This is a cost pill only. OK/SHORT are presentation, never permission to submit or skip the existing confirmation.
 */
internal fun buildUpgradeMoneyPrice(
    price: BaseOrderPrice?,
    priceCurrent: Boolean = false,
    balanceShards: String? = null,
    balanceCurrent: Boolean = false,
): PriceUi? {
    if (price == null || price.currency != "SHARDS") return null
    if (!priceCurrent) return unavailableShardsPrice()
    val cost = wholeShards(price.amount)?.takeIf { it.signum() > 0 } ?: return unavailableShardsPrice()
    return shardsCostPrice(price.amount, cost, balanceShards.takeIf { balanceCurrent })
}

/**
 * The price of the exact server-reviewed training subset, never a draft total or requested-count estimate.
 * [reviewCurrent] belongs to the controller/host: identity equality cannot prove freshness after A -> B -> A.
 * It also asserts that no loading/error/recovery condition invalidates this unsent review. Defaults stay closed.
 *
 * Re-parse the raw response and compare the frozen confirmation using the SAME existing validator the repository
 * uses before confirmation. No new request/key/consent is generated: the existing key is only checked. Saved intents,
 * receipt recovery, mutation, hydration and all Seal transitions remain exclusively with their current owners.
 * SERVER_ZERO is possible only for an admitted server quote with a nonempty queue and exact unchanged confirmation.
 */
internal fun trainingMoneyPrice(
    reviewed: ReviewedQuote?,
    wallet: String?,
    baseId: String?,
    reviewCurrent: Boolean = false,
): PriceUi {
    if (!reviewCurrent || reviewed == null || wallet.isNullOrBlank() || baseId.isNullOrBlank() ||
        reviewed.draft.wallet != wallet || reviewed.draft.baseId != baseId) return unavailableShardsPrice()

    val quote = runCatching { TrainingQuote.from(reviewed.quote.raw) }.getOrNull() ?: return unavailableShardsPrice()
    if (quote != reviewed.quote || quote.queueable.isEmpty() || quote.queueable.any { it.count <= 0 })
        return unavailableShardsPrice()
    val key = (reviewed.body["idempotencyKey"] as? JsonPrimitive)?.contentOrNull ?: return unavailableShardsPrice()
    val confirmation = runCatching {
        trainingConfirmation(quote.raw, baseId, key, reviewed.scheduling)
    }.getOrNull() ?: return unavailableShardsPrice()
    if (confirmation != reviewed.body) return unavailableShardsPrice()

    val cost = wholeShards(quote.costShards) ?: return unavailableShardsPrice()
    if (cost.signum() == 0) return PriceUi(Currency.SHARDS, "0", PriceStatus.SERVER_ZERO)
    return shardsCostPrice(quote.costShards, cost, quote.availableShards)
}

private fun shardsCostPrice(amount: String, cost: BigInteger, balance: String?): PriceUi {
    val funds = wholeShards(balance)
    val status = when {
        funds == null -> PriceStatus.CHECKING
        funds < cost -> PriceStatus.SHORT
        else -> PriceStatus.OK
    }
    return PriceUi(Currency.SHARDS, exactAmount(amount), status)
}

private fun unavailableShardsPrice() = PriceUi(Currency.SHARDS, null, PriceStatus.UNAVAILABLE)

private fun wholeShards(value: String?): BigInteger? =
    value?.takeIf(SHARDS_INTEGER::matches)?.toBigIntegerOrNull()

private val SHARDS_INTEGER = Regex("0|[1-9][0-9]*")
