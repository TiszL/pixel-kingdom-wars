package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.graphics.Color
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** E-8 native ground primitive: the drawable extent — the field plus its edge-clamped margin
 * (`REALM_KIT.edgeExtendTiles`, so a river leaving the field runs on instead of stopping at the far
 * repeat) — is cut into `chunkTiles`² chunks from the extent's origin, each cached as one
 * SpriteBatch vertex array (x, y, packed colour, u, v × 4 per quad) listing the chunk's water → base →
 * overlay cells from the single tileset texture. Layers only overlap inside one tile, so per-chunk
 * layer order equals the global `floorPlan` order. A chunk is rebuilt only when the claim changes
 * (kingdom/ring cells move) or when an animated cell it contains swaps frame; a still chunk is a
 * memcpy per frame. No GL here: the vertex maths is the same one the far repeat quad proved upright. */
class RealmKitChunkCache(val kit: RealmKitManifest, val rendererTilePixels: Double, val chunkTiles: Int = 16) {
    private val rules = kit.rules
    val chunksPerAxis: Int = ceil(rules.extentTiles.toDouble() / chunkTiles).toInt()
    /** Total vertex-array rebuilds since construction (tests pin the rebuild triggers on it). */
    var rebuilds: Int = 0; private set
    /** One build's worst case (every layer on every tile), shared because builds run one at a time on the GL thread. */
    private val scratch = FloatArray(kit.layers.size * chunkTiles * chunkTiles * 20)
    inner class Chunk(val cx: Int, val cy: Int) {
        val tx0 = rules.extentOriginTile + cx * chunkTiles; val ty0 = rules.extentOriginTile + cy * chunkTiles
        val tx1 = min(rules.extentEndTile, tx0 + chunkTiles); val ty1 = min(rules.extentEndTile, ty0 + chunkTiles)
        val bounds = LayeredGroundRect(tx0 * rendererTilePixels, ty0 * rendererTilePixels, (tx1 - tx0) * rendererTilePixels, (ty1 - ty0) * rendererTilePixels)
        var claim: RealmKitClaim? = null; private set
        /** Distinct animated cell ids present after the last build, and the frames they were built at. */
        var animatedCells: IntArray = IntArray(0); private set
        var signature: IntArray = IntArray(0); private set
        var vertices: FloatArray = FloatArray(0); private set
        var quads: Int = 0; private set
        fun signatureAt(elapsedMs: Long, reducedMotion: Boolean) = IntArray(animatedCells.size) { kit.cellFrame(animatedCells[it], elapsedMs, reducedMotion) }
        /** Called for every visible chunk every frame, so it compares in place instead of allocating a signature. */
        fun needsBuild(claim: RealmKitClaim, elapsedMs: Long, reducedMotion: Boolean): Boolean {
            if (this.claim != claim) return true
            for (i in animatedCells.indices) if (kit.cellFrame(animatedCells[i], elapsedMs, reducedMotion) != signature[i]) return true
            return false
        }
        /** A claim change restamps the cells; a frame swap keeps every quad and cell and only moves animated UVs, so it
         * rewrites this chunk's own arrays. Zoomed out a view holds dozens of chunks and the water ones swap every
         * animation frame; a fresh array per rebuild was GC churn on the GL thread. */
        fun build(claim: RealmKitClaim, elapsedMs: Long, reducedMotion: Boolean) {
            val T = rendererTilePixels; val tile = kit.tilePixels.toDouble()
            val textureWidth = kit.tileset.width.toDouble(); val textureHeight = kit.tileset.height.toDouble()
            val animated = if (this.claim != claim) sortedSetOf<Int>() else null
            val out = scratch
            var offset = 0
            for (layer in kit.layers) for (ty in ty0 until ty1) for (tx in tx0 until tx1) {
                val cell = kit.cell(claim, layer.id, tx, ty)
                if (cell == 0) continue
                val c = kit.cells[cell - 1]
                if (c.frames > 1) animated?.add(cell)
                val frame = kit.cellFrame(cell, elapsedMs, reducedMotion)
                val u0 = ((c.x + frame * tile) / textureWidth).toFloat(); val v0 = (c.y / textureHeight).toFloat()
                val u1 = ((c.x + (frame + 1) * tile) / textureWidth).toFloat(); val v1 = ((c.y + tile) / textureHeight).toFloat()
                val x0 = (tx * T).toFloat(); val y0 = (ty * T).toFloat(); val x1 = ((tx + 1) * T).toFloat(); val y1 = ((ty + 1) * T).toFloat()
                fun corner(x: Float, y: Float, u: Float, v: Float) {
                    out[offset] = x; out[offset + 1] = y; out[offset + 2] = Color.WHITE_FLOAT_BITS; out[offset + 3] = u; out[offset + 4] = v; offset += 5
                }
                corner(x0, y0, u0, v0); corner(x0, y1, u0, v1); corner(x1, y1, u1, v1); corner(x1, y0, u1, v0)
            }
            vertices = if (vertices.size == offset) out.copyInto(vertices, 0, 0, offset) else out.copyOf(offset)
            quads = offset / 20
            if (animated != null) { animatedCells = animated.toIntArray(); signature = signatureAt(elapsedMs, reducedMotion) }
            else for (i in animatedCells.indices) signature[i] = kit.cellFrame(animatedCells[i], elapsedMs, reducedMotion)
            this.claim = claim
            rebuilds++
        }
    }
    private val chunks = HashMap<Int, Chunk>()
    fun chunk(cx: Int, cy: Int): Chunk {
        require(cx in 0 until chunksPerAxis && cy in 0 until chunksPerAxis)
        return chunks.getOrPut(cy * chunksPerAxis + cx) { Chunk(cx, cy) }
    }
    /** Chunk coordinates whose tile rect intersects the view, row-major (the order the batch draws them). */
    fun visibleChunks(view: LayeredGroundRect): List<Pair<Int, Int>> {
        require(listOf(view.x, view.y, view.width, view.height).all { it.isFinite() } && view.width > 0 && view.height > 0)
        val span = chunkTiles * rendererTilePixels; val origin = rules.extentOriginTile * rendererTilePixels
        val cx0 = max(0.0, floor((view.x - origin) / span)).toInt(); val cx1 = min(chunksPerAxis.toDouble(), ceil((view.x + view.width - origin) / span)).toInt()
        val cy0 = max(0.0, floor((view.y - origin) / span)).toInt(); val cy1 = min(chunksPerAxis.toDouble(), ceil((view.y + view.height - origin) / span)).toInt()
        val out = mutableListOf<Pair<Int, Int>>()
        for (cy in cy0 until cy1) for (cx in cx0 until cx1) out += cx to cy
        return out
    }
    /** The chunk's current vertex array, rebuilt first when its claim or animation frames changed. */
    fun vertices(cx: Int, cy: Int, claim: RealmKitClaim, elapsedMs: Long, reducedMotion: Boolean): Chunk {
        kit.assertClaim(claim); require(elapsedMs >= 0)
        val chunk = chunk(cx, cy)
        if (chunk.needsBuild(claim, elapsedMs, reducedMotion)) chunk.build(claim, elapsedMs, reducedMotion)
        return chunk
    }
    /** Drop every cached array (a new texture or renderer scale needs fresh UVs). */
    fun clear() { chunks.clear() }
    val cachedChunks: Int get() = chunks.size
}
