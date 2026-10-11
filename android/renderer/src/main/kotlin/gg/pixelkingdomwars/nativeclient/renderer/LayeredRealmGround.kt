package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.graphics.Color
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

/** Versioned layered ground. Never selected through the historical GroundPresentation.
 * Transport bytes must be hashed before worker-side decode. Android WebP decoding
 * supplies straight (unpremultiplied) RGBA; GL receives prepared pixels only. */
data class LayeredGroundRect(val x: Double, val y: Double, val width: Double, val height: Double) {
    fun intersects(b: LayeredGroundRect) = x < b.x + b.width && b.x < x + width && y < b.y + b.height && b.y < y + height
    fun scaled(scale: Double) = LayeredGroundRect(x * scale, y * scale, width * scale, height * scale)
}
data class LayeredGroundAsset(val id: String, val path: String, val sha256: String, val size: Long,
    val width: Int, val height: Int, val frameWidth: Int, val frameHeight: Int, val frameCount: Int,
    val frameDurationMs: Int, val anchorX: Int, val anchorY: Int)
data class LayeredGroundPlacement(val id: String, val asset: String, val bounds: LayeredGroundRect,
    val layer: Int, val phaseFrame: Int, val animated: Boolean)
data class LayeredGroundRepeat(val originX: Double, val originY: Double, val width: Double, val height: Double) {
    /** World-anchored UVs; retain negative coordinates so Repeat wraps both axes. */
    fun uv(view: LayeredGroundRect) = LayeredGroundRect((view.x - originX) / width,
        (view.y - originY) / height, view.width / width, view.height / height)
    /** SpriteBatch vertices are x/y/packed color/u/v. The camera is Y-down;
     * using explicit vertices avoids the texture/region overloads' different V order. */
    fun writeQuad(view: LayeredGroundRect, vertices: FloatArray) {
        require(vertices.size == 20)
        val uv = uv(view)
        fun corner(offset: Int, x: Double, y: Double, u: Double, v: Double) {
            vertices[offset] = x.toFloat(); vertices[offset + 1] = y.toFloat(); vertices[offset + 2] = Color.WHITE_FLOAT_BITS
            vertices[offset + 3] = u.toFloat(); vertices[offset + 4] = v.toFloat()
        }
        corner(0, view.x, view.y, uv.x, uv.y)
        corner(5, view.x, view.y + view.height, uv.x, uv.y + uv.height)
        corner(10, view.x + view.width, view.y + view.height, uv.x + uv.width, uv.y + uv.height)
        corner(15, view.x + view.width, view.y, uv.x + uv.width, uv.y)
    }
    fun scaled(scale: Double) = LayeredGroundRepeat(originX * scale, originY * scale, width * scale, height * scale)
}
data class LayeredGroundExterior(val asset: LayeredGroundAsset, val rect: LayeredGroundRect)
data class LayeredGroundFar(val asset: LayeredGroundAsset, val repeat: LayeredGroundRepeat)
data class LayeredGroundDraw(val id: String, val asset: LayeredGroundAsset, val frame: Int,
    val source: LayeredGroundRect, val destination: LayeredGroundRect, val flipX: Boolean = false, val flipY: Boolean = false, val repeat: LayeredGroundRepeat? = null)

/** Limits are presentation admission, not game mechanics. Active source images
 * total <=16MiB per realm, <=2 realms resident; sequential decode/upload callers
 * must evict an unused realm before acquiring a third and cancel obsolete work. */
class LayeredRealmGround(v: JsonValue, allowedRealms: Set<String> = setOf("frostveil", "elderwood", "sunscar", "crownlands", "seeker-reach", "stormcairn", "thornwake", "cinderfall"), manifestSizeBytes: Int = (v.toJson(JsonWriter.OutputType.json) + "\n").toByteArray(Charsets.UTF_8).size) {
    val realmId = v.getString("realmId")
    val status = v.getString("status")
    val groundRevision: Int
    val centerRect: LayeredGroundRect
    val exterior: LayeredGroundExterior?
    val far: LayeredGroundFar?
    val tilePixels: Int
    val field: LayeredGroundRect
    val protectedFrame: LayeredGroundRect
    val assets: Map<String, LayeredGroundAsset>
    val placements: List<LayeredGroundPlacement>
    val ground: LayeredGroundAsset
    val sampling: String
    val compressedBytes: Long
    val rgbaBytes: Long
    init {
        require(status in setOf("preview-only", "accepted") && realmId in allowedRealms)
        groundRevision = number(v, "groundRevision", 3, 4)
        require(number(v, "schemaVersion", 1, 2) == groundRevision - 2)
        tilePixels = number(v, "tilePixels", 32, 32)
        field = rect(v.get("field")); protectedFrame = rect(v.get("protectedFrame"))
        require(field == LayeredGroundRect(-1088.0, -1088.0, 3136.0, 3136.0))
        // Visual guarantee only: centered clean artwork may grow without changing
        // claims or archived coordinates. Never accept a smaller/moved guarantee.
        require(protectedFrame.width in 1472.0..field.width && protectedFrame.width % tilePixels == 0.0 && protectedFrame.height == protectedFrame.width)
        require(protectedFrame.x == (960.0 - protectedFrame.width) / 2 && protectedFrame.y == protectedFrame.x)
        val rows = v.get("assets"); require(rows.isArray && rows.size in 1..16)
        assets = rows.map { a ->
            val id = a.getString("id"); require(id.matches(Regex("[a-z][a-z0-9-]{0,63}")))
            val hash = a.getString("sha256"); require(hash.matches(Regex("[a-f0-9]{64}")))
            val file = a.getString("path")
            require(file == "atlas/fantasy/layered-ground/assets/$hash.png" || file == "atlas/fantasy/layered-ground/assets/$hash.webp")
            val width = number(a, "width", 1, 2048); val height = number(a, "height", 1, 2048)
            val fw = number(a, "frameWidth", 1, 2048); val fh = number(a, "frameHeight", 1, 2048)
            val count = number(a, "frameCount", 1, 64)
            require(width % fw == 0 && height % fh == 0 && width / fw * (height / fh) == count)
            require(number(a, "reducedMotionFrame", 0, 0) == 0)
            LayeredGroundAsset(id, file, hash, number(a, "size", 1, MAX_COMPRESSED_BYTES.toInt()).toLong(), width, height, fw, fh, count,
                number(a, "frameDurationMs", 50, 10000), number(a.get("anchor"), "x", 0, fw), number(a.get("anchor"), "y", 0, fh))
        }.also { list -> require(list.map { it.id }.distinct().size == list.size && list.map { it.path }.distinct().size == list.size) }.associateBy { it.id }
        compressedBytes = assets.values.sumOf { it.size }; rgbaBytes = assets.values.sumOf { it.width.toLong() * it.height * 4 }
        require(compressedBytes <= MAX_COMPRESSED_BYTES && rgbaBytes <= MAX_RGBA_BYTES)
        ground = requireNotNull(assets[v.get("ground").getString("asset")]); require(ground.frameCount == 1)
        sampling = v.get("ground").getString("sampling"); require(sampling == "repeat" || sampling == "world")
        val g = v.get("ground")
        if (groundRevision == 4) {
            require(sampling == "world" && protectedFrame == LayeredGroundRect(-320.0, -320.0, 1600.0, 1600.0))
            require(manifestSizeBytes > 0 && compressedBytes + manifestSizeBytes <= MAX_COMPRESSED_BYTES)
            centerRect = sceneryRect(g.get("centerRect")); require(contains(centerRect, field))
            val e = g.get("exterior"); val outer = requireNotNull(assets[e.getString("asset")])
            exterior = LayeredGroundExterior(outer, sceneryRect(e.get("rect")))
            require(contains(exterior.rect, centerRect) && outer.frameCount == 1)
            val f = g.get("far"); val material = requireNotNull(assets[f.getString("asset")])
            far = LayeredGroundFar(material, LayeredGroundRepeat(coordinate(f.get("origin"), "x", -16384.0, 16384.0),
                coordinate(f.get("origin"), "y", -16384.0, 16384.0), coordinate(f.get("period"), "width", 32.0, 16384.0),
                coordinate(f.get("period"), "height", 32.0, 16384.0)))
            require(material.frameCount == 1 && material.width.countOneBits() == 1 && material.height.countOneBits() == 1)
            require(setOf(ground.id, outer.id, material.id).size == 3)
        } else { centerRect = field; exterior = null; far = null }
        val places = v.get("placements"); require(places.isArray && places.size <= 1024)
        placements = places.map { p ->
            val id = p.getString("id"); require(id.matches(Regex("[a-z][a-z0-9-]{0,63}")))
            require(p.get("interactive")?.isBoolean == true && !p.getBoolean("interactive") && p.get("animated")?.isBoolean == true)
            val a = requireNotNull(assets[p.getString("asset")]); require(a.id != ground.id && a.id != exterior?.asset?.id && a.id != far?.asset?.id)
            val width = coordinate(p, "width", 1.0, 2048.0); val height = coordinate(p, "height", 1.0, 2048.0)
            val x = coordinate(p, "x", -4096.0, 4096.0) - a.anchorX * width / a.frameWidth
            val y = coordinate(p, "y", -4096.0, 4096.0) - a.anchorY * height / a.frameHeight
            val bounds = LayeredGroundRect(x, y, width, height)
            require(x >= field.x && y >= field.y && x + width <= field.x + field.width && y + height <= field.y + field.height && !bounds.intersects(protectedFrame))
            LayeredGroundPlacement(id, a.id, bounds, number(p, "layer", 0, 15), number(p, "phaseFrame", 0, a.frameCount - 1), p.getBoolean("animated"))
        }.also { list -> require(list.map { it.id }.distinct().size == list.size) }.sortedBy { it.layer }
    }
    /** Actual catalogue presentation uses 64px tiles today; art coordinates use32.
     * Do not assume native world units equal the source art plane. */
    fun floorBounds(rendererTilePixels: Double) = field.scaled(scale(rendererTilePixels))
    /** Complete texels inside the clean guarantee, matching shared inward rounding. */
    fun cleanGroundCrop(): LayeredGroundRect {
        val x = ceil((protectedFrame.x - centerRect.x) * ground.width / centerRect.width)
        val y = ceil((protectedFrame.y - centerRect.y) * ground.height / centerRect.height)
        val width = floor((protectedFrame.x + protectedFrame.width - centerRect.x) * ground.width / centerRect.width) - x
        val height = floor((protectedFrame.y + protectedFrame.height - centerRect.y) * ground.height / centerRect.height) - y
        require(width >= 1 && height >= 1)
        return LayeredGroundRect(x, y, width, height)
    }
    /** Outside the painting both axes use only clean material. Integer source
     * seats stay fixed while panning; neither scenery nor whole clearings repeat. */
    fun floorPlan(rendererTilePixels: Double, view: LayeredGroundRect): List<LayeredGroundDraw> {
        require(listOf(view.x, view.y, view.width, view.height).all { it.isFinite() } && view.width > 0 && view.height > 0)
        if (groundRevision == 4) {
            val scale = scale(rendererTilePixels); val f = requireNotNull(far); val e = requireNotNull(exterior)
            val out = mutableListOf(LayeredGroundDraw("floor-far", f.asset, 0, whole(f.asset), view, repeat = f.repeat.scaled(scale)))
            for ((id, asset, rect) in listOf(Triple("floor-exterior", e.asset, e.rect), Triple("floor-center", ground, centerRect))) {
                val destination = rect.scaled(scale)
                if (destination.intersects(view)) out += LayeredGroundDraw(id, asset, 0, whole(asset), destination)
            }
            return out
        }
        val f = floorBounds(rendererTilePixels); val crop = cleanGroundCrop()
        val ux = f.width / ground.width; val uy = f.height / ground.height
        val x0 = floor(((view.x - f.x) / ux - crop.x) / crop.width)
        val y0 = floor(((view.y - f.y) / uy - crop.y) / crop.height)
        val x1 = ceil(((view.x + view.width - f.x) / ux - crop.x) / crop.width)
        val y1 = ceil(((view.y + view.height - f.y) / uy - crop.y) / crop.height)
        require(listOf(x0, y0, x1, y1).all { it.isFinite() && it in -9007199254740991.0..9007199254740991.0 }
            && (x1 - x0) * (y1 - y0) <= 1024)
        val out = mutableListOf<LayeredGroundDraw>()
        for (y in y0.toLong() until y1.toLong()) for (x in x0.toLong() until x1.toLong()) {
            val tx = crop.x + x * crop.width; val ty = crop.y + y * crop.height
            val bottom = ty + crop.height; val right = tx + crop.width
            val middle = max(ty, 0.0); val middleEnd = minOf(bottom, ground.height.toDouble())
            val parts = listOf(
                LayeredGroundRect(tx, ty, crop.width, minOf(bottom, 0.0) - ty),
                LayeredGroundRect(tx, max(ty, ground.height.toDouble()), crop.width, bottom - max(ty, ground.height.toDouble())),
                LayeredGroundRect(tx, middle, minOf(right, 0.0) - tx, middleEnd - middle),
                LayeredGroundRect(max(tx, ground.width.toDouble()), middle, right - max(tx, ground.width.toDouble()), middleEnd - middle),
            )
            for ((part, p) in parts.withIndex()) {
                if (p.width <= 0 || p.height <= 0) continue
                val destination = LayeredGroundRect(f.x + p.x * ux, f.y + p.y * uy, p.width * ux, p.height * uy)
                if (!destination.intersects(view)) continue
                out += LayeredGroundDraw("floor-$x-$y-$part", ground, 0,
                    LayeredGroundRect(crop.x + p.x - tx, crop.y + p.y - ty, p.width, p.height), destination)
                require(out.size <= 1024)
            }
        }
        if (f.intersects(view)) out += LayeredGroundDraw("floor-c-c", ground, 0,
            LayeredGroundRect(0.0, 0.0, ground.width.toDouble(), ground.height.toDouble()), f)
        require(out.size <= 1024)
        return out
    }
    fun drawPlan(rendererTilePixels: Double, view: LayeredGroundRect, foregroundElapsedMs: Long,
        reducedMotion: Boolean, background: Boolean = false): List<LayeredGroundDraw> {
        if (background) return emptyList()
        val scale = scale(rendererTilePixels); require(foregroundElapsedMs >= 0)
        return placements.mapNotNull { p ->
            val destination = p.bounds.scaled(scale)
            if (!destination.intersects(view)) return@mapNotNull null
            val a = assets.getValue(p.asset)
            val frame = if (reducedMotion || !p.animated) 0 else ((foregroundElapsedMs / a.frameDurationMs % a.frameCount + p.phaseFrame) % a.frameCount).toInt()
            val columns = a.width / a.frameWidth
            LayeredGroundDraw(p.id, a, frame, LayeredGroundRect((frame % columns * a.frameWidth).toDouble(),
                (frame / columns * a.frameHeight).toDouble(), a.frameWidth.toDouble(), a.frameHeight.toDouble()), destination)
        }
    }
    private fun scale(tile: Double): Double { require(tile.isFinite() && tile > 0); return tile / tilePixels }
    companion object {
        const val MAX_COMPRESSED_BYTES = 2L * 1024 * 1024
        const val MAX_RGBA_BYTES = 16L * 1024 * 1024
        const val MAX_RESIDENT_REALMS = 2
        private fun number(v: JsonValue, key: String, lo: Int, hi: Int): Int {
            val n = requireNotNull(v.get(key)); require(n.isLong && n.asLong() in lo.toLong()..hi.toLong())
            return n.asLong().toInt() // range checked as Long before narrowing
        }
        private fun coordinate(v: JsonValue, key: String, lo: Double, hi: Double): Double {
            val n = requireNotNull(v.get(key)); require(n.isNumber)
            return n.asDouble().also { require(it.isFinite() && it in lo..hi) }
        }
        private fun whole(a: LayeredGroundAsset) = LayeredGroundRect(0.0, 0.0, a.width.toDouble(), a.height.toDouble())
        private fun contains(a: LayeredGroundRect, b: LayeredGroundRect) = a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height
        private fun sceneryRect(v: JsonValue) = LayeredGroundRect(coordinate(v, "x", -16384.0, 16384.0), coordinate(v, "y", -16384.0, 16384.0),
            coordinate(v, "width", 1.0, 16384.0), coordinate(v, "height", 1.0, 16384.0))
        private fun rect(v: JsonValue) = LayeredGroundRect(coordinate(v, "x", -4096.0, 4096.0), coordinate(v, "y", -4096.0, 4096.0),
            coordinate(v, "width", 1.0, 4096.0), coordinate(v, "height", 1.0, 4096.0))
    }
}
