package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.math.roundToInt

/** Web fx/hpbars.ts: Night-Ink outline and backing, fill Meadow above 50% / Vault Gold above 25% / Ember
 * below. A troop bar is 32×6 world px floating 4 px above the body top and shows once the unit is damaged
 * (BattleScene.update: `hp < maxHp`); a building bar is 48×8 world px, 6 px above the sprite top, shown at
 * full from battle start for every targetable building (R4) and hidden once destroyed. Walls are the one
 * native exception: their bars appear only once damaged (owner 2026-09-17), or a base shows a hundred bars.
 * Sizes are authored at the web's 64 world px tile and scale with the scene's tile. */
object HpBars {
    const val INK = 0x1a171e
    const val MEADOW = 0x8cb36e
    const val GOLD = 0xe3ae3c
    const val EMBER = 0xc75a2e
    const val INK_ALPHA = .92f
    /** Web scenes render 1 game px = 2 world px; a 32 game px tile is 64 world px. */
    const val WEB_TILE_WORLD_PX = 64f
    enum class Kind(val width: Float, val height: Float, val lift: Float) { TROOP(32f, 6f, 4f), BUILDING(48f, 8f, 6f) }
    data class Geometry(val outlineX: Float, val outlineY: Float, val outlineWidth: Float, val outlineHeight: Float,
        val fillX: Float, val fillY: Float, val fillWidth: Float, val fillHeight: Float, val fillColor: Int)

    fun fillColor(fraction: Float): Int = when { fraction > .5f -> MEADOW; fraction > .25f -> GOLD; else -> EMBER }
    fun fraction(hp: Double, maxHp: Long): Float = if (maxHp <= 0 || !hp.isFinite()) 0f else (hp / maxHp).toFloat().coerceIn(0f, 1f)
    fun troopVisible(hp: Double, maxHp: Long, alive: Boolean): Boolean = alive && maxHp > 0 && hp < maxHp
    fun buildingVisible(hp: Long, maxHp: Long, wall: Boolean, destroyed: Boolean): Boolean =
        !destroyed && maxHp > 0 && hp > 0 && (!wall || hp < maxHp)

    /** `cx`/`topY` are world units with y growing downward, as the renderer's camera draws. The fill is at
     * least one authored pixel while any health remains, exactly like the web's `Math.max(1, round(w*f))`. */
    fun geometry(kind: Kind, cx: Float, topY: Float, fraction: Float, tilePixels: Float): Geometry {
        val unit = tilePixels / WEB_TILE_WORLD_PX
        val f = fraction.coerceIn(0f, 1f)
        val width = kind.width * unit; val height = kind.height * unit
        val x = cx - width / 2; val y = topY - kind.lift * unit - height
        val fill = if (f > 0f) maxOf(unit, (width * f).roundToInt().toFloat()) else 0f
        return Geometry(x - unit, y - unit, width + 2 * unit, height + 2 * unit, x, y, fill, height, fillColor(f))
    }
}

/** Display state only, the troop counterpart of BuildingHealthVisualModel: maxima are the app's frozen
 * display ledger (BattleScene.actorMaxHp); `hit`/`chain` damage and `heal` amounts are canonical, already
 * applied. Actors without a supplied maximum have no health and therefore no bar. Never rerun an attack. */
class ActorHealthVisualModel(maxima: Map<Int, Long>, events: List<PresentationEvent>, checkpoint: () -> Unit = {}) {
    data class Health(val hp: Double, val maxHp: Long)
    private data class Change(val tick: Int, val hp: Double)
    private val maxima = maxima.filterValues { it > 0 }
    private val history = HashMap<Int, MutableList<Change>>()
    init {
        var index = 0
        fun current(id: Int) = history[id]?.last()?.hp
        fun change(id: Int, tick: Int, hp: Double) { history[id]?.add(Change(tick, hp)) }
        for (event in events) {
            if (index++ % 256 == 0) checkpoint()
            when (event.e) {
                "deploy", "spawn", "troopSpawn" -> {
                    val data = JsonReader().parse(event.json)
                    val id = data.getInt("id"); val maximum = this.maxima[id] ?: continue
                    history[id] = mutableListOf(Change(event.t, maximum.toDouble()))
                }
                "hit" -> {
                    val data = JsonReader().parse(event.json)
                    val target = data.get("target") ?: continue
                    if (!target.isNumber) continue // String targets are buildings; a troop named "1" is a different target.
                    val id = target.asInt(); val before = current(id) ?: continue
                    change(id, event.t, (before - data.getDouble("dmg", 0.0).coerceAtLeast(0.0)).coerceAtLeast(0.0))
                }
                "chain" -> {
                    val data = JsonReader().parse(event.json)
                    val targets = data.get("targets") ?: continue; val damages = data.get("dmg")
                    targets.forEachIndexed { hop, target ->
                        val id = target.asInt(); val before = current(id) ?: return@forEachIndexed
                        val damage = damages?.get(hop)?.asDouble() ?: 0.0
                        change(id, event.t, (before - damage.coerceAtLeast(0.0)).coerceAtLeast(0.0))
                    }
                }
                "heal" -> {
                    val data = JsonReader().parse(event.json)
                    val id = data.getInt("id"); val before = current(id) ?: continue
                    change(id, event.t, minOf(this.maxima.getValue(id).toDouble(), before + data.getDouble("amount", 0.0).coerceAtLeast(0.0)))
                }
                "troopDeath", "detonate" -> {
                    val id = JsonReader().parse(event.json).getInt("id")
                    if (current(id) != null) change(id, event.t, 0.0)
                }
            }
        }
    }
    fun at(id: Int, tick: Float): Health? {
        val changes = history[id] ?: return null
        if (changes.first().tick > tick) return null // Not yet on the field.
        var low = 0; var high = changes.size
        while (low < high) { val middle = (low + high) ushr 1; if (changes[middle].tick <= tick) low = middle + 1 else high = middle }
        return Health(changes[(low - 1).coerceAtLeast(0)].hp, maxima.getValue(id))
    }
}
