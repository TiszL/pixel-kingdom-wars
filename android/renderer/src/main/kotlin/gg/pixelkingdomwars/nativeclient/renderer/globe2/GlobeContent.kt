package gg.pixelkingdomwars.nativeclient.renderer.globe2

import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.renderer.GlobeArt
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.world.ExactPng
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * Where globe bytes come from (plan §6.3): the debug-bundled world content (`AssetManager` `world/…`, NT's bundler) or
 * the active client pack. Called on a decode thread. Same shape as the realm engine's `RealmPackFiles`, so one `:app`
 * class can serve both.
 */
interface GlobeFiles {
    /** The file's bytes, or null when it is absent. */
    fun read(path: String): ByteArray?
    /** The sha256 an outer manifest pins for [path] (`world/content.json`), or null when there is none. */
    fun expectedSha256(path: String): String? = null
}

/** Straight (non-premultiplied) RGBA8, rows from the top. */
class GlobeRgba(val width: Int, val height: Int, val rgba: ByteArray)

/** Decodes an art image (the albedo and cloud WebPs): `:app` implements it with `BitmapFactory` (`inPremultiplied =
 *  false`, `inScaled = false`). Data PNGs never come here (they go through [ExactPng]). */
fun interface GlobeImageDecoder { fun decode(bytes: ByteArray, key: String): GlobeRgba? }

/** Fills one (layer, level) of a texture into [out] (position 0, exactly width × height × bytes per texel). Called on
 *  a decode thread or, by [DirectGlobeUploader], on the GL thread before the first world frame. */
fun interface GlobePixels {
    fun fill(layer: Int, level: Int, width: Int, height: Int, out: ByteBuffer)
    /** This source fills row bands ([fillRows]): a worker uploader may then fill a big level in bands, and asks
     *  nothing of a source that says false (no band buffer is taken for it). A function: a default property getter on
     *  a fun interface does not survive R8 (see the app's PixelSource.decodesRows). */
    fun fillsRows(): Boolean = false
    /** Rows [y0], [y0] + [rows] of one (layer, level) into [out] (position 0, width × rows × bytes per texel), so a
     *  worker uploader can fill a big level in bands; false when this source fills whole levels only. */
    fun fillRows(layer: Int, level: Int, width: Int, y0: Int, rows: Int, out: ByteBuffer): Boolean = false
}

/**
 * How never-sampled textures are filled (plan §5.7). `:app` implements it over `StagingUploader.fresh` (the shared
 * worker context: immutable storage filled off the GL thread, adopted on a fence). [DirectGlobeUploader] is the
 * GL-thread fallback, legal only before the first world frame (Gl3Core refuses a big upload after it).
 */
interface GlobeUploader {
    fun fresh(core: Gl3Core, pool: Gl3Pool, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
              sampling: Gl3Sampling, wrap: Gl3Wrap, pixels: GlobePixels): Gl3Texture?
    /** GL thread, frame start (after `beginFrame`, before any pass): adopt what the worker finished. */
    fun poll(core: Gl3Core) {}
    /** Can this uploader fill a texture after the first world frame (a worker)? The GL-thread fallback cannot. */
    val fillsAfterFirstFrame: Boolean
}

/** The GL-thread fallback: creates and fills at once. Only before the first world frame (and after a context loss,
 *  which resets it); the globe never calls it later. */
class DirectGlobeUploader : GlobeUploader {
    private var scratch: ByteBuffer = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder())
    override val fillsAfterFirstFrame: Boolean get() = false
    override fun fresh(core: Gl3Core, pool: Gl3Pool, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                       sampling: Gl3Sampling, wrap: Gl3Wrap, pixels: GlobePixels): Gl3Texture? {
        if (core.firstWorldFrameDrawn) return null
        val texture = core.array(pool, width, height, layers, format, levels, sampling, wrap) ?: return null
        for (layer in 0 until layers) for (level in 0 until levels) {
            val w = maxOf(1, width shr level); val h = maxOf(1, height shr level); val bytes = w * h * format.bytesPerTexel
            if (scratch.capacity() < bytes) scratch = ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder())
            scratch.clear(); scratch.limit(bytes)
            val view = scratch.slice().order(ByteOrder.nativeOrder())
            pixels.fill(layer, level, w, h, view)
            view.position(0)
            core.upload(texture, layer, level, 0, 0, w, h, view)
        }
        return texture
    }
}

/** A decoded texture: [data][layer][level] tightly packed rows (level 0 first), ready for [GlobePixels]. */
class GlobeTextureData(val width: Int, val height: Int, val format: Gl3Format, val sampling: Gl3Sampling, val wrap: Gl3Wrap,
                       val data: Array<Array<ByteArray>>) {
    val layers: Int get() = data.size
    val levels: Int get() = data[0].size
    val bytes: Long get() = data.sumOf { l -> l.sumOf { it.size.toLong() } }
    val pixels = object : GlobePixels {
        override fun fill(layer: Int, level: Int, width: Int, height: Int, out: ByteBuffer) {
            val src = data[layer][level]
            require(src.size == width * height * format.bytesPerTexel) { "globe texture layer $layer level $level is ${src.size} bytes, not ${width}x$height" }
            out.put(src)
        }
        override fun fillsRows(): Boolean = true
        override fun fillRows(layer: Int, level: Int, width: Int, y0: Int, rows: Int, out: ByteBuffer): Boolean {
            val src = data[layer][level]; val row = width * format.bytesPerTexel
            require(y0 >= 0 && rows > 0 && (y0 + rows) * row <= src.size) { "globe texture layer $layer level $level has no rows $y0+$rows at width $width" }
            out.put(src, y0 * row, rows * row)
            return true
        }
    }
}

/**
 * One Phase E island's near-slot art (PHASE_E index → a one-layer [PhaseEIslandLayer.NEAR]² texture with its mips), built
 * on a decode thread when the camera heads for that island. [cancelled] is polled between steps and resample bands: true
 * (the camera left, another island is wanted, a newer load) returns null, never a partial texture.
 */
fun interface GlobeNearArt { fun build(island: Int, cancelled: () -> Boolean): GlobeNearBuilt? }

/** A built near art and where its time went (decode thread, ms): the verified read and WebP decode, the resample, the
 *  mip chain. The renderer adds the upload and reports all of it ([GlobeEvents.nearArt]). */
class GlobeNearBuilt(val data: GlobeTextureData, val decodeMs: Double = 0.0, val resampleMs: Double = 0.0, val mipMs: Double = 0.0)

/** An exploration island's animated point (production island-effects.mjs), ready for the fx instance buffer. */
class GlobeFxPoints(val count: Int, val dirs: FloatArray, val info: IntArray, val colors: ByteArray)

/**
 * One stage of the globe's content: independent decode [jobs] (a cube face, a selection field, a chain's art) and the
 * [join] that assembles their results once every job has run. Building a batch reads nothing; the renderer runs the
 * jobs across its decode threads ([GlobeFanOut]). Each job writes only its own slot, so jobs may run in any order and
 * on any thread; [join] runs after all of them (the fan-out's counters order the writes before it).
 */
class GlobeBatch<T>(val name: String, val jobs: List<() -> Unit>, private val joinStep: () -> T) {
    fun join(): T = joinStep()
    /** Every job, then the join, on the calling thread (tests and tools). */
    fun runAll(): T { for (j in jobs) j(); return join() }
}

/**
 * Runs a [GlobeBatch]'s jobs on up to [width] tasks of an executor and hands [done] the joined result or the first
 * error, on the thread that finished last. Each task claims jobs from a shared index until none is left, so no thread
 * ever waits for another (a busy or single-threaded pool still completes the batch, only serially). [cancelled] (a
 * superseded load) skips the jobs not yet started. [progress] counts finished jobs for the loading meter.
 */
internal class GlobeFanOut<T>(private val batch: GlobeBatch<T>, private val width: Int, private val cancelled: () -> Boolean,
                              private val progress: java.util.concurrent.atomic.AtomicInteger?, private val done: (T?, Throwable?) -> Unit) {
    private val next = java.util.concurrent.atomic.AtomicInteger(0)
    private val live = java.util.concurrent.atomic.AtomicInteger(0)
    @Volatile private var error: Throwable? = null

    fun start(executor: java.util.concurrent.Executor) {
        val n = maxOf(1, minOf(width, batch.jobs.size))
        live.set(n)
        repeat(n) {
            try { executor.execute { work() } }
            catch (e: java.util.concurrent.RejectedExecutionException) { if (error == null) error = e; exit() }
        }
    }

    private fun work() {
        try {
            while (true) {
                val i = next.getAndIncrement()
                if (i >= batch.jobs.size) break
                if (error != null || cancelled()) continue
                try { batch.jobs[i](); progress?.incrementAndGet() }
                catch (t: Throwable) { if (error == null) error = t } // an OutOfMemoryError too: reported, never a crash
            }
        } finally { exit() }
    }

    private fun exit() {
        if (live.decrementAndGet() != 0) return
        val e = error ?: if (cancelled()) java.util.concurrent.CancellationException("superseded") else null
        if (e != null) { done(null, e); return }
        val result = try { batch.join() } catch (t: Throwable) { done(null, t); return }
        done(result, null)
    }
}

/** What the globe needs for its first frame: the small (a256) albedo cube, sea/shore/glow, clouds, the selection
 *  fields and the frozen geography. */
class GlobeFirst(val albedo: GlobeTextureData, val ssg: GlobeTextureData, val clouds: GlobeTextureData, val selection: GlobeTextureData,
                 val geography: GlobeGeography, val geoms: Array<GlobeRealmGeom>)

/** The 32 exploration islands' art (RG-1): the chains' premultiplied atlas, the full-resolution land bits for picking,
 *  the uploaded cell/atlas size and the animated feature points (null when the pack has no effects file). */
class GlobeIslands(val art: GlobeTextureData, val land: Array<java.util.BitSet>, val cell: Int, val atlas: Int, val fx: GlobeFxPoints?)

/** One Phase E island's selection field (`globe-v2/phase-e/sel-<id>.png`, main.js islandSdf): RG16F texels [rg16f]
 *  ([width] × [height], as the realm fields, with the open sea's rate lifted by [GlobeContent.liftSeaRates]), and its
 *  window half extents in radians (`globe-v2.json` `selection.phaseE[].hu/hv`). */
class GlobePhaseEField(val id: String, val width: Int, val height: Int, val hu: Double, val hv: Double, val rg16f: ByteArray)

/** The Phase E islands' content (D-172, debug world bundles only): one art layer per island ([PhaseEIslandLayer.resample],
 *  premultiplied, mipmapped, PHASE_E order) and the three selection fields. */
class GlobePhaseE(val art: GlobeTextureData, val fields: List<GlobePhaseEField>)

/**
 * The globe's content in stages (fix pass: the first frame never waits for the 1024² cube):
 * - [first]: everything the first frame samples, with the 256² albedo cube (about 1/16 of the 1024² decode);
 * - [albedoHigh]: the 1024² albedo cube, uploaded as a fresh texture after the first frame and swapped in when ready;
 * - [islands]: the exploration islands (chain groups, which may download, and 14 exact PNG decodes), a stage of its own
 *   that the renderer waits for before its first frame (owner 2026-10-06, bounded: GlobeV2Renderer.ISLAND_HOLD_MS) and
 *   shows once their draws are rehearsed; null when there is no island model;
 * - [phaseE]: the Phase E islands (D-172), waited for the same way; its result is null (the layer stays off, RG-3)
 *   unless the world content's `content.json` says `"phaseEIslands": true`;
 * - [phaseENear]: one Phase E island's near-slot art ([GlobeNearArt]), built on a decode thread only when the live
 *   layer asks for it (the camera heads for that island).
 */
class GlobeAssets(val first: GlobeBatch<GlobeFirst>, val albedoHigh: GlobeBatch<GlobeTextureData>?, val islands: GlobeBatch<GlobeIslands>?,
                  val phaseE: GlobeBatch<GlobePhaseE?>? = null, val phaseENear: GlobeNearArt? = null)

class GlobeContentException(message: String) : RuntimeException(message)

/**
 * Reads and decodes the globe's content (plan §6.3; lane NG). Two sources:
 * - [world]: the verified world content root (`world/` in the debug bundle, NT's `tools/world-debug-content.mjs`):
 *   `globe-v2/a256-{f}.webp` (first frame), `globe-v2/a1024-{f}.webp` (after it), `globe-v2/ssg512-{f}.png`,
 *   `globe-v2/sel-<realm>.png`, `baked/c512-{f}.webp`. Every file is hashed against [GlobeFiles.expectedSha256] before
 *   it is decoded; a mismatch refuses that stage (the first stage refuses the globe; a later one only drops its part).
 * - [pack]: the active client pack (already hash-verified at activation by `ContentStore`): the frozen geography masks,
 *   the exploration chains' art and masks, and `native-island-effects.json` (RG-1: the legacy globe's own island art).
 * Data PNGs go through [ExactPng]; the albedo and cloud WebPs through [images]. Mips are built here (box filter; the
 * island art premultiplied by its land alpha), never with glGenerateMipmap. [load] only plans the stages (it reads
 * nothing); their jobs run on decode threads.
 *
 * The Phase E islands (D-172) load only when [world]'s own index (`content.json`, the bundle's root of trust, which the
 * debug bundler writes) carries `"phaseEIslands": true`: then `globe-v2.json` `selection.phaseE`, the three fields and
 * the three `<id>.webp` arts are read, each hashed like every world file. [phaseELayer] is the art layer size. Every
 * Phase E resample (the far layers and a near art) runs on the calling decode thread plus up to [nearLanes] − 1 tasks
 * of [nearHelpers] (the host's low-priority island pool; none: one lane).
 */
class GlobeContent(private val world: GlobeFiles, private val pack: GlobeFiles, private val images: GlobeImageDecoder,
                   private val art: GlobeArt?, private val realmIds: List<String>, private val phaseELayer: Int = PhaseEIslandLayer.LAYER,
                   private val phaseENear: Int = PhaseEIslandLayer.NEAR, private val nearHelpers: java.util.concurrent.Executor? = null,
                   private val nearLanes: Int = 1) {

    /** The staged load (cheap: no file is read here). */
    fun load(): GlobeAssets = GlobeAssets(first(), cube("albedo-1024", "globe-v2/a1024-", ".webp", Gl3Format.RGBA8, art = true), art?.let { islands(it) },
        phaseE(), GlobeNearArt { i, cancelled -> phaseENearArt(GlobeV2Pin.PHASE_E[i], cancelled) })

    private fun first(): GlobeBatch<GlobeFirst> {
        val albedo = cube("albedo-256", "globe-v2/a256-", ".webp", Gl3Format.RGBA8, art = true)
        val ssg = cube("ssg", "globe-v2/ssg512-", ".png", Gl3Format.RG8, art = false)
        val clouds = cube("clouds", "baked/c512-", ".webp", Gl3Format.R8, art = true)
        val selection = selection()
        var geography: GlobeGeography? = null; var geoms: Array<GlobeRealmGeom>? = null
        val geo: () -> Unit = {
            val g = GlobeGeography.fromMasks(packFile(MASK_SURFACE), packFile(MASK_REALM))
                ?: throw GlobeContentException("the frozen geography masks could not be decoded")
            geoms = Array(realmIds.size) { g.realmGeom(it) }
            geography = g
        }
        // the geography (two masks and eight flood fills) first: it is the longest single job
        val jobs = listOf(geo) + selection.jobs + ssg.jobs + clouds.jobs + albedo.jobs
        return GlobeBatch("first", jobs) {
            GlobeFirst(albedo.join(), ssg.join(), clouds.join(), selection.join(), geography!!, geoms!!)
        }
    }

    // ---------------------------------------------------------------- world content (verified)

    private fun worldFile(path: String): ByteArray {
        val bytes = world.read(path) ?: throw GlobeContentException("world content is missing $path")
        val want = world.expectedSha256(path) ?: throw GlobeContentException("world content has no sha256 for $path")
        if (sha256(bytes) != want) throw GlobeContentException("world content $path does not match its sha256")
        return bytes
    }

    private fun packFile(path: String): ByteArray {
        val bytes = pack.read(path) ?: throw GlobeContentException("the client pack is missing $path")
        pack.expectedSha256(path)?.let { if (sha256(bytes) != it) throw GlobeContentException("client pack $path does not match its sha256") }
        return bytes
    }

    private fun rgba(path: String, bytes: ByteArray, art: Boolean): RgbaSource {
        if (!art || path.endsWith(".png")) {
            val png = ExactPng.decode(bytes) ?: throw GlobeContentException("$path is not a PNG the exact decoder accepts")
            return RgbaSource(png.width, png.height, png.rgba)
        }
        val image = images.decode(bytes, path) ?: throw GlobeContentException("$path could not be decoded")
        return RgbaSource(image.width, image.height, image.rgba)
    }

    /** Six faces (+X −X +Y −Y +Z −Z, row 0 = t = −1) into a 6-layer array with a full box-filtered mip chain: one job
     *  per face. */
    private fun cube(name: String, prefix: String, suffix: String, format: Gl3Format, art: Boolean): GlobeBatch<GlobeTextureData> {
        val sizes = IntArray(6)
        val layers = arrayOfNulls<Array<ByteArray>>(6)
        val jobs = List(6) { f -> {
            val path = "$prefix$f$suffix"
            val img = rgba(path, worldFile(path), art)
            if (img.width != img.height) throw GlobeContentException("$path is ${img.width}x${img.height}")
            sizes[f] = img.width
            layers[f] = mipChain(pack(img, format), img.width, img.width, format.bytesPerTexel)
        } }
        return GlobeBatch(name, jobs) {
            for (f in 1 until 6) if (sizes[f] != sizes[0]) throw GlobeContentException("$prefix$f$suffix is ${sizes[f]}², face 0 is ${sizes[0]}²")
            GlobeTextureData(sizes[0], sizes[0], format, Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP, Array(6) { layers[it]!! })
        }
    }

    /**
     * The 8 realm selection fields (art-prep/globe-v2 `sel-*.png`, 8-bit RGB): texel R16F = the half-float whose bits are
     * `(R << 8) | G` (signed outline distance), G16F = `B / 128` (its rate). One layer per realm in REALMS order, one job
     * per realm.
     */
    private fun selection(): GlobeBatch<GlobeTextureData> {
        val ws = IntArray(realmIds.size); val hs = IntArray(realmIds.size)
        val layers = arrayOfNulls<Array<ByteArray>>(realmIds.size)
        val jobs = List(realmIds.size) { r -> {
            val path = "globe-v2/sel-${realmIds[r]}.png"
            val png = ExactPng.decode(worldFile(path)) ?: throw GlobeContentException("$path is not a PNG the exact decoder accepts")
            ws[r] = png.width; hs[r] = png.height
            layers[r] = arrayOf(fieldTexels(png.rgba, png.width * png.height))
        } }
        return GlobeBatch("selection", jobs) {
            for (r in realmIds.indices) if (ws[r] != ws[0] || hs[r] != hs[0]) throw GlobeContentException("globe-v2/sel-${realmIds[r]}.png is ${ws[r]}x${hs[r]}")
            GlobeTextureData(ws[0], hs[0], Gl3Format.RG16F, Gl3Sampling.LINEAR, Gl3Wrap.REPEAT, Array(realmIds.size) { layers[it]!! })
        }
    }

    /** A selection field's 8-bit RGB texels as RG16F: R16F = the half whose bits are `(R << 8) | G`, G16F = `B / 128`. */
    private fun fieldTexels(rgba: ByteArray, n: Int): ByteArray {
        val out = ByteArray(n * 4)
        val bb = ByteBuffer.wrap(out).order(ByteOrder.nativeOrder())
        for (i in 0 until n) {
            val r8 = rgba[i * 4].toInt() and 0xFF; val g8 = rgba[i * 4 + 1].toInt() and 0xFF; val b8 = rgba[i * 4 + 2].toInt() and 0xFF
            bb.putShort(i * 4, ((r8 shl 8) or g8).toShort())
            bb.putShort(i * 4 + 2, Half.bits(b8 / 128f))
        }
        return out
    }

    // ---------------------------------------------------------------- Phase E islands (D-172, debug bundles only)

    private class PhaseEEntry(val file: String, val w: Int, val h: Int, val hu: Double, val hv: Double)

    /**
     * The Phase E stage: per island its field and its art (6 jobs; the batch runs on one decode thread, like the
     * exploration islands, so its large art decodes never take both). Every job first reads the world index's flag (once,
     * shared): without `"phaseEIslands": true` every job is a no-op and the result is null (RG-3).
     */
    private fun phaseE(): GlobeBatch<GlobePhaseE?> {
        val specs = GlobeV2Pin.PHASE_E
        val meta by lazy { phaseEMeta() }
        val fields = arrayOfNulls<GlobePhaseEField>(specs.size)
        val layers = arrayOfNulls<Array<ByteArray>>(specs.size)
        val jobs = specs.indices.flatMap { i -> listOf<() -> Unit>(
            { meta?.let { m -> fields[i] = phaseEField(specs[i].id, m.getValue(specs[i].id)) } },
            { if (meta != null) layers[i] = phaseEArt(specs[i]) },
        ) }
        return GlobeBatch("phase-e", jobs) {
            if (meta == null) null
            else GlobePhaseE(GlobeTextureData(phaseELayer, phaseELayer, Gl3Format.RGBA8, Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP, Array(specs.size) { layers[it]!! }),
                List(specs.size) { fields[it]!! })
        }
    }

    /** Null when the world index does not ask for the islands; else `globe-v2.json` `selection.phaseE`, checked against
     *  the pinned placements (a field built for another placement would outline the wrong coast). */
    private fun phaseEMeta(): Map<String, PhaseEEntry>? {
        val index = world.read(WORLD_INDEX) ?: return null
        if (!phaseEFlag(index)) return null
        val list = JsonReader().parse(String(worldFile(GLOBE_V2_JSON), Charsets.UTF_8)).get("selection")?.get("phaseE")
            ?: throw GlobeContentException("$GLOBE_V2_JSON has no selection.phaseE")
        val out = HashMap<String, PhaseEEntry>()
        for (s in GlobeV2Pin.PHASE_E) {
            val e = list.firstOrNull { it.getString("id", "") == s.id } ?: throw GlobeContentException("$GLOBE_V2_JSON has no field for ${s.id}")
            if (kotlin.math.abs(e.getDouble("lon") - s.lon) > 1e-9 || kotlin.math.abs(e.getDouble("lat") - s.lat) > 1e-9)
                throw GlobeContentException("the ${s.id} field is not at the pinned placement (${e.getDouble("lon")}, ${e.getDouble("lat")})")
            out[s.id] = PhaseEEntry(e.getString("file"), e.getInt("w"), e.getInt("h"), e.getDouble("hu"), e.getDouble("hv"))
        }
        return out
    }

    private fun phaseEField(id: String, e: PhaseEEntry): GlobePhaseEField {
        val path = "globe-v2/${e.file}"
        val png = ExactPng.decode(worldFile(path)) ?: throw GlobeContentException("$path is not a PNG the exact decoder accepts")
        if (png.width != e.w || png.height != e.h) throw GlobeContentException("$path is ${png.width}x${png.height}, $GLOBE_V2_JSON says ${e.w}x${e.h}")
        return GlobePhaseEField(id, png.width, png.height, e.hu, e.hv, liftSeaRates(fieldTexels(png.rgba, png.width * png.height)))
    }

    /** One island's far layer. Its resample runs across the near lanes too (owner 2026-10-06: the far layers now hold the
     *  globe's first frame, so they no longer take one thread's time); the banded resample is bit-exact on any lanes. */
    private fun phaseEArt(spec: GlobeIslandSpec, size: Int = phaseELayer): Array<ByteArray> {
        val path = "${spec.id}.webp"
        val img = rgba(path, worldFile(path), art = true)
        val layer = PhaseEIslandLayer.resample(spec, img.rgba, img.width, img.height, size, nearHelpers, nearLanes) { false }
            ?: throw GlobeContentException("the ${spec.id} art resample was interrupted")
        return mipChain(layer, size, size, 4)
    }

    /** The near slot's art of one island: the same verified `<id>.webp`, resampled at [phaseENear]² (one layer) across
     *  the near lanes, with its mips. Only the renderer's live Phase E layer asks for it, so the world index's flag has
     *  already said yes. Null when [cancelled]. */
    private fun phaseENearArt(spec: GlobeIslandSpec, cancelled: () -> Boolean): GlobeNearBuilt? {
        if (cancelled()) return null
        val t0 = System.nanoTime()
        val base = run {
            val path = "${spec.id}.webp"
            val img = rgba(path, worldFile(path), art = true)
            val t1 = System.nanoTime()
            if (cancelled()) return null
            val out = PhaseEIslandLayer.resample(spec, img.rgba, img.width, img.height, phaseENear, nearHelpers, nearLanes, cancelled) ?: return null
            Triple(out, t1, System.nanoTime())
        }
        if (cancelled()) return null
        val levels = mipChain(base.first, phaseENear, phaseENear, 4)
        val t3 = System.nanoTime()
        return GlobeNearBuilt(GlobeTextureData(phaseENear, phaseENear, Gl3Format.RGBA8, Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP, arrayOf(levels)),
            (base.second - t0) / 1e6, (base.third - base.second) / 1e6, (t3 - base.third) / 1e6)
    }

    // ---------------------------------------------------------------- client pack (exploration islands, RG-1)

    /**
     * One layer per chain: the chain's colour art where its mask says land (mask R = 1), else transparent, premultiplied,
     * at 1/[ISLE_DOWNSCALE] of the pack atlas (the v2 camera never comes closer than the atlas floor, where a 320 px
     * island cell is already minified about 2×), with a box mip chain. The full-resolution land bits stay on the CPU for
     * picking (the legacy rule: a hit counts only on a land texel of the precise mask). One job per chain (a chain read
     * may acquire its content group), plus one for the effects file.
     */
    private fun islands(art: GlobeArt): GlobeBatch<GlobeIslands> {
        val size = art.atlas; val half = size / ISLE_DOWNSCALE
        val lands = arrayOfNulls<java.util.BitSet>(art.chainIds.size)
        val layers = arrayOfNulls<Array<ByteArray>>(art.chainIds.size)
        var fx: GlobeFxPoints? = null
        val jobs = List(art.chainIds.size) { c -> {
            val id = art.chainIds[c]
            val color = ExactPng.decode(packFile("$CHAIN_DIR$id-detail.png")) ?: throw GlobeContentException("chain $id art is not a PNG the exact decoder accepts")
            val mask = ExactPng.decode(packFile("$CHAIN_DIR$id-detail-mask.png")) ?: throw GlobeContentException("chain $id mask is not a PNG the exact decoder accepts")
            if (color.width != size || color.height != size || mask.width != size || mask.height != size) throw GlobeContentException("chain $id atlas is not ${size}²")
            val land = java.util.BitSet(size * size)
            val full = ByteArray(size * size * 4)
            for (i in 0 until size * size) {
                if (mask.rgba[i * 4].toInt() and 0xFF != 1) continue
                land.set(i)
                full[i * 4] = color.rgba[i * 4]; full[i * 4 + 1] = color.rgba[i * 4 + 1]; full[i * 4 + 2] = color.rgba[i * 4 + 2]; full[i * 4 + 3] = -1
            }
            // full is premultiplied (land texels opaque, sea texels all zero), so a plain box keeps it premultiplied
            val base = if (ISLE_DOWNSCALE == 1) full else box(full, size, size, 4)
            lands[c] = land
            layers[c] = mipChain(base, half, half, 4)
        } } + listOf<() -> Unit>({ fx = effects(art) })
        return GlobeBatch("islands", jobs) {
            val data = GlobeTextureData(half, half, Gl3Format.RGBA8, Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP, Array(art.chainIds.size) { layers[it]!! })
            GlobeIslands(data, Array(art.chainIds.size) { lands[it]!! }, art.cell / ISLE_DOWNSCALE, half, fx)
        }
    }

    /** The legacy effects file (production island-effects.mjs export), parsed off the GL thread (plan §3.4). */
    private fun effects(art: GlobeArt): GlobeFxPoints? {
        val bytes = pack.read(art.effectsPath) ?: return null
        val sites = JsonReader().parse(String(bytes, Charsets.UTF_8))
        if (sites.size != art.islands.size) throw GlobeContentException("island effects list ${sites.size} sites for ${art.islands.size} islands")
        val dirs = ArrayList<Float>(); val info = ArrayList<Int>(); val colors = ArrayList<Byte>()
        fun point(lonRad: Double, latRad: Double, kind: Int, u: Int, v: Int, island: Int, rgb: Int) {
            val lon = lonRad * 180 / Math.PI; val lat = latRad * 180 / Math.PI
            val d = V.dirOf(lon, lat)
            dirs += d[0].toFloat(); dirs += d[1].toFloat(); dirs += d[2].toFloat()
            info += kind; info += u; info += v; info += island
            colors += (rgb ushr 16 and 255).toByte(); colors += (rgb ushr 8 and 255).toByte(); colors += (rgb and 255).toByte(); colors += (-1).toByte()
        }
        var island = 0
        var site = sites.child
        while (site != null) {
            var n = 0
            var p = site.get("shore")?.child
            while (p != null) { point(p.getDouble("lon"), p.getDouble("lat"), FX_SHORE, n, 0, island, SHORE_RGB); n++; p = p.next }
            var f = site.get("features")?.child
            while (f != null) {
                val kind = when (f.getString("kind")) { "beacon" -> FX_BEACON; "fall" -> FX_FALL; "vent" -> FX_VENT; "spore" -> FX_SPORE; else -> throw GlobeContentException("unknown island effect ${f.getString("kind")}") }
                val rgb = when (kind) {
                    FX_FALL -> 0xd4f2ed
                    FX_BEACON -> f.getString("tint", if (f.getString("group", "") == "aurora") "d9ecff" else "fff0bd").removePrefix("#").toInt(16)
                    FX_VENT -> 0xffc18a
                    else -> 0xd6e9bb
                }
                var q = f.get("pixels")?.child
                while (q != null) { point(q.getDouble("lon"), q.getDouble("lat"), kind, q.getInt("u", 0), q.getInt("v", 0), island, rgb); q = q.next }
                f = f.next
            }
            island++; site = site.next
        }
        return GlobeFxPoints(info.size / 4, dirs.toFloatArray(), info.toIntArray(), colors.toByteArray())
    }

    private class RgbaSource(val width: Int, val height: Int, val rgba: ByteArray)

    private fun pack(img: RgbaSource, format: Gl3Format): ByteArray {
        val n = img.width * img.height; val bpt = format.bytesPerTexel
        if (bpt == 4) return img.rgba
        val out = ByteArray(n * bpt)
        for (i in 0 until n) for (c in 0 until bpt) out[i * bpt + c] = img.rgba[i * 4 + c]
        return out
    }

    companion object {
        const val MASK_SURFACE = "atlas/fantasy/globe/surface-mask.png"
        const val MASK_REALM = "atlas/fantasy/globe/realm-mask.png"
        const val CHAIN_DIR = "atlas/fantasy/globe/generated/"
        /** The world content's own index (the debug bundle's `world/content.json`) and the flag it may carry (D-172). */
        const val WORLD_INDEX = "content.json"
        const val PHASE_E_FLAG = "phaseEIslands"
        const val GLOBE_V2_JSON = "globe-v2/globe-v2.json"
        /** The island atlas is uploaded at half the pack's resolution (see [isleAtlas]). */
        const val ISLE_DOWNSCALE = 2
        const val FX_SHORE = 0; const val FX_BEACON = 1; const val FX_FALL = 2; const val FX_VENT = 3; const val FX_SPORE = 4
        /** The legacy shore sparkle colour (GlobeIslandEffects: `pixel(p, 0xbbd8d1)`). */
        const val SHORE_RGB = 0xbbd8d1

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        /** The world index's Phase E flag (D-172): true only when [index] (`content.json`) says `"phaseEIslands": true`.
         *  The one reading of it: the Phase E stage and the HUD's island chips both ask here. */
        fun phaseEFlag(index: ByteArray): Boolean = try { JsonReader().parse(String(index, Charsets.UTF_8)).getBoolean(PHASE_E_FLAG, false) }
            catch (e: RuntimeException) { throw GlobeContentException("world $WORLD_INDEX is not JSON: ${e.message}") }

        /** Level 0 plus every box-filtered level down to 1×1. */
        fun mipChain(base: ByteArray, width: Int, height: Int, bpt: Int): Array<ByteArray> {
            val levels = ArrayList<ByteArray>(); levels += base
            var w = width; var h = height; var cur = base
            while (w > 1 || h > 1) { cur = box(cur, w, h, bpt); w = maxOf(1, w / 2); h = maxOf(1, h / 2); levels += cur }
            return levels.toTypedArray()
        }

        /** One 2×2 box step (an odd edge repeats its last texel). Data that is premultiplied (the island art: alpha-0
         *  texels carry rgb 0) averages linearly, so a land edge never bleeds sea colour into a lower level. */
        fun box(src: ByteArray, w: Int, h: Int, bpt: Int): ByteArray {
            val nw = maxOf(1, w / 2); val nh = maxOf(1, h / 2)
            val out = ByteArray(nw * nh * bpt)
            for (y in 0 until nh) for (x in 0 until nw) {
                val x0 = minOf(w - 1, x * 2); val x1 = minOf(w - 1, x * 2 + 1); val y0 = minOf(h - 1, y * 2); val y1 = minOf(h - 1, y * 2 + 1)
                val i00 = (y0 * w + x0) * bpt; val i10 = (y0 * w + x1) * bpt; val i01 = (y1 * w + x0) * bpt; val i11 = (y1 * w + x1) * bpt
                val o = (y * nw + x) * bpt
                for (c in 0 until bpt) out[o + c] = ((src[i00 + c].u() + src[i10 + c].u() + src[i01 + c].u() + src[i11 + c].u() + 2) / 4).toByte()
            }
            return out
        }

        private fun Byte.u(): Int = toInt() and 0xFF

        /** A Phase E field keeps its baked rate where the outline distance is at or above this (the coast: the rim and
         *  keyline sit within about one geography px of the outline at every zoom). */
        const val SEA_RATE_FROM = -0.5f
        /** From this outline distance out the rate is at least 1 ([islandSeaRate]). */
        const val SEA_RATE_FULL = -2f

        /**
         * The rate a Phase E island field keeps at a texel of outline distance [sd] whose baked rate is [rate] (owner
         * 2026-10-06, screenshots 5 and 6: zoomed out, the Seeker and Solana halos were square boxes crossed by dark
         * streaks; zoomed in they were right).
         *
         * The pinned shader (D-168.2, byte for byte the web's) turns the distance into screen pixels as
         * `sd / (0.635 · rate · footprint)` (selFw), so the glow's 9 px body and 30 px tail are as wide as the stored rate
         * says. The builder's rate (art-prep globe-v2 lib.mjs `windowGrad`) is |∇sd| over one geography px with
         * clamp-to-edge reads: on the window's outer ring it is about half the true slope (0.44 to 0.66), and along the
         * sea's centre lines between two coasts (the blurred ridge) it dips to 0.25 to 0.5. Close up the glow lives a few
         * pixels from the coast, where the rate is right. Zoomed out its tail spans the whole window (a 3° margin), so the
         * halved rate on the border ring cut it along the window's rectangle, beyond the window (CLAMP: the border's rate)
         * the shader's slope-1 overshoot fell twice as fast, and the centre lines drew dark streaks.
         *
         * The sea side of the field is a great-circle distance in geography px, slope 1 wherever it is defined, so the
         * open sea keeps at least that rate: unchanged at or above [SEA_RATE_FROM], at least 1 at or below [SEA_RATE_FULL],
         * a smoothstep between. The distances themselves are never changed (the outline, the dimming and the cloud
         * clearing stay the builder's).
         */
        fun islandSeaRate(sd: Float, rate: Float): Float {
            if (!(sd < SEA_RATE_FROM)) return rate
            val t = ((SEA_RATE_FROM - sd) / (SEA_RATE_FROM - SEA_RATE_FULL)).coerceIn(0f, 1f)
            return maxOf(rate, t * t * (3f - 2f * t))
        }

        /** [islandSeaRate] over a field's RG16F texels (native byte order, as [GlobePhaseEField.rg16f]), in place: only a
         *  rate that rises is rewritten, every distance stays bit for bit. Returns [rg16f]. One pass of bit decodes on the
         *  decode thread (no pow), so the islands' load, which holds the globe's first frame, barely notices it. */
        fun liftSeaRates(rg16f: ByteArray): ByteArray {
            val b = ByteBuffer.wrap(rg16f).order(ByteOrder.nativeOrder())
            for (o in 0 until rg16f.size / 4 * 4 step 4) {
                val sd = Half.fast(b.getShort(o).toInt() and 0xFFFF)
                if (!(sd < SEA_RATE_FROM)) continue
                val rate = Half.fast(b.getShort(o + 2).toInt() and 0xFFFF)
                val lifted = islandSeaRate(sd, rate)
                if (lifted > rate) b.putShort(o + 2, Half.bits(lifted))
            }
            return rg16f
        }
    }
}

/** IEEE half-float bits (round to nearest even) for the selection rate channel. */
internal object Half {
    fun bits(v: Float): Short {
        val f = java.lang.Float.floatToIntBits(v)
        val sign = (f ushr 16) and 0x8000
        val exp = ((f ushr 23) and 0xFF) - 127 + 15
        var mant = f and 0x7FFFFF
        if (exp <= 0) {
            if (exp < -10) return sign.toShort()
            mant = mant or 0x800000
            val shift = 14 - exp
            var h = mant shr shift
            val rem = mant and ((1 shl shift) - 1); val halfway = 1 shl (shift - 1)
            if (rem > halfway || (rem == halfway && (h and 1) == 1)) h++
            return (sign or h).toShort()
        }
        if (exp >= 31) return (sign or 0x7C00).toShort()
        var h = (exp shl 10) or (mant shr 13)
        val rem = mant and 0x1FFF
        if (rem > 0x1000 || (rem == 0x1000 && (h and 1) == 1)) h++
        return (sign or h).toShort()
    }

    fun toFloat(bits: Int): Float {
        val s = if (bits and 0x8000 != 0) -1f else 1f
        val e = (bits ushr 10) and 0x1F; val m = bits and 0x3FF
        return when (e) {
            0 -> s * m / 1024f * (1f / 16384f)
            31 -> if (m == 0) s * Float.POSITIVE_INFINITY else Float.NaN
            else -> s * (1 + m / 1024f) * Math.pow(2.0, (e - 15).toDouble()).toFloat()
        }
    }

    /** [toFloat] by assembling the float's bits (exact for every half, signed zeros, infinities and NaN included; no
     *  pow), for a pass over a whole field's texels ([GlobeContent.liftSeaRates]). */
    fun fast(bits: Int): Float {
        val e = (bits ushr 10) and 0x1F; val m = bits and 0x3FF
        val sign = (bits and 0x8000) shl 16
        return when (e) {
            0 -> { val v = m * SUBNORMAL; if (sign != 0) -v else v } // m · 2^-24
            31 -> java.lang.Float.intBitsToFloat(sign or 0x7F800000 or (m shl 13))
            else -> java.lang.Float.intBitsToFloat(sign or ((e + 112) shl 23) or (m shl 13)) // exponent e − 15 + 127
        }
    }

    private const val SUBNORMAL = 1f / 16777216f // 2^-24, a subnormal half's unit
}
