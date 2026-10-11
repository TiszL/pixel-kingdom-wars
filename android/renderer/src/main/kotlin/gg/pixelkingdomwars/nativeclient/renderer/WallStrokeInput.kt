package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.floor

data class WallStrokeTile(val tx: Int, val ty: Int)
/** An explicitly admitted, single-batch drawing lease. Geometry is supplied by the app's
 * current base/canonical catalogue; the renderer owns contacts, never prices or orders. */
data class WallStrokeMode(val token: String, val baseId: String, val columns: Int, val rows: Int,
    val footprintWidth: Int, val footprintHeight: Int, val validTiles: Set<WallStrokeTile>,
    val minimumTileX: Int = 0, val minimumTileY: Int = 0) {
    init {
        require(token.isNotBlank() && baseId.isNotBlank() && columns > 0 && rows > 0)
        require(footprintWidth in 1..columns && footprintHeight in 1..rows)
        require(validTiles.all { it.tx in minimumTileX..minimumTileX+columns-footprintWidth && it.ty in minimumTileY..minimumTileY+rows-footprintHeight })
    }
}
sealed interface WallStrokeEvent {
    val token: String
    data class Preview(override val token: String, val tiles: List<WallStrokeTile>) : WallStrokeEvent
    data class Released(override val token: String, val tiles: List<WallStrokeTile>) : WallStrokeEvent
}

/** Source BaseScene paintWallTile: sample moves only (no interpolation); a pure tap
 * samples release. Budget/cap cannot trim this set. Pinch is camera-only until all lift. */
class WallStrokeInput(private val emit: (WallStrokeEvent) -> Unit) {
    private var mode: WallStrokeMode? = null
    private var sceneRevision = -1L
    private var width = 0; private var height = 0
    private val contacts = mutableSetOf<Int>()
    private var owner: Int? = null
    private var blocked = false
    private var consumedToken: String? = null
    private val painted = linkedSetOf<WallStrokeTile>()
    val highlights: List<SceneHighlight> get() = mode?.let { m -> painted.map {
        SceneHighlight(it.tx.toFloat(), it.ty.toFloat(), m.footprintWidth.toFloat(), m.footprintHeight.toFloat(), 0x5FE36A, 0.5f)
    } }.orEmpty()

    fun frame(next: WallStrokeMode?, revision: Long, baseId: String?, battle: Boolean, viewportWidth: Int, viewportHeight: Int) {
        val admitted = next?.takeIf { !battle && it.baseId == baseId && viewportWidth > 0 && viewportHeight > 0 }
        if (mode != admitted || revision != sceneRevision || width != viewportWidth || height != viewportHeight) {
            clear(); blocked = contacts.isNotEmpty()
            mode = admitted; sceneRevision = revision; width = viewportWidth; height = viewportHeight
        }
    }
    /** Returns true only when this pointer belongs to wall painting. */
    fun down(pointer: Int, primary: Boolean, inside: Boolean): Boolean {
        contacts.add(pointer)
        if (contacts.size > 1) { clear(); blocked = true; return false }
        if (!primary || !inside || blocked || mode == null || mode?.token == consumedToken) return false
        owner = pointer; return true
    }
    fun move(pointer: Int, tileX: Float, tileY: Float, inside: Boolean): Boolean {
        if (owner != pointer || blocked || contacts.size != 1 || mode == null) return false
        if (inside) sample(tileX, tileY)
        return true
    }
    /** A release outside the view cancels the whole candidate, without clamping it into a purchase. */
    fun up(pointer: Int, tileX: Float, tileY: Float, inside: Boolean): Boolean {
        val owns = owner == pointer; contacts.remove(pointer)
        if (owns && !blocked && mode != null && mode?.token != consumedToken && inside) {
            if (painted.isEmpty()) sample(tileX, tileY)
            val result = painted.toList(); val token = requireNotNull(mode).token
            clear()
            if (result.isNotEmpty()) { consumedToken = token; emit(WallStrokeEvent.Released(token, result)) }
        } else if (owns) clear()
        if (contacts.isEmpty()) blocked = false
        return owns
    }
    fun cancel(pointer: Int? = null) {
        if (pointer != null) contacts.remove(pointer)
        clear(); blocked = contacts.isNotEmpty()
    }
    /** Platform pause/disposal ends the entire contact stream; it is never a release. */
    fun reset() { clear(); contacts.clear(); blocked = false }
    private fun sample(x: Float, y: Float) {
        val m = mode ?: return; if (!x.isFinite() || !y.isFinite()) return
        // JavaScript Math.round(v) is floor(v + .5), including negative half values.
        val tx = floor(x - m.footprintWidth / 2f + .5f).toInt().coerceIn(m.minimumTileX, m.minimumTileX + m.columns - m.footprintWidth)
        val ty = floor(y - m.footprintHeight / 2f + .5f).toInt().coerceIn(m.minimumTileY, m.minimumTileY + m.rows - m.footprintHeight)
        val tile = WallStrokeTile(tx, ty)
        if (tile in m.validTiles && painted.add(tile)) emit(WallStrokeEvent.Preview(m.token, painted.toList()))
    }
    private fun clear() {
        val old = mode; val hadTiles = painted.isNotEmpty(); owner = null; painted.clear()
        if (old != null && hadTiles) emit(WallStrokeEvent.Preview(old.token, emptyList()))
    }
}
