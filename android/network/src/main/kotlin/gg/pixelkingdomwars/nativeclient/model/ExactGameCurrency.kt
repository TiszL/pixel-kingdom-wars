package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*

/** K155 terms selection: one whole price, with no fallback after confirmation. */
object ExactGameCurrency {
    private fun amount(text: String) = text.also { require(it.matches(Regex("0|[1-9][0-9]{0,18}"))) }
        .toBigInteger().also { require(it <= Long.MAX_VALUE.toBigInteger()) }
    private fun value(raw: JsonObject, key: String) = amount(requireNotNull((raw[key] as? JsonPrimitive)?.takeIf { it.isString }?.content))
    private fun feature(raw: JsonObject, key: String) = (raw["features"] as? JsonObject)?.get(key) as? JsonObject
    fun supported(raw: JsonObject) = feature(raw, "gameCurrency")?.let {
        it["version"] == JsonPrimitive(1) && it["exactSpendCurrency"] == JsonPrimitive(1)
    } == true
    private fun gems(raw: JsonObject) = feature(raw, "gems")?.let {
        it["version"] == JsonPrimitive(1) && it["receipts"] == JsonPrimitive(1)
    } == true
    fun choose(price: String, balances: JsonObject): GameCurrency {
        check(supported(balances)) { "This server cannot enforce the reviewed currency. Refresh before paying." }
        val cost = amount(price); require(cost.signum() > 0)
        if (gems(balances) && value(balances, "gems") >= cost) return GameCurrency.GEMS
        if (value(balances, "keep") >= cost) return GameCurrency.KEEP
        error("Neither Gems nor custodial KEEP covers the whole price.")
    }
    fun requireCovered(currency: GameCurrency, price: String, balances: JsonObject) {
        check(supported(balances)) { "Currency enforcement is unavailable. Keep the original command." }
        check(currency != GameCurrency.GEMS || gems(balances)) { "Gems are paused. Keep the original command." }
        val cost = amount(price)
        check(cost.signum() > 0 && value(balances, if (currency == GameCurrency.GEMS) "gems" else "keep") >= cost) {
            "The reviewed ${currency.name} no longer covers this price."
        }
    }
}
