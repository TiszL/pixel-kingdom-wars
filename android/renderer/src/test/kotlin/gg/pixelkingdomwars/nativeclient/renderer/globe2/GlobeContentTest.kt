package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.GlobeArt
import gg.pixelkingdomwars.nativeclient.renderer.GlobeIsland
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32
import java.util.zip.Deflater
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The globe's content path (GLOBE-NATIVE-PLAN §6.3, native CLAUDE.md "content activates only after hash verification"):
 * every world file is hashed before it is decoded and one bad byte refuses its stage; the first frame's stage reads only
 * the small set (the N1 first-frame bar: never the 1024² cube or a chain group, which may download); the selection
 * fields decode to the exact half floats the builder stored; the cube layers keep the builder's face order; mips are
 * box-filtered here (never glGenerateMipmap); the island art is premultiplied so a coast never bleeds sea into its
 * mips; the island effects parse off the GL thread into the fx instances; the fan-out runs every job exactly once.
 */
class GlobeContentTest {
    private val realmIds = GlobeV2Pin.REALMS.map { it.id }

    private class Files(val map: MutableMap<String, ByteArray>, val hashes: Boolean) : GlobeFiles {
        val sha = map.mapValues { GlobeContent.sha256(it.value) }.toMutableMap()
        val reads: MutableList<String> = java.util.Collections.synchronizedList(ArrayList())
        override fun read(path: String): ByteArray? { reads += path; return map[path] }
        override fun expectedSha256(path: String): String? = if (hashes) sha[path] else null
    }

    /** A solid WebP stand-in: the decoder returns a size×size image whose red channel is the face index × 10. */
    private val images = GlobeImageDecoder { bytes, _ -> val size = bytes[0].toInt(); GlobeRgba(size, size, ByteArray(size * size * 4) { i -> if (i % 4 == 0) (bytes[1] * 10).toByte() else if (i % 4 == 3) -1 else 7 }) }

    private fun world(): MutableMap<String, ByteArray> {
        val m = HashMap<String, ByteArray>()
        for (f in 0 until 6) {
            m["globe-v2/a256-$f.webp"] = byteArrayOf(8, f.toByte())
            m["globe-v2/a1024-$f.webp"] = byteArrayOf(16, f.toByte())
            m["baked/c512-$f.webp"] = byteArrayOf(4, f.toByte())
            m["globe-v2/ssg512-$f.png"] = png(4, 4) { x, y -> intArrayOf(if (x < 2) 200 else 40, f * 20 + y, 0) }
        }
        for ((r, id) in realmIds.withIndex()) m["globe-v2/sel-$id.png"] = png(6, 3) { x, y ->
            // half(+2.5) = 0x4100 inside, half(-25.9) ≈ 0xCE7A outside; rate B/128
            if (x == r % 6) intArrayOf(0x41, 0x00, 128) else intArrayOf(0xCE, 0x7A, 64 + y)
        }
        return m
    }

    private fun pack(art: GlobeArt?): MutableMap<String, ByteArray> {
        val m = HashMap<String, ByteArray>()
        m[GlobeContent.MASK_SURFACE] = Goldens.bytes("surface-mask.png"); m[GlobeContent.MASK_REALM] = Goldens.bytes("realm-mask.png")
        if (art != null) {
            for (id in art.chainIds) {
                m["${GlobeContent.CHAIN_DIR}$id-detail.png"] = png(art.atlas, art.atlas) { x, _ -> intArrayOf(200, 100, 50 + x) }
                m["${GlobeContent.CHAIN_DIR}$id-detail-mask.png"] = png(art.atlas, art.atlas) { x, _ -> intArrayOf(if (x < art.atlas / 2) 1 else 0, 0, 0) }
            }
            m[art.effectsPath] = """[{"shore":[{"lon":0.1,"lat":0.2},{"lon":0.11,"lat":0.2}],"features":[{"kind":"fall","pixels":[{"lon":0.1,"lat":0.21,"u":3,"v":4}]},{"kind":"beacon","group":"aurora","pixels":[{"lon":0.1,"lat":0.22}]}]}]""".toByteArray()
        }
        return m
    }

    private fun smallArt() = GlobeArt(listOf("glasswake"), listOf(GlobeIsland(0, 0, 5.7, 11.5, 1.0, 1.0)), 2, 8, 1.12,
        "", 1, 1, emptyList(), "", 1, 1, emptyList(), "atlas/fantasy/globe/native-island-effects.json", 720, 360, { false }, { false }, { _, _ -> false })

    @Test fun `the world content decodes into the builder's layouts`() {
        val assets = GlobeContent(Files(world(), true), Files(pack(null), false), images, null, realmIds).load()
        val a = assets.first.runAll()
        assertEquals(6, a.albedo.layers); assertEquals(8, a.albedo.width, "the first frame samples the small (a256) cube"); assertEquals(4, a.albedo.levels, "8 → 4 → 2 → 1")
        assertEquals(30, a.albedo.data[3][0][0].toInt(), "face 3 is layer 3 (GL order +X −X +Y −Y +Z −Z)")
        assertEquals(Gl3Format.RG8, a.ssg.format); assertEquals(4 * 4 * 2, a.ssg.data[0][0].size)
        assertEquals(200, a.ssg.data[0][0][0].toInt() and 0xFF, "R: sea/shore"); assertEquals(40, a.ssg.data[2][0][1].toInt() and 0xFF, "G: glow")
        assertEquals(Gl3Format.R8, a.clouds.format); assertEquals(20, a.clouds.data[2][0][0].toInt())
        // selection: the half bits are (R << 8) | G, the rate is B / 128
        assertEquals(8, a.selection.layers); assertEquals(Gl3Format.RG16F, a.selection.format)
        val s = ByteBuffer.wrap(a.selection.data[1][0]).order(ByteOrder.nativeOrder())
        assertEquals(2.5f, Half.toFloat(s.getShort(1 * 4).toInt() and 0xFFFF), "inside texel of realm 1")
        assertEquals(1.0f, Half.toFloat(s.getShort(1 * 4 + 2).toInt() and 0xFFFF), "rate 128/128")
        assertTrue(Half.toFloat(s.getShort(0).toInt() and 0xFFFF) < -25f, "outside is clamped far negative")
        assertEquals(0.5f, Half.toFloat(s.getShort(2).toInt() and 0xFFFF), "rate 64/128")
        assertEquals(realmIds.size, a.geoms.size)
        val high = assets.albedoHigh!!.runAll()
        assertEquals(16, high.width, "the late stage is the a1024 cube"); assertEquals(5, high.levels); assertEquals(6, high.layers)
        assertEquals(40, high.data[4][0][0].toInt(), "face 4 is layer 4 in the late cube too")
    }

    @Test fun `the first stage reads only the small set, never the 1024 cube or a chain group`() {
        val art = smallArt()
        val world = Files(world(), true); val pack = Files(pack(art), false)
        val assets = GlobeContent(world, pack, images, art, realmIds).load()
        assertTrue(world.reads.isEmpty() && pack.reads.isEmpty(), "planning the load reads nothing")
        assets.first.runAll()
        val read = (world.reads + pack.reads).toSet()
        assertTrue(read.none { "a1024" in it }, "the 1024² cube is not in the first-frame set: $read")
        assertTrue(read.none { it.startsWith(GlobeContent.CHAIN_DIR) || it == art.effectsPath }, "no chain group or island file before the first frame: $read")
        assertEquals((0 until 6).map { "globe-v2/a256-$it.webp" }.toSet(), read.filter { "a256" in it }.toSet())
        assertEquals(6 + 6 + 6 + realmIds.size + 2, read.size, "a256, ssg512, c512 faces, the selection fields and the two masks")
        assertEquals(1 + realmIds.size + 18, assets.first.jobs.size, "one job per face and field (they run in parallel), the geography one")
        assertEquals(6, assets.albedoHigh!!.jobs.size); assertEquals(art.chainIds.size + 1, assets.islands!!.jobs.size)
    }

    @Test fun `the fan-out runs every job once across threads, joins once, and reports the first error`() {
        val pool = java.util.concurrent.Executors.newFixedThreadPool(2)
        try {
            val runs = java.util.concurrent.atomic.AtomicIntegerArray(40)
            val threads = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
            val ok = GlobeBatch("t", List(40) { i -> { runs.incrementAndGet(i); threads += Thread.currentThread().name; Thread.sleep(2) } }) { (0 until 40).sumOf { runs.get(it) } }
            val done = java.util.concurrent.LinkedBlockingQueue<Any>()
            val progress = java.util.concurrent.atomic.AtomicInteger()
            GlobeFanOut(ok, 2, { false }, progress) { r, e -> done.put(r ?: e!!) }.start(pool)
            assertEquals(40, done.poll(10, java.util.concurrent.TimeUnit.SECONDS), "every job ran exactly once before the join")
            assertEquals(40, progress.get()); assertEquals(2, threads.size, "the jobs spread over both decode threads")
            val bad = GlobeBatch("t", List(10) { i -> { if (i == 3) throw GlobeContentException("face 3 is 7x9") } }) { "joined" }
            GlobeFanOut(bad, 2, { false }, null) { r, e -> done.put(r ?: e!!) }.start(pool)
            val e = done.poll(10, java.util.concurrent.TimeUnit.SECONDS)
            assertTrue(e is GlobeContentException && e.message == "face 3 is 7x9", "the first error, never a join over a missing slot: $e")
            // a pool that runs one task at a time still completes (a worker never waits for another)
            val single = java.util.concurrent.Executors.newSingleThreadExecutor()
            try {
                GlobeFanOut(ok, 2, { false }, null) { r, e2 -> done.put(r ?: e2!!) }.start(single)
                assertEquals(80, done.poll(10, java.util.concurrent.TimeUnit.SECONDS))
            } finally { single.shutdownNow() }
        } finally { pool.shutdownNow() }
    }

    @Test fun `one tampered byte refuses its stage, the first stage the globe and a late one only its part`() {
        val files = world(); val f = Files(files, true)
        files["globe-v2/ssg512-2.png"] = files.getValue("globe-v2/ssg512-2.png").copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }
        assertFailsWith<GlobeContentException> { GlobeContent(f, Files(pack(null), false), images, null, realmIds).load().first.runAll() }
        val unpinned = object : GlobeFiles { override fun read(path: String) = files[path] }
        assertFailsWith<GlobeContentException>("a world file without a pinned sha256 is refused") { GlobeContent(unpinned, Files(pack(null), false), images, null, realmIds).load().first.runAll() }
        val late = world(); val lf = Files(late, true)
        late["globe-v2/a1024-5.webp"] = byteArrayOf(16, 6) // not the pinned bytes
        val assets = GlobeContent(lf, Files(pack(null), false), images, null, realmIds).load()
        assets.first.runAll()
        assertFailsWith<GlobeContentException>("the 1024² cube is refused on its own") { assets.albedoHigh!!.runAll() }
    }

    @Test fun `island art is premultiplied at half size with land bits for picking, and its effects parse`() {
        val art = smallArt()
        val a = GlobeContent(Files(world(), true), Files(pack(art), false), images, art, realmIds).load().islands!!.runAll()
        val isles = a.art
        assertEquals(4, isles.width, "uploaded at half the pack atlas"); assertEquals(1, a.cell); assertEquals(4, a.atlas)
        val l0 = isles.data[0][0]
        for (y in 0 until 4) for (x in 0 until 4) {
            val i = (y * 4 + x) * 4
            if (x >= 2) { for (c in 0 until 4) assertEquals(0, l0[i + c].toInt(), "sea texels are all zero (premultiplied), x=$x") }
            else assertEquals(255, l0[i + 3].toInt() and 0xFF, "land is opaque")
        }
        val top = isles.data[0].last()
        assertTrue(kotlin.math.abs((top[0].toInt() and 0xFF) - 100) <= 1 && kotlin.math.abs((top[3].toInt() and 0xFF) - 128) <= 1,
            "the 1×1 level is half coverage with the colour premultiplied (no sea colour): ${top[0].toInt() and 0xFF}, ${top[3].toInt() and 0xFF}")
        assertTrue(a.land[0].get(0) && !a.land[0].get(7), "full-resolution land bits for the legacy pick rule")
        val fx = a.fx!!
        assertEquals(4, fx.count, "2 shore points + 1 fall + 1 beacon")
        assertEquals(GlobeContent.FX_SHORE, fx.info[0]); assertEquals(1, fx.info[4 + 1], "the shore index rides in u")
        assertEquals(GlobeContent.FX_FALL, fx.info[8]); assertEquals(3, fx.info[9]); assertEquals(4, fx.info[10])
        assertEquals(GlobeContent.FX_BEACON, fx.info[12])
        assertEquals(0xd9, fx.colors[12].toInt() and 0xFF, "an aurora beacon's tint")
    }

    // ---- Phase E islands (D-172 debug bundles; RG-3 everywhere else) ----

    /** The world bundle with the Phase E files the bundler copies: the index with [flag] (null: no index at all), the
     *  builder's globe-v2.json selection.phaseE entries, a field per island and a 24² stand-in art per island. */
    private fun phaseEWorld(flag: Boolean?, placementLat: Double? = null): MutableMap<String, ByteArray> {
        val m = world()
        if (flag != null) m[GlobeContent.WORLD_INDEX] = """{"schema":1,"phaseEIslands":$flag,"files":[]}""".toByteArray()
        val entries = GlobeV2Pin.PHASE_E.mapIndexed { i, s ->
            """{"id":"${s.id}","file":"phase-e/sel-${s.id}.png","w":${5 + i},"h":4,"lon":${s.lon},"lat":${if (i == 0 && placementLat != null) placementLat else s.lat},"hu":0.1${i},"hv":0.2${i}}"""
        }
        m[GlobeContent.GLOBE_V2_JSON] = """{"selection":{"realms":[],"phaseE":[${entries.joinToString(",")}]}}""".toByteArray()
        GlobeV2Pin.PHASE_E.forEachIndexed { i, s ->
            m["globe-v2/phase-e/sel-${s.id}.png"] = png(5 + i, 4) { x, _ -> if (x == 0) intArrayOf(0x41, 0x00, 128) else intArrayOf(0xCE, 0x7A, 64) }
            m["${s.id}.webp"] = byteArrayOf(24, 20) // the stand-in decoder: an opaque 24² image of colour (200, 7, 7)
        }
        return m
    }

    @Test fun `without the world index's flag the Phase E stage reads only the index and yields nothing (RG-3)`() {
        for (flag in listOf(null, false)) {
            val world = Files(phaseEWorld(flag), true)
            val assets = GlobeContent(world, Files(pack(null), false), images, null, realmIds, phaseELayer = 32).load()
            assertTrue(world.reads.isEmpty(), "planning reads nothing")
            assertEquals(null, assets.phaseE!!.runAll(), "flag $flag: the layer stays off")
            assertEquals(listOf(GlobeContent.WORLD_INDEX), world.reads.distinct(), "flag $flag: not one island file is read")
        }
    }

    @Test fun `with the flag the fields decode like the realm fields and each art is resampled into its box with the shallows`() {
        val size = 32
        val pe = GlobeContent(Files(phaseEWorld(true), true), Files(pack(null), false), images, null, realmIds, phaseELayer = size).load().phaseE!!.runAll()!!
        assertEquals(GlobeV2Pin.PHASE_E.map { it.id }, pe.fields.map { it.id })
        for ((i, f) in pe.fields.withIndex()) {
            assertEquals(5 + i, f.width); assertEquals(4, f.height)
            assertEquals(0.1 + i / 100.0, f.hu, 1e-12); assertEquals(0.2 + i / 100.0, f.hv, 1e-12)
            val b = ByteBuffer.wrap(f.rg16f).order(ByteOrder.nativeOrder())
            assertEquals(2.5f, Half.toFloat(b.getShort(0).toInt() and 0xFFFF), "the same (R << 8) | G half as a realm field")
            assertEquals(1.0f, Half.toFloat(b.getShort(2).toInt() and 0xFFFF), "the coast keeps its rate 128/128")
            // Rewritten 2026-10-06 (it pinned the baked 64/128 here): an island's open sea (−25.9) now keeps at least the
            // distance's true slope, so a zoomed-out halo is never cut along the window's rectangle (liftSeaRates). The
            // distance itself stays the builder's half, bit for bit.
            assertEquals(0xCE7A.toShort(), b.getShort(4), "the open sea's distance is untouched")
            assertEquals(1.0f, Half.toFloat(b.getShort(4 + 2).toInt() and 0xFFFF), "the open sea's baked 64/128 is lifted to 1")
        }
        val art = pe.art
        assertEquals(GlobeV2Pin.PHASE_E.size, art.layers); assertEquals(size, art.width); assertEquals(6, art.levels, "32 → 1")
        assertEquals(Gl3Format.RGBA8, art.format)
        for (l in 0 until art.layers) {
            val px = art.data[l][0]
            val c = ((size / 2) * size + size / 2) * 4
            assertEquals(listOf(200, 7, 7, 255), (0 until 4).map { px[c + it].toInt() and 0xFF }, "the box centre is the art, opaque")
            // the shallows: every partly covered texel is composite's teal (58, 170, 190) over the sea, and there are some
            var halo = 0; var clear = 0
            for (t in 0 until size * size) {
                val a = px[t * 4 + 3].toInt() and 0xFF
                if (a == 0) { clear++; for (k in 0 until 3) assertEquals(0, px[t * 4 + k].toInt(), "sea texels are all zero (premultiplied)"); continue }
                if (a == 255) continue
                halo++
                assertTrue(a / 255.0 <= PhaseEIslandLayer.SHALLOWS + 0.01, "a halo is at most 45 % strong: $a")
                val r = (px[t * 4].toInt() and 0xFF) * 255.0 / a; val g = (px[t * 4 + 1].toInt() and 0xFF) * 255.0 / a; val bl = (px[t * 4 + 2].toInt() and 0xFF) * 255.0 / a
                assertTrue(kotlin.math.abs(r - 58) < 12 && kotlin.math.abs(g - 170) < 12 && kotlin.math.abs(bl - 190) < 12, "a halo texel is teal: $r $g $bl")
            }
            assertTrue(halo > 0, "layer $l has the shallows ring"); assertTrue(clear > 0, "layer $l has open sea around the island")
        }
    }

    @Test fun `each island's box holds its whole art frame and margin, and no more than it needs`() {
        for (s in GlobeV2Pin.PHASE_E) {
            val b = PhaseEIslandLayer.box(s)
            val c = DoubleArray(3); val e = DoubleArray(3); val n = DoubleArray(3); val d = DoubleArray(3)
            PhaseEIslandLayer.axes(s, c, e, n)
            val hu = s.wDeg / 2 + PhaseEIslandLayer.MARGIN * s.wDeg; val hv = s.wDeg * s.aspect / 2 + PhaseEIslandLayer.MARGIN * s.wDeg
            var mx = 0.0; var my = 0.0
            for (u in listOf(-hu, 0.0, hu)) for (v in listOf(-hv, 0.0, hv)) {
                val tu = kotlin.math.tan(u * V.RAD); val tv = kotlin.math.tan(v * V.RAD)
                V.norm(d, V.set(d, c[0] + e[0] * tu + n[0] * tv, c[1] + e[1] * tu + n[1] * tv, c[2] + e[2] * tu + n[2] * tv))
                val dx = kotlin.math.abs(((V.lon(d) - s.lon + 540) % 360) - 180); val dy = kotlin.math.abs(V.lat(d) - s.lat)
                assertTrue(dx < b[0] && dy < b[1], "${s.id}: frame point ($u, $v) lies inside the box")
                mx = maxOf(mx, dx); my = maxOf(my, dy)
            }
            assertTrue(b[0] < mx * 1.05 && b[1] < my * 1.05, "${s.id}: a tight box (${b[0]} × ${b[1]} for $mx × $my)")
        }
    }

    @Test fun `a tampered island file or a field built for another placement refuses only the Phase E part`() {
        val tampered = phaseEWorld(true); val files = Files(tampered, true)
        tampered["solana-island.webp"] = byteArrayOf(24, 21) // not the pinned bytes
        val assets = GlobeContent(files, Files(pack(null), false), images, null, realmIds, phaseELayer = 16).load()
        assets.first.runAll() // the globe itself still loads
        assertFailsWith<GlobeContentException> { assets.phaseE!!.runAll() }
        val moved = GlobeContent(Files(phaseEWorld(true, placementLat = 33.0), true), Files(pack(null), false), images, null, realmIds, phaseELayer = 16).load()
        val e = assertFailsWith<GlobeContentException> { moved.phaseE!!.runAll() }
        assertTrue("pinned placement" in e.message!!, e.message)
    }

    /**
     * The critic's Seeker OOM (Rule 12: the old resample was never measured): it box-reduced the pack art into a double
     * per channel (Divine at k = 1: a 90 MiB DoubleArray on a default Android heap, caught by the fan-out as
     * partUnavailable, so the islands silently did not show). The resample now holds the reduced art at 4 B a texel
     * (none at k = 1) and tests land where it reads it. At the pack's real sizes it allocates no more than the layer plus
     * the reduced art: under 12 MB per island for the 1024² far layer and under 20 MB for the 2048² near slot (the layer
     * itself is 16.8 MB). The decoded art is the caller's (the host's BitmapFactory decode) and not counted here.
     */
    @Test fun `the resample's heap stays bounded at the pack's real art sizes, far layer and near slot`() {
        val bean = java.lang.management.ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        org.junit.Assume.assumeTrue(bean.isThreadAllocatedMemorySupported)
        bean.isThreadAllocatedMemoryEnabled = true
        val sizes = mapOf("seeker-island" to intArrayOf(1819, 2489), "solana-island" to intArrayOf(2048, 2051), "divine-isle" to intArrayOf(2048, 1436))
        for (spec in GlobeV2Pin.PHASE_E) {
            val (w, h) = sizes.getValue(spec.id).let { it[0] to it[1] }
            // an opaque green island (land, not the art's water colour) filling the middle of a transparent frame
            val rgba = ByteArray(w * h * 4)
            for (y in 0 until h) for (x in 0 until w) {
                val dx = (x - w / 2.0) / (w * 0.4); val dy = (y - h / 2.0) / (h * 0.4)
                if (dx * dx + dy * dy < 1) { val i = (y * w + x) * 4; rgba[i] = 90; rgba[i + 1] = 150.toByte(); rgba[i + 2] = 60; rgba[i + 3] = -1 }
            }
            for ((size, ceiling) in listOf(PhaseEIslandLayer.LAYER to (12L shl 20), PhaseEIslandLayer.NEAR to (20L shl 20))) {
                val before = bean.currentThreadAllocatedBytes
                val out = PhaseEIslandLayer.resample(spec, rgba, w, h, size)
                val used = bean.currentThreadAllocatedBytes - before
                println("resample ${spec.id} ${w}x$h → $size²: k=${PhaseEIslandLayer.reduction(spec, w, h, size)}, ${"%.1f".format(used / 1048576.0)} MiB allocated")
                assertTrue(used < ceiling, "${spec.id} ${w}x$h at $size²: ${used shr 20} MB allocated (ceiling ${ceiling shr 20} MB)")
                val c = ((size / 2) * size + size / 2) * 4
                assertEquals(listOf(90, 150, 60, 255), (0 until 4).map { out[c + it].toInt() and 0xFF }, "${spec.id} at $size²: the centre is the art")
                var halo = 0
                for (t in 0 until size * size) { val a = out[t * 4 + 3].toInt() and 0xFF; if (a in 1..254) halo++ }
                assertTrue(halo > 0, "${spec.id} at $size²: the shallows ring is there")
            }
        }
    }

    /** Straight-alpha art with every case the resample tells apart: opaque land, the art's own water colour (not land),
     *  half-opaque edges (the shallows ring) and transparent sea, from a fixed seed. */
    private fun islandArt(w: Int, h: Int, seed: Long): ByteArray {
        val r = java.util.Random(seed); val rgba = ByteArray(w * h * 4)
        for (y in 0 until h) for (x in 0 until w) {
            val dx = (x - w / 2.0) / (w * 0.42); val dy = (y - h / 2.0) / (h * 0.42); val d = dx * dx + dy * dy
            val i = (y * w + x) * 4
            val a = when { d < 0.7 -> 255; d < 1.0 -> r.nextInt(256); else -> 0 }
            val water = r.nextInt(5) == 0
            rgba[i] = (if (water) 40 else 60 + r.nextInt(150)).toByte(); rgba[i + 1] = (if (water) 160 else r.nextInt(256)).toByte()
            rgba[i + 2] = (if (water) 200 else r.nextInt(256)).toByte(); rgba[i + 3] = a.toByte()
        }
        return rgba
    }

    /**
     * Owner 2026-09-27 ("solana island and divine and seeker island takes long time to load"): the near resample now runs
     * in row bands across lanes with its trig and land tests made once. It must draw exactly what code 29 drew (the
     * owner approved that look), on one lane or four, whatever pool the lanes come from (a busy or shut one included),
     * for the far layer (k = 2) and the near slot (k = 1).
     */
    @Test fun `the banded resample is bit-exact to code 29's on any number of lanes, at both reduction factors`() {
        val helpers = java.util.concurrent.Executors.newFixedThreadPool(3)
        val refusing = java.util.concurrent.Executor { throw java.util.concurrent.RejectedExecutionException("shut down") }
        try {
            for ((n, spec) in GlobeV2Pin.PHASE_E.withIndex()) {
                val w = 180 + 37 * n; val h = (w * spec.aspect).toInt()
                val rgba = islandArt(w, h, 7L + n)
                for (size in listOf(96, 256)) {
                    val k = PhaseEIslandLayer.reduction(spec, w, h, size)
                    val ref = ResampleReference.resample(spec, rgba, w, h, size)
                    assertTrue(ref.any { it != 0.toByte() }, "${spec.id} at $size: the reference drew something")
                    for ((lanes, pool) in listOf(1 to null, 4 to helpers, 4 to refusing, 2 to helpers)) {
                        val out = PhaseEIslandLayer.resample(spec, rgba, w, h, size, pool, lanes) { false }!!
                        val diff = ref.indices.count { ref[it] != out[it] }
                        assertEquals(0, diff, "${spec.id} ${w}x$h at $size² (k = $k), $lanes lanes: bytes differing from code 29")
                    }
                    if (size == 96) assertTrue(k >= 2, "${spec.id}: the far-style case reduces the art (k = $k)")
                    else assertEquals(1, k, "${spec.id}: the near-style case reads the art itself")
                }
            }
        } finally { helpers.shutdownNow() }
    }

    /**
     * Owner 2026-10-06 (the islands must be on the globe in its first frame): the far layers now hold the globe's reveal,
     * so their resample runs across the island lanes the near art uses instead of one thread, and must still draw exactly
     * what one lane draws (every layer, every mip), or the islands the player first sees would change.
     */
    @Test fun `the far layers resample across the island lanes and draw exactly what one lane draws`() {
        val pool = java.util.concurrent.Executors.newFixedThreadPool(3)
        val asked = java.util.concurrent.atomic.AtomicInteger()
        val lanes = java.util.concurrent.Executor { r -> asked.incrementAndGet(); pool.execute(r) }
        try {
            val size = 128 // four row bands, so every lane has one to claim
            val one = GlobeContent(Files(phaseEWorld(true), true), Files(pack(null), false), images, null, realmIds, phaseELayer = size)
                .load().phaseE!!.runAll()!!
            val four = GlobeContent(Files(phaseEWorld(true), true), Files(pack(null), false), images, null, realmIds, phaseELayer = size,
                nearHelpers = lanes, nearLanes = 4).load().phaseE!!.runAll()!!
            assertEquals(GlobeV2Pin.PHASE_E.size * 3, asked.get(), "each island's far resample offered its bands to three helper lanes")
            assertEquals(one.art.layers, four.art.layers); assertEquals(one.art.levels, four.art.levels)
            for (l in 0 until one.art.layers) for (level in 0 until one.art.levels)
                assertTrue(one.art.data[l][level].contentEquals(four.art.data[l][level]), "layer $l level $level: the lanes drew what one lane draws")
            assertTrue(one.art.data[0][0].any { it != 0.toByte() }, "the layer is not empty")
        } finally { pool.shutdownNow() }
    }

    @Test fun `a cancelled resample or near build stops at its next band and returns nothing`() {
        val spec = GlobeV2Pin.PHASE_E[1]
        val rgba = islandArt(200, 200, 3L)
        var polls = 0
        assertEquals(null, PhaseEIslandLayer.resample(spec, rgba, 200, 200, 256, null, 1) { ++polls > 3 },
            "the camera left after three bands: no partial layer")
        assertTrue(polls in 4..5, "one check per band (plus the final one): the fourth stops it, not the ${256 / PhaseEIslandLayer.BAND_ROWS} bands in all ($polls checks)")
        val files = Files(phaseEWorld(true), true)
        val assets = GlobeContent(files, Files(pack(null), false), images, null, realmIds, phaseELayer = 16, phaseENear = 32).load()
        assertEquals(null, assets.phaseENear!!.build(2) { true }, "a build cancelled before it started")
        assertTrue("divine-isle.webp" !in files.reads, "it stopped before reading: no 1.4 MB read and hash, no 12 MB decode for an island the camera left")
        assertTrue(assets.phaseENear!!.build(2) { false } != null)
    }

    /**
     * Review 2026-09-27 (MAJOR 2): the resample's helper lanes run on the host's world-isle threads, whose uncaught
     * handler fails the whole world to the legacy globe. A lane that throws in its band loop (an OutOfMemoryError there)
     * never escapes its thread: the resample stops every lane and rethrows it on the calling thread, never returning a
     * layer that may miss a band; the content's near build passes it up to the renderer's catch (one island's close-up).
     */
    @Test fun `a resample lane that throws never escapes its thread, and the build rethrows it on the calling thread`() {
        val spec = GlobeV2Pin.PHASE_E[1]
        val rgba = islandArt(200, 200, 3L)
        val lane = DyingLane(OutOfMemoryError("lane"))
        val e = assertFailsWith<OutOfMemoryError> { PhaseEIslandLayer.resample(spec, rgba, 200, 200, 256, lane.executor, 2) { lane.check() } }
        assertEquals("lane", e.message, "the lane's own error, on the calling thread")
        lane.join()
        assertTrue(lane.uncaught.isEmpty(), "nothing reached the lane thread's uncaught handler: ${lane.uncaught}")
        val near = DyingLane(OutOfMemoryError("near lane"))
        val assets = GlobeContent(Files(phaseEWorld(true), true), Files(pack(null), false), images, null, realmIds, phaseELayer = 16, phaseENear = 64,
            nearHelpers = near.executor, nearLanes = 2).load()
        assertFailsWith<OutOfMemoryError> { assets.phaseENear!!.build(2) { near.check() } }
        near.join()
        assertTrue(near.uncaught.isEmpty(), "the content's build: ${near.uncaught}")
    }

    @Test fun `the art is reduced to about the layer's density and never kept above one and a half layers`() {
        val sizes = mapOf("seeker-island" to intArrayOf(1819, 2489), "solana-island" to intArrayOf(2048, 2051), "divine-isle" to intArrayOf(2048, 1436))
        for (spec in GlobeV2Pin.PHASE_E) {
            val (w, h) = sizes.getValue(spec.id).let { it[0] to it[1] }
            assertEquals(2, PhaseEIslandLayer.reduction(spec, w, h, PhaseEIslandLayer.LAYER), "${spec.id} for the far layer (Divine was k = 1: the whole art)")
            assertEquals(1, PhaseEIslandLayer.reduction(spec, w, h, PhaseEIslandLayer.NEAR), "${spec.id} for the near slot: the art itself, no copy")
            for (size in listOf(PhaseEIslandLayer.LAYER, PhaseEIslandLayer.NEAR)) {
                val k = PhaseEIslandLayer.reduction(spec, w, h, size)
                assertTrue(maxOf(w, h) / k <= PhaseEIslandLayer.ART_CAP * size, "${spec.id} at $size: ${w / k}x${h / k}")
            }
        }
    }

    @Test fun `the near slot's art is the same verified file at the near size, one layer with its mips`() {
        val world = phaseEWorld(true)
        val assets = GlobeContent(Files(world, true), Files(pack(null), false), images, null, realmIds, phaseELayer = 16, phaseENear = 32).load()
        val near = assets.phaseENear!!.build(2) { false }!!.data
        assertEquals(32, near.width); assertEquals(1, near.layers); assertEquals(6, near.levels, "32 → 1")
        val c = (16 * 32 + 16) * 4
        assertEquals(listOf(200, 7, 7, 255), (0 until 4).map { near.data[0][0][c + it].toInt() and 0xFF }, "the island's art")
        world["divine-isle.webp"] = byteArrayOf(24, 21) // not the pinned bytes
        val tampered = GlobeContent(Files(world, true).also { it.sha["divine-isle.webp"] = GlobeContent.sha256(byteArrayOf(24, 20)) }, Files(pack(null), false),
            images, null, realmIds, phaseELayer = 16, phaseENear = 32).load()
        assertFailsWith<GlobeContentException> { tampered.phaseENear!!.build(2) { false } }
    }

    @Test fun `the Phase E flag is on only when the world index says true`() {
        assertTrue(GlobeContent.phaseEFlag("""{"schema":1,"phaseEIslands":true,"files":[]}""".toByteArray()))
        for (index in listOf("""{"schema":1,"phaseEIslands":false}""", """{"schema":1,"files":[]}""", "{}"))
            assertEquals(false, GlobeContent.phaseEFlag(index.toByteArray()), index)
        assertFailsWith<GlobeContentException> { GlobeContent.phaseEFlag("""{"phaseEIslands":""".toByteArray()) }
    }

    @Test fun `half floats round-trip the field's range`() {
        for (v in floatArrayOf(0f, 1f, -1f, 2.5f, -25.9f, 25.9f, 0.0078125f, 1.9921875f)) {
            val back = Half.toFloat(Half.bits(v).toInt() and 0xFFFF)
            assertTrue(kotlin.math.abs(back - v) <= kotlin.math.abs(v) * 1e-3f + 1e-6f, "$v → $back")
        }
    }

    // ---- Phase E halo at a distance (owner 2026-10-06, screenshots 5 and 6: square, streaked halos zoomed out) ----

    @Test fun `the fast half decode is the exact decode for every half`() {
        for (bits in 0..0xFFFF) {
            val slow = Half.toFloat(bits); val fast = Half.fast(bits)
            if (slow.isNaN()) assertTrue(fast.isNaN(), "bits $bits") else assertEquals(slow, fast, "bits $bits")
        }
    }

    @Test fun `an island field keeps the coast's rate and gives the open sea a true distance slope`() {
        // Why: the shader's glow is sd / (0.635 · rate · footprint) screen px wide; a rate below the distance's real
        // slope (1) makes the glow fall too soon. The coast (rim, keyline) must keep the builder's rate exactly.
        val cases = listOf(
            floatArrayOf(2.5f, 0.3f, 0.3f),   // land: untouched
            floatArrayOf(-0.25f, 0.3f, 0.3f), // the coast band: untouched
            floatArrayOf(-3f, 0.4375f, 1f),   // the window's border ring (the builder's clamp-halved rate): lifted
            floatArrayOf(-25.9f, 0.5f, 1f),   // open sea: lifted
            floatArrayOf(-6f, 1.0234375f, 1.0234375f), // already steeper than 1: kept
        )
        val rg = ByteArray(cases.size * 4)
        val b = ByteBuffer.wrap(rg).order(ByteOrder.nativeOrder())
        cases.forEachIndexed { i, c -> b.putShort(i * 4, Half.bits(c[0])); b.putShort(i * 4 + 2, Half.bits(c[1])) }
        val distances = IntArray(cases.size) { b.getShort(it * 4).toInt() }
        GlobeContent.liftSeaRates(rg)
        cases.forEachIndexed { i, c ->
            assertEquals(distances[i], b.getShort(i * 4).toInt(), "texel $i: the distance is the builder's, bit for bit")
            assertEquals(Half.toFloat(Half.bits(c[2]).toInt() and 0xFFFF), Half.toFloat(b.getShort(i * 4 + 2).toInt() and 0xFFFF),
                "texel $i (sd ${c[0]}, baked ${c[1]})")
        }
        // between the coast and the open sea the floor rises smoothly, never jumping
        var last = 0f
        var sd = GlobeContent.SEA_RATE_FROM
        while (sd >= GlobeContent.SEA_RATE_FULL - 0.5f) {
            val r = GlobeContent.islandSeaRate(sd, 0f)
            assertTrue(r >= last && r - last < 0.05f, "a smooth floor at $sd: $last → $r")
            last = r; sd -= 0.02f
        }
        assertEquals(1f, last)
    }

    @Test fun `a halo keeps one screen falloff across the field window's border`() {
        // A row of an island field as the builder bakes it: a distance falling 0.1 geography px per texel (slope 1) with its
        // rate measured by clamp-to-edge reads, so it sinks to about half on the last ring (lib.mjs windowGrad). Beyond
        // the border the shader keeps falling at slope 1 with the border texel's rate (CLAMP). The glow is a function of
        // dp = sd / (0.635 · rate · footprint); the box the owner saw is dp's step jumping at the border.
        val n = 40; val ring = 12
        val sd = FloatArray(n) { -(2f + it * 0.1f) }
        val rate = FloatArray(n) { if (it < n - ring) 1f else 1f - 0.55f * (it - (n - ring) + 1) / ring }
        fun steps(rates: FloatArray): List<Float> {
            val dp = FloatArray(n + 10) { i -> if (i < n) sd[i] / rates[i] else (sd[n - 1] - (i - n + 1) * 0.1f) / rates[n - 1] }
            return (1 until dp.size).map { dp[it - 1] - dp[it] }
        }
        val before = steps(rate)
        assertTrue(before.max() / before.min() > 1.8f, "the baked rates cut the glow at the border: ${before.max() / before.min()}")
        val rg = ByteArray(n * 4)
        val b = ByteBuffer.wrap(rg).order(ByteOrder.nativeOrder())
        for (i in 0 until n) { b.putShort(i * 4, Half.bits(sd[i])); b.putShort(i * 4 + 2, Half.bits(rate[i])) }
        GlobeContent.liftSeaRates(rg)
        val lifted = FloatArray(n) { Half.toFloat(b.getShort(it * 4 + 2).toInt() and 0xFFFF) }
        val after = steps(lifted)
        assertTrue(after.max() / after.min() < 1.05f, "one falloff inside, across and beyond the border: ${after.max() / after.min()}")
    }

    companion object {
        /** A minimal RGB PNG (filter 0 rows, zlib via Deflater). */
        fun png(w: Int, h: Int, px: (Int, Int) -> IntArray): ByteArray {
            val raw = ByteArrayOutputStream()
            for (y in 0 until h) { raw.write(0); for (x in 0 until w) { val c = px(x, y); raw.write(c[0]); raw.write(c[1]); raw.write(c[2]) } }
            val d = Deflater(); d.setInput(raw.toByteArray()); d.finish()
            val z = ByteArrayOutputStream(); val buf = ByteArray(8192); while (!d.finished()) { val n = d.deflate(buf); z.write(buf, 0, n) }
            val out = ByteArrayOutputStream()
            out.write(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
            fun chunk(type: String, data: ByteArray) {
                out.write(ByteBuffer.allocate(4).putInt(data.size).array()); val body = type.toByteArray() + data; out.write(body)
                val crc = CRC32(); crc.update(body); out.write(ByteBuffer.allocate(4).putInt(crc.value.toInt()).array())
            }
            chunk("IHDR", ByteBuffer.allocate(13).putInt(w).putInt(h).put(8).put(2).put(0).put(0).put(0).array())
            chunk("IDAT", z.toByteArray()); chunk("IEND", ByteArray(0))
            return out.toByteArray()
        }
    }
}
