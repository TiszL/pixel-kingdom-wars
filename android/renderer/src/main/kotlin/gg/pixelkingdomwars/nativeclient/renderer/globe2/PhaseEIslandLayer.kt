package gg.pixelkingdomwars.nativeclient.renderer.globe2

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3VertexArray
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.tan

/**
 * The Phase E islands (Seeker, Solana, Divine) as a globe layer (RG-3; GLOBE-NATIVE-PLAN §1.1, §3.2 PhaseEIslandLayer;
 * D-172). OFF unless the verified world content says `"phaseEIslands": true` (`world/content.json`, written only by the
 * bundler `tools/world-debug-content.mjs`): a release APK packages the flag false, so there the layer never loads,
 * draws or picks, the camera keeps the atlas floor over their seas ([GlobeCameraV2.phaseE]) and the globe-v2 faces show
 * open sea where the art would sit (LANE-NB.md: islands drawn by a layer are never baked into the faces).
 *
 * When on, [GlobeV2Renderer] turns it on ([enabled]) once the art is resident, the selection fields are uploaded and the
 * draw is rehearsed:
 * - the art: the pinned 'globe-isles' program (NR4: no forked globe shader), one instance per island over its lon/lat box
 *   (the art frame plus composite.mjs's 6 % margin, [box]), one layer per island of a [LAYER]² premultiplied RGBA8 array
 *   resampled here from the pack's close-range art (`<id>.webp`, the web's `islandArt` slot art) in its tangent frame,
 *   with composite.mjs's shallows halo (`islandAt` + `withIsland`), so the far and near look is the concept's;
 * - selection like a realm (D-166.1): the prebaked RG16F field `globe-v2/phase-e/sel-<id>.png` in the art's frame, window
 *   half extents `globe-v2.json` `selection.phaseE[].hu/hv` (main.js islandSdf), read by the shared shader's `uSel.x = 2`
 *   branch: rim, keyline, glow, travelling shimmer, draw-on entrance, the rest dimmed;
 * - picking by the D-165 tap ellipses ([GlobePicking]) and the camera's lower floor near the art (main.js minAltAt).
 *
 * GL thread only for [build], [draw], [lost] and [dispose]; [draw] never allocates.
 */
class PhaseEIslandLayer {
    /** On: the world content asked for the islands and they are live (resident, rehearsed); release too since the owner's 2026-09-26 call. */
    var enabled: Boolean = false; private set

    /** The islands the HUD may offer and the picker may hit: none while off. */
    val islands: List<GlobeIslandSpec> get() = if (enabled) GlobeV2Pin.PHASE_E else emptyList()

    /** The selection frame of island [id] (centre, east, north), as main.js fxFrame(dirOf(lon, lat)); false when off. */
    fun frame(id: String, c: DoubleArray, e: DoubleArray, n: DoubleArray): Boolean {
        if (!enabled) return false
        val i = GlobeV2Pin.PHASE_E.firstOrNull { it.id == id } ?: return false
        V.dirOf(c, i.lon, i.lat)
        V.norm(e, V.crossUp(e, c)); V.cross(n, c, e)
        return true
    }

    // ---- GPU (GL thread) ----
    /** Per island (PHASE_E order): its RG16F selection field (2D, the shader's `sampler2D uSelIsleMap`) and window. */
    val fields = arrayOfNulls<Gl3Texture>(GlobeV2Pin.PHASE_E.size)
    val hu = DoubleArray(GlobeV2Pin.PHASE_E.size)
    val hv = DoubleArray(GlobeV2Pin.PHASE_E.size)
    /** The near slots (plan §5.8 "+1 island art slot", widened to [NEAR_SLOTS] on 2026-09-27): island art at [NEAR]² from
     *  the pack art (about the web slot's 144–220 texels per degree). The displayed one ([nearIsland], [near]) is drawn
     *  instead of its [LAYER]² layer; the others wait resident for a return trip. -1 / null: none displayed. */
    var nearIsland = -1; private set
    var near: Gl3Texture? = null; private set
    private val slotTex = arrayOfNulls<Gl3Texture>(NEAR_SLOTS)
    private val slotIsland = IntArray(NEAR_SLOTS) { -1 }
    private val slotUsed = LongArray(NEAR_SLOTS)
    private var slotClock = 0L
    /** The near slot holds a resident island: [draw] leaves it out and [drawNear] draws it. */
    val nearActive: Boolean get() = nearIsland >= 0 && near?.ready == true
    /** Vertex arrays over one instance buffer: [ALL] three islands, the two [WITHOUT] the near one, and the [NEAR_ONE]
     *  island alone at layer 0 of the near slot's texture. */
    private val vaos = arrayOfNulls<Gl3VertexArray>(1 + 2 * GlobeV2Pin.PHASE_E.size)
    private var buffers = IntArray(0)

    internal fun goLive() { enabled = true }

    /** The instance buffer: per record (lon, lat, rx, ry) of an island's box and (layer, 0, 0, 0), the 'globe-isles'
     *  layout ([RECORDS]). Every vertex array uses the exploration layer's layout id: the same attributes, so the same
     *  (program, state) pair, and the near draw needs no rehearsal of its own. */
    fun build(core: Gl3Core) {
        val gl = core.gl
        val quad = gl.genBuffer(); val inst = gl.genBuffer()
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quad); gl.bufferData(GL20.GL_ARRAY_BUFFER, QUAD.size * 4, floats(QUAD), GL20.GL_STATIC_DRAW)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, inst); gl.bufferData(GL20.GL_ARRAY_BUFFER, RECORDS.size * 4, floats(RECORDS), GL20.GL_STATIC_DRAW)
        for (k in vaos.indices) {
            val v = core.vertexArray(ExplorationIslandLayer.LAYOUT_ISLES)
            val at = recordOf(k) * 32
            gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, GL20.GL_FLOAT, false, 0, 0)
            gl.bindBuffer(GL20.GL_ARRAY_BUFFER, inst)
            gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, GL20.GL_FLOAT, false, 32, at); gl.vertexAttribDivisor(1, 1)
            gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, GL20.GL_FLOAT, false, 32, at + 16); gl.vertexAttribDivisor(2, 1)
            vaos[k] = v
        }
        core.bindVertexArray(null)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, 0)
        buffers = intArrayOf(quad, inst)
    }

    /** The islands in one instanced draw from their [LAYER]² layers (the vertex stage culls what faces away or is off
     *  screen), all but the near slot's island, which [drawNear] draws. */
    fun draw(core: Gl3Core) {
        val n = nearIsland
        val v = (if (nearActive) vaos[1 + n] else vaos[0]) ?: return
        core.bindVertexArray(v)
        core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, if (v === vaos[0]) GlobeV2Pin.PHASE_E.size else GlobeV2Pin.PHASE_E.size - 1)
        core.bindVertexArray(null)
    }

    /** The near slot's island from its own texture (bound by the caller at the art unit): false when there is none. */
    fun drawNear(core: Gl3Core): Boolean {
        val n = nearIsland
        if (!nearActive) return false
        val v = vaos[1 + GlobeV2Pin.PHASE_E.size + n] ?: return false
        core.bindVertexArray(v)
        core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, 1)
        core.bindVertexArray(null)
        return true
    }

    /** Is island [island]'s near art resident (a return trip shows it without a build)? */
    fun resident(island: Int): Boolean = slotOf(island)?.let { slotTex[it]?.ready == true } == true

    /** Display island [island]'s resident near art (a return trip): false when it is not resident. */
    fun show(island: Int): Boolean {
        val k = slotOf(island) ?: return false
        if (slotTex[k]?.ready != true) return false
        near = slotTex[k]; nearIsland = island; slotUsed[k] = ++slotClock
        return true
    }

    /** Island [island]'s resident [texture] takes a slot (its own, or the free one its build made room for with
     *  [makeRoom]); it is displayed only once [show] picks it (the renderer shows the island at the view centre). */
    fun store(core: Gl3Core, island: Int, texture: Gl3Texture) {
        var k = slotOf(island) ?: slotTex.indexOfFirst { it == null }.takeIf { it >= 0 }
        if (k == null) { makeRoom(core); k = slotTex.indexOfFirst { it == null } } // never NEAR_SLOTS + 1 at once
        if (slotTex[k] !== texture) core.free(slotTex[k])
        slotTex[k] = texture; slotIsland[k] = island; slotUsed[k] = ++slotClock
    }

    /** A slot is free: a finished build's texture may be reserved at once, evicting nothing. */
    val slotFree: Boolean get() = slotTex.any { it == null }

    /**
     * Make one slot free for a finished build, if one is not already: free the least recently used slot (shown or
     * stored) whose island is not displayed now ([nearIsland]); its island falls back to its [LAYER]² layer. The
     * renderer asks only once the camera has stopped flying and still aims at the build's island (GlobeV2Renderer
     * adoptNear), so the island aimed at is never the victim. False when no slot can go. So a build's texture never
     * makes [NEAR_SLOTS] + 1 near textures stand at once.
     */
    fun makeRoom(core: Gl3Core): Boolean {
        if (slotFree) return true
        var lru = -1
        for (k in slotTex.indices) if (slotIsland[k] != nearIsland && (lru < 0 || slotUsed[k] < slotUsed[lru])) lru = k
        if (lru < 0) return false
        free(core, lru)
        return true
    }

    /** Free every slot but the displayed one (a dive's start: the realm's loads and map never pay for the globe's
     *  spare slot). */
    fun dropSpare(core: Gl3Core) { for (k in slotTex.indices) if (slotIsland[k] != nearIsland) free(core, k) }

    /** Free every slot: the islands fall back to their [LAYER]² layers. */
    fun dropNear(core: Gl3Core) { for (k in slotTex.indices) free(core, k); near = null; nearIsland = -1 }

    private fun free(core: Gl3Core, k: Int) {
        core.free(slotTex[k]); slotTex[k] = null; slotIsland[k] = -1; slotUsed[k] = 0
    }

    private fun slotOf(island: Int): Int? { for (k in slotIsland.indices) if (slotIsland[k] == island && island >= 0) return k; return null }

    private fun forgetSlots() { slotTex.fill(null); slotIsland.fill(-1); slotUsed.fill(0); near = null; nearIsland = -1 }

    /** Forget the GL names of a dead context (never deleted: they belong to it); the layer is off until it reloads. */
    fun lost() { vaos.fill(null); buffers = IntArray(0); fields.fill(null); forgetSlots(); enabled = false }

    /** `glDelete*` of the buffers only (the core deletes vertex arrays and textures): O(1), plan §5.9. */
    fun dispose(core: Gl3Core) {
        for (b in buffers) core.gl.deleteBuffer(b)
        buffers = IntArray(0); vaos.fill(null); forgetSlots(); enabled = false
    }

    companion object {
        /** Each island's far art layer is LAYER² texels: about 53–95 texels per degree of arc over the boxes, 16.8 MB for
         *  the three with mips. Up close a [NEAR] slot takes over for the island the camera is at. */
        const val LAYER = 1024
        /** The near slots' size (plan §5.8 "+1 island art slot"): 106–190 texels per degree over the boxes, about the web
         *  slot art's 144–220, so the island floor (alt 0.1) is not magnified 2–4× as the far layer would be. 22.4 MB
         *  (2048² × 4 B × 4/3) with mips each. */
        const val NEAR = 2048
        /**
         * How many islands keep their [NEAR] art resident (owner 2026-09-27: Seeker → Solana → Seeker must not rebuild).
         * GPU budget (plan §5.8, 140 MB for the globe): 58.5 (the rest of the globe, the N5 figure this file carried)
         * + 16.8 (the three far layers) + 2.4 (the selection fields) = 77.7 MB, plus 22.4 MB per near slot: two slots
         * 122.5 MB (fits), three 144.9 MB (over). So two; the third island shows its far [LAYER]² layer (half the
         * resolution) while its own is built, which then replaces the least recently used one that is neither
         * displayed nor aimed at ([makeRoom], at the time GlobeV2Renderer.adoptNear states). A dive's start (the
         * approach prefetch, or the dive itself) frees the slot not displayed ([dropSpare]), so the realm's loads never
         * run beside two islands' slots.
         */
        const val NEAR_SLOTS = 2
        /** The resample's unit of work: [NEAR] / 32 = 64 bands (small enough that lanes on slow and fast cores even out
         *  and a cancel is seen within one band, a few ms). */
        const val BAND_ROWS = 32
        /** main.js islandArt.bind: the nearest island's slot art is wanted below this altitude (`smooth(1.1, 0.35, alt)`
         *  starts there) and within [NEAR_REACH] of its art width from its centre (`bd < 2.2`, nearest by angle ÷ wDeg). */
        const val NEAR_ALT = 1.1
        const val NEAR_REACH = 2.2
        /** The art is box-reduced by a whole factor k before the resample, and k is at least what keeps the reduced art's
         *  longest side within ART_CAP × the layer: the resample's heap stays about (1.5 × size)² × 4 B + the layer. */
        const val ART_CAP = 1.5
        /** The islands' label anchors in the published WorldFrame: ANCHOR_BASE + PHASE_E index, after the realms' (the web's
         *  `destinations`: realms first, then NEW_ISLANDS, then DIVINE, one index each). */
        val ANCHOR_BASE: Int = GlobeV2Pin.REALMS.size
        /** composite.mjs islandAt: art up to 6 % of its width outside its rect still answers (the shallows halo). */
        const val MARGIN = 0.06
        /** composite.mjs islandAt: the shallows are 9 land samples 1.8 % of the art's width apart. */
        const val NEAR_STEP = 0.018
        /** composite.mjs islandAt: nothing is painted where the direction is more than ~25.8° from the art's centre. */
        const val DZ_MIN = 0.9
        /** composite.mjs withIsland: the shallows tint and strength. */
        private val TEAL = doubleArrayOf(58.0, 170.0, 190.0)
        const val SHALLOWS = 0.45

        private val QUAD = floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 0f, 1f, 1f, 0f, 1f)

        /** The art frame's axes (main.js islandArt / composite.mjs, rot 0): east0 = (cos lon, 0, −sin lon), north = c × east. */
        fun axes(spec: GlobeIslandSpec, c: DoubleArray, e: DoubleArray, n: DoubleArray) {
            V.dirOf(c, spec.lon, spec.lat)
            V.set(e, cos(spec.lon * V.RAD), 0.0, -kotlin.math.sin(spec.lon * V.RAD))
            V.cross(n, c, e)
        }

        /**
         * The island's box as (rx, ry): the half extents in degrees of longitude and latitude that contain the art's
         * frame (width wDeg, height wDeg × aspect, per-axis angles) plus [MARGIN] of its width on every side. Set-up only.
         */
        fun box(spec: GlobeIslandSpec): DoubleArray {
            val c = DoubleArray(3); val e = DoubleArray(3); val n = DoubleArray(3); val d = DoubleArray(3)
            axes(spec, c, e, n)
            val hu = spec.wDeg / 2 + MARGIN * spec.wDeg; val hv = spec.wDeg * spec.aspect / 2 + MARGIN * spec.wDeg
            var rx = 0.0; var ry = 0.0
            val steps = 128
            for (s in 0..steps) for (side in 0 until 4) {
                val k = -1 + 2.0 * s / steps
                val u = if (side < 2) (if (side == 0) -hu else hu) else k * hu
                val v = if (side < 2) k * hv else (if (side == 2) -hv else hv)
                val tu = tan(u * V.RAD); val tv = tan(v * V.RAD)
                V.norm(d, V.set(d, c[0] + e[0] * tu + n[0] * tv, c[1] + e[1] * tu + n[1] * tv, c[2] + e[2] * tu + n[2] * tv))
                rx = max(rx, abs(((V.lon(d) - spec.lon + 540) % 360) - 180)); ry = max(ry, abs(V.lat(d) - spec.lat))
            }
            return doubleArrayOf(rx * 1.01, ry * 1.01)
        }

        /**
         * The instance records (GLOBE_ISLES_VS aIsle/aSlot: lon, lat, rx, ry of the island's box, then layer, 0, 0, 0):
         * the three islands at their layers; for each island i the two others (the far draw while i has the near slot);
         * then each island alone at layer 0 (the near slot's texture).
         */
        val RECORDS: FloatArray = run {
            val n = GlobeV2Pin.PHASE_E.size
            val boxes = GlobeV2Pin.PHASE_E.map { box(it) }
            val order = ArrayList<IntArray>() // (island, layer)
            for (i in 0 until n) order += intArrayOf(i, i)
            for (i in 0 until n) for (j in 0 until n) if (j != i) order += intArrayOf(j, j)
            for (i in 0 until n) order += intArrayOf(i, 0)
            FloatArray(order.size * 8).also { d ->
                order.forEachIndexed { r, (i, layer) ->
                    val s = GlobeV2Pin.PHASE_E[i]; val b = boxes[i]
                    d[r * 8] = s.lon.toFloat(); d[r * 8 + 1] = s.lat.toFloat(); d[r * 8 + 2] = b[0].toFloat(); d[r * 8 + 3] = b[1].toFloat(); d[r * 8 + 4] = layer.toFloat()
                }
            }
        }
        /** The first record of vertex array [k] (0: all; 1 + i: all but i; 1 + n + i: i alone). */
        private fun recordOf(k: Int): Int {
            val n = GlobeV2Pin.PHASE_E.size
            return when { k == 0 -> 0; k <= n -> n + (k - 1) * (n - 1); else -> n + n * (n - 1) + (k - 1 - n) }
        }

        /** The art's reduction factor for a [size]² layer: the whole factor that brings the art near the layer's finest
         *  density (texels per degree of arc), and at least what keeps its longest side within [ART_CAP] × [size]. */
        fun reduction(spec: GlobeIslandSpec, w: Int, h: Int, size: Int): Int {
            val b = box(spec)
            val artPerDeg = w / spec.wDeg
            val outPerDeg = max(size / (2 * b[1]), size / (2 * b[0] * cos(spec.lat * V.RAD)))
            return max(max(1, floor(artPerDeg / outPerDeg).toInt()), ceil(max(w, h) / (ART_CAP * size)).toInt())
        }

        /**
         * One island's layer: [size]² premultiplied RGBA8 over its [box], row 0 at the box's north edge (the shader's
         * `cell.y` grows southward), texel centres at (i + ½)/size. The art [rgba] (straight alpha, [w]×[h], the pack's
         * `<id>.webp`) is read at 1/k ([reduction]): the art itself when k = 1, else its k×k box average, premultiplied at
         * 8 bits (composite.mjs pre-filters its copies likewise). Each texel is composite.mjs islandAt + withIsland over
         * transparent sea: the art's alpha-weighted bilinear colour inside its rect, and where the art is under half opaque
         * the shallows (9 land samples [NEAR_STEP] of the width apart; land = alpha > 128 and not composite's water colour)
         * tint 45 % teal. As premultiplied (C, A) over the sea s: s·(1 − A) + C = composite's withIsland(s).
         *
         * Heap: the layer ([size]² × 4 B) plus, when k > 1, the reduced art (at most ([ART_CAP] × [size])² × 4 B), the
         * art's land as one bit a texel (≤ 0.6 MB) and one sine and cosine per column. The pack art (1819×2489, 2048×2051,
         * 2048×1436) takes about 8–9 MB here at [LAYER] and the layer alone (16.8 MB) at [NEAR] (the decoded art is the
         * caller's).
         */
        fun resample(spec: GlobeIslandSpec, rgba: ByteArray, w: Int, h: Int, size: Int): ByteArray =
            resample(spec, rgba, w, h, size, null, 1) { false }!!

        /**
         * [resample] in bands of [BAND_ROWS] rows, on the calling thread and up to [lanes] − 1 tasks of [helpers]
         * (owner 2026-09-27: "solana island and divine and seeker island takes long time to load"; the 2048² near
         * resample was the whole wait, about 0.5 s on an M3 and an estimated 2–4 s on the Seeker, one thread). Every
         * lane claims the next band from one counter, so a busy or absent pool only means fewer lanes, and the caller
         * waits only for bands a helper has already claimed (never for a queued task: no deadlock on a shared pool).
         * [cancelled] is polled between bands; true returns null (the camera left the island). Nothing a lane throws
         * escapes it (review 2026-09-27: an OutOfMemoryError on a helper reached the host's world-isle uncaught
         * handler, which drops the whole world to the legacy globe): the first one stops every lane at its next band and
         * is rethrown here, on the calling thread, once no lane still writes, so the caller's own failure handling
         * costs only this island's art.
         *
         * Bit-exact to the per-texel form (GlobeContentTest pins it against the reference): the column sines and
         * cosines and each row's are the same `sin`/`cos` of the same angles as `V.dirOf`, multiplied in its order, and
         * the land bits are the same test, made once per art texel instead of nine times per layer texel.
         */
        fun resample(spec: GlobeIslandSpec, rgba: ByteArray, w: Int, h: Int, size: Int, helpers: Executor?, lanes: Int,
                     cancelled: () -> Boolean): ByteArray? {
            require(rgba.size == w * h * 4) { "${spec.id} art is ${rgba.size} bytes, not ${w}x$h" }
            val plan = Resample(spec, rgba, w, h, size)
            val bands = (size + BAND_ROWS - 1) / BAND_ROWS
            val next = AtomicInteger(0)
            val lock = Object()
            var active = 0; var closed = false
            var failure: Throwable? = null
            fun work() {
                synchronized(lock) { if (closed) return; active++ }
                try {
                    val px = DoubleArray(4)
                    while (!cancelled()) {
                        val b = next.getAndIncrement()
                        if (b >= bands) break
                        plan.rows(b * BAND_ROWS, minOf(size, (b + 1) * BAND_ROWS), px)
                    }
                } catch (t: Throwable) {
                    // never out of a helper's task (its thread's uncaught handler fails the world): kept for the caller
                    synchronized(lock) { if (failure == null) failure = t }
                    next.set(bands) // the other lanes claim nothing more
                } finally { synchronized(lock) { active--; lock.notifyAll() } }
            }
            if (helpers != null) for (k in 1 until lanes) {
                try { helpers.execute { work() } } catch (e: RejectedExecutionException) { break }
            }
            work()
            synchronized(lock) {
                closed = true // a helper task that starts from here on finds nothing to do
                try { while (active > 0) lock.wait() }
                catch (e: InterruptedException) { Thread.currentThread().interrupt(); return null }
                failure?.let { throw it } // a band may be missing: never a partial layer
            }
            return if (cancelled() || next.get() < bands) null else plan.out
        }

        /** The per-island set-up of [resample] and its row bands (each lane writes only its own rows of [out]). */
        private class Resample(private val spec: GlobeIslandSpec, rgba: ByteArray, w: Int, h: Int, private val size: Int) {
            private val b = box(spec)
            private val art = Reduced(rgba, w, h, reduction(spec, w, h, size))
            private val kw = art.w; private val kh = art.h
            private val c = DoubleArray(3); private val e = DoubleArray(3); private val n = DoubleArray(3)
            private val hDeg = spec.wDeg * spec.aspect
            private val margin = kw * MARGIN
            private val step = max(1, (kw * NEAR_STEP).roundToInt())
            private val land = java.util.BitSet(kw * kh).also { for (t in 0 until kw * kh) if (art.land(t)) it.set(t) }
            private val sinLon = DoubleArray(size); private val cosLon = DoubleArray(size)
            val out = ByteArray(size * size * 4)

            init {
                axes(spec, c, e, n)
                for (i in 0 until size) {
                    val lon = spec.lon + b[0] * ((i + 0.5) / (size / 2.0) - 1)
                    sinLon[i] = kotlin.math.sin(lon * V.RAD); cosLon[i] = cos(lon * V.RAD)
                }
            }

            fun rows(j0: Int, j1: Int, px: DoubleArray) {
                for (j in j0 until j1) {
                    val lat = spec.lat + b[1] * (1 - (j + 0.5) / (size / 2.0))
                    val cl = cos(lat * V.RAD); val sl = kotlin.math.sin(lat * V.RAD)
                    for (i in 0 until size) texel(i, j, cl * sinLon[i], sl, cl * cosLon[i], px)
                }
            }

            private fun texel(i: Int, j: Int, d0: Double, d1: Double, d2: Double, px: DoubleArray) {
                val dz = d0 * c[0] + d1 * c[1] + d2 * c[2]
                if (dz < DZ_MIN) return
                val u = atan((d0 * e[0] + d1 * e[1] + d2 * e[2]) / dz) / V.RAD; val v = atan((d0 * n[0] + d1 * n[1] + d2 * n[2]) / dz) / V.RAD
                val fx = (u / spec.wDeg + 0.5) * kw; val fy = (0.5 - v / hDeg) * kh
                if (fx < -margin || fy < -margin || fx > kw + margin || fy > kh + margin) return
                var near = 0
                val cx = floor(fx).toInt(); val cy = floor(fy).toInt()
                for (dy in -1..1) for (dx in -1..1) {
                    val xx = cx + dx * step; val yy = cy + dy * step
                    if (xx >= 0 && yy >= 0 && xx < kw && yy < kh && land.get(yy * kw + xx)) near++
                }
                val inside = fx >= 0 && fy >= 0 && fx < kw && fy < kh
                if (inside) {
                    val bx = V.clamp(fx - 0.5, 0.0, kw - 1.001); val by = V.clamp(fy - 0.5, 0.0, kh - 1.001)
                    val xa = floor(bx).toInt(); val ya = floor(by).toInt(); val tx = bx - xa; val ty = by - ya
                    val t00 = ya * kw + xa; val t10 = ya * kw + minOf(kw - 1, xa + 1)
                    val t01 = minOf(kh - 1, ya + 1) * kw + xa; val t11 = minOf(kh - 1, ya + 1) * kw + minOf(kw - 1, xa + 1)
                    for (ch in 0 until 4) px[ch] = (art.pm(t00, ch) * (1 - tx) + art.pm(t10, ch) * tx) * (1 - ty) + (art.pm(t01, ch) * (1 - tx) + art.pm(t11, ch) * tx) * ty
                } else px.fill(0.0)
                // premultiplied art colour = rgb · a (composite's alpha-weighted colour times its alpha)
                val a = px[3] / 255; val cr = px[0]; val cg = px[1]; val cb = px[2]
                val hk = if (near > 0 && a < 0.5) SHALLOWS * near / 9 else 0.0
                val alpha = hk + a - hk * a
                if (alpha <= 0.0) return
                val o = (j * size + i) * 4
                out[o] = (TEAL[0] * hk * (1 - a) + cr).roundToInt().coerceIn(0, 255).toByte()
                out[o + 1] = (TEAL[1] * hk * (1 - a) + cg).roundToInt().coerceIn(0, 255).toByte()
                out[o + 2] = (TEAL[2] * hk * (1 - a) + cb).roundToInt().coerceIn(0, 255).toByte()
                out[o + 3] = (alpha * 255).roundToInt().coerceIn(0, 255).toByte()
            }
        }

        /**
         * The art at 1/[k] as premultiplied 8-bit texels ([w]×[h] of them): with k = 1 the straight-alpha art itself,
         * premultiplied as it is read (no copy); else its k×k box average (4 B a texel). [pm] is 0..255 premultiplied
         * rgb, or the alpha for channel 3.
         */
        private class Reduced(private val rgba: ByteArray, sw: Int, sh: Int, k: Int) {
            val w = sw / k; val h = sh / k
            private val box: ByteArray? = if (k == 1) null else ByteArray(w * h * 4).also { out ->
                val nk = k * k
                for (y in 0 until h) for (x in 0 until w) {
                    var r = 0; var g = 0; var bl = 0; var a = 0
                    for (yy in 0 until k) for (xx in 0 until k) {
                        val i = ((y * k + yy) * sw + x * k + xx) * 4
                        val al = rgba[i + 3].toInt() and 0xFF
                        r += (rgba[i].toInt() and 0xFF) * al; g += (rgba[i + 1].toInt() and 0xFF) * al; bl += (rgba[i + 2].toInt() and 0xFF) * al; a += al
                    }
                    val o = (y * w + x) * 4
                    out[o] = ((r + 255 * nk / 2) / (255 * nk)).toByte(); out[o + 1] = ((g + 255 * nk / 2) / (255 * nk)).toByte()
                    out[o + 2] = ((bl + 255 * nk / 2) / (255 * nk)).toByte(); out[o + 3] = ((a + nk / 2) / nk).toByte()
                }
            }

            fun pm(t: Int, ch: Int): Int {
                val b = box
                if (b != null) return b[t * 4 + ch].toInt() and 0xFF
                val a = rgba[t * 4 + 3].toInt() and 0xFF
                return if (ch == 3) a else ((rgba[t * 4 + ch].toInt() and 0xFF) * a + 127) / 255
            }

            /** composite.mjs islandAt's land: alpha over 128 and not the art's own water colour. */
            fun land(t: Int): Boolean {
                val al = pm(t, 3)
                if (al <= 128) return false
                val sr = pm(t, 0) * 255.0 / al; val sg = pm(t, 1) * 255.0 / al; val sb = pm(t, 2) * 255.0 / al
                return !(sg > 110 && sb > 130 && sr < 110 && sb - sr > 60)
            }
        }

        private fun floats(a: FloatArray) = ByteBuffer.allocateDirect(a.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().put(a).also { it.position(0) }
    }
}
