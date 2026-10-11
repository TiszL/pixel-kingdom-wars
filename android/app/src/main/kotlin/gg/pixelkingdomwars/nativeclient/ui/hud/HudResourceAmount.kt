package gg.pixelkingdomwars.nativeclient.ui.hud

import gg.pixelkingdomwars.nativeclient.ui.features.ResourceAmount
import gg.pixelkingdomwars.nativeclient.ui.features.ResourceUnit
import java.math.BigDecimal

/**
 * Display-only projection of MS-B's admitted quantity. It never reads a wallet, quotes an
 * action or treats a missing account/token as zero. Preserve [ResourceAmount] alongside
 * this text for loading/unavailable affordances; a formatted value is not spend admission.
 */
fun hudAmountText(amount: ResourceAmount): String = when (amount) {
    ResourceAmount.Loading, is ResourceAmount.Unavailable -> "…"
    ResourceAmount.Absent -> "—"
    is ResourceAmount.Known -> knownAmountText(amount) ?: "…"
}

private fun knownAmountText(amount: ResourceAmount.Known): String? {
    // These match the bounded quantity grammar of the registry contract. Money never
    // passes through Float/Double, rounding, locale parsing or scientific notation.
    if (amount.decimals !in 0..255 || amount.value.length !in 1..256) return null
    return when (amount.unit) {
        ResourceUnit.BASE_UNITS -> {
            if (!INTEGER.matches(amount.value)) return null
            BigDecimal(amount.value).movePointLeft(amount.decimals)
        }
        ResourceUnit.DECIMAL -> {
            if (!DECIMAL.matches(amount.value)) return null
            val value = BigDecimal(amount.value)
            if (value.scale() > amount.decimals) return null
            value
        }
    }.stripTrailingZeros().toPlainString()
}

private val INTEGER = Regex("0|[1-9][0-9]*")
private val DECIMAL = Regex("(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?")
