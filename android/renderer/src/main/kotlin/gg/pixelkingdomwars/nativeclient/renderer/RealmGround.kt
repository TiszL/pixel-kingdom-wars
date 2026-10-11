package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonValue
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** Realm presentation of a base or battlefield (`visualContext` on the server DTOs). The renderer
 * never guesses it: absent context keeps the pack's declared default, exactly like the web. */
data class RealmVisual(val realmId: String, val artVersion: Int, val groundRevision: Int? = null)

/** The ground a pack can actually draw for a server context. Revision 5 is the realm kit, and a pack pinned from a
 * source older than the kit has no `layeredGroundV5` section. Such a pack presents the same realm at revision 4, the
 * published layered painting it does carry: the rewrite the server applies for a renderer below the kit contract
 * (apps/api `presentVisualContextForClient`). Every other context is returned by reference, so an unknown revision or
 * art generation still fails closed where it did before. */
internal fun presentableGroundVisual(visual: RealmVisual?, kitAvailable: Boolean): RealmVisual? =
    if (visual != null && visual.artVersion == 2 && visual.groundRevision == 5 && !kitAvailable) visual.copy(groundRevision = 4) else visual

data class GroundSource(val path: String, val sha256: String, val size: Long, val width: Int, val height: Int, val color: Int)

/** Authored source-pixel seats; revision admission owns these, never terrain RGB. */
data class GroundEnvironmentFeature(val kind: String, val x: Int, val y: Int, val seed: Long, val width: Int, val height: Int)

/** One art generation (`BASE_GROUND_ART` / `BASE_GROUND_ART_V2`): geometry plus per-realm sources. */
class GroundArt(val artVersion: Int, v: JsonValue) {
    val sourceSize: Int = v.getInt("sourceSize")
    val tilePx: Int = v.getInt("tilePx")
    val plotTiles: Int = v.getInt("plotTiles")
    val edgeBlendPx: Int = v.getInt("edgeBlendPx")
    val worldOriginTiles: Int = v.getInt("worldOriginTiles")
    val worldTiles: Int = v.getInt("worldTiles")
    val manifestPath: String = v.getString("manifestPath")
    val sources: Map<String, GroundSource> = v.get("sources").associate { s ->
        s.name to GroundSource(s.getString("path"), s.getString("sha256"), s.getLong("size"), s.getInt("width"), s.getInt("height"), WallPalette.rgb(s.getString("color")))
    }
    val features: List<GroundEnvironmentFeature>? = v.get("features")?.let { rows ->
        require(rows.isArray) { "Ground features must be source seats" }
        rows.map { seat ->
            require(listOf("x", "y", "seed", "width", "height").all { seat.get(it)?.isLong == true }) { "Ground feature seats must be integers" }
            require(listOf("x", "y").all { seat.getLong(it) in 0 until sourceSize.toLong() } &&
                listOf("width", "height").all { seat.getLong(it) in 1..sourceSize.toLong() }) { "Ground feature extents escape the source plane" }
            GroundEnvironmentFeature(seat.getString("kind"), seat.getInt("x"), seat.getInt("y"), seat.getLong("seed"), seat.getInt("width"), seat.getInt("height"))
        }.also { seats ->
            require(seats.isNotEmpty() && seats.size <= sourceSize)
            require(seats.map { it.seed }.distinct().size == seats.size)
            require(seats.map { it.x to it.y }.distinct().size == seats.size)
            require(seats.all { it.x in 0 until sourceSize && it.y in 0 until sourceSize && it.seed in 1..0xffffffffL && it.width in 1..sourceSize && it.height in 1..sourceSize &&
                it.kind in setOf("water", "ice", "crystal", "vent", "foliage", "waterfall", "dust", "mist") }) { "Invalid authored ground feature" }
            val lo = -worldOriginTiles.toDouble() / worldTiles * sourceSize
            val hi = (plotTiles - worldOriginTiles).toDouble() / worldTiles * sourceSize
            require(seats.all { it.x < lo || it.y < lo || it.x >= hi || it.y >= hi }) { "Scenery accents must leave the building frame clear" }
        }
    }
    init {
        require(sourceSize > 0 && tilePx > 0 && worldTiles > 0 && edgeBlendPx > 0)
        require(sources.values.all { it.width == sourceSize && it.height == sourceSize }) { "Ground painting geometry disagrees with its art version" }
    }
    /** Native game pixels: the world origin and span the crop rule samples against. */
    val start: Int get() = worldOriginTiles * tilePx
    val span: Int get() = tilePx * worldTiles
}

/** The `ground` section: realm ids, defaults, art generations, crop rule inputs and skirt tints. */
class GroundPresentation(section: JsonValue) {
    val realms: List<String> = section.get("realms").map { it.asString() }
    val realmNames: Map<String, String> = section.get("realmNames").associate { it.name to it.asString() }
    val defaultVisual: RealmVisual = visual(section.get("defaultVisual"))
    val currentVisual: RealmVisual = visual(section.get("currentVisual"))
    val campaignRealmByAct: List<String> = section.get("campaignRealmByAct").map { it.asString() }
    val art: Map<Int, GroundArt> = section.get("art").associate { it.name.toInt() to GroundArt(it.name.toInt(), it) }
    val revisions: Map<RealmVisual, GroundArt> = section.get("revisions")?.associate {
        val context = visual(it.get("visual"))
        context to GroundArt(context.artVersion, it.get("art"))
    }.orEmpty()
    val motionFrameMs: Int
    val motionCellTiles: Int
    val motionMaxVisiblePoints: Int
    /** Null on historical contracts, whose ambient marks retain their original world-pixel size. */
    val motionVisibility: GroundMotionVisibility?
    /** realm → (stone tint, other tint) for art version 2; version 1 stays untinted. */
    val skirtTints: Map<String, Pair<Int, Int>> = section.get("skirtTints").associate { it.name to (it.getInt("stone") to it.getInt("other")) }
    init {
        require(section.getInt("version") in 1..2) { "Unsupported ground section" }
        require(realms.isNotEmpty() && realms.toSet().size == realms.size)
        require(art.keys.containsAll(setOf(1, 2))) { "Ground art generations are incomplete" }
        require(art.values.all { it.sources.keys == realms.toSet() }) { "A ground generation misses a realm painting" }
        require(revisions.all { (visual, revision) -> visual.realmId in realms && visual.artVersion in art && visual.groundRevision != null && revision.sources.keys == setOf(visual.realmId) })
        // Layered revisions 3/4 and the revision-5 realm kit live in their own hash-addressed sections, not here.
        require(currentVisual.groundRevision == null || currentVisual in revisions || (currentVisual.artVersion == 2 && currentVisual.groundRevision in setOf(3, 4, 5))) { "Current ground revision is missing its painting" }
        val motion = section.get("motion")
        motionVisibility = if (section.getInt("version") >= 2) GroundMotionVisibility(
            motion.getFloat("minAmbientScreenPx"), motion.getFloat("minStrokeScreenPx"), motion.getFloat("minDriftScreenPx"), motion.getFloat("maxFeatureScale")) else null
        motionFrameMs = motion.getInt("frameMs"); motionCellTiles = motion.getInt("cellTiles"); motionMaxVisiblePoints = motion.getInt("maxVisiblePoints")
        require(motionFrameMs > 0 && motionCellTiles > 0 && motionMaxVisiblePoints >= 0)
        require(art.values.all { it.features == null }) { "Historical ground cannot acquire authored feature seats" }
        require(revisions.all { (visual, revision) ->
            if (visual.groundRevision == 2) revision.features != null && revision.features.size <= motionMaxVisiblePoints
            else revision.features == null
        }) { "Ground feature seats disagree with their immutable revision" }
        require(campaignRealmByAct.all { it in realms } && defaultVisual.realmId in realms && currentVisual.realmId in realms)
        require(skirtTints.keys == realms.toSet())
    }
    private fun visual(v: JsonValue) = RealmVisual(v.getString("realmId"), v.getInt("artVersion"), v.get("groundRevision")?.asInt()).also { require(v.getInt("version") == 1) }
    /** `resolveBaseVisualContext`: unknown or malformed context depicts the default. */
    fun resolve(value: RealmVisual?): RealmVisual =
        if (value != null && value.realmId in realms && value.artVersion in art) {
            if (value in revisions) value else value.copy(groundRevision = null)
        } else defaultVisual
    fun artFor(visual: RealmVisual): GroundArt = resolve(visual).let { revisions[it] ?: art.getValue(it.artVersion) }
    fun sourceFor(visual: RealmVisual): GroundSource = artFor(visual).sources.getValue(resolve(visual).realmId)
    /** `skirtTint`: stone props share one tint, everything else another; v1 art is untinted. */
    fun skirtTint(key: String, visual: RealmVisual?): Int {
        val resolved = resolve(visual)
        if (resolved.artVersion == 1) return 0xffffff
        val (stone, other) = skirtTints.getValue(resolved.realmId)
        return if (key.contains("rock") || key.contains("boulder")) stone else other
    }
}

/** Decoded RGBA painting, `width * height * 4` bytes. */
class GroundPixels(val data: ByteArray, val width: Int, val height: Int) {
    init { require(data.size == width * height * 4) { "Ground pixels must be complete RGBA" } }
}

/** Port of `renderGroundPixels` / `createGroundRaster` (`packages/shared/src/baseVisual.ts`).
 * Coordinates are native game pixels; the source is never wrapped, rotated or mirrored. */
object GroundRaster {
    fun render(source: GroundPixels, art: GroundArt, realmId: String, width: Int, height: Int, originX: Int = 0, originY: Int = 0): ByteArray {
        require(source.width == art.sourceSize && source.height == art.sourceSize) { "Fantasy ground must be complete ${art.sourceSize}×${art.sourceSize} RGBA artwork" }
        require(width in 1..4096 && height in 1..4096) { "Invalid fantasy ground raster bounds" }
        val color = art.sources.getValue(realmId).color
        val channels = intArrayOf(color shr 16 and 255, color shr 8 and 255, color and 255)
        val start = art.start; val span = art.span
        val result = ByteArray(width * height * 4)
        val columns = IntArray(width) { x -> max(0, min(source.width - 1, Math.floorDiv((x + originX - start) * source.width, span))) * 4 }
        val data = source.data
        for (y in 0 until height) {
            val wy = y + originY
            val sy = max(0, min(source.height - 1, Math.floorDiv((wy - start) * source.height, span)))
            val rowBase = sy * source.width * 4
            for (x in 0 until width) {
                val wx = x + originX
                val from = rowBase + columns[x]; val to = (y * width + x) * 4
                // v2 uses authored terrain throughout the world; only frozen v1 contexts keep the skirt.
                if (art.artVersion == 2) {
                    result[to] = data[from]; result[to + 1] = data[from + 1]; result[to + 2] = data[from + 2]; result[to + 3] = -1
                    continue
                }
                val distance = maxOf(0, start - wx, start - wy, wx - start - span + 1, wy - start - span + 1)
                val fade = min(1.0, distance / art.edgeBlendPx.toDouble())
                // Quiet clustered grit, deterministic at every crop origin (Math.imul semantics).
                val hash = (Math.floorDiv(wx, 3) + 431) * 374761393 xor (Math.floorDiv(wy, 3) + 719) * 668265263
                val shade = ((hash xor (hash ushr 13)) and 7) - 3
                for (k in 0 until 3) {
                    val value = Math.round((data[from + k].toInt() and 255) * (1 - fade) + (channels[k] + shade) * fade)
                    result[to + k] = value.coerceIn(0, 255).toByte()
                }
                result[to + 3] = -1
            }
        }
        return result
    }
}

/** A stable world cell mark for the cosmetic `BASE_GROUND_MOTION` overlay. Nothing is simulated. */
class GroundMote(var x: Double, var y: Double, val seed: Long, var feature: String? = null, val width: Double = 0.0, val height: Double = 0.0)

data class GroundMotionVisibility(val minAmbientScreenPx: Float, val minStrokeScreenPx: Float, val minDriftScreenPx: Float, val maxFeatureScale: Float) {
    init { require(listOf(minAmbientScreenPx, minStrokeScreenPx, minDriftScreenPx, maxFeatureScale).all { it.isFinite() && it > 0 }) }
}

sealed class GroundGlyph {
    /** Phaser `lineBetween` with `lineStyle(width, colour, alpha)`. */
    data class Line(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val width: Float, val color: Int, val alpha: Float) : GroundGlyph()
    /** Phaser `strokeEllipse(cx, cy, width, height)`. */
    data class StrokeEllipse(val cx: Float, val cy: Float, val width: Float, val height: Float, val lineWidth: Float, val color: Int, val alpha: Float) : GroundGlyph()
    data class FillEllipse(val cx: Float, val cy: Float, val width: Float, val height: Float, val color: Int, val alpha: Float) : GroundGlyph()
    data class FillRect(val x: Float, val y: Float, val width: Float, val height: Float, val color: Int, val alpha: Float) : GroundGlyph()
    data class FillTriangle(val x0: Float, val y0: Float, val x1: Float, val y1: Float, val x2: Float, val y2: Float, val color: Int, val alpha: Float) : GroundGlyph()
    data class FillCircle(val cx: Float, val cy: Float, val radius: Float, val color: Int, val alpha: Float) : GroundGlyph()
}

/** Port of `FantasyGroundMotion` (`apps/web/src/game/world/fantasyGround.ts`): world-stable motes,
 * decode-time terrain features and the per-realm glyphs drawn every `motion.frameMs`. Code-only
 * per the catalogue (`motionGlyphs.codeOnly`); v1 art has no motion. */
class GroundMotion(private val presentation: GroundPresentation, private val tilePx: Float) {
    /** `groundMotes`: one candidate per motion cell across the authored world, in seed order. */
    fun motes(corner: Int, tiles: Int): MutableList<GroundMote> {
        val cell = presentation.motionCellTiles
        val points = mutableListOf<GroundMote>()
        val lo = corner * tilePx.toDouble(); val hi = (corner + tiles) * tilePx.toDouble()
        val cyStart = floor(corner.toDouble() / cell).toInt(); val cyEnd = ceil((corner + tiles).toDouble() / cell).toInt()
        for (cy in cyStart until cyEnd) for (cx in cyStart until cyEnd) {
            val hash = (cx + 431) * 374761393 xor (cy + 719) * 668265263
            val seed = (hash xor (hash ushr 13)).toLong() and 0xffffffffL
            val x = (cx + (seed and 255) / 256.0) * cell * tilePx
            val y = (cy + ((seed shr 8) and 255) / 256.0) * cell * tilePx
            if (x >= lo && y >= lo && x < hi && y < hi) points += GroundMote(x, y, seed)
        }
        points.sortBy { it.seed }
        return points
    }

    /** `terrainFeature`: colour evidence belongs to presentation only. */
    fun terrainFeature(r: Int, g: Int, b: Int, realm: String): String? = when (realm) {
        "frostveil" -> when {
            r in 70..130 && g - r > 40 && b - g >= 10 && b - g <= 28 -> "water"
            r > 145 && g > r * 1.04 && b > r * 1.05 -> "ice"
            else -> null
        }
        "seeker-reach" -> when {
            (g > 180 && r < g * 0.87 && b >= r) || (b > 190 && r > 160 && b > g * 1.13 && r > g * 0.95) -> "crystal"
            g > 130 && g < 180 && r < g * 0.8 && b > r -> "water"
            else -> null
        }
        "stormcairn" -> if (r in 85..126 && g - r >= 12 && g - r <= 32 && b - g >= 12 && b - g <= 30 && b >= 130) "water" else null
        "cinderfall" -> if (r >= 110 && r - g >= -3 && r - g <= 15 && g - b >= 5 && g - b <= 20) "vent" else null
        else -> if (b > r * 1.15 && g > r * 1.08 && b > g * 0.85 && b + g > 150) "water" else null
    }

    /** `attachTerrainFeatures`: the same affine registration as the pixel sampler. */
    fun attachTerrainFeatures(points: MutableList<GroundMote>, source: GroundPixels, art: GroundArt, realm: String) {
        art.features?.let { features ->
            val scale = art.worldTiles * tilePx.toDouble() / art.sourceSize
            val origin = art.worldOriginTiles * tilePx.toDouble()
            val ambient = points.filter { it.x < 0 || it.y < 0 || it.x >= art.plotTiles * tilePx || it.y >= art.plotTiles * tilePx }
            points.clear()
            points += features.map { GroundMote(origin + it.x * scale, origin + it.y * scale, it.seed, it.kind, it.width * scale, it.height * scale) }
            points += ambient
            return
        }
        val scale = source.width / (art.worldTiles * tilePx.toDouble())
        val origin = art.worldOriginTiles * tilePx.toDouble()
        fun read(x: Int, y: Int): String? {
            if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null
            val at = (y * source.width + x) * 4
            return terrainFeature(source.data[at].toInt() and 255, source.data[at + 1].toInt() and 255, source.data[at + 2].toInt() and 255, realm)
        }
        val offsets = intArrayOf(0, -1, 1)
        val step = presentation.motionCellTiles * tilePx / 3.0
        for (point in points) {
            var found = false
            for (dy in offsets) {
                for (dx in offsets) {
                    val x = point.x + dx * step; val y = point.y + dy * step
                    val sx = floor((x - origin) * scale).toInt(); val sy = floor((y - origin) * scale).toInt()
                    val feature = read(sx, sy)
                    if (feature == null || (feature == "ice" && point.seed % 3 != 0L)) continue
                    val radius = if (feature == "water") 4 else 2
                    val support = listOf(-radius to 0, radius to 0, 0 to -radius, 0 to radius).count { (ox, oy) -> read(sx + ox, sy + oy) == feature }
                    if (support < 3) continue
                    point.x = x; point.y = y; point.feature = feature
                    found = true; break
                }
                if (found) break
            }
        }
    }

    /** `draw` for one mote at the overlay phase (seconds advanced by frameMs per motion frame). */
    fun glyphs(point: GroundMote, phaseSeconds: Double, realm: String, out: MutableList<GroundGlyph>, screenPixelsPerWorldPixel: Float = 1f) {
        require(screenPixelsPerWorldPixel.isFinite() && screenPixelsPerWorldPixel > 0)
        val nativeUnit = tilePx / 32f
        val visibility = presentation.motionVisibility
        val ambientUnit = max(nativeUnit, (visibility?.minAmbientScreenPx ?: 0f) / screenPixelsPerWorldPixel)
        val unit = if (point.feature != null && visibility != null) min(ambientUnit, nativeUnit * visibility.maxFeatureScale) else ambientUnit
        val stroke = max(unit / 2, (visibility?.minStrokeScreenPx ?: 0f) / screenPixelsPerWorldPixel)
        val drift = max(3 * nativeUnit, (visibility?.minDriftScreenPx ?: 0f) / screenPixelsPerWorldPixel)
        val phase = phaseSeconds + (point.seed and 255) / 13.0
        val wave = sin(phase); val pulse = ((sin(phase * 0.7) + 1) / 2).toFloat()
        val px = point.x.toFloat(); val x = (point.x + wave * drift).toFloat(); val y = point.y.toFloat()
        if (point.feature != null && point.width > 0 && point.height > 0) {
            environmentGlyphs(point, stroke, phase, wave.toFloat(), pulse, out); return
        }
        when (point.feature) {
            "water" -> {
                val ripple = ((phase % 4) / 4).toFloat()
                out += GroundGlyph.StrokeEllipse(px, y, (3 + ripple * 8) * unit, (1 + ripple * 3) * unit, stroke, 0xc7fff1, (1 - ripple) * 0.3f)
                out += GroundGlyph.Line(px - 2 * unit, y, px + 2 * unit, y, stroke, 0xe1ffff, pulse * 0.25f)
                return
            }
            "ice" -> {
                out += GroundGlyph.Line(px - 3 * unit, y, px + 3 * unit, y, stroke, 0xecffff, pulse * 0.55f)
                out += GroundGlyph.Line(px, y - 2 * unit, px, y + 2 * unit, stroke, 0xecffff, pulse * 0.55f)
                return
            }
            "crystal" -> {
                out += GroundGlyph.FillTriangle(px, y - 3 * unit, px - 2 * unit, y + unit, px + 2 * unit, y + unit, 0xd8fff0, pulse * 0.3f)
                out += GroundGlyph.Line(px, y - 3 * unit, px, y + 2 * unit, stroke, 0xc9ffef, pulse * 0.45f)
                return
            }
            "vent" -> {
                out += GroundGlyph.FillEllipse(px, y, (5 + pulse * 3) * unit, (2 + pulse) * unit, 0xff9c42, 0.08f + pulse * 0.17f)
                out += GroundGlyph.FillRect(px, y, unit, unit, 0xffd689, pulse * 0.45f)
                return
            }

        }
        when (realm) {
            "frostveil" -> {
                out += GroundGlyph.FillRect(x, y + ((phase % 7) * unit).toFloat(), unit, unit, 0xe4fcff, 0.18f + pulse * 0.25f)
                if ((point.seed and 3) == 0L) {
                    out += GroundGlyph.Line(px - 2 * unit, y, px + 2 * unit, y, stroke, 0xc7f7ff, pulse * 0.4f)
                    out += GroundGlyph.Line(px, y - 2 * unit, px, y + 2 * unit, stroke, 0xc7f7ff, pulse * 0.4f)
                }
            }
            "elderwood", "crownlands" -> out += GroundGlyph.FillEllipse(x, y + (cos(phase * 0.7) * 3 * unit).toFloat(), 2.5f * unit, unit,
                if (realm == "elderwood") 0xeac17b else 0xffe4a0, 0.16f + pulse * 0.2f)
            "sunscar" -> out += GroundGlyph.Line(x - 4 * unit, y, x + 4 * unit, y + (wave * unit).toFloat(), unit, 0xf5deb1, 0.1f + pulse * 0.15f)
            "seeker-reach" -> out += GroundGlyph.FillRect(x, y - pulse * 5 * unit, unit, 2 * unit, if ((point.seed and 1) != 0L) 0x9dffd8 else 0xe2c6ff, 0.15f + pulse * 0.32f)
            "stormcairn" -> {
                val fall = ((phase % 3) * 5 * unit).toFloat()
                out += GroundGlyph.Line(x, y + fall, x - 2 * unit, y + fall + 4 * unit, stroke, 0xc6e7ed, 0.16f + pulse * 0.1f)
            }
            "thornwake" -> out += GroundGlyph.FillCircle(x, y - pulse * 4 * unit, unit * 0.7f, 0xcbffe2, 0.1f + pulse * 0.2f)
            "cinderfall" -> out += GroundGlyph.FillRect(x, y - pulse * 6 * unit, unit, unit, if ((point.seed and 1) != 0L) 0xffb456 else 0xee7449, 0.15f + pulse * 0.32f)
        }
    }

    /** Source-sized landmark accents; no painting resampling or texture upload. */
    private fun environmentGlyphs(point: GroundMote, stroke: Float, phase: Double, wave: Float, pulse: Float, out: MutableList<GroundGlyph>) {
        val x = point.x.toFloat(); val y = point.y.toFloat(); val w = point.width.toFloat(); val h = point.height.toFloat()
        when (point.feature) {
            "water" -> {
                val ripple = ((phase % 4) / 4).toFloat()
                out += GroundGlyph.StrokeEllipse(x, y, w * (0.3f + ripple * 0.6f), h * (0.3f + ripple * 0.6f), stroke, 0xc7fff1, (1 - ripple) * 0.25f)
                out += GroundGlyph.Line(x - w * 0.2f, y, x + w * 0.2f, y, stroke, 0xe1ffff, pulse * 0.25f)
            }
            "ice" -> {
                out += GroundGlyph.Line(x - w * 0.4f, y, x + w * 0.4f, y, stroke, 0xecffff, pulse * 0.5f)
                out += GroundGlyph.Line(x, y - h * 0.4f, x, y + h * 0.4f, stroke, 0xecffff, pulse * 0.5f)
            }
            "crystal" -> {
                out += GroundGlyph.FillTriangle(x, y - h * 0.45f, x - w * 0.3f, y + h * 0.3f, x + w * 0.3f, y + h * 0.3f, 0xd8fff0, pulse * 0.13f)
                out += GroundGlyph.Line(x, y - h * 0.4f, x, y + h * 0.3f, stroke, 0xc9ffef, pulse * 0.4f)
            }
            "vent" -> {
                out += GroundGlyph.FillEllipse(x, y, w * (0.6f + pulse * 0.3f), h * 0.15f, 0xff9c42, 0.06f + pulse * 0.12f)
                out += GroundGlyph.FillEllipse(x + wave * w * 0.15f, y - pulse * h * 0.8f, w * (0.3f + pulse * 0.5f), h * 0.2f, 0xcdb8a2, (1 - pulse) * 0.1f)
            }
            "foliage" -> {
                val bend = wave * w * 0.12f
                for (slot in -1..1) {
                    val offset = slot * 0.25f
                    out += GroundGlyph.Line(x + w * offset, y,
                        x + w * offset + bend, y - h * (0.6f - kotlin.math.abs(offset)), stroke, 0xa6bd78, 0.12f + pulse * 0.14f)
                }
                out += GroundGlyph.FillEllipse(x + bend, y - h * 0.45f, w * 0.3f, h * 0.12f, 0xd8d99a, pulse * 0.16f)
            }
            "waterfall" -> {
                val fall = ((phase % 2) / 2).toFloat()
                for (slot in -1..1) {
                    val offset = slot * 0.25f
                    val top = ((fall + offset + 1) % 1) * 0.7f - 0.45f
                    out += GroundGlyph.Line(x + offset * w, y + top * h, x + offset * w, y + (top + 0.22f) * h, stroke, 0xdcffff, 0.18f + pulse * 0.22f)
                }
            }
            "dust" -> out += GroundGlyph.Line(x - w * 0.4f + wave * w * 0.1f, y,
                x + w * 0.4f + wave * w * 0.1f, y - h * 0.3f, stroke, 0xf5deb1, 0.06f + pulse * 0.1f)
            "mist" -> out += GroundGlyph.FillEllipse(x + wave * w * 0.08f, y - pulse * h * 0.2f,
                w * (0.7f + pulse * 0.2f), h * 0.7f, 0xc9dedc, 0.025f + pulse * 0.04f)
        }
    }

    companion object { const val TWO_PI = 2 * PI }
}

/** Native-pixel window handed to the canonical row writer (`renderGroundPixels` origin and size). */
data class GroundCoverage(val originX: Int, val originY: Int, val width: Int, val height: Int) {
    init { require(width > 0 && height > 0) }
    /** The smallest window holding both, the way `groundCoverageRect` only ever grows a crop outwards. */
    fun union(other: GroundCoverage): GroundCoverage {
        val x = min(originX, other.originX); val y = min(originY, other.originY)
        return GroundCoverage(x, y, max(originX + width, other.originX + other.width) - x, max(originY + height, other.originY + other.height) - y)
    }
}

/** How a resolved realm painting meets the scene. The scene's ground window is the plot plus [skirtTiles]
 * on every side: `BaseScene.drawUnderlay` builds `FantasyGround(-SKIRT / T, (WORLD + SKIRT * 2) / T)` with
 * `SKIRT = BASE_CAMERA.skirtTiles * T`, a catalogue number the scene carries as `camera.skirtTiles` (a
 * fixture without a claim has no camera and no skirt). v1 is rasterised once by the canonical writer over
 * that window; the realm colour shows beyond it. v2 keeps the source texture: the crop rule is clamped
 * nearest-neighbour sampling over the authored world, which a nearest, clamp-to-edge texture reproduces
 * at any zoom, so it is drawn over the whole world plus any window beyond it (the web's
 * `groundPaintLayout` edge extensions). A battlefield's deploy ring therefore lies on painted terrain. */
class GroundPlan(val visual: RealmVisual, val art: GroundArt, val source: GroundSource, plotTiles: Int, skirtTiles: Int, plotMinimum: Int = 0) {
    init { require(plotTiles > 0 && skirtTiles >= 0) { "Invalid ground window" } }
    val rasterised: Boolean get() = art.artVersion == 1
    /** The scene's ground window (plot plus skirt) in native pixels. */
    val window: GroundCoverage = ((plotTiles + 2 * skirtTiles) * art.tilePx).let { size -> GroundCoverage((plotMinimum - skirtTiles) * art.tilePx, (plotMinimum - skirtTiles) * art.tilePx, size, size) }
    /** The rectangle the uploaded pixels span: the raster window (v1) or the authored world (v2). */
    val paint: GroundCoverage = if (rasterised) window else GroundCoverage(art.start, art.start, art.span, art.span)
    /** The rectangle drawn; where it exceeds [paint] a v2 surface repeats its edge pixels. */
    val coverage: GroundCoverage = if (rasterised) window else paint.union(window)
    fun worldBounds(tilePixels: Float): BaseWorldBounds {
        val scale=worldScale(tilePixels)
        return BaseWorldBounds(coverage.originX*scale,coverage.originY*scale,
            (coverage.originX+coverage.width)*scale,(coverage.originY+coverage.height)*scale)
    }
    /** v2 edge pixels fill the live viewport without allocating or stretching the authored world. */
    fun drawBounds(tilePixels: Float, view: BaseWorldBounds): BaseWorldBounds {
        val painted=worldBounds(tilePixels)
        return if(rasterised) painted else BaseWorldBounds(min(painted.left,view.left),min(painted.top,view.top),
            max(painted.right,view.right),max(painted.bottom,view.bottom))
    }
    /** Stable identity of one prepared surface: the same realm, generation and window need no re-decode. */
    val identity: String = "${visual.realmId}@v${visual.artVersion}:r${visual.groundRevision ?: 0}:${source.sha256}:${coverage.originX},${coverage.originY},${coverage.width}x${coverage.height}"
    /** World pixels per native pixel at the scene's tile size (`presentation.worldScale`). */
    fun worldScale(tilePixels: Float): Float = tilePixels / art.tilePx
    /** Texture coordinates of a world rectangle over the painted window; values beyond 0..1 clamp to the edge. */
    fun textureWindow(tilePixels: Float, left: Float, top: Float, right: Float, bottom: Float): FloatArray {
        val scale = worldScale(tilePixels)
        val worldLeft = paint.originX * scale; val worldTop = paint.originY * scale
        val worldWidth = paint.width * scale; val worldHeight = paint.height * scale
        return floatArrayOf((left - worldLeft) / worldWidth, (top - worldTop) / worldHeight, (right - worldLeft) / worldWidth, (bottom - worldTop) / worldHeight)
    }
}

/** `FantasyGroundMotion.onUpdate`: motes inside the camera view plus one tile of margin, capped in
 * seed order so a fully visible map is still covered fairly. */
fun visibleGroundMotes(points: List<GroundMote>, left: Float, top: Float, right: Float, bottom: Float, marginPx: Float, maxVisible: Int): List<GroundMote> {
    if (maxVisible <= 0) return emptyList()
    val out = ArrayList<GroundMote>(minOf(maxVisible, points.size))
    for (point in points) {
        val pad = marginPx + max(point.width, point.height)
        if (point.x >= left - pad && point.y >= top - pad && point.x <= right + pad && point.y <= bottom + pad) {
            out += point
            if (out.size == maxVisible) break
        }
    }
    return out
}

/** The realm's ground colour (RGB) from a render catalogue tree, or null when the pack or the realm does not say. App covers
 *  fade through it (scene-transitions spec §2 BATTLE_FADE: "fade through the target's ground colour"); the renderer clears
 *  to the same colour before its ground exists. Off Main: it parses the catalogue's ground section. */
fun realmGroundColor(catalogue: JsonValue, visual: RealmVisual?): Int? = runCatching {
    visual?.let { RendererCatalogue.ground(catalogue)?.artFor(it)?.sources?.get(it.realmId)?.color }
}.getOrNull()
