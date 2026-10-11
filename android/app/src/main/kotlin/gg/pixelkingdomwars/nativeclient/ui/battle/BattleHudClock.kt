package gg.pixelkingdomwars.nativeclient.ui.battle

/** Read-only HUD sampling. The renderer and accepted commands keep the unrounded clock.
 * Before scene admission only whole seconds are visible; after admission use its source tick. */
internal fun battleHudPlayhead(milliseconds: Double, tickDurationMs: Float?): Double {
    val interval = tickDurationMs?.toDouble()?.takeIf { it.isFinite() && it > 0 } ?: 1_000.0
    return kotlin.math.floor(milliseconds.coerceAtLeast(0.0) / interval) * interval
}
