package gg.pixelkingdomwars.nativeclient.ui.world

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BaseHandOver
import kotlin.math.roundToInt

/**
 * The map label layers (HUD-STYLE §9): globe place names and realm-map counters and name tags. Pure placement first,
 * then one Compose layer that keeps a pan free of recomposition: the label SET (text, kind) is state and recomposes only
 * when it changes; the positions are written into [LabelBoard] once per engine frame and read only in placement blocks
 * (the ArmyChipLayer pattern, GLOBE-NATIVE-PLAN §3.4). Labels never take touches; they are the first layer under every
 * control, and their placement already keeps them off every control rect.
 */
object WorldLabels {
    data class Placed(val id: Int, val x: Float, val y: Float, val w: Float, val h: Float)

    /** `.hud-place` box estimate: Silkscreen/VT323 12 dp caps, .08 em tracking, a 1 dp outline each side. */
    fun placeSize(name: String, t: HudType): Pair<Float, Float> = (HudType.textWidth(name.length, t.place, t.place * 0.08f) + 2f) to (t.place + 3f)

    /**
     * main.js `updateLabels`: each visible destination (engine anchors, view px → dp by [density]) is placed with
     * [GlobeHudPlan.placeLabel] against the UI rects and the names already placed, in destination order (realms, then
     * the live Phase E islands: [names] by anchor id, "" for none); the selected destination's name is skipped while its
     * panel names it.
     */
    fun globe(anchorIds: IntArray, anchorXY: FloatArray, count: Int, density: Float, names: List<String>, t: HudType,
        uiRects: List<HudRect>, width: Float, height: Float, hideIndex: Int?): List<Placed> {
        val order = (0 until count).sortedBy { anchorIds[it] }
        val rects = ArrayList<DoubleArray>(uiRects.size + count); uiRects.forEach { rects += doubleArrayOf(it.x.toDouble(), it.y.toDouble(), it.right.toDouble(), it.bottom.toDouble()) }
        val out = ArrayList<Placed>(count)
        for (k in order) {
            val id = anchorIds[k]; if (id == hideIndex) continue
            val name = names.getOrNull(id)?.takeIf { it.isNotEmpty() } ?: continue
            val (w, h) = placeSize(name, t)
            val p = GlobeHudPlan.placeLabel((anchorXY[2 * k] / density).toDouble(), (anchorXY[2 * k + 1] / density).toDouble(), w.toDouble(), h.toDouble(),
                rects, width.toDouble(), height.toDouble()) ?: continue
            rects += doubleArrayOf(p[0], p[1], p[0] + w, p[1] + h)
            out += Placed(id, p[0].toFloat(), p[1].toFloat(), w, h)
        }
        return out
    }

    /** The realm camera in the HUD's units: centre in catalog deed columns/rows and dp per deed. */
    data class RealmView(val camX: Double, val camY: Double, val s: Double, val d: Double, val width: Double, val height: Double)
    sealed interface RealmLabel { val key: Any }
    data class CounterLabel(val n: Int, val mine: Boolean, val slot: Int) : RealmLabel { override val key: Any get() = "c$slot" }
    /** A name tag showing [name] and [level]; level null is the compact map-range tag (D-NEXT): avatar and name only. */
    data class TagLabel(val base: RealmHudBase, val big: Boolean, val name: String = base.name, val level: Int? = base.level) : RealmLabel {
        override val key: Any get() = "t${base.tileId}"
    }
    /** [hidden]: bases whose counter could not be placed clear of the controls (under an opaque card), not drawn.
     *  [ws]/[hs]: each tag's width and height in dp, beside its top-left [xs]/[ys] (empty for counters). */
    class RealmLabels(val labels: List<RealmLabel>, val xs: FloatArray, val ys: FloatArray, val counters: List<RealmHudModel.Counter>, val onScreen: Int, val hidden: Int = 0,
        val ws: FloatArray = FloatArray(0), val hs: FloatArray = FloatArray(0)) {
        /**
         * The kingdom whose name tag is under ([x], [y]) dp, or null. A tag takes no touches itself (a finger landing on it
         * must still pinch the map), so the map's tap asks this first, as it asks the counters' `hitCluster`. At map zoom the
         * tag sits above its kingdom, mostly over the deed to the north (at s 30, 22 of its 24 dp), so the deed under the
         * finger would select the neighbour or an open deed (REFIX review of 82c91fc, finding 3).
         */
        fun tagAt(x: Double, y: Double): RealmHudBase? {
            for (i in ws.indices) {
                val tag = labels[i] as? TagLabel ?: continue
                if (x >= xs[i] && x < xs[i] + ws[i] && y >= ys[i] && y < ys[i] + hs[i]) return tag.base
            }
            return null
        }
    }

    /** Wrap a catalog column onto the camera's side of the dateline. */
    fun unwrap(x: Int, camX: Double, columns: Int): Double { var dx = x - camX; dx -= Math.round(dx / columns) * columns.toDouble(); return camX + dx }

    /**
     * ui.js `labels(view)`: below `uiDots` the FAR counters over the filtered bases (every on-screen base counted
     * once), otherwise up to 16 name tags. [plotAnchor] lifts a tag to its plot (N3 supplies it from the pinned plot
     * rules; in N2 tags sit on the deed centre, lifted like the web's default candidates).
     * D-177 landing (owner 2026-09-26): below `uiDots` only these kingdom counts, as the web's photo 1: no names, no
     * levels, no empty-realm line; details come as the player zooms in (da1b7ee's named overview was withdrawn).
     * D-NEXT (owner 2026-09-26, code 31): from `uiDots` until BASES draws a kingdom's real base ([BaseHandOver.drawsBase],
     * per kingdom between `IMPOSTOR[0]` and `IMPOSTOR[1]`), the map shows it by its dot (BASES) and this compact tag: the
     * player's picture and the name ([RealmHudModel.mapTagName]), no level. Once the base draws, the tag is the web's again.
     */
    fun realm(filtered: List<RealmHudBase>, selected: RealmHudBase?, cardOpen: Boolean, view: RealmView, columns: Int,
        chrome: List<DoubleArray>, box: DoubleArray, t: HudType, plotAnchor: ((RealmHudBase, Double, Double) -> Double)? = null): RealmLabels {
        if (view.s < HudBands.UI_DOTS_S) {
            val n = filtered.size; val bx = IntArray(n); val by = IntArray(n); val mine = BooleanArray(n)
            // Counters run in a camera-local deed space so a wrapped realm (Cinderfall) clusters across the dateline.
            val ox = Math.floor(view.camX).toInt()
            filtered.forEachIndexed { i, b -> bx[i] = (unwrap(b.x, view.camX, columns) - ox).roundToInt(); by[i] = b.y; mine[i] = b.mine }
            val res = RealmHudModel.clusterCounters(bx, by, mine, n, view.camX - ox, view.camY, view.s, view.width, view.height, chrome, box)
            // A counter the web's placement could not push off the chrome (its kingdoms lie under an opaque card or sheet,
            // beyond the 480 dp spiral) is not drawn: it would only hide under that control. Its bases stay accounted for.
            val k = RealmHudModel.CLEAR // the same clearance the placement keeps (it also holds the pin tail)
            val shown = res.list.filter { c -> chrome.none { r -> c.px - c.w / 2 < r[2] + k && c.px + c.w / 2 > r[0] - k && c.py - RealmHudModel.COUNTER_H / 2 < r[3] + k && c.py + RealmHudModel.COUNTER_H / 2 > r[1] - k } }
            val xs = FloatArray(shown.size); val ys = FloatArray(shown.size)
            val labels = shown.mapIndexed { i, c -> xs[i] = (c.px - c.w / 2).roundToInt().toFloat(); ys[i] = (c.py - RealmHudModel.COUNTER_H / 2).roundToInt().toFloat(); CounterLabel(c.n, c.mine, i) }
            for (c in res.list) { c.u += ox * c.n.toDouble() }
            return RealmLabels(labels, xs, ys, shown, res.onScreen, res.list.sumOf { it.n } - shown.sumOf { it.n })
        }
        val s = view.s; val W = view.width; val H = view.height
        val lift = minOf(HudBands.KEEP_MIN_CSS, s * 0.6)
        val cands = ArrayList<RealmHudModel.TagCandidate>()
        fun candidate(b: RealmHudBase, priority: Double) {
            val x = unwrap(b.x, view.camX, columns)
            val cx = (x + 0.5 - view.camX) * s + W / 2; val cy = (b.y + 0.5 - view.camY) * s + H / 2
            if (cx < -60 - s || cy < -40 - s || cx > W + 60 + s || cy > H + 60 + s) return
            val ay = plotAnchor?.invoke(b, cx, cy) ?: (cy - lift * 0.5)
            if (cx < -60 || ay < -40 || cx > W + 60 || ay > H + 60) return
            cands += RealmHudModel.TagCandidate(b, cx, ay, priority, compact = !BaseHandOver.drawsBase(b.tileId, view.s, view.d))
        }
        for (b in if (filtered.size < 4000) filtered else filtered.subList(0, 4000)) {
            val x = unwrap(b.x, view.camX, columns); val cx = (x + 0.5 - view.camX) * s + W / 2; val cy = (b.y + 0.5 - view.camY) * s + H / 2
            candidate(b, RealmHudModel.tagPriority(b == selected, b.mine, true, b.level, cx, cy, W, H))
        }
        if (selected != null && cands.none { it.base == selected }) candidate(selected, 2e9)
        val trueBand = view.d >= HudBands.TRUE_FULL_D
        val tags = RealmHudModel.placeTags(cands, selected, cardOpen, trueBand, chrome, box, t.cap.toDouble(), t.body.toDouble())
        val xs = FloatArray(tags.size); val ys = FloatArray(tags.size); val ws = FloatArray(tags.size); val hs = FloatArray(tags.size)
        val labels = tags.mapIndexed { i, tag ->
            xs[i] = (tag.x - tag.w / 2).roundToInt().toFloat(); ys[i] = (tag.bottom - tag.h).roundToInt().toFloat(); ws[i] = tag.w.toFloat(); hs[i] = tag.h.toFloat()
            TagLabel(tag.base, tag.big, tag.name, tag.level)
        }
        return RealmLabels(labels, xs, ys, emptyList(), 0, ws = ws, hs = hs)
    }
}

/** Positions written per frame, read in placement only; [items] is the label set and recomposes only when it changes. */
@Stable internal class LabelBoard<T : Any>(capacity: Int) {
    var items by mutableStateOf<List<T>>(emptyList())
    val xs = FloatArray(capacity); val ys = FloatArray(capacity)
    val generation = mutableLongStateOf(0L)
    fun publish(next: List<T>, x: FloatArray, y: FloatArray) {
        val n = minOf(next.size, xs.size)
        for (i in 0 until n) { xs[i] = x[i]; ys[i] = y[i] }
        if (next != items) items = if (next.size > xs.size) next.subList(0, xs.size) else next
        generation.longValue++
    }
}

/** One label layer: every item is laid out at its board position (dp) inside a placement block. */
@Composable internal fun <T : Any> LabelLayer(board: LabelBoard<T>, key: (T) -> Any, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    Box(modifier.fillMaxSize().clipToBounds()) {
        board.items.forEachIndexed { index, item ->
            key(key(item)) {
                Box(Modifier.layout { measurable, _ ->
                    val placeable = measurable.measure(Constraints())
                    layout(0, 0) {
                        board.generation.longValue // re-place (not recompose) on every published frame
                        if (index < board.items.size) placeable.place(board.xs[index].dp.roundToPx(), board.ys[index].dp.roundToPx())
                    }
                }) { content(item) }
            }
        }
    }
}
