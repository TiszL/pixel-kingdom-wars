package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3VertexArray
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

/**
 * The zoomable minimap (minimap.js, D-164.6): a scissored pass in the world surface over a rect Compose owns.
 * Pass 1 draws chart8 (no other-realm veil since pin 02e9da84, owner 2026-09-26), the main view's box and the rounded
 * frame; pass 2 one instanced quad per base (gold = mine, white = others, red = attackable while that filter is on,
 * filtered-out dimmed) and the pulsing selection last. Its own camera runs from "fit realm" (zoom 0) to 12× the main view's width (zoom 1) and
 * follows the main view as it zooms. Compose forwards taps and drags as intents; [toDeedX]/[toDeedY], [inBox],
 * [freeze] and [zoomBy] are the web's hit-div helpers. GL thread only; no allocation per frame.
 */
class RealmMinimap(private val core: Gl3Core) {
    private var cols = 1; private var rows = 1
    var zoom = 0.0; private set
    private var frozen = false
    private val frozenRect = DoubleArray(4)
    /** The minimap's deed rect of the last draw (x0, y0, x1, y1); NaN until drawn. */
    val lastRect = doubleArrayOf(Double.NaN, Double.NaN, Double.NaN, Double.NaN)
    // rect in CSS px, or w ≤ 0 when collapsed
    private var rx = 0.0; private var ry = 0.0; private var rw = 0.0; private var rh = 0.0
    private var filterOn = false
    private var instances: FloatBuffer = direct(64)
    var points = 0; private set
    private var firstX = 0.0; private var firstY = 0.0
    private var vao: Gl3VertexArray? = null
    private var buffer = 0
    private var quadBuffer = 0
    private var uploaded = false
    // the main view's stand-in list (SHARDKEEP D-191: the drawn bases only), its own buffer and vertex array
    private var standIn: FloatBuffer = direct(64)
    var standInPoints = 0; private set
    private var standInVao: Gl3VertexArray? = null
    private var standInBuffer = 0
    private var standInUploaded = false
    private val sea = floatArrayOf(0.05f, 0.13f, 0.27f)

    fun setGrid(cols: Int, rows: Int) { this.cols = cols; this.rows = rows; zoom = 0.0 }
    fun setSea(rgb: FloatArray) { rgb.copyInto(sea, 0, 0, 3) }

    /** The minimap's rect in CSS px (Compose layout, converted by the host), or a zero width when collapsed. */
    fun setRect(x: Double, y: Double, w: Double, h: Double) { rx = x; ry = y; rw = w; rh = h }
    val visible: Boolean get() = rw > 0 && rh > 0

    /**
     * minimap.js `setBases`: others first, then mine on top, the selection last. [x]/[y] are plot centres (deed units),
     * [flags] bit 1 mine · 2 filtered-in (only while a filter is active) · 4 attackable (attack filter on) · 8 selected.
     * Uploaded on the next allowed frame (never inside a flight or fade).
     */
    fun setPoints(n: Int, x: DoubleArray, y: DoubleArray, flags: IntArray, filterActive: Boolean) {
        filterOn = filterActive
        instances = packed(instances, n, x, y, flags)
        points = n
        if (n > 0) { firstX = x[0]; firstY = y[0] }
        uploaded = false
    }

    /**
     * The main view's stand-in list (SHARDKEEP D-191): [RealmBases.standInPoints], the DRAWN bases only (filtered-in plus
     * the selection), so a filtered-out kingdom is hidden on the main view while the minimap keeps every base at its own
     * 15 %. Same layout as [setPoints]; uploaded with it on the next allowed frame.
     */
    fun setStandIn(n: Int, x: DoubleArray, y: DoubleArray, flags: IntArray) {
        standIn = packed(standIn, n, x, y, flags)
        standInPoints = n
        standInUploaded = false
    }

    /** One instance per point (x, y, flags, 0) into [buf], grown when too small. */
    private fun packed(buf: FloatBuffer, n: Int, x: DoubleArray, y: DoubleArray, flags: IntArray): FloatBuffer {
        val b = if (buf.capacity() < n * 4) direct(maxOf(n * 4, buf.capacity() * 2)) else buf
        b.clear()
        for (i in 0 until n) { b.put(x[i].toFloat()); b.put(y[i].toFloat()); b.put(flags[i].toFloat()); b.put(0f) }
        b.flip()
        return b
    }

    /** Create the instance buffers and vertex arrays (GL thread; again after a context change). */
    fun createGl() {
        val gl = core.gl
        buffer = gl.genBuffer(); quadBuffer = gl.genBuffer(); standInBuffer = gl.genBuffer()
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quadBuffer)
        gl.bufferData(GL20.GL_ARRAY_BUFFER, QUAD.capacity() * 4, QUAD, GL20.GL_STATIC_DRAW)
        vao = dotsArray(buffer); uploaded = false
        standInVao = dotsArray(standInBuffer); standInUploaded = false
    }

    /** The dots layout over the shared quad and one instance buffer (the same (program, layout) pair for both lists). */
    private fun dotsArray(instanceBuffer: Int): Gl3VertexArray {
        val gl = core.gl
        val array = core.vertexArray(LAYOUT_DOTS)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quadBuffer)
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, GL20.GL_FLOAT, false, 0, 0)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, instanceBuffer)
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, GL20.GL_FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1)
        core.bindVertexArray(null)
        return array
    }

    /** Upload pending instance data, both lists (a buffer upload: the host allows it only outside flights and fades). */
    fun flush(): Boolean {
        if (vao == null) return false
        var any = false
        if (!uploaded) { upload(buffer, points, instances); uploaded = true; any = true }
        if (!standInUploaded) { upload(standInBuffer, standInPoints, standIn); standInUploaded = true; any = true }
        return any
    }

    private fun upload(target: Int, n: Int, data: FloatBuffer) {
        val gl = core.gl
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, target)
        gl.bufferData(GL20.GL_ARRAY_BUFFER, maxOf(16, n * 16), if (n > 0) data else null, GL20.GL_DYNAMIC_DRAW)
    }

    /** minimap.js `viewRect`: the minimap's deed rect for the current zoom (frozen during a box drag) into [out]. */
    fun viewRect(viewW: Double, viewH: Double, s: Double, camX: Double, camY: Double, hasView: Boolean, out: DoubleArray) {
        if (frozen) { frozenRect.copyInto(out); return }
        val aspect = if (rw > 0 && rh > 0) rw / rh else 1.0
        var fitW = cols.toDouble(); var fitH = rows.toDouble()
        if (fitW / fitH > aspect) fitH = fitW / aspect else fitW = fitH * aspect
        val mainW = if (hasView) viewW / s else cols.toDouble()
        val localW = min(fitW, mainW * MIN_ZOOM_VIEW_FACTOR)
        val w = exp(ln(fitW) + (ln(localW) - ln(fitW)) * zoom); val h = w / aspect
        var cx = cols / 2.0; var cy = rows / 2.0
        if (zoom > 0 && hasView) {
            val k = min(1.0, zoom * 3)
            cx += (camX - cx) * k; cy += (camY - cy) * k
            cx = if (w < cols) cx.coerceIn(w / 2, cols - w / 2) else cols / 2.0
            cy = if (h < rows) cy.coerceIn(h / 2, rows - h / 2) else rows / 2.0
        }
        out[0] = cx - w / 2; out[1] = cy - h / 2; out[2] = cx + w / 2; out[3] = cy + h / 2
    }

    /**
     * The minimap pass (after everything else in the frame, screen or snapshot target of height [targetH] device px),
     * scissored to its rect; the main view's box comes from [view]'s deed rect.
     */
    fun draw(chart: Gl3Program, dots: Gl3Program, chartTex: Gl3Texture, deeds: Gl3Texture, far: Gl3Texture,
             view: RealmView, targetH: Int) {
        if (!visible || !chart.ready || !chartTex.ready || !deeds.ready || !far.ready) return
        val dpr = view.dpr
        val x = jsRound(rx * dpr); val y = jsRound(targetH - (ry + rh) * dpr); val w = jsRound(rw * dpr); val h = jsRound(rh * dpr)
        if (w < 4 || h < 4) return
        viewRect(view.viewW, view.viewH, view.s, view.x, view.y, true, lastRect)
        val m = lastRect
        val gl = core.gl
        // its own opaque state, whatever a lane pass left: the chart writes alpha 1 on every channel (owner, code-27:
        // "the minimap sometimes turns transparent"; pinned by RealmMinimapStateTest)
        core.disable(GL20.GL_DEPTH_TEST); core.disable(GL20.GL_BLEND); core.colorMask(true, true, true, true)
        core.enable(GL20.GL_SCISSOR_TEST); core.scissor(x, y, w, h); core.viewport(x, y, w, h)
        if (core.use(chart)) {
            core.bindTexture(0, chartTex); core.bindTexture(1, deeds); core.bindTexture(2, far)
            gl.uniform1i(chart.uniform(core, "uChart"), 0); gl.uniform1i(chart.uniform(core, "uDeeds"), 1); gl.uniform1i(chart.uniform(core, "uFar"), 2)
            gl.uniform3f(chart.uniform(core, "uSea"), sea[0], sea[1], sea[2])
            gl.uniform4f(chart.uniform(core, "uMini"), m[0].toFloat(), m[1].toFloat(), m[2].toFloat(), m[3].toFloat())
            gl.uniform4f(chart.uniform(core, "uBox"), view.rectX0.toFloat(), view.rectY0.toFloat(), view.rectX1.toFloat(), view.rectY1.toFloat())
            gl.uniform4f(chart.uniform(core, "uPx"), w.toFloat(), h.toFloat(), dpr.toFloat(), (10 * dpr).toFloat())
            gl.uniform2f(chart.uniform(core, "uOrigin"), x.toFloat(), y.toFloat())
            core.fullscreen()
        }
        val array = vao
        if (points > 0 && uploaded && array != null && core.use(dots)) {
            val deedPx = w / (m[2] - m[0]); val zoomT = ((deedPx - 2.5) / 3.5).coerceIn(0.0, 1.0)
            gl.uniform4f(dots.uniform(core, "uMini"), m[0].toFloat(), m[1].toFloat(), m[2].toFloat(), m[3].toFloat())
            gl.uniform4f(dots.uniform(core, "uPx"), w.toFloat(), h.toFloat(), dpr.toFloat(), 0f)
            gl.uniform1f(dots.uniform(core, "uDot"), (deedPx * 0.55).coerceIn(1.0, 4.0).toFloat())
            gl.uniform1f(dots.uniform(core, "uMine"), max(5 * dpr, deedPx * 1.2).toFloat())
            gl.uniform2f(dots.uniform(core, "uAlpha"), (0.2 + 0.5 * zoomT).toFloat(), if (filterOn) 1f else 0f)
            core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
            core.bindVertexArray(array); core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, points); core.bindVertexArray(null)
            core.disable(GL20.GL_BLEND)
        }
        core.disable(GL20.GL_SCISSOR_TEST); core.viewport(0, 0, view.targetW, targetH)
    }

    /**
     * The occupancy dots on the MAIN view (the whole bound target), until a bases lane draws the bases: the stand-in list
     * ([setStandIn]: the DRAWN bases only, SHARDKEEP D-191) through the minimap's `minimap-dots` program, with the main
     * view's deed rect as `uMini` and BASES' FAR dot sizes (bases.js:743: others `clamp(s·0.25, 2, 4)`, yours
     * `clamp(s·0.45, 4, 6)` CSS px). `rm-chart` (the FAR ground) has no occupancy of its own, so without this the realm
     * map would show no kingdom until the bases lane. The dim state (`uAlpha.y`) stays off: a filtered-out kingdom is not
     * in this list, never drawn dimmed (the look players read as the filter doing nothing). Same (program, state) pair as
     * the minimap's dots (blended, depth off). False when nothing was drawn.
     */
    fun drawOccupancy(dots: Gl3Program, view: RealmView): Boolean {
        val array = standInVao
        if (standInPoints == 0 || !standInUploaded || array == null || !core.use(dots)) return false
        val gl = core.gl; val dpr = view.dpr; val s = view.s
        core.disable(GL20.GL_DEPTH_TEST)
        gl.uniform4f(dots.uniform(core, "uMini"), view.rectX0.toFloat(), view.rectY0.toFloat(), view.rectX1.toFloat(), view.rectY1.toFloat())
        gl.uniform4f(dots.uniform(core, "uPx"), view.targetW.toFloat(), view.targetH.toFloat(), dpr.toFloat(), 0f)
        gl.uniform1f(dots.uniform(core, "uDot"), ((s * 0.25).coerceIn(2.0, 4.0) * dpr).toFloat())
        gl.uniform1f(dots.uniform(core, "uMine"), ((s * 0.45).coerceIn(4.0, 6.0) * dpr).toFloat())
        gl.uniform2f(dots.uniform(core, "uAlpha"), OCCUPANCY_ALPHA, 0f)
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        core.bindVertexArray(array); core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, standInPoints); core.bindVertexArray(null)
        core.disable(GL20.GL_BLEND)
        return true
    }

    /**
     * minimap.js `rehearse`: the real draw's state (depth off; the chart opaque with its three textures on units 0–2,
     * a full-screen pass; the dots blended, ONE instance centred on the first base, 8 px wide) inside [Gl3Core.rehearse].
     * False when it cannot draw now (not loaded, no bases for the dots).
     */
    fun rehearse(program: Gl3Program, chart: Gl3Program, dots: Gl3Program, chartTex: Gl3Texture?, deeds: Gl3Texture?, far: Gl3Texture?,
                 targetW: Int, targetH: Int): Boolean {
        val gl = core.gl
        core.disable(GL20.GL_DEPTH_TEST); core.disable(GL20.GL_BLEND); core.colorMask(true, true, true, true) // the draw's state
        if (program === chart) {
            if (chartTex == null || deeds == null || far == null || !chartTex.ready || !deeds.ready || !far.ready || !core.use(chart)) return false
            core.bindTexture(0, chartTex); core.bindTexture(1, deeds); core.bindTexture(2, far)
            gl.uniform1i(chart.uniform(core, "uChart"), 0); gl.uniform1i(chart.uniform(core, "uDeeds"), 1); gl.uniform1i(chart.uniform(core, "uFar"), 2)
            core.fullscreen(); return true
        }
        // (with no bases yet the buffer holds one zero instance: the pipeline is built all the same, so a realm without
        // occupants never waits for bases, and the first real dots are not a first draw)
        val array = vao
        if (program !== dots || !uploaded || array == null || !core.use(dots)) return false
        val tw = targetW.toDouble(); val th = targetH.toDouble(); val e = 16 / max(1.0, tw)
        gl.uniform4f(dots.uniform(core, "uMini"), (firstX - e * tw / 2).toFloat(), (firstY - e * th / 2).toFloat(), (firstX + e * tw / 2).toFloat(), (firstY + e * th / 2).toFloat())
        gl.uniform4f(dots.uniform(core, "uPx"), tw.toFloat(), th.toFloat(), 1f, 0f)
        gl.uniform1f(dots.uniform(core, "uDot"), 8f); gl.uniform1f(dots.uniform(core, "uMine"), 8f); gl.uniform2f(dots.uniform(core, "uAlpha"), 1f, 0f)
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        core.bindVertexArray(array); core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, 1); core.bindVertexArray(null)
        core.disable(GL20.GL_BLEND)
        return true
    }

    /** Minimap-local CSS px → deed coords (tap → fly; box drags); NaN before the first draw. */
    fun toDeedX(mx: Double): Double = if (lastRect[0].isNaN() || rw <= 0) Double.NaN else lastRect[0] + mx / rw * (lastRect[2] - lastRect[0])
    fun toDeedY(my: Double): Double = if (lastRect[0].isNaN() || rh <= 0) Double.NaN else lastRect[1] + my / rh * (lastRect[3] - lastRect[1])
    /** Deeds per minimap CSS px at the current (or frozen) zoom. */
    fun deedPerPx(): Double = if (lastRect[0].isNaN() || rw <= 0) 1.0 else (lastRect[2] - lastRect[0]) / rw

    /** Is the minimap point on the main view box? The grab zone is ≥ 44 × 44 CSS px however small the box draws. */
    fun inBox(mx: Double, my: Double, boxX0: Double, boxY0: Double, boxX1: Double, boxY1: Double): Boolean {
        val px = toDeedX(mx); val py = toDeedY(my)
        if (px.isNaN()) return false
        val dpp = deedPerPx()
        val gx = max(8.0, (44 - (boxX1 - boxX0) / dpp) / 2) * dpp; val gy = max(8.0, (44 - (boxY1 - boxY0) / dpp) / 2) * dpp
        return px > boxX0 - gx && px < boxX1 + gx && py > boxY0 - gy && py < boxY1 + gy
    }

    fun freeze() { if (!lastRect[0].isNaN()) { lastRect.copyInto(frozenRect); frozen = true } }
    fun unfreeze() { frozen = false }
    fun zoomBy(k: Double) { zoom = (zoom + ln(k) / ln(MIN_ZOOM_VIEW_FACTOR * 2)).coerceIn(0.0, 1.0) }
    fun resetZoom() { zoom = 0.0 }

    fun dispose() {
        if (buffer != 0) core.gl.deleteBuffer(buffer)
        if (quadBuffer != 0) core.gl.deleteBuffer(quadBuffer)
        if (standInBuffer != 0) core.gl.deleteBuffer(standInBuffer)
        buffer = 0; quadBuffer = 0; standInBuffer = 0; vao = null; standInVao = null; uploaded = false; standInUploaded = false
    }

    companion object {
        const val LAYOUT_DOTS = 0x4d44
        const val MIN_ZOOM_VIEW_FACTOR = 12.0
        /** bases.js:745: an unfiltered FAR dot's alpha (0.85); `minimap-dots` applies its own 0.9 / 0.15 under a filter. */
        const val OCCUPANCY_ALPHA = 0.85f
        private fun jsRound(v: Double): Int = Math.floor(v + 0.5).toInt()
        /** The unit quad (attribute 0 = 0..1 corner, 6 vertices, non-indexed), like the core's own. */
        private val QUAD: FloatBuffer = direct(12).apply { put(floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 0f, 1f, 1f, 0f, 1f)); flip() }
        private fun direct(floats: Int): FloatBuffer = ByteBuffer.allocateDirect(floats * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
    }
}
