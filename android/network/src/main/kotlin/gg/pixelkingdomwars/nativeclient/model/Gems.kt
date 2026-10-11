package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

internal fun wholeGemsAmount(value: String): String = value.also {
    require(it.length <= 32 && it.matches(Regex("0|[1-9][0-9]*"))) { "Expected a whole currency amount" }
}
private fun positiveWireInteger(value: Long) { require(value in 1..((1L shl 53) - 1)) }

@Serializable data class GemsFeature(val version: Int, val receipts: Int, val exactConsent: Int? = null) {
    val supported: Boolean get() = version == 1 && receipts == 1
}
@Serializable data class BalanceFeatures(val gems: GemsFeature? = null)
@Serializable data class GemsRate(val gemsPerKeep: Long, val shardsPerGem: Long) {
    init { positiveWireInteger(gemsPerKeep); positiveWireInteger(shardsPerGem) }
}
@Serializable data class NativeEconomyCapability(val gems: GemsCapability? = null, val workshop: WorkshopCapability? = null)
@Serializable data class WorkshopCapability(val enabled: Boolean = false, val recipeVersion: Int) {
    init { require(recipeVersion > 0) }
}
@Serializable data class GemsCapability(
    val enabled: Boolean = false,
    val sources: List<String> = emptyList(),
    val destinationAta: String? = null,
    val gemsPerKeep: Long,
    val shardsPerGem: Long,
    val minConvertKeep: Long,
    val maxConvertKeepPerTx: Long,
    val exactConsent: Int? = null,
) {
    init {
        positiveWireInteger(gemsPerKeep); positiveWireInteger(shardsPerGem)
        positiveWireInteger(minConvertKeep); positiveWireInteger(maxConvertKeepPerTx)
        require(minConvertKeep <= maxConvertKeepPerTx)
    }
}
@Serializable data class GemsTask(val id: String, @Serializable(DecimalStringSerializer::class) val gems: String,
    val claimed: Boolean, val title: String? = null) {
    init { require(id.matches(Regex("[a-z0-9_-]{1,64}"))); wholeGemsAmount(gems) }
}
/** Server-owned rates and bounds; the native client never copies game constants. */
@Serializable data class GemsOverview(val features: BalanceFeatures, val gems: String, val tasks: List<GemsTask>,
    val sources: List<String>, val minConvertKeep: Long, val maxConvertKeepPerTx: Long,
    val gemsPerKeep: Long, val shardsPerGem: Long, val serverNow: String) {
    init {
        wholeGemsAmount(gems); positiveWireInteger(minConvertKeep); positiveWireInteger(maxConvertKeepPerTx)
        require(minConvertKeep <= maxConvertKeepPerTx); positiveWireInteger(gemsPerKeep); positiveWireInteger(shardsPerGem)
        java.time.Instant.parse(serverNow)
    }
    companion object { fun from(raw: JsonObject): GemsOverview = raw.decode() }
}

enum class GameCurrency { KEEP, GEMS }
/** A consent MUST show the preferred currency and the whole-price fallback. This is a display
 * prediction from one snapshot, never proof of a debit: only receipt funding is authoritative.
 * Even sufficient Gems can change before POST, so the fallback remains disclosed. */
class GameCurrencyConsent private constructor(val amount: String, val preferred: GameCurrency,
    val fallback: GameCurrency, val expected: GameCurrency?) {
    companion object {
        fun gemsFirst(amount: String, balances: Balances, capability: GemsCapability): GameCurrencyConsent {
            val price = wholeGemsAmount(amount).toBigInteger(); require(price.signum() > 0)
            require(capability.enabled && balances.features?.gems?.supported == true)
            val gems = wholeGemsAmount(requireNotNull(balances.gems)).toBigInteger()
            val keep = wholeGemsAmount(balances.keep).toBigInteger()
            return GameCurrencyConsent(amount, GameCurrency.GEMS, GameCurrency.KEEP, when {
                gems >= price -> GameCurrency.GEMS
                keep >= price -> GameCurrency.KEEP
                else -> null // The two balances must never be added to fund a split price.
            })
        }
    }
}
