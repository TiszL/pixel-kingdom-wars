package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.floor

internal data class LiveTroopStack(var id: Int, var count: Int, val x: Double, var top: Double)

/** BattleScene.refreshLiveTroopStacks: count actual coincident living bodies, not nearby
 * simulation positions or pending deployments. Rebuilt per frame, so a rewind or replacement
 * never inherits a death/count from the previous presentation. Owns no actors or GL resources. */
internal class LiveTroopStacks {
    private val groups = LinkedHashMap<Pair<Double, Double>, LiveTroopStack>()
    val stacks: Collection<LiveTroopStack> get() = groups.values
    fun beginFrame() { groups.clear() }

    fun drawn(id: Int, x: Float, y: Float, displayHeight: Float, alive: Boolean, visible: Boolean, alpha: Float) {
        if (!alive || !visible || alpha <= 0 || !x.isFinite() || !y.isFinite()) return
        // JS Math.round ties toward +infinity; Kotlin round uses ties-to-even. Double also
        // avoids adding 0.5f losing the fractional boundary before rounding a Float position.
        val roundedX = floor(x.toDouble() + 0.5)
        val roundedY = floor(y.toDouble() + 0.5)
        val key = roundedX to roundedY
        val top = y.toDouble() - displayHeight
        val stack = groups[key]
        if (stack == null) groups[key] = LiveTroopStack(id, 1, roundedX, top)
        else { stack.id = minOf(stack.id, id); stack.count++; stack.top = minOf(stack.top, top) }
    }
}
