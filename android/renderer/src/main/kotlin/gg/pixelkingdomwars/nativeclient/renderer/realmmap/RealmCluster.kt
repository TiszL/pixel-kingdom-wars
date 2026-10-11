package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** One FAR cluster counter: [n] bases, drawn centred at ([px], [py]) CSS px, [w] wide; ([u], [v]) = the cluster's
 *  deed-space centroid × n (the fly target is u/n, v/n). */
class RealmCounter {
    var n = 0
    var sx = 0.0; var sy = 0.0
    var u = 0.0; var v = 0.0
    var mine = false
    var px = 0.0; var py = 0.0; var w = 0.0
    internal var key = 0L
}

/**
 * The FAR cluster counters (ui.js `clusterCounters`, `placeCounter`, `hitCluster`; plan §8.2, V1 "count sum =
 * bases"). World-anchored cells on a √2 ladder of deed sizes (≥ [SEP] CSS px) grow until ≤ [MAX] cells hold the
 * on-screen bases; every on-screen base lands in exactly one cell, so the counts add up. Counters are pushed off the
 * chrome rects (the HUD controls, padded by [CLEAR]), and any two closer than [SEP] merge, keeping the sum.
 * Pooled: after warm-up it allocates nothing. Coordinates are CSS px (dp); Compose draws the counters.
 */
class RealmCluster {
    private val pool = ArrayList<RealmCounter>()
    private var used = 0
    private var keys = LongArray(128)
    private var slots = IntArray(128)
    /** The counters of the last [compute], valid until the next one. */
    val list = ArrayList<RealmCounter>(MAX)
    var onScreen = 0; private set
    private var chrome = DoubleArray(0)
    private var chromeCount = 0
    private val box = DoubleArray(4)

    /** Chrome rects [l, t, r, b] × [count] in CSS px (the HUD's padded control bounds). Copied, then padded by [CLEAR]. */
    fun setChrome(rects: DoubleArray, count: Int) {
        if (chrome.size < count * 4) chrome = DoubleArray(count * 4)
        for (i in 0 until count) {
            chrome[i * 4] = rects[i * 4] - CLEAR; chrome[i * 4 + 1] = rects[i * 4 + 1] - CLEAR
            chrome[i * 4 + 2] = rects[i * 4 + 2] + CLEAR; chrome[i * 4 + 3] = rects[i * 4 + 3] + CLEAR
        }
        chromeCount = count
    }

    /**
     * Cluster the filtered bases at camera ([camX], [camY]) and scale [s] CSS px per deed on a [viewW] × [viewH] CSS px
     * view; [boxL]…[boxB] is the safe box labels must lie inside. Bases are deed cells (the deed centre, not the plot).
     */
    fun compute(bases: RealmBases, camX: Double, camY: Double, s: Double, viewW: Double, viewH: Double,
                boxL: Double, boxT: Double, boxR: Double, boxB: Double): List<RealmCounter> {
        box[0] = boxL; box[1] = boxT; box[2] = boxR; box[3] = boxB
        var k = max(0, ceil(2 * log2(SEP / s)).toInt())
        var on = 0
        for (guard in 0 until 48) {
            val g = sqrt(2.0).pow(k)
            clearCells(); on = 0
            for (i in 0 until bases.size) {
                if (!bases.filtered[i]) continue
                val bx = bases.deedX[i] + 0.5; val by = bases.deedY[i] + 0.5
                val sx = (bx - camX) * s + viewW / 2; val sy = (by - camY) * s + viewH / 2
                if (sx < 0 || sy < 0 || sx > viewW || sy > viewH) continue
                on++
                val key = floor(bx / g).toLong() * 65536 + floor(by / g).toLong()
                val c = cell(key)
                c.n++; c.sx += sx; c.sy += sy; c.u += bx; c.v += by; if (bases.mine(i)) c.mine = true
            }
            if (used <= MAX) break
            k++
        }
        onScreen = on
        for (i in 0 until used) place(pool[i])
        var changed = true; var it = 0
        while (changed && it < 16) {
            changed = false
            for (i in 0 until used) for (j in i + 1 until used) {
                val a = pool[i]; val b = pool[j]
                if (a.n == 0 || b.n == 0) continue
                val dx = abs(a.px - b.px); val dy = abs(a.py - b.py)
                if (hypot(dx, dy) >= SEP && (dx >= (a.w + b.w) / 2 + PAD || dy >= COUNTER_H + PAD)) continue
                a.n += b.n; a.sx += b.sx; a.sy += b.sy; a.u += b.u; a.v += b.v; a.mine = a.mine || b.mine; b.n = 0
                place(a); changed = true
            }
            it++
        }
        list.clear()
        for (i in 0 until used) if (pool[i].n > 0) list.add(pool[i])
        return list
    }

    /** ui.js `hitCluster`: the counter within [HIT_R] CSS px of a tap (the nearest), or null. */
    fun hit(sx: Double, sy: Double): RealmCounter? {
        var best: RealmCounter? = null; var bd = Double.POSITIVE_INFINITY
        for (c in list) { val d = hypot(c.px - sx, c.py - sy); if (d < HIT_R && d < bd) { bd = d; best = c } }
        return best
    }

    // ---- cells: an open-addressed key → pool index table (no boxing, no per-frame allocation) ----
    private fun clearCells() { keys.fill(EMPTY); used = 0 }

    private fun cell(key: Long): RealmCounter {
        if (used * 2 >= keys.size) grow()
        var h = mix(key) and (keys.size - 1)
        while (true) {
            val k = keys[h]
            if (k == EMPTY) {
                keys[h] = key; slots[h] = used
                if (pool.size == used) pool.add(RealmCounter())
                val c = pool[used++]
                c.n = 0; c.sx = 0.0; c.sy = 0.0; c.u = 0.0; c.v = 0.0; c.mine = false; c.key = key
                return c
            }
            if (k == key) return pool[slots[h]]
            h = (h + 1) and (keys.size - 1)
        }
    }

    private fun grow() {
        val oldKeys = keys; val oldSlots = slots
        keys = LongArray(oldKeys.size * 2) { EMPTY }; slots = IntArray(oldSlots.size * 2)
        for (i in oldKeys.indices) {
            val k = oldKeys[i]; if (k == EMPTY) continue
            var h = mix(k) and (keys.size - 1)
            while (keys[h] != EMPTY) h = (h + 1) and (keys.size - 1)
            keys[h] = k; slots[h] = oldSlots[i]
        }
    }

    private fun mix(key: Long): Int { var x = key * -0x61c8864680b583ebL; x = x xor (x ushr 29); return x.toInt() }

    /** ui.js `placeCounter`: the centroid kept inside the safe box and off every chrome rect. */
    private fun place(c: RealmCounter) {
        val w = counterW(c.n); val h = COUNTER_H
        val x0 = clampTo(c.sx / c.n, box[0] + w / 2, box[2] - w / 2); val y0 = clampTo(c.sy / c.n, box[1] + h / 2, box[3] - h / 2)
        var x = x0; var y = y0
        var pass = 0
        while (pass < 6) {
            val r = hits(x, y, w, h); if (r < 0) break
            var bx = Double.NaN; var by = Double.NaN; var bd = Double.POSITIVE_INFINITY
            val o = r * 4
            for (q in 0 until 4) {
                val px = when (q) { 0 -> chrome[o] - w / 2; 1 -> chrome[o + 2] + w / 2; else -> x }
                val py = when (q) { 2 -> chrome[o + 1] - h / 2; 3 -> chrome[o + 3] + h / 2; else -> y }
                if (!inBox(px, py, w, h)) continue
                val d = abs(px - x0) + abs(py - y0)
                if (d < bd) { bd = d; bx = px; by = py }
            }
            if (bx.isNaN()) break
            x = bx; y = by; pass++
        }
        if (hits(x, y, w, h) >= 0) {
            var rad = 8.0
            spiral@ while (rad < 480) {
                for (a in 0 until 16) {
                    val px = x0 + cos(a * PI / 8) * rad; val py = y0 + sin(a * PI / 8) * rad
                    if (inBox(px, py, w, h) && hits(px, py, w, h) < 0) { x = px; y = py; break@spiral }
                }
                rad += 8.0
            }
        }
        c.px = x; c.py = y; c.w = w
    }

    private fun inBox(x: Double, y: Double, w: Double, h: Double) =
        x - w / 2 >= box[0] && x + w / 2 <= box[2] && y - h / 2 >= box[1] && y + h / 2 <= box[3]

    private fun hits(x: Double, y: Double, w: Double, h: Double): Int {
        for (i in 0 until chromeCount) {
            val o = i * 4
            if (x - w / 2 < chrome[o + 2] && x + w / 2 > chrome[o] && y - h / 2 < chrome[o + 3] && y + h / 2 > chrome[o + 1]) return i
        }
        return -1
    }

    companion object {
        /** ui.js SEP, MAX_COUNTERS, PAD, CLEAR, COUNTER_H, the hit radius (22): HUD geometry in CSS px (HUD-STYLE §9). */
        const val SEP = 44.0
        const val MAX = 40
        const val PAD = 4.0
        const val CLEAR = 12.0
        const val COUNTER_H = 28.0
        const val HIT_R = 22.0
        private const val EMPTY = Long.MIN_VALUE

        /** ui.js `counterW`: VT323 20 px, advance 0.4 em per digit, 16 px padding, ≥ 28. */
        fun counterW(n: Int): Double = max(28.0, 16.0 + 8.0 * digits(n))
        private fun digits(n: Int): Int { var d = 1; var v = n; while (v >= 10) { v /= 10; d++ }; return d }
        private fun clampTo(x: Double, a: Double, b: Double) = max(a, min(b, x))
        /** JS `Math.log2`: exact on powers of two (the web's ladder start depends on it at s = 44 / 2^j). */
        private fun log2(v: Double): Double {
            val e = Math.getExponent(v)
            return if (v == Math.scalb(1.0, e)) e.toDouble() else ln(v) / ln(2.0)
        }
        private fun Double.pow(k: Int): Double = Math.pow(this, k.toDouble())
    }
}
